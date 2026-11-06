import { MockConnector } from "./mock.js";
import type { Payout, PayoutRequest, Status } from "./types.js";
export class PayPalConnector extends MockConnector {
  private token = "";
  private expires = 0;
  private known = new Map<string, PayoutRequest>();
  constructor() {
    super("paypal");
    if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET)
      this.mode = "sandbox";
  }
  private async api(path: string, body?: unknown): Promise<any> {
    const base =
      process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";
    if (Date.now() > this.expires) {
      const r = await fetch(base + "/v1/oauth2/token", {
        method: "POST",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`,
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`PayPal authentication: ${r.status}`);
      const d = (await r.json()) as any;
      this.token = d.access_token;
      this.expires = Date.now() + (d.expires_in - 60) * 1000;
    }
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`PayPal request: ${r.status}`);
    return r.json();
  }
  private normalize(d: any, req?: PayoutRequest): Payout {
    const h = d.batch_header;
    const item = d.items?.[0];
    const states: Record<string, Status> = {
      SUCCESS: "succeeded",
      FAILED: "failed",
      DENIED: "failed",
      RETURNED: "failed",
      CANCELED: "cancelled",
    };
    return {
      id: h.payout_batch_id,
      beneficiaryId: req?.beneficiaryId || item?.payout_item?.receiver || "",
      amount: req?.amount ?? Number(item?.payout_item?.amount?.value),
      currency: req?.currency || item?.payout_item?.amount?.currency || "",
      reference: req?.reference || item?.payout_item?.note || "",
      idempotencyKey:
        req?.idempotencyKey || h.sender_batch_header?.sender_batch_id || "",
      createdAt: h.time_created || new Date().toISOString(),
      status: states[item?.transaction_status] || "pending",
    };
  }
  override async createPayout(req: PayoutRequest) {
    if (this.mode === "mock") return super.createPayout(req);
    const d = await this.api("/v1/payments/payouts", {
      sender_batch_header: {
        sender_batch_id: req.idempotencyKey,
        email_subject: "Atlas payout",
      },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: req.beneficiaryId,
          amount: { value: req.amount.toFixed(2), currency: req.currency },
          note: req.reference,
          sender_item_id: req.idempotencyKey,
        },
      ],
    });
    this.known.set(d.batch_header.payout_batch_id, req);
    return this.normalize(d, req);
  }
  override async getPayout(id: string) {
    return this.mode === "mock"
      ? super.getPayout(id)
      : this.normalize(
          await this.api("/v1/payments/payouts/" + encodeURIComponent(id)),
          this.known.get(id),
        );
  }
  override async listPayouts() {
    return this.mode === "mock"
      ? super.listPayouts()
      : Promise.all([...this.known.keys()].map((id) => this.getPayout(id)));
  }
  override async getBeneficiary(id: string) {
    return this.mode === "mock"
      ? super.getBeneficiary(id)
      : { id, name: id, email: id, valid: /^[^@]+@[^@]+\.[^@]+$/.test(id) };
  }
  override async cancelPayout(id: string): Promise<Payout> {
    if (this.mode === "mock") return super.cancelPayout(id);
    throw new Error(
      "PayPal only supports cancelling unclaimed items; batch cancellation requires manual reconciliation",
    );
  }
  override async updateBeneficiary(): Promise<never> {
    throw new Error(
      "PayPal recipient changes require independent verification",
    );
  }
}
