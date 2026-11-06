import { it, expect, vi, beforeEach, afterEach, describe } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { sign, verifySignature, eventObject, parseEvent } from "../src/live/webhook.js";
import { classifyTransfer, incidentFromTransfer } from "../src/live/detector.js";
import { TransferPoller } from "../src/live/poller.js";
import { Commander } from "../src/service.js";
import { createApp } from "../src/app.js";
import { AuditLog } from "../src/audit/log.js";
import { FakeAirwallex } from "./fakeAirwallex.js";
import type { Payout } from "../src/connectors/types.js";

const SECRET = "whsec_test_only_not_real";
const realFetch = globalThis.fetch; // local HTTP calls must bypass the stubbed Airwallex fetch
let dir: string;
let server: Server | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-live-"));
  vi.stubEnv("AUDIT_LOG_PATH", join(dir, "audit.jsonl"));
  for (const k of ["AIRWALLEX_CLIENT_ID", "AIRWALLEX_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "ANTHROPIC_API_KEY", "AIRWALLEX_WEBHOOK_SECRET", "ATLAS_AUTORUN"])
    vi.stubEnv(k, "");
  vi.stubEnv("CONNECTOR", "airwallex");
});
afterEach(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

// A transfer object shaped like GET /api/v1/transfers/{id} (recorded sandbox shape).
const transfer = (over: Record<string, unknown> = {}) => ({
  id: "11111111-2222-4333-8444-555555555555",
  request_id: "original-abc",
  beneficiary_id: "bene-real-uuid",
  transfer_amount: 3,
  transfer_currency: "USD",
  reference: "INV-LIVE01",
  status: "CANCELLED",
  failure: { code: "90101", details: { type: "INCORRECT_ROUTING" }, message: "Invalid account name/number" },
  created_at: "2026-10-28T01:10:00+0000",
  ...over,
});
const event = (name: string, data: unknown, id = "evt_" + Math.random().toString(36).slice(2)) =>
  JSON.stringify({ id, name, account_id: "acct_test", data, created_at: "2026-10-28T01:10:05+0000", version: "2025-06-30" });

async function start(c = new Commander()) {
  server = createApp(c).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server!.once("listening", r));
  const port = (server.address() as { port: number }).port;
  const post = (body: string, headers: Record<string, string>) =>
    realFetch(`http://127.0.0.1:${port}/webhooks/airwallex`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
  const signed = (body: string, ts = String(Date.now()), secret = SECRET) =>
    post(body, { "x-timestamp": ts, "x-signature": sign(secret, ts, body) });
  return { c, port, post, signed };
}
const settle = async (c: Commander, pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  await c.exclusive(async () => {});
};

describe("signature verification", () => {
  const body = event("payout.transfer.failed", transfer());
  const ts = "1761613805000";
  const now = Number(ts) + 1000;
  it("accepts a correct HMAC-SHA256(secret, x-timestamp + raw body)", () => {
    expect(verifySignature({ secret: SECRET, timestamp: ts, signature: sign(SECRET, ts, body), rawBody: body, now })).toEqual({ ok: true });
  });
  it("matches the documented construction exactly (hex digest, timestamp first)", async () => {
    const { createHmac } = await import("node:crypto");
    expect(sign(SECRET, ts, body)).toBe(createHmac("sha256", SECRET).update(ts + body).digest("hex"));
  });
  it("rejects a wrong secret, a tampered body, and re-serialized JSON", () => {
    const good = sign(SECRET, ts, body);
    expect(verifySignature({ secret: SECRET, timestamp: ts, signature: sign("other", ts, body), rawBody: body, now }).ok).toBe(false);
    expect(verifySignature({ secret: SECRET, timestamp: ts, signature: good, rawBody: body.replace('"transfer_amount":3', '"transfer_amount":3000'), now }).ok).toBe(false);
    expect(verifySignature({ secret: SECRET, timestamp: ts, signature: good, rawBody: JSON.stringify(JSON.parse(body), null, 2), now }).ok).toBe(false);
    expect(verifySignature({ secret: SECRET, timestamp: ts, signature: "zz", rawBody: body, now }).ok).toBe(false);
    expect(verifySignature({ secret: SECRET, timestamp: undefined, signature: good, rawBody: body, now }).ok).toBe(false);
  });
  it("rejects stale and far-future timestamps even with a valid signature", () => {
    const sig = sign(SECRET, ts, body);
    const stale = verifySignature({ secret: SECRET, timestamp: ts, signature: sig, rawBody: body, now: Number(ts) + 6 * 60 * 1000 });
    expect(stale).toMatchObject({ ok: false, status: 400 });
    expect(verifySignature({ secret: SECRET, timestamp: ts, signature: sig, rawBody: body, now: Number(ts) - 6 * 60 * 1000 }).ok).toBe(false);
  });
  it("fails closed with 503 when no secret is configured", () => {
    const r = verifySignature({ secret: "", timestamp: ts, signature: sign(SECRET, ts, body), rawBody: body, now });
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect((r as any).reason).toMatch(/AIRWALLEX_WEBHOOK_SECRET/);
  });
});

describe("event mapping", () => {
  it("reads the transfer from data (transfer events) or data.object (other resources)", () => {
    expect(eventObject(parseEvent(event("payout.transfer.failed", transfer()))).id).toBe(transfer().id);
    expect(eventObject(parseEvent(event("x.y", { object: { id: "nested" } }))).id).toBe("nested");
    expect(() => parseEvent('{"name":"x"}')).toThrow();
  });
  it("classifies polled transfers: failed, cancelled, stuck in PROCESSING past threshold", () => {
    const c = new Commander();
    const n = (o: Record<string, unknown>) => c.connectors.airwallex.normalize(transfer(o));
    const created = Date.parse("2026-10-28T01:10:00Z");
    expect(classifyTransfer(n({}), 120000, created)).toBe("failed"); // CANCELLED + failure object
    expect(classifyTransfer(n({ status: "FAILED" }), 120000, created)).toBe("failed");
    expect(classifyTransfer(n({ status: "CANCELLED", failure: undefined }), 120000, created)).toBe("cancelled");
    expect(classifyTransfer(n({ status: "PROCESSING", failure: undefined }), 120000, created + 60000)).toBeNull();
    expect(classifyTransfer(n({ status: "PROCESSING", failure: undefined }), 120000, created + 121000)).toBe("stuck");
    expect(classifyTransfer(n({ status: "PAID", failure: undefined }), 120000, created + 10 ** 7)).toBeNull();
  });
  it("maps detections to engine scenarios the planner understands", () => {
    const c = new Commander();
    const n = (o: Record<string, unknown>) => c.connectors.airwallex.normalize(transfer(o));
    expect(incidentFromTransfer(n({}), { kind: "cancelled", source: "webhook" }).scenario).toBe("bad-beneficiary");
    expect(incidentFromTransfer(n({ status: "FAILED", failure: { code: "x", details: { type: "COMPLIANCE_REJECTED" }, message: "Rejected" } }), { kind: "failed", source: "poller" }).scenario).toBe("transfer-failed");
    expect(incidentFromTransfer(n({ failure: undefined }), { kind: "cancelled", source: "poller" }).scenario).toBe("transfer-cancelled");
    expect(incidentFromTransfer(n({ status: "PROCESSING", failure: undefined }), { kind: "stuck", source: "poller" }).scenario).toBe("stuck");
  });
});

describe("webhook endpoint", () => {
  it("returns 503 and creates nothing when AIRWALLEX_WEBHOOK_SECRET is missing", async () => {
    const { c, signed } = await start();
    const r = await signed(event("payout.transfer.failed", transfer()));
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/AIRWALLEX_WEBHOOK_SECRET/);
    expect(c.incidents).toHaveLength(0);
  });
  it("a locally signed payout.transfer.failed event becomes an incident that runs policy, escalates and audits", async () => {
    vi.stubEnv("AIRWALLEX_WEBHOOK_SECRET", SECRET);
    const { c, signed } = await start();
    const r = await signed(event("payout.transfer.failed", transfer(), "evt_1"));
    expect(r.status).toBe(200);
    await settle(c, () => c.incidents[0]?.status === "awaiting_approval");
    const i = c.incidents[0];
    expect(c.incidents).toHaveLength(1);
    expect(i).toMatchObject({ source: "webhook", scenario: "bad-beneficiary", status: "awaiting_approval", providerEventId: "evt_1" });
    expect(i.actions?.[0]).toMatchObject({ action: { type: "repair" }, policy: { decision: "escalate" } });
    expect(c.queue.items).toHaveLength(1);
    const events = c.audit.entries().map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(["webhook.received", "incident.detected", "agent.planned", "policy.evaluated", "approval.queued"]));
    expect(c.audit.verify().valid).toBe(true);
  });
  it("rejects bad and stale signatures with 400", async () => {
    vi.stubEnv("AIRWALLEX_WEBHOOK_SECRET", SECRET);
    const { c, signed, post } = await start();
    const body = event("payout.transfer.failed", transfer());
    expect((await signed(body, String(Date.now()), "wrong-secret")).status).toBe(400);
    expect((await signed(body, String(Date.now() - 10 * 60 * 1000))).status).toBe(400);
    expect((await post(body, {})).status).toBe(400);
    expect(c.incidents).toHaveLength(0);
  });
  it("dedupes by event id (Airwallex retries) and by transfer id (failed then cancelled)", async () => {
    vi.stubEnv("AIRWALLEX_WEBHOOK_SECRET", SECRET);
    const { c, signed } = await start();
    const body = event("payout.transfer.failed", transfer({ status: "FAILED" }), "evt_dup");
    expect((await signed(body)).status).toBe(200);
    const again = await signed(body);
    expect(await again.json()).toMatchObject({ duplicate: true });
    await signed(event("payout.transfer.cancelled", transfer(), "evt_2"));
    await settle(c, () => c.audit.entries().filter((e) => e.event === "webhook.received").length === 2);
    expect(c.incidents).toHaveLength(1);
    expect(c.audit.entries().filter((e) => e.event === "webhook.received")).toHaveLength(2);
    expect(c.audit.entries().some((e) => e.event === "transfer.status_observed" && (e.data as any).providerStatus === "CANCELLED")).toBe(true);
  });
  it("remembers accepted event ids and incident transfers across restarts via the audit log", async () => {
    vi.stubEnv("AIRWALLEX_WEBHOOK_SECRET", SECRET);
    const first = await start();
    const body = event("payout.transfer.failed", transfer(), "evt_restart");
    await first.signed(body);
    await settle(first.c, () => first.c.incidents.length === 1);
    const c2 = new Commander(new AuditLog());
    expect(c2.seenEvents.has("evt_restart")).toBe(true);
    expect(c2.knownTransfers.has(transfer().id)).toBe(true);
    const r = await c2.ingestTransfer(c2.connectors.airwallex.normalize(transfer()), { kind: "failed", source: "poller" });
    expect(r.created).toBe(false);
  });
  it("streams audit entries to the dashboard over SSE", async () => {
    vi.stubEnv("AIRWALLEX_WEBHOOK_SECRET", SECRET);
    const { port, signed } = await start();
    const ctrl = new AbortController();
    const res = await realFetch(`http://127.0.0.1:${port}/api/events`, { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    await signed(event("payout.transfer.failed", transfer()));
    let text = "";
    const end = Date.now() + 3000;
    while (!/approval\.queued/.test(text) && Date.now() < end) text += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    expect(text).toMatch(/event: hello/);
    expect(text).toMatch(/"event":"incident\.detected"/);
    expect(text).toMatch(/"event":"approval\.queued"/);
  });
});

describe("polling fallback (fake sandbox, no network)", () => {
  let fake: FakeAirwallex;
  beforeEach(() => {
    vi.stubEnv("AIRWALLEX_CLIENT_ID", "test-id");
    vi.stubEnv("AIRWALLEX_API_KEY", "test-key");
    vi.stubEnv("AIRWALLEX_BASE_URL", "https://airwallex.invalid");
    fake = new FakeAirwallex();
    vi.stubGlobal("fetch", fake.fetch);
  });
  it("creates incidents for failed and stuck transfers on its own, once each, and ignores healthy ones", async () => {
    const c = new Commander();
    const aw = c.connectors.airwallex;
    const bad = await aw.createPayout({ beneficiaryId: "vendor-bad", amount: 3, currency: "USD", reference: "INV-P1", idempotencyKey: "p1" });
    await aw.waitForStatus(bad.id, ["PROCESSING"], 1000, 1);
    await aw.simulateTransition(bad.id, "SENT");
    await aw.simulateTransition(bad.id, "FAILED", "INVALID_ACCOUNT_NAME_OR_NUMBER");
    const stuck = await aw.createPayout({ beneficiaryId: "vendor-acme", amount: 2, currency: "USD", reference: "INV-P2", idempotencyKey: "p2" });
    await aw.waitForStatus(stuck.id, ["PROCESSING"], 1000, 1);
    const ok = await aw.createPayout({ beneficiaryId: "vendor-acme", amount: 1, currency: "USD", reference: "INV-P3", idempotencyKey: "p3" });
    await aw.simulateTransition((await aw.waitForStatus(ok.id, ["PROCESSING"], 1000, 1)).id, "SENT");
    const created = Date.parse(fake.transfers.get(stuck.id).created_at); // fake stamps creation time "now"
    const poller = new TransferPoller(c, aw, { intervalMs: 1000, stuckMs: 120000, lookbackMs: 3600000 });
    await poller.tick(created + 30000); // stuck not yet past threshold
    expect(c.incidents.map((i) => i.payout?.id)).toEqual([bad.id]);
    await poller.tick(created + 130000);
    await poller.tick(created + 140000); // repeated polls: no duplicates
    expect(c.incidents).toHaveLength(2);
    const byId = Object.fromEntries(c.incidents.map((i) => [i.payout!.id, i]));
    expect(byId[bad.id]).toMatchObject({ source: "poller", scenario: "bad-beneficiary", status: "awaiting_approval" });
    expect(byId[stuck.id]).toMatchObject({ source: "poller", scenario: "stuck", status: "manual_review" });
    expect(byId[ok.id]).toBeUndefined();
    expect(fake.calls.some((x) => x.includes("from_created_at="))).toBe(true);
    expect(fake.creates).toBe(3); // the agent never created a replacement payment
  });
  it("a webhook and the poller seeing the same transfer produce one incident", async () => {
    vi.stubEnv("AIRWALLEX_WEBHOOK_SECRET", SECRET);
    const { c, signed } = await start();
    const aw = c.connectors.airwallex;
    const bad = await aw.createPayout({ beneficiaryId: "vendor-bad", amount: 3, currency: "USD", reference: "INV-P4", idempotencyKey: "p4" });
    await aw.waitForStatus(bad.id, ["PROCESSING"], 1000, 1);
    await aw.simulateTransition(bad.id, "SENT");
    await aw.simulateTransition(bad.id, "FAILED", "INVALID_ACCOUNT_NAME_OR_NUMBER");
    const raw = fake.transfers.get(bad.id);
    await signed(event("payout.transfer.failed", raw, "evt_w1"));
    await settle(c, () => c.incidents.length === 1);
    await new TransferPoller(c, aw, { intervalMs: 1000, stuckMs: 120000, lookbackMs: 3600000 }).tick(Date.parse("2026-10-28T00:53:00Z"));
    expect(c.incidents).toHaveLength(1);
    expect(c.incidents[0].source).toBe("webhook");
  });
  it("manual sandbox simulations are not re-opened by the poller", async () => {
    const c = new Commander();
    await c.exclusive(() => c.simulate("bad-beneficiary"));
    await new TransferPoller(c, c.connectors.airwallex, { intervalMs: 1000, stuckMs: 120000, lookbackMs: 3600000 }).tick(Date.parse("2026-10-28T00:53:00Z"));
    expect(c.incidents).toHaveLength(1);
    expect(c.incidents[0].source).toBe("manual");
  });
});
