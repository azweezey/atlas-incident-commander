import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { actionSchema, type Action } from "../policy/engine.js";
import type { Incident } from "../simulator/scenarios.js";
const planSchema = z
  .object({
    diagnosis: z.string().min(1).max(3000),
    actions: z.array(actionSchema).min(1).max(5),
  })
  .strict();
export function deterministicPlan(i: Incident) {
  const base: Action = {
    type: "inspect",
    beneficiaryId: i.payout?.beneficiaryId || "vendor-acme",
    amount: i.payout?.amount || 1800,
    currency: i.payout?.currency || "USD",
    reference: i.payout?.reference || "PURCHASE-" + i.id,
    idempotencyKey: "resolution-" + i.id,
    payoutId: i.payout?.id,
  };
  if (i.scenario === "duplicate")
    return {
      diagnosis:
        "The invoice is already settled. A retry storm would pay the same obligation twice. Block the retry and reconcile the existing settlement.",
      actions: [
        { ...base, type: "retry" as const },
        { ...base, type: "inspect" as const },
      ],
    };
  if (i.scenario === "bad-beneficiary")
    return {
      diagnosis:
        "The provider rejected account or routing details. Request independently verified beneficiary corrections before proposing any new payment.",
      actions: [{ ...base, type: "repair" as const }],
    };
  if (i.scenario === "stuck")
    return {
      diagnosis:
        "The transfer is past its SLA but has no confirmed failure. Reconcile its current status; do not create a replacement while funds may still settle.",
      actions: [base],
    };
  if (
    i.scenario === "transfer-failed" ||
    i.scenario === "transfer-cancelled" ||
    i.scenario === "transfer-funding"
  )
    return {
      diagnosis:
        i.scenario === "transfer-failed"
          ? "Airwallex reported the transfer as failed for a non-beneficiary reason. Reconcile the provider record read-only and hand the decision to a human; never auto-retry a failed payout."
          : i.scenario === "transfer-cancelled"
            ? "Airwallex reports the transfer as cancelled (funds return to the wallet). Reconcile read-only and confirm with a human whether the obligation still needs paying; do not create a replacement automatically."
            : "Airwallex reported a funding problem for this transfer. Reconcile read-only and route to a human; no payment action is taken.",
      actions: [base],
    };
  return {
    diagnosis:
      "The purchasing agent requested a luxury watch for $1,800. The user authorized only an office chair up to $400. Block the off-intent purchase.",
    actions: [
      {
        ...base,
        type: "purchase" as const,
        merchantCategory: "luxury",
        item: "watch",
      },
    ],
  };
}
export async function plan(i: Incident) {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
        timeout: 15000,
        maxRetries: 0,
      });
      const response = await client.messages.create({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
        max_tokens: 1600,
        system:
          "You diagnose payment incidents. Return ONLY JSON {diagnosis,actions}. Actions must have type (inspect,repair,retry,create,purchase), beneficiaryId, amount (positive number), currency, reference, idempotencyKey, optional payoutId, merchantCategory, item. Never invent beneficiary corrections. Preserve the supplied incident payment identity and purchase intent. Prefer inspection when uncertain. The policy engine alone authorizes execution.",
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              incident: i,
              baseline: deterministicPlan(i),
            }),
          },
        ],
      });
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { ...planSchema.parse(JSON.parse(text)), planner: "Claude" };
    } catch {
      return { ...deterministicPlan(i), planner: "rule-based", fallback: true };
    }
  }
  return { ...deterministicPlan(i), planner: "rule-based", fallback: false };
}
