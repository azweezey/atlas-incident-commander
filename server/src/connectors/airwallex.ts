import { MockConnector } from "./mock.js";
import type { Beneficiary, Payout, PayoutRequest, Status } from "./types.js";

/**
 * Airwallex adapter.
 * - mock mode (no credentials): in-memory MockConnector behaviour.
 * - sandbox mode: real calls to https://api.sandbox.airwallex.com (test money only).
 *
 * Verified against the Airwallex API reference (https://www.airwallex.com/docs/api):
 *   POST /api/v1/authentication/login             (x-client-id, x-api-key) -> { token, expires_at } (30 min)
 *   GET  /api/v1/balances/current
 *   GET  /api/v1/beneficiaries, GET /api/v1/beneficiaries/{id}
 *   POST /api/v1/beneficiaries/create, POST /api/v1/beneficiaries/validate
 *   POST /api/v1/transfers/create (request_id = idempotency key, unique for 7 days)
 *   GET  /api/v1/transfers/{id}, GET /api/v1/transfers?request_id=...
 *   POST /api/v1/transfers/{id}/cancel
 *   POST /api/v1/simulation/transfers/{id}/transition (sandbox only)
 */

export class AirwallexError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(`Airwallex ${status}${code ? " " + code : ""}: ${message}`);
  }
}

export interface ApiCallRecord {
  method: string;
  path: string;
  status: number;
  code?: string;
  objectStatus?: string;
  id?: string;
}

export interface BeneficiarySpec {
  nickname: string;
  beneficiary: Record<string, unknown>;
  transfer_methods: string[];
}

const usBank = (name: string, accountNumber: string) => ({
  entity_type: "COMPANY",
  company_name: name,
  type: "BANK_ACCOUNT",
  address: {
    country_code: "US",
    city: "Phoenix",
    state: "AZ",
    postcode: "85004",
    street_address: "1 Sandbox Way",
  },
  bank_details: {
    account_currency: "USD",
    account_name: name,
    bank_country_code: "US",
    account_number: accountNumber,
    account_routing_type1: "aba",
    account_routing_value1: "021000021",
    local_clearing_system: "ACH",
    bank_account_category: "Checking",
  },
});

/** Logical beneficiary ids used by the policy allowlist, mapped to sandbox test contacts. */
export const sandboxBeneficiaries: Record<string, BeneficiarySpec> = {
  "vendor-acme": {
    nickname: "atlas-vendor-acme",
    beneficiary: usBank("Acme Supplies (Sandbox)", "56999999"),
    transfer_methods: ["LOCAL"],
  },
  "vendor-bad": {
    nickname: "atlas-vendor-bad",
    beneficiary: usBank("Routing Repair Required (Sandbox)", "56999998"),
    transfer_methods: ["LOCAL"],
  },
};

const BENEFICIARY_FAILURE =
  /ROUTING|ACCOUNT|BENEFICIARY|BANK|IBAN|SWIFT|NAME_MISMATCH/i;

export function isBeneficiaryFailure(d: any): boolean {
  const f = d?.failure;
  if (!f && !d?.failure_reason) return false;
  return BENEFICIARY_FAILURE.test(
    [f?.details?.type, f?.message, d?.failure_reason].filter(Boolean).join(" "),
  );
}

export function mapStatus(d: any): Status {
  switch (d?.status) {
    case "PAID":
      return "succeeded";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      // Sandbox moves a FAILED transfer straight to CANCELLED (funds returned) but keeps the failure object.
      return d.failure ? "failed" : "cancelled";
    default:
      // SCHEDULED, PROCESSING, SENT, OVERDUE, IN_APPROVAL...: funds may still move, so never treat as final.
      return "pending";
  }
}

export class AirwallexConnector extends MockConnector {
  private token = "";
  private expires = 0;
  private realIds = new Map<string, string>();
  private logicalIds = new Map<string, string>();
  /** Optional hook used by the sandbox run script to record what Airwallex returned (no secrets). */
  onCall?: (r: ApiCallRecord) => void;
  /** Refresh margin before the 30-minute token expiry. */
  static refreshMarginMs = 5 * 60 * 1000;

