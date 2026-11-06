import { z } from "zod";
import type { Payout } from "../connectors/types.js";
import { policyConfig } from "./config.js";
export const actionSchema = z
  .object({
    type: z.enum(["create", "retry", "purchase", "inspect", "repair"]),
    beneficiaryId: z.string().min(1),
    amount: z.number().positive().finite(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    reference: z.string().min(1),
    idempotencyKey: z.string().min(1),
    payoutId: z.string().optional(),
    merchantCategory: z.string().optional(),
    item: z.string().optional(),
  })
  .strict();
export type Action = z.infer<typeof actionSchema>;
export interface Intent {
  merchantCategory: string;
  maxBudget: number;
  item: string;
}
export interface PolicyResult {
  decision: "allow" | "escalate" | "deny";
  reasons: string[];
  ruleHits: string[];
}
export function evaluate(
  action: Action,
  history: Payout[],
  intent?: Intent,
  config = policyConfig,
  now = Date.now(),
): PolicyResult {
  const result: PolicyResult = { decision: "allow", reasons: [], ruleHits: [] };
  const hit = (
    decision: PolicyResult["decision"],
    rule: string,
    reason: string,
  ) => {
    result.ruleHits.push(rule);
    result.reasons.push(reason);
    if (
      decision === "deny" ||
      (decision === "escalate" && result.decision === "allow")
    )
      result.decision = decision;
  };
  if (!actionSchema.safeParse(action).success) {
    hit("deny", "invalid-action", "Action failed schema validation");
    return result;
  }
  if (action.type === "inspect") {
    hit("allow", "read-only", "Read-only reconciliation; no funds move");
    return result;
  }
  if (action.type === "repair") {
    hit(
      "escalate",
      "verified-details",
      "Beneficiary details require independent verification; approval records a manual task only",
    );
    return result;
  }
  if (action.currency !== config.currency)
    hit(
      "deny",
      "currency",
      "No FX conversion configured; only USD is supported for spending decisions",
    );
  if (!config.allowedBeneficiaries.includes(action.beneficiaryId))
    hit("deny", "allowlist", "Beneficiary is not on the approved allowlist");
  if (action.amount > config.hardCap)
    hit("deny", "hard-cap", "Amount exceeds the hard cap");
  else if (action.amount > config.approvalLimit)
    hit(
      "deny",
      "approval-ceiling",
      "Amount exceeds the human approval ceiling",
    );
  else if (action.amount >= config.autoLimit)
    hit(
      "escalate",
      "spend-limit",
      "Irreversible money movement requires human approval at or above the automatic limit",
    );
  if (
    history.some(
      (p) =>
        p.idempotencyKey === action.idempotencyKey && p.status === "succeeded",
    )
  )
    hit("deny", "completed-key", "Completed idempotency key cannot be reused");
  if (
    history.some(
      (p) =>
        p.idempotencyKey === action.idempotencyKey && p.status === "pending",
    )
  )
    hit(
      "deny",
      "reserved-key",
      "Idempotency key is pending or execution outcome is uncertain",
    );
  if (
    history.some(
      (p) =>
        p.beneficiaryId === action.beneficiaryId &&
        p.amount === action.amount &&
        p.currency === action.currency &&
        p.reference.trim().toLowerCase() ===
          action.reference.trim().toLowerCase() &&
        ["succeeded", "pending"].includes(p.status) &&
        now - Date.parse(p.createdAt) <= config.windowMs,
    )
  )
    hit(
      "deny",
      "duplicate-invoice",
      "Same beneficiary, amount, currency and reference already paid or pending within 24 hours",
    );
  if (action.type === "retry") {
    const target = history.find((p) => p.id === action.payoutId);
    if (!target || target.status !== "failed")
      hit(
        "deny",
        "retry-status",
        "Only a confirmed failed payout may be retried; succeeded or pending payouts must not be paid again",
      );
    else if (
      target.beneficiaryId !== action.beneficiaryId ||
      target.amount !== action.amount ||
      target.currency !== action.currency ||
      target.reference !== action.reference
    )
      hit("deny", "retry-binding", "Retry must match the original payout");
  }
  if (action.type === "purchase") {
    if (!intent)
      hit(
        "deny",
        "intent-missing",
        "A purchase requires a user-authored intent",
      );
    else {
      if (
        action.merchantCategory !== intent.merchantCategory ||
        action.item !== intent.item
      )
        hit(
          "deny",
          "intent-mismatch",
          "Merchant category or item does not match the user intent",
        );
      if (action.amount > intent.maxBudget)
        hit("deny", "intent-budget", "Purchase exceeds the user intent budget");
    }
  }
  if (!result.reasons.length)
    hit(
      "allow",
      "within-policy",
      "Allowlisted payment is within limits and has no duplicate",
    );
  return result;
}
