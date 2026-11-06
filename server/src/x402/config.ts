/**
 * Kit 11 (x402 Business Agents): every price, budget, cap and fee lives here, in code.
 * The model (or rule-based planner) may weigh evidence and explain; it never sets these numbers.
 * Amounts are *USDZ (Metal testnet dollar token), to the cent, unless a currency says otherwise.
 */
export type AgentRole = "sourcing" | "support" | "treasury";

export interface AgentLimits {
  budget: number;
  cap: number;
}

export const kit11Config = {
  /** Total the three business agents may spend between them. Metal caps each mandate, not the total, so Atlas holds the 20 in code. */
  totalBudget: 20,
  mandates: {
    sourcing: { budget: 10, cap: 0.03 },
    support: { budget: 4, cap: 0.1 },
    treasury: { budget: 6, cap: 1 },
  } satisfies Record<AgentRole, AgentLimits>,
  /** Price a customer's agent pays per market-data query. */
  queryPrice: 0.05,
  /** Upstream provider's price per record, before and after the price rise. */
  upstreamPrice: 0.02,
  upstreamPriceAfterRise: 0.04,
  /** The smallest per-query margin the treasury agent will accept when it proposes new limits. */
  minMarginPerQuery: 0.02,
  /** The simulated customer's own mandate (its agent pays us under it). */
  customer: { budget: 2, cap: 0.1 },
  /** Queries sold before the upstream price rises. */
  initialQueries: 5,
  /** The batch the customer disputes, and the query ids. */
  disputedBatch: ["Q1", "Q2", "Q3", "Q4"],
  /** Upstream data older than this is judged wrong (the evidence a refund turns on). */
  staleAfterHours: 24,
  /** Monthly licence fee, invoiced in euros, paid through Airwallex (sandbox). */
  licenceFee: {
    amount: 15,
    currency: "EUR",
    invoice: "LIC-2026-11",
    counterparty: "Licensor Data GmbH (Sandbox)",
    beneficiaryId: "licensor-eur",
  },
  /** Airwallex sandbox flat SWIFT fee per EUR payout (from the Airwallex hackathon guide). */
  swiftFeeEur: 12.85,
} as const;

export type Kit11Config = typeof kit11Config;

export const cents = (n: number) => Math.round(n * 100);
export const fromCents = (c: number) => Math.round(c) / 100;
export const money = (n: number) => fromCents(cents(n));