  constructor() {
    super("airwallex");
    if (process.env.AIRWALLEX_CLIENT_ID && process.env.AIRWALLEX_API_KEY)
      this.mode = "sandbox";
  }
  private get base() {
    return process.env.AIRWALLEX_BASE_URL || "https://api.sandbox.airwallex.com";
  }
  private async authenticate(force = false) {
    if (!force && this.token && Date.now() < this.expires) return;
    const r = await fetch(this.base + "/api/v1/authentication/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-id": process.env.AIRWALLEX_CLIENT_ID!,
        "x-api-key": process.env.AIRWALLEX_API_KEY!,
      },
      signal: AbortSignal.timeout(15000),
    });
    this.onCall?.({
      method: "POST",
      path: "/api/v1/authentication/login",
      status: r.status,
    });
    if (!r.ok) throw new AirwallexError(r.status, "", "authentication failed");
    const d = (await r.json()) as any;
    if (!d.token) throw new AirwallexError(r.status, "", "no token returned");
    this.token = d.token;
    const exp = Date.parse(d.expires_at ?? "");
    const lifetime = Number.isFinite(exp) ? exp : Date.now() + 30 * 60 * 1000;
    this.expires = lifetime - AirwallexConnector.refreshMarginMs;
  }
  async api(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<any> {
    await this.authenticate();
    const r = await fetch(this.base + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    let d: any = text;
    try {
      d = text ? JSON.parse(text) : {};
    } catch {
      /* plain text such as "OK" */
    }
    this.onCall?.({
      method,
      path: path.split("?")[0],
      status: r.status,
      code: typeof d === "object" ? d?.code : undefined,
      objectStatus: typeof d === "object" ? d?.status : undefined,
      id: typeof d === "object" ? d?.id : undefined,
    });
    if (r.status === 401 && !retried) {
      this.token = "";
      await this.authenticate(true);
      return this.api(method, path, body, true);
    }
    if (!r.ok)
      throw new AirwallexError(
        r.status,
        (typeof d === "object" && d?.code) || "",
        (typeof d === "object" && d?.message) || String(d).slice(0, 200),
        typeof d === "object" ? d?.details : undefined,
      );
    return d;
  }

  // ---------- balances ----------
  async balances(): Promise<
    { currency: string; available_amount: number; total_amount: number }[]
  > {
    if (this.mode === "mock")
      return [{ currency: "USD", available_amount: 0, total_amount: 0 }];
    return this.api("GET", "/api/v1/balances/current");
  }

  // ---------- beneficiaries ----------
  async validateBeneficiary(
    spec: Omit<BeneficiarySpec, "nickname">,
  ): Promise<{ valid: boolean; errors: { source: string; code: string }[] }> {
    try {
      await this.api("POST", "/api/v1/beneficiaries/validate", spec);
      return { valid: true, errors: [] };
    } catch (e) {
      if (e instanceof AirwallexError && e.status === 400)
        return { valid: false, errors: e.details?.errors || [] };
      throw e;
    }
  }
  async listBeneficiaries(nickname?: string): Promise<any[]> {
    const q = nickname ? "?nick_name=" + encodeURIComponent(nickname) : "";
    return (await this.api("GET", "/api/v1/beneficiaries" + q)).items || [];
  }
  async createBeneficiary(spec: BeneficiarySpec): Promise<any> {
    return this.api("POST", "/api/v1/beneficiaries/create", spec);
  }
  /** Map a logical id (e.g. vendor-acme) to an Airwallex beneficiary id, creating the sandbox contact once. */
  async resolveBeneficiary(id: string): Promise<string> {
    const spec = sandboxBeneficiaries[id];
    if (!spec) return id; // already an Airwallex id
    const cached = this.realIds.get(id);
    if (cached) return cached;
    let found = (await this.listBeneficiaries(spec.nickname)).find(
      (b) => b.nickname === spec.nickname,
    );
    if (!found) {
      const v = await this.validateBeneficiary(spec);
      if (!v.valid)
        throw new Error(
          "Sandbox beneficiary failed validation: " +
            v.errors.map((e) => e.source).join(", "),
        );
      found = await this.createBeneficiary(spec);
    }
    const realId = found.id || found.beneficiary_id;
    this.realIds.set(id, realId);
    this.logicalIds.set(realId, id);
    return realId;
  }
  private logical(realId: string) {
    return this.logicalIds.get(realId) || realId;
  }

  // ---------- transfers ----------
  normalize(d: any, req?: PayoutRequest): Payout {
    const failure = d.failure
      ? d.failure.message || d.failure.code
      : d.failure_reason;
    return {
      id: d.id,
      beneficiaryId: d.beneficiary_id
        ? this.logical(d.beneficiary_id)
        : req?.beneficiaryId || "",
      amount: Number(d.transfer_amount ?? req?.amount),
      currency: d.transfer_currency || req?.currency || "",
      reference: d.reference || req?.reference || "",
      idempotencyKey: d.request_id || req?.idempotencyKey || "",
      createdAt: d.created_at
        ? new Date(Date.parse(d.created_at.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"))).toISOString()
        : new Date().toISOString(),
      status: mapStatus(d),
      providerStatus: d.status,
      ...(failure ? { failureReason: failure } : {}),
      ...(d.failure?.details?.type || d.failure?.code
        ? { failureCode: d.failure.details?.type || d.failure.code }
        : {}),
    };
  }
  async findByRequestId(requestId: string): Promise<Payout | undefined> {
    const d = await this.api(
      "GET",
      "/api/v1/transfers?request_id=" + encodeURIComponent(requestId),
    );
    const t = (d.items || []).find((x: any) => x.request_id === requestId);
    return t ? this.normalize(t) : undefined;
  }
  override async getPayout(id: string) {
    if (this.mode === "mock") return super.getPayout(id);
    return this.normalize(
      await this.api("GET", "/api/v1/transfers/" + encodeURIComponent(id)),
    );
  }
  override async listPayouts() {
    if (this.mode === "mock") return super.listPayouts();
    const d = await this.api("GET", "/api/v1/transfers?page_size=200");
    return (d.items || []).map((p: any) => this.normalize(p));
  }
  /** Transfers created at or after `sinceIso` (used by the polling fallback). */
  async listRecentTransfers(sinceIso: string): Promise<Payout[]> {
    if (this.mode === "mock") return [];
    const d = await this.api(
      "GET",
      "/api/v1/transfers?page_size=200&from_created_at=" +
        encodeURIComponent(sinceIso.replace(/\.\d{3}Z$/, "Z")),
    );
    return (d.items || []).map((p: any) => this.normalize(p));
  }
  override async createPayout(req: PayoutRequest) {
    if (this.mode === "mock") return super.createPayout(req);
    const beneficiaryId = await this.resolveBeneficiary(req.beneficiaryId);
    try {
      return this.normalize(
        await this.api("POST", "/api/v1/transfers/create", {
          request_id: req.idempotencyKey,
          beneficiary_id: beneficiaryId,
          transfer_amount: req.amount,
          transfer_currency: req.currency,
          source_currency: req.currency,
          transfer_method: "LOCAL",
          reference: req.reference,
          reason: "payment_for_goods",
        }),
        req,
      );
    } catch (e) {
      // Provider-side idempotency: the request_id was already used, so return the existing transfer, never a new one.
      if (
        e instanceof AirwallexError &&
        e.status === 400 &&
        ["duplicate_request_id", "request_id_duplicate"].includes(e.code)
      ) {
        const existing = e.details?.id
          ? await this.getPayout(e.details.id)
          : await this.findByRequestId(req.idempotencyKey);
        if (existing) return { ...existing, providerDuplicate: true };
      }
      // Outcome unknown (timeout, 409 request_pending, 5xx): look the transfer up by request_id before giving up.
      if (
        !(e instanceof AirwallexError) ||
        e.status === 409 ||
        e.status >= 500
      ) {
        const existing = await this.findByRequestId(req.idempotencyKey).catch(
          () => undefined,
        );
        if (existing) return existing;
      }
      throw e;
    }
  }
  override async cancelPayout(id: string): Promise<Payout> {
    if (this.mode === "mock") return super.cancelPayout(id);
    await this.api(
      "POST",
      "/api/v1/transfers/" + encodeURIComponent(id) + "/cancel",
    );
    return this.getPayout(id);
  }
  /** Sandbox only: drive a transfer through its lifecycle. */
  async simulateTransition(
    id: string,
    nextStatus: "PROCESSING" | "SENT" | "PAID" | "FAILED" | "CANCELLED",
    failureType?: string,
  ): Promise<Payout> {
    if (this.mode !== "sandbox")
      throw new Error("Transition simulation is sandbox-only");
    await this.api(
      "POST",
      `/api/v1/simulation/transfers/${encodeURIComponent(id)}/transition`,
      { next_status: nextStatus, ...(failureType ? { failure_type: failureType } : {}) },
    );
    return this.getPayout(id);
  }
  /** Poll until the raw provider status is one of `wanted` (sandbox moves SCHEDULED -> PROCESSING within seconds). */
  async waitForStatus(id: string, wanted: string[], timeoutMs = 20000, intervalMs = 1000) {
    const end = Date.now() + timeoutMs;
    let p = await this.getPayout(id);
    while (!wanted.includes(p.providerStatus || "") && Date.now() < end) {
      await new Promise((r) => setTimeout(r, intervalMs));
      p = await this.getPayout(id);
    }
    return p;
  }
  override async getBeneficiary(id: string): Promise<Beneficiary> {
    if (this.mode === "mock") return super.getBeneficiary(id);
    const realId = await this.resolveBeneficiary(id);
    const d = await this.api(
      "GET",
      "/api/v1/beneficiaries/" + encodeURIComponent(realId),
    );
    // Valid only if Airwallex still accepts the stored details AND no transfer to it
    // has failed for beneficiary reasons since the details were last updated.
    const check = await this.validateBeneficiary({
      beneficiary: d.beneficiary,
      transfer_methods: d.transfer_methods || ["LOCAL"],
    });
    const transfers =
      (
        await this.api(
          "GET",
          "/api/v1/transfers?beneficiary_id=" + encodeURIComponent(realId),
        )
      ).items || [];
    const since = Date.parse(d.updated_at ?? "") || 0;
    const failedOnDetails = transfers.some(
      (t: any) =>
        isBeneficiaryFailure(t) &&
        (Date.parse(t.updated_at ?? t.created_at ?? "") || Infinity) >= since,
    );
    return {
      id,
      name:
        d.nickname ||
        d.beneficiary?.company_name ||
        d.beneficiary?.bank_details?.account_name ||
        realId,
      valid: check.valid && !failedOnDetails,
    };
  }
  override async updateBeneficiary(): Promise<never> {
    throw new Error(
      "Beneficiary corrections require independently verified details",
    );
  }
}
