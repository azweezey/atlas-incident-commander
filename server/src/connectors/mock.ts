import { randomUUID } from "node:crypto";
import type {
  Beneficiary,
  PaymentConnector,
  Payout,
  PayoutRequest,
} from "./types.js";
export class MockConnector implements PaymentConnector {
  mode: "mock" | "sandbox" = "mock";
  payouts = new Map<string, Payout>();
  beneficiaries = new Map<string, Beneficiary>([
    [
      "vendor-acme",
      {
        id: "vendor-acme",
        name: "Acme Supplies",
        email: "acme@example.com",
        valid: true,
      },
    ],
    [
      "vendor-bad",
      { id: "vendor-bad", name: "Routing Repair Required", valid: false },
    ],
  ]);
  constructor(public name: "airwallex" | "paypal") {}
  async getPayout(id: string) {
    const p = this.payouts.get(id);
    if (!p) throw new Error("Payout not found");
    return { ...p };
  }
  async listPayouts() {
    return [...this.payouts.values()].map((p) => ({ ...p }));
  }
  async createPayout(req: PayoutRequest) {
    const old = [...this.payouts.values()].find(
      (p) => p.idempotencyKey === req.idempotencyKey,
    );
    if (old) return { ...old };
    const b = await this.getBeneficiary(req.beneficiaryId);
    const p: Payout = {
      ...req,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: b.valid ? "succeeded" : "failed",
      ...(!b.valid
        ? { failureReason: "Invalid account or routing details" }
        : {}),
    };
    this.payouts.set(p.id, p);
    return { ...p };
  }
  async cancelPayout(id: string) {
    const p = await this.getPayout(id);
    if (p.status !== "pending")
      throw new Error("Only pending payouts can be cancelled");
    p.status = "cancelled";
    this.payouts.set(id, p);
    return p;
  }
  async retryPayout(id: string): Promise<Payout> {
    const p = await this.getPayout(id);
    if (p.status !== "failed")
      throw new Error("Only confirmed failed payouts can be retried");
    return this.createPayout({
      ...p,
      idempotencyKey: p.idempotencyKey + ":retry",
    });
  }
  async getBeneficiary(id: string) {
    const b = this.beneficiaries.get(id);
    if (!b) throw new Error("Unknown beneficiary");
    return { ...b };
  }
  async updateBeneficiary(id: string, patch: Partial<Beneficiary>) {
    const b = { ...(await this.getBeneficiary(id)), ...patch, id };
    this.beneficiaries.set(id, b);
    return b;
  }
  seed(p: Payout) {
    this.payouts.set(p.id, { ...p });
  }
  reset() {
    this.payouts.clear();
  }
}
