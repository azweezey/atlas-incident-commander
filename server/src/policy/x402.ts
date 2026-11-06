/**
 * Kit 11 policy rules (x402 Business Agents). Same PolicyResult shape and decision semantics as the
 * Kit 3 engine: deny > escalate > allow. Numbers come from kit11Config (code), never from a model.
 */
import type { PolicyResult } from "./engine.js";
import { cents, kit11Config, type AgentRole, type Kit11Config } from "../x402/config.js";

export type X402Action =
  | { type: "x402.issue_mandates"; idempotencyKey: string; limits: Record<AgentRole, { budget: number; cap: number }> }
  | { type: "x402.purchase"; idempotencyKey: string; agent: "sourcing"; resource: string; queryId: string; maxPrice: number; mandateCap: number }
  | {
      type: "x402.replace_mandates";
      idempotencyKey: string;
      from: Record<AgentRole, { budget: number; cap: number }>;
      to: Record<AgentRole, { budget: number; cap: number }>;
      spent: Record<AgentRole, number>;
      queryPriceFrom: number;
      queryPriceTo: number;
      upstreamPrice: number;
      rationale: string;
    }
  | {
      type: "x402.refund";
      idempotencyKey: string;
      orderId: string;
      amount: number;
      charged: number;
      orderVerified: boolean;
      dataWrong: boolean;
      supportRemaining: number;
    }
  | { type: "x402.move_earnings"; idempotencyKey: string; amount: number; netEarnings: number; treasuryRemaining: number }
  | {
      type: "x402.pay_licence";
      idempotencyKey: string;
      amount: number;
      currency: string;
      beneficiaryId: string;
      invoice: string;
      counterparty: string;
    };

export interface X402State {
  refundedOrders: Set<string>;
  paidInvoices: Set<string>;
}

const sum = (l: Record<AgentRole, { budget: number }>) => (Object.values(l) as { budget: number }[]).reduce((t, x) => t + cents(x.budget), 0);

export function evaluateX402(action: X402Action, state: X402State, config: Kit11Config = kit11Config): PolicyResult {
  const result: PolicyResult = { decision: "allow", reasons: [], ruleHits: [] };
  const hit = (decision: PolicyResult["decision"], rule: string, reason: string) => {
    result.ruleHits.push(rule);
    result.reasons.push(reason);
    if (decision === "deny" || (decision === "escalate" && result.decision === "allow")) result.decision = decision;
  };
  const total = cents(config.totalBudget);
  switch (action.type) {
    case "x402.issue_mandates": {
      if (sum(action.limits) > total) hit("deny", "x402-total-budget", `Mandate budgets exceed the ${config.totalBudget} *USDZ total held in code`);
      for (const [role, l] of Object.entries(action.limits))
        if (cents(l.cap) > cents(l.budget)) hit("deny", "x402-cap-above-budget", `${role}: per-payment cap is above its budget`);
      break;
    }
    case "x402.purchase": {
      if (cents(action.maxPrice) > cents(action.mandateCap))
        hit("deny", "x402-purchase-cap", "Purchase ceiling is above the sourcing mandate's cap");
      break;
    }
    case "x402.replace_mandates": {
      hit("escalate", "x402-mandate-change", "Changing an agent's spending limits always requires a human (owner) approval");
      if (sum(action.to) > total) hit("deny", "x402-total-budget", `Proposed budgets exceed the ${config.totalBudget} *USDZ total held in code`);
      for (const role of Object.keys(action.to) as AgentRole[]) {
        const to = action.to[role];
        if (cents(to.cap) > cents(to.budget)) hit("deny", "x402-cap-above-budget", `${role}: cap above budget`);
        if (cents(to.budget) <= cents(action.spent[role] ?? 0))
          hit("deny", "x402-replacement-budget", `${role}: a replacement carries what the agent spent, so its budget must exceed ${action.spent[role]}`);
      }
      if (cents(action.queryPriceTo) - cents(action.to.sourcing.cap) < cents(config.minMarginPerQuery))
        hit("deny", "x402-margin", `Query price minus the sourcing cap is below the ${config.minMarginPerQuery} *USDZ minimum margin`);
      if (cents(action.to.sourcing.cap) < cents(action.upstreamPrice))
        hit("deny", "x402-cap-below-upstream", "Proposed sourcing cap still cannot pay the upstream price");
      break;
    }
    case "x402.refund": {
      if (state.refundedOrders.has(action.orderId)) hit("deny", "x402-refund-once", `Order ${action.orderId} was already refunded; a refund pays at most once`);
      if (!action.orderVerified) hit("deny", "x402-order-unverified", "Signed order does not verify against its payment; escalate instead of refunding");
      if (!action.dataWrong) hit("deny", "x402-refund-evidence", "The data delivered for this order was not judged wrong; the signed order shows the customer's agent placed it");
      if (cents(action.amount) > cents(action.charged)) hit("deny", "x402-refund-amount", "Refund exceeds what the order charged");
      if (cents(action.amount) > cents(action.supportRemaining)) hit("deny", "x402-support-budget", "Refund exceeds what is left of the support budget");
      break;
    }
    case "x402.move_earnings": {
      if (cents(action.amount) > cents(action.netEarnings)) hit("deny", "x402-earnings", "Amount exceeds net earnings recorded this run");
      if (cents(action.amount) > cents(action.treasuryRemaining)) hit("deny", "x402-treasury-budget", "Amount exceeds what is left of the treasury budget");
      break;
    }
    case "x402.pay_licence": {
      const f = config.licenceFee;
      hit("escalate", "x402-fiat-payout", "Fiat payout to the licensor requires approval bound to amount, currency, counterparty and invoice");
      if (action.currency !== f.currency || cents(action.amount) !== cents(f.amount) || action.beneficiaryId !== f.beneficiaryId || action.invoice !== f.invoice)
        hit("deny", "x402-invoice-binding", "Payout does not match the licence invoice held in code");
      if (state.paidInvoices.has(action.invoice)) hit("deny", "x402-invoice-paid", `Invoice ${action.invoice} is already paid`);
      break;
    }
  }
  if (!result.reasons.length) hit("allow", "within-policy", "Within the limits held in code");
  return result;
}
