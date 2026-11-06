/**
 * Live-detection proof against the REAL Airwallex sandbox (test money only), using POLLING
 * (no webhook subscription needed). Appends a section to docs/SANDBOX_RUN_LOG.md.
 *   npm run live:proof -w server
 *
 * 1. Starts the real server (createApp + TransferPoller) on a random local port and subscribes to /api/events (SSE).
 * 2. Creates a $3 transfer to the invalid-details test contact and fails it with the sandbox simulation endpoint.
 *    Creates a $2 transfer and leaves it in PROCESSING (stuck threshold 30s for this run).
 * 3. Does NOT call any ingest/simulate API: incidents must appear on their own via the poller.
 * 4. Waits for both incidents to be detected, planned, policy-checked, escalated / reconciled and audited.
 * 5. Approves the escalated repair (a manual verification task; no money moves) to show the approval path.
 * 6. Sends a LOCALLY SIGNED webhook (throwaway secret generated in-process, not an Airwallex secret) carrying the
 *    real failed transfer to prove webhook + poller dedupe on a real object. Then moves the stuck transfer to PAID
 *    and shows the status change is observed on the existing incident (no new incident).
 * Credentials come from ../.env and are never printed.
 */
import dotenv from "dotenv";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
dotenv.config({ path: [".env", "../.env"], quiet: true } as any);
if (!process.env.AIRWALLEX_CLIENT_ID || !process.env.AIRWALLEX_API_KEY) {
  console.error("Set AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY in .env first.");
  process.exit(1);
}
process.env.AUDIT_LOG_PATH = join(mkdtempSync(join(tmpdir(), "atlas-live-")), "audit.jsonl");
process.env.CONNECTOR = "airwallex";
process.env.AIRWALLEX_WEBHOOK_SECRET = "local-proof-" + randomBytes(16).toString("hex"); // throwaway, in-memory only
delete process.env.ANTHROPIC_API_KEY;
const { Commander } = await import("../src/service.js");
const { createApp } = await import("../src/app.js");
const { TransferPoller } = await import("../src/live/poller.js");
const { sign } = await import("../src/live/webhook.js");
type Rec = import("../src/connectors/airwallex.js").ApiCallRecord;

const c = new Commander();
const aw = c.connectors.airwallex;
const calls: (Rec & { at: string })[] = [];
aw.onCall = (r) => calls.push({ ...r, at: new Date().toISOString() });
const poller = new TransferPoller(c, aw, { intervalMs: 5000, stuckMs: 30000, lookbackMs: 3 * 60 * 1000 });
const server = createApp(c, { poller }).listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const port = (server.address() as { port: number }).port;
const az = (iso = new Date().toISOString()) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/Phoenix", hour: "numeric", minute: "2-digit", second: "2-digit" });

// SSE subscriber = what the dashboard sees
const sse: { at: string; event: string; incidentId?: string }[] = [];
const ctrl = new AbortController();
(async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    let k;
    while ((k = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, k);
      buf = buf.slice(k + 2);
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      if (block.includes("event: audit") && data) {
        const d = JSON.parse(data.slice(6));
        sse.push({ at: d.timestamp, event: d.event, incidentId: d.incidentId });
      }
    }
  }
})().catch(() => {});

const tag = randomUUID().slice(0, 8).toUpperCase();
const t0 = new Date().toISOString();
console.log("creating test transfers…");
const bad = await aw.createPayout({ beneficiaryId: "vendor-bad", amount: 3, currency: "USD", reference: "LIVE-" + tag + "-F", idempotencyKey: "live-fail-" + tag });
let b = await aw.waitForStatus(bad.id, ["PROCESSING", "SENT", "FAILED", "CANCELLED"]);
if (b.providerStatus === "PROCESSING") await aw.simulateTransition(bad.id, "SENT");
await aw.simulateTransition(bad.id, "FAILED", "INVALID_ACCOUNT_NAME_OR_NUMBER");
b = await aw.waitForStatus(bad.id, ["FAILED", "CANCELLED"]);
const stuck = await aw.createPayout({ beneficiaryId: "vendor-acme", amount: 2, currency: "USD", reference: "LIVE-" + tag + "-S", idempotencyKey: "live-stuck-" + tag });
const s = await aw.waitForStatus(stuck.id, ["PROCESSING"]);
const tCreated = new Date().toISOString();
console.log("transfers ready; starting poller (no manual ingest)…");
poller.start();

const until = async (pred: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
  return pred();
};
const inc = (id: string) => c.incidents.find((i) => i.payout?.id === id);
const okFail = await until(() => inc(bad.id)?.status === "awaiting_approval", 60000);
const okStuck = await until(() => inc(stuck.id)?.status === "manual_review", 90000);
poller.stop();
const fi = inc(bad.id), si = inc(stuck.id);
const detectedAt = (id?: string) => c.audit.entries().find((e) => e.event === "incident.detected" && (e.data as any).incident.id === id)?.timestamp;

// Approval path for the escalated repair (manual verification task only).
const appr = c.queue.items.find((a) => a.incidentId === fi?.id);
const decision = appr ? await c.exclusive(() => c.decide(appr.id, true, "Live proof operator", "Verified by phone with vendor (demo)")) : undefined;

