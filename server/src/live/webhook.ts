import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Airwallex webhook signature verification, per
 * https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events
 *   value_to_digest = x-timestamp (string, exactly as received) + raw JSON body (unparsed)
 *   x-signature     = hex(HMAC-SHA256(key = notification URL secret, message = value_to_digest))
 *   x-timestamp     = Unix time in MILLISECONDS
 * The docs leave the freshness window to the receiver; we default to 5 minutes.
 */
export type VerifyResult =
  | { ok: true }
  | { ok: false; status: number; reason: string };

export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

export function sign(secret: string, timestamp: string, rawBody: string | Buffer) {
  return createHmac("sha256", secret)
    .update(timestamp)
    .update(rawBody)
    .digest("hex");
}

export function verifySignature(opts: {
  secret: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: Buffer | string;
  now?: number;
  toleranceMs?: number;
}): VerifyResult {
  const { secret, timestamp, signature, rawBody } = opts;
  if (!secret)
    return {
      ok: false,
      status: 503,
      reason:
        "Webhook secret not configured: set AIRWALLEX_WEBHOOK_SECRET. Refusing all webhook events (fail closed).",
    };
  if (!timestamp || !signature)
    return { ok: false, status: 400, reason: "Missing x-timestamp or x-signature header" };
  if (!/^\d{10,16}$/.test(timestamp))
    return { ok: false, status: 400, reason: "Malformed x-timestamp" };
  if (!/^[0-9a-f]{64}$/i.test(signature))
    return { ok: false, status: 400, reason: "Invalid signature" };
  const expected = Buffer.from(sign(secret, timestamp, rawBody), "hex");
  const given = Buffer.from(signature, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return { ok: false, status: 400, reason: "Invalid signature" };
  // Signature first, then freshness (the order the docs describe).
  const tolerance = opts.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const age = (opts.now ?? Date.now()) - Number(timestamp);
  if (Math.abs(age) > tolerance)
    return { ok: false, status: 400, reason: "Stale or future x-timestamp (outside tolerance)" };
  return { ok: true };
}

export interface AirwallexEvent {
  id: string;
  name: string;
  account_id?: string;
  data: any;
  created_at?: string;
  version?: string;
}

export function parseEvent(rawBody: Buffer | string): AirwallexEvent {
  const e = JSON.parse(rawBody.toString());
  if (!e || typeof e.id !== "string" || !e.id || typeof e.name !== "string")
    throw new Error("Event is missing id or name");
  return e;
}

/** For payout.transfer.* events `data` is the transfer (same as GET /transfers/{id}); other resources nest it under data.object. */
export function eventObject(e: AirwallexEvent): any {
  const d = e.data || {};
  return d.object && typeof d.object === "object" ? d.object : d;
}

/** Transfer events that open an incident. All other payout.transfer.* events are recorded as status observations. */
export const INCIDENT_EVENTS = {
  "payout.transfer.failed": "failed",
  "payout.transfer.cancelled": "cancelled",
  "payout.transfer.overdue": "overdue",
  "payout.transfer.funding.failed": "funding-failed",
  "payout.transfer.funding.reversed": "funding-failed",
} as const;

/** Events to subscribe to when registering the webhook. */
export const SUBSCRIBED_EVENTS = [
  ...Object.keys(INCIDENT_EVENTS),
  "payout.transfer.processing",
  "payout.transfer.sent",
  "payout.transfer.paid",
];
