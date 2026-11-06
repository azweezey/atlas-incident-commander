/**
 * Kit 11 treasury leg on Airwallex (SANDBOX — test money only).
 * The Airwallex sandbox cannot receive stablecoins, so earnings are pulled on Metal testnet to an
 * address we hold, and their arrival is recorded here as a *simulated* deposit (Airwallex's sandbox
 * simulation endpoint) whose reference is the Metal transaction hash. The licence fee then goes out
 * as a real sandbox FX conversion (USD -> EUR) and a SWIFT transfer to a sandbox beneficiary.
 * Without Airwallex credentials, a clearly labeled in-memory mock is used instead.
 */
import { randomUUID } from "node:crypto";
import { AirwallexConnector } from "../connectors/airwallex.js";
import { kit11Config } from "./config.js";

export interface DepositResult {
  id?: string;
  status?: string;
  amount: number;
  currency: string;
  reference: string;
  confirmed: boolean;
}
export interface LicencePayment {
  rate?: number;
  conversion: { id?: string; status?: string; buyAmount: number; sellAmount?: number; buyCurrency: string; sellCurrency: string };
  beneficiaryId: string;
  transfer: { id?: string; status?: string; amount: number; currency: string; method: string; fee: number; requestId: string };
}
export interface Treasury {
  mode: "sandbox" | "mock";
  label: string;
  usdAvailable(): Promise<number | null>;
  /** Record the earnings arrival (simulated deposit, reference = Metal tx hash), then confirm it via GET /deposits. */
  recordEarnings(amountUsd: number, reference: string): Promise<DepositResult>;
  payLicence(requestId: string): Promise<LicencePayment>;
}

export const licensorBeneficiary = {
  beneficiary: {
    entity_type: "COMPANY",
    company_name: kit11Config.licenceFee.counterparty,
    type: "BANK_ACCOUNT",
    address: { country_code: "DE", city: "Berlin", postcode: "10115", street_address: "1 Sandboxstrasse" },
    bank_details: {
      account_currency: "EUR",
      account_name: kit11Config.licenceFee.counterparty,
      bank_country_code: "DE",
      iban: "DE89370400440532013000",
      swift_code: "COBADEFFXXX",
    },
  },
  transfer_methods: ["SWIFT"],
  nickname: "atlas-kit11-licensor-eur",
};

const total = () => Math.round((kit11Config.licenceFee.amount + kit11Config.swiftFeeEur) * 100) / 100;

