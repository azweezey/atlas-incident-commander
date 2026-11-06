import { randomUUID } from "node:crypto";
import { MockConnector } from "../connectors/mock.js";
import type { Action, Intent, PolicyResult } from "../policy/engine.js";
import type { Payout } from "../connectors/types.js";
export interface Incident {
  id: string;
  connector: string;
  scenario: string;
  title: string;
  severity: "high" | "medium" | "critical";
  status:
    | "open"
    | "running"
    | "blocked"
    | "awaiting_approval"
    | "resolved"
    | "manual_review";
  payout?: Payout;
  intent?: Intent;
  diagnosis?: string;
  planner?: string;
  actions?: { action: Action; policy: PolicyResult; outcome?: string }[];
  /** How the incident was detected: manual simulation, polling fallback, or Airwallex webhook. */
  source?: "manual" | "poller" | "webhook";
  detectedAt?: string;
  providerEventId?: string;
  /** Untrusted free text attached to the incident (provider memo, vendor email). Data, never instructions. */
  notes?: string;
}
export const scenarios = [
  "duplicate",
  "bad-beneficiary",
  "stuck",
  "purchase",
] as const;
export function simulate(scenario: string, connector: MockConnector): Incident {
  if (connector.mode !== "mock")
    throw new Error("Simulation is available only in mock mode");
  if (!scenarios.includes(scenario as any)) throw new Error("Unknown scenario");
  const id = randomUUID();
  const p: Payout = {
    id: randomUUID(),
    beneficiaryId: "vendor-acme",
    amount: 1200,
    currency: "USD",
    reference: "INV-" + id.slice(0, 8),
    idempotencyKey: "original-" + id,
    createdAt: new Date().toISOString(),
    status: "succeeded",
  };
  const incident: Incident = {
    id,
    connector: connector.name,
    scenario,
    title: "Duplicate invoice / retry storm",
    severity: "critical",
    status: "open",
    payout: p,
  };
  if (scenario === "bad-beneficiary") {
    Object.assign(p, {
      beneficiaryId: "vendor-bad",
      amount: 250,
      status: "failed",
      failureReason: "Invalid account / routing number",
    });
    Object.assign(incident, {
      title: "Failed payout: invalid beneficiary details",
      severity: "high",
    });
  }
  if (scenario === "stuck") {
    Object.assign(p, {
      status: "pending",
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });
    Object.assign(incident, {
      title: "Transfer pending beyond the 24-hour SLA",
      severity: "medium",
    });
  }
  if (scenario === "purchase") {
    delete incident.payout;
    Object.assign(incident, {
      title: "Purchasing agent exceeded user intent",
      severity: "high",
      intent: {
        merchantCategory: "office",
        maxBudget: 400,
        item: "office chair",
      },
    });
  } else connector.seed(p);
  return incident;
}
