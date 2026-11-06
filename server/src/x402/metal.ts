/**
 * MetalConnector: the one interface the Kit 11 scenario uses for the chain side.
 * Two implementations:
 *  - TestnetMetalConnector: real Metal testnet via the `metal-agent` CLI and `@metalntwx/metal-pay`.
 *  - SimMetalConnector: a clearly labeled local simulation that mirrors the same shapes and refusal reasons.
 * Choose with METAL_MODE=testnet|simulation (default: testnet when METAL_RPC_URL is set, else simulation).
 */
import type { AgentRole } from "./config.js";

export type MetalMode = "testnet" | "simulation";

export interface MandateSpec {
  agent: AgentRole | "customer";
  principal: string;
  cap: number;
  budget: number;
  payees?: { address: string; name?: string }[];
  description: string;
}

export interface Mandate extends MandateSpec {
  /** Mandate id (bytes32 on chain). */
  id: string;
  /** Credential file (testnet) or in-memory handle (simulation). No secrets are ever serialized here. */
  credential: string;
  version: number;
  bindTx?: string;
  replaces?: string;
}

export interface MandateState {
  spent: number;
  budget: number;
  revoked: boolean;
}

export interface Refusal {
  /** e.g. mandate_cap_exceeded, mandate_revoked, mandate_budget_spent, seller_error */
  reason: string;
  detail: string;
}

export interface PayResult {
  ok: boolean;
  status?: number;
  amount?: number;
  payer?: string;
  payee?: string;
  tx?: string;
  nonce?: string;
  signedOffer?: string;
  body?: any;
  refusal?: Refusal;
  /** True when a payment was signed and the outcome is unconfirmed (must look up /settlements before paying again). */
  inDoubt?: boolean;
}

export interface PullResult {
  outcome: "paid" | "already_paid" | "refused" | "pending" | "held";
  amount: number;
  to: string;
  tx?: string;
  spent?: number;
  reason?: string;
}

export interface SaleRecord {
  queryId: string;
  resource: string;
  amount: number;
  payer: string;
  payTo: string;
  tx: string;
  signedOffer: string;
  delivered: any;
  settledAt: string;
}

export interface SellerResponse {
  status: number;
  body: any;
}

export interface SellerRoute {
  /** e.g. "GET /query" — also the signed order's resource. */
  resource: string;
  payTo: string;
  price: () => number;
  signedOrder: boolean;
  handler: (ctx: { queryId?: string }) => Promise<SellerResponse>;
}

export interface Storefront {
  urlOf(resource: string): string;
  close(): Promise<void>;
}

export interface OrderCheck {
  ok: boolean;
  steps: { outcome: string; title?: string; detail?: string }[];
}

export interface MetalConnector {
  mode: MetalMode;
  /** Human label for UI and docs. */
  label: string;
  network: string;
  /** Create (or reuse) an owner's Metal account (a smart account a mandate's principal is). */
  account(role: "business" | "customer"): Promise<{ address: string; tx?: string; reused: boolean }>;
  /** A plain address we hold (the upstream provider's payee, the off-ramp address for earnings). */
  address(role: "upstream" | "offramp"): Promise<string>;
  /** Make sure an account holds at least `min` *USDZ (faucet on testnet). */
  ensureFunded(address: string, min: number): Promise<{ balance: number; fundedTx?: string }>;
  balanceOf(address: string): Promise<number>;
  issueMandate(spec: MandateSpec, runId: string): Promise<Mandate>;
  /** Owner-only: bind a new credential in place of the old one; spend carries over; old one is revoked. */
  replaceMandate(old: Mandate, next: Omit<MandateSpec, "agent" | "principal">, runId: string): Promise<{ mandate: Mandate; spent: number; tx?: string }>;
  mandateState(m: Mandate): Promise<MandateState>;
  serve(routes: SellerRoute[], onSale: (s: SaleRecord) => void): Promise<Storefront>;
  /** An agent pays an x402 route under its mandate (the agent holds only the mandate key). */
  pay(m: Mandate, url: string, headers?: Record<string, string>): Promise<PayResult>;
  /** Direct payout under a mandate (refunds, moving earnings). Same paymentId = pays at most once. */
  pull(m: Mandate, to: string, amount: number, paymentId: string): Promise<PullResult>;
  /** Seller-side check: the signed order against the payment on chain. */
  verifyOrder(tx: string, signedOffer: string): Promise<OrderCheck>;
  /** Look a signed-but-unconfirmed purchase up in the facilitator's /settlements. */
  findSettlement(payTo: string, nonce: string): Promise<{ found: boolean; tx?: string }>;
  explorer(tx?: string): string | undefined;
  close(): Promise<void>;
}

export const REFUSAL_TEXT: Record<string, string> = {
  mandate_cap_exceeded: "the amount is above the mandate's per-payment cap",
  mandate_budget_spent: "the mandate's budget is spent",
  mandate_revoked: "the mandate is revoked, or replaced: the agent pays under the credential that replaced it",
  mandate_payee_not_listed: "the payee is not one the mandate names",
  mandate_not_bound: "the account has no mandate bound from this credential",
};