export class AirwallexTreasury implements Treasury {
  mode = "sandbox" as const;
  label = "Airwallex sandbox (test money)";
  private beneficiaryId?: string;
  constructor(private aw: AirwallexConnector) {}
  async usdAvailable() {
    const usd = (await this.aw.balances()).find((b) => b.currency === "USD");
    return usd ? Number(usd.available_amount) : null;
  }
  private async globalAccount() {
    if (process.env.AIRWALLEX_GLOBAL_ACCOUNT_ID) return process.env.AIRWALLEX_GLOBAL_ACCOUNT_ID;
    const ga = await this.aw.api("GET", "/api/v1/global_accounts");
    const usd = (ga.items ?? []).find((g: any) => g.status === "ACTIVE" && JSON.stringify(g).includes("USD")) ?? (ga.items ?? [])[0];
    if (!usd) throw new Error("No Airwallex global account to receive the deposit");
    return usd.id as string;
  }
  private async findDeposit(reference: string) {
    try {
      const list = await this.aw.api("GET", "/api/v1/deposits?page_num=0&page_size=20");
      return (list.items ?? []).find((x: any) => JSON.stringify(x).includes(reference));
    } catch {
      return undefined; // a slow or failed lookup only means "not confirmed yet"
    }
  }
  async recordEarnings(amountUsd: number, reference: string): Promise<DepositResult> {
    const body = {
      global_account_id: await this.globalAccount(),
      amount: amountUsd,
      payer_name: "Metal testnet earnings (simulated arrival)",
      reference,
    };
    // The simulation endpoint takes no request_id, so on a timeout we look the deposit up by its
    // reference (the Metal tx hash) before trying again; it is never created twice on purpose.
    let d: any;
    for (let attempt = 0; attempt < 3 && !d; attempt++) {
      try {
        d = await this.aw.api("POST", "/api/v1/simulation/deposit/create", body);
      } catch (e) {
        await new Promise((r) => setTimeout(r, 2000));
        d = await this.findDeposit(reference);
        if (!d && attempt === 2) throw e;
      }
    }
    let confirmed = false;
    for (let i = 0; i < 5 && !confirmed; i++) {
      confirmed = !!(await this.findDeposit(reference));
      if (!confirmed) await new Promise((r) => setTimeout(r, 1000));
    }
    return { id: d.id, status: d.status, amount: amountUsd, currency: "USD", reference, confirmed };
  }
  private async beneficiary() {
    if (this.beneficiaryId) return this.beneficiaryId;
    const found = (await this.aw.listBeneficiaries(licensorBeneficiary.nickname)).find((b) => b.nickname === licensorBeneficiary.nickname);
    const b = found ?? (await this.aw.createBeneficiary(licensorBeneficiary as any));
    this.beneficiaryId = (b.id || b.beneficiary_id) as string;
    return this.beneficiaryId;
  }
  async payLicence(requestId: string): Promise<LicencePayment> {
    const f = kit11Config.licenceFee;
    const buy = total();
    const conv = await this.aw.api("POST", "/api/v1/fx/conversions/create", {
      request_id: requestId + "-fx",
      buy_currency: "EUR",
      sell_currency: "USD",
      buy_amount: buy,
    });
    const beneficiaryId = await this.beneficiary();
    const t = await this.aw.api("POST", "/api/v1/transfers/create", {
      request_id: requestId,
      beneficiary_id: beneficiaryId,
      transfer_amount: f.amount,
      transfer_currency: "EUR",
      source_currency: "EUR",
      transfer_method: "SWIFT",
      reference: f.invoice,
      reason: "professional_business_services",
    });
    return {
      rate: Number(conv.client_rate ?? conv.rate) || undefined,
      conversion: { id: conv.conversion_id ?? conv.id, status: conv.status, buyAmount: buy, sellAmount: Number(conv.sell_amount) || undefined, buyCurrency: "EUR", sellCurrency: "USD" },
      beneficiaryId,
      transfer: { id: t.id, status: t.status, amount: f.amount, currency: "EUR", method: "SWIFT", fee: kit11Config.swiftFeeEur, requestId },
    };
  }
}

/** No Airwallex credentials: in-memory mock with the same shapes, labeled as a mock everywhere. */
export class MockTreasury implements Treasury {
  mode = "mock" as const;
  label = "Airwallex mock (no credentials; nothing sent)";
  usd = 1000;
  deposits: DepositResult[] = [];
  transfers = new Set<string>();
  async usdAvailable() {
    return this.usd;
  }
  async recordEarnings(amountUsd: number, reference: string) {
    const d = { id: "mock-dep-" + randomUUID().slice(0, 8), status: "SETTLED", amount: amountUsd, currency: "USD", reference, confirmed: true };
    this.usd += amountUsd;
    this.deposits.push(d);
    return d;
  }
  async payLicence(requestId: string): Promise<LicencePayment> {
    if (this.transfers.has(requestId)) throw new Error("duplicate_request_id");
    this.transfers.add(requestId);
    const rate = 1.12;
    const buy = total();
    this.usd -= Math.round(buy * rate * 100) / 100;
    return {
      rate,
      conversion: { id: "mock-fx-" + requestId.slice(-6), status: "SETTLED", buyAmount: buy, sellAmount: Math.round(buy * rate * 100) / 100, buyCurrency: "EUR", sellCurrency: "USD" },
      beneficiaryId: "mock-licensor-eur",
      transfer: { id: "mock-tr-" + requestId.slice(-6), status: "SENT", amount: kit11Config.licenceFee.amount, currency: "EUR", method: "SWIFT", fee: kit11Config.swiftFeeEur, requestId },
    };
  }
}

export const createTreasury = (aw: AirwallexConnector): Treasury => (aw.mode === "sandbox" ? new AirwallexTreasury(aw) : new MockTreasury());
