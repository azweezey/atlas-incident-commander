import { randomUUID } from "node:crypto";
import type { Payout } from "../connectors/types.js";
import type { Incident } from "../simulator/scenarios.js";

export type DetectionKind = "failed" | "cancelled" | "stuck" | "overdue" | "funding-failed";
export interface Detection {
  kind: DetectionKind;
  source: "webhook" | "poller";
  eventId?: string;
  eventName?: string;
}

const BENEFICIARY_FAILURE =
  /ROUTING|ACCOUNT|BENEFICIARY|BANK|IBAN|SWIFT|NAME_MISMATCH/i;

export function beneficiaryFailure(p: Payout) {
  return BENEFICIARY_FAILURE.test([p.failureCode, p.failureReason].filter(Boolean).join(" "));
}

/** What the poller treats as an incident: FAILED, CANCELLED, or PROCESSING longer than stuckMs. */
export function classifyTransfer(p: Payout, stuckMs: number, now = Date.now()): DetectionKind | null {
  if (p.status === "failed") return "failed";
  if (p.status === "cancelled") return "cancelled";
  if (p.providerStatus === "PROCESSING" && now - Date.parse(p.createdAt) >= stuckMs) return "stuck";
  return null;
}

export function incidentFromTransfer(p: Payout, d: Detection): Incident {
  // A cancel that carries a failure object is a failure (sandbox auto-cancels failed transfers).
  const kind = d.kind === "cancelled" && p.status === "failed" ? "failed" : d.kind;
  const base = {
    id: randomUUID(),
    connector: "airwallex",
    status: "open" as const,
    payout: p,
    source: d.source,
    detectedAt: new Date().toISOString(),
    ...(d.eventId ? { providerEventId: d.eventId } : {}),
  };
  const amt = `${p.currency} ${p.amount}`;
  if (kind === "failed" && beneficiaryFailure(p))
    return { ...base, scenario: "bad-beneficiary", severity: "high",
      title: `Failed payout (${amt}): invalid beneficiary details` };
  if (kind === "failed")
    return { ...base, scenario: "transfer-failed", severity: "high",
      title: `Failed payout (${amt}): ${p.failureCode || p.failureReason || "provider failure"}` };
  if (kind === "cancelled")
    return { ...base, scenario: "transfer-cancelled", severity: "medium",
      title: `Payout cancelled (${amt})` };
  if (kind === "stuck")
    return { ...base, scenario: "stuck", severity: "medium",
      title: `Transfer stuck in PROCESSING (${amt}, no confirmed outcome)` };
  return { ...base, scenario: "transfer-funding", severity: "high",
    title: `Payout funding problem (${amt}): ${d.eventName || kind}` };
}
