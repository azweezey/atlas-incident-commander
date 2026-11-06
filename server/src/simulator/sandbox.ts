import { randomUUID } from "node:crypto";
import type { AirwallexConnector } from "../connectors/airwallex.js";
import { scenarios, type Incident } from "./scenarios.js";

/**
 * Real-sandbox incident setup for Airwallex. Creates small test-money transfers and
 * drives them with POST /api/v1/simulation/transfers/{id}/transition so the agent
 * diagnoses real provider objects instead of seeded mock data.
 */
export const sandboxAmounts = {
  duplicate: 12,
  "bad-beneficiary": 5,
  stuck: 7,
} as const;

export async function simulateSandbox(
  scenario: string,
  c: AirwallexConnector,
): Promise<Incident> {
  if (c.mode !== "sandbox") throw new Error("Sandbox simulation needs credentials");
  if (!scenarios.includes(scenario as any)) throw new Error("Unknown scenario");
  const id = randomUUID();
  const reference = "INV-" + id.slice(0, 8).toUpperCase();
  const create = async (beneficiaryId: string, amount: number) => {
    const p = await c.createPayout({
      beneficiaryId,
      amount,
      currency: "USD",
      reference,
      idempotencyKey: "original-" + id,
    });
    return c.waitForStatus(p.id, ["PROCESSING", "SENT", "PAID", "FAILED", "CANCELLED"]);
  };
  if (scenario === "duplicate") {
    const p = await create("vendor-acme", sandboxAmounts.duplicate);
    await c.simulateTransition(p.id, "SENT");
    const paid = await c.simulateTransition(p.id, "PAID");
    return {
      id,
      connector: c.name,
      scenario,
      title: "Duplicate invoice / retry storm",
      severity: "critical",
      status: "open",
      payout: paid,
    };
  }
  if (scenario === "bad-beneficiary") {
    const p = await create("vendor-bad", sandboxAmounts["bad-beneficiary"]);
    // Sandbox rejects PROCESSING -> FAILED (500 operation_failed); SENT -> FAILED works.
    if (p.providerStatus === "PROCESSING") await c.simulateTransition(p.id, "SENT");
    await c.simulateTransition(p.id, "FAILED", "INVALID_ACCOUNT_NAME_OR_NUMBER");
    const failed = await c.waitForStatus(p.id, ["FAILED", "CANCELLED"]);
    return {
      id,
      connector: c.name,
      scenario,
      title: "Failed payout: invalid beneficiary details",
      severity: "high",
      status: "open",
      payout: failed,
    };
  }
  if (scenario === "stuck") {
    // Left in PROCESSING on purpose: the sandbox does not advance it without a simulation call.
    const p = await create("vendor-acme", sandboxAmounts.stuck);
    return {
      id,
      connector: c.name,
      scenario,
      title: "Transfer stuck in PROCESSING (no confirmed outcome)",
      severity: "medium",
      status: "open",
      payout: p,
    };
  }
  return {
    id,
    connector: c.name,
    scenario,
    title: "Purchasing agent exceeded user intent",
    severity: "high",
    status: "open",
    intent: { merchantCategory: "office", maxBudget: 400, item: "office chair" },
  };
}