// Webhook + poller dedupe on the real failed transfer object.
const raw = await aw.api("GET", "/api/v1/transfers/" + bad.id);
const body = JSON.stringify({ id: "evt_local_" + tag, name: "payout.transfer.failed", account_id: "local-proof", data: raw, created_at: new Date().toISOString(), version: "2025-06-30" });
const ts = String(Date.now());
const wr = await fetch(`http://127.0.0.1:${port}/webhooks/airwallex`, { method: "POST", headers: { "Content-Type": "application/json", "x-timestamp": ts, "x-signature": sign(process.env.AIRWALLEX_WEBHOOK_SECRET!, ts, body) }, body });
const wr2 = await fetch(`http://127.0.0.1:${port}/webhooks/airwallex`, { method: "POST", headers: { "Content-Type": "application/json", "x-timestamp": ts, "x-signature": "0".repeat(64) }, body });
await new Promise((r) => setTimeout(r, 1000));
await c.exclusive(async () => {});

// Stuck transfer later settles: observed on the existing incident, no new incident.
await aw.simulateTransition(stuck.id, "SENT");
await aw.simulateTransition(stuck.id, "PAID");
await poller.tick();
await c.exclusive(async () => {});
ctrl.abort();
server.closeAllConnections?.();
server.close();

const incidentsForOurTransfers = c.incidents.filter((i) => [bad.id, stuck.id].includes(i.payout?.id || ""));
const audit = c.audit.entries();
const listCalls = calls.filter((r) => r.path === "/api/v1/transfers" && r.method === "GET");
const pass = okFail && okStuck && incidentsForOurTransfers.length === 2 && wr.status === 200 && wr2.status === 400 && c.audit.verify().valid;
const actions = (i?: typeof fi) => (i?.actions || []).map((a) => `${a.action.type} => ${a.policy.decision} (${a.policy.ruleHits.join(", ")}): ${a.outcome}`).join("; ");
const md = [
  "",
  "## Live detection proof (polling, no webhook subscription)",
  "",
  `Run: ${new Date(t0).toLocaleString("en-US", { timeZone: "America/Phoenix", dateStyle: "medium", timeStyle: "short" })} AZ (MST), real sandbox, test money only. Generated by \`npm run live:proof -w server\` (server/scripts/live-proof.ts). Poller every 5s, stuck threshold 30s, lookback 3 min. The script never called simulate/ingest: incidents came from the poller reading \`GET /api/v1/transfers?from_created_at=…\`.`,
  "",
  `**Result: ${pass ? "PASS" : "FAIL"}**`,
  "",
  "| Transfer | Setup (sandbox) | Airwallex status seen | Incident (auto-detected) | Agent + policy | Final |",
  "| --- | --- | --- | --- | --- | --- |",
  `| \`${bad.id}\` ($3) | created to atlas-vendor-bad, simulated SENT -> FAILED (INVALID_ACCOUNT_NAME_OR_NUMBER) | ${b.providerStatus}${b.failureCode ? " / " + b.failureCode : ""}${b.failureReason ? ": " + b.failureReason : ""} | ${fi ? `${fi.title} (source=${fi.source}, scenario=${fi.scenario}) at ${az(detectedAt(fi.id))}` : "NOT DETECTED"} | ${actions(fi)} | ${fi?.status} |`,
  `| \`${stuck.id}\` ($2) | created to atlas-vendor-acme, left in PROCESSING | ${s.providerStatus} | ${si ? `${si.title} (source=${si.source}) at ${az(detectedAt(si.id))}` : "NOT DETECTED"} | ${actions(si)} | ${si?.status} |`,
  "",
  `- Transfers ready at ${az(tCreated)} AZ; the poller made ${listCalls.length} list calls (${[...new Set(listCalls.map((r) => r.status))].join("/")}).`,
  `- Approval: repair for the failed transfer approved by "Live proof operator" -> ${decision?.status}: ${decision?.outcome}.`,
  `- Locally signed webhook (throwaway in-process secret, NOT from Airwallex) carrying the real failed transfer: HTTP ${wr.status}; incidents for that transfer afterwards: ${c.incidents.filter((i) => i.payout?.id === bad.id).length} (deduped with the poller). Same body with a bad signature: HTTP ${wr2.status}.`,
  `- Stuck transfer then simulated SENT -> PAID: recorded as \`transfer.status_observed\` (${audit.filter((e) => e.event === "transfer.status_observed" && (e.data as any).transferId === stuck.id).map((e) => (e.data as any).providerStatus).join(", ") || "none"}) on the existing incident; total incidents for these two transfers: ${incidentsForOurTransfers.length}.`,
  `- Dashboard stream (SSE /api/events) delivered ${sse.length} live audit messages, including: ${[...new Set(sse.map((x) => x.event))].join(", ")}.`,
  `- Audit chain: ${c.audit.verify().valid ? "valid" : "BROKEN"}, ${audit.length} entries. Audit events: ${[...new Set(audit.map((e) => e.event))].join(", ")}.`,
  "",
  "Airwallex calls (excluding repeated poller list calls):",
  "",
  "| Time (AZ) | Call | HTTP | Airwallex code / object status | id |",
  "| --- | --- | --- | --- | --- |",
  ...calls
    .filter((r, i, all) => !(r.path === "/api/v1/transfers" && r.method === "GET" && all[i - 1]?.path === r.path && all[i - 1]?.method === "GET"))
    .map((r) => `| ${az(r.at)} | \`${r.method} ${r.path}\` | ${r.status} | ${[r.code, r.objectStatus].filter(Boolean).join(" / ") || "-"} | ${r.id ? "`" + r.id + "`" : "-"} |`),
  "",
];
appendFileSync(resolve("../docs/SANDBOX_RUN_LOG.md"), md.join("\n"));
console.log(md.slice(0, 16).join("\n"));
console.log(pass ? "LIVE PROOF PASS" : "LIVE PROOF FAIL");
process.exit(pass ? 0 : 1);
