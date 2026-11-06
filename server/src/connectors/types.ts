export type Status = "succeeded" | "failed" | "pending" | "cancelled";
export interface PayoutRequest {
  beneficiaryId: string;
  amount: number;
  currency: string;
  reference: string;
  idempotencyKey: string;
}
export interface Payout extends PayoutRequest {
  id: string;
  status: Status;
  createdAt: string;
  failureReason?: string;
  /** Raw provider status, e.g. Airwallex SCHEDULED / PROCESSING / SENT / PAID. */
  providerStatus?: string;
  /** Provider failure code/type when the provider reports one. */
  failureCode?: string;
  /** True when the provider rejected a create as a duplicate request id and the existing transfer was returned. */
  providerDuplicate?: boolean;
}
export interface Beneficiary {
  id: string;
  name: string;
  email?: string;
  valid: boolean;
}
export interface PaymentConnector {
  name: "airwallex" | "paypal";
  mode: "mock" | "sandbox";
  getPayout(id: string): Promise<Payout>;
  listPayouts(): Promise<Payout[]>;
  createPayout(req: PayoutRequest): Promise<Payout>;
  cancelPayout(id: string): Promise<Payout>;
  retryPayout(id: string): Promise<Payout>;
  getBeneficiary(id: string): Promise<Beneficiary>;
  updateBeneficiary?(
    id: string,
    patch: Partial<Beneficiary>,
  ): Promise<Beneficiary>;
}
