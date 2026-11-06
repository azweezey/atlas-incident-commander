import { it, expect, describe, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { evaluateX402, type X402State } from "../src/policy/x402.js";
import { SimMetalConnector } from "../src/x402/metalSim.js";
import { MockTreasury } from "../src/x402/treasury.js";
import { X402Scenario } from "../src/x402/scenario.js";
import { kit11Config } from "../src/x402/config.js";
import { Commander } from "../src/service.js";
import { createApp } from "../src/app.js";
import { parseLines } from "../src/x402/metalTestnet.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-x402-"));
  vi.stubEnv("AUDIT_LOG_PATH", join(dir, "audit.jsonl"));
  for (const k of ["AIRWALLEX_CLIENT_ID", "AIRWALLEX_API_KEY", "ANTHROPIC_API_KEY", "METAL_RPC_URL"]) vi.stubEnv(k, "");
  vi.stubEnv("METAL_MODE", "simulation");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const fresh = (): X402State => ({ refundedOrders: new Set(), paidInvoices: new Set() });
const L = (s: number, su: number, t: number, sc = 0.03) => ({ sourcing: { budget: s, cap: sc }, support: { budget: su, cap: 0.1 }, treasury: { budget: t, cap: 1 } });

describe("Kit 11 policy", () => {
  it("allows the configured mandates and denies budgets above the 20 total", () => {
    expect(evaluateX402({ type: "x402.issue_mandates", idempotencyKey: "a", limits: L(10, 4, 6) }, fresh()).decision).toBe("allow");
    const r = evaluateX402({ type: "x402.issue_mandates", idempotencyKey: "a", limits: L(11, 4, 6) }, fresh());
    expect(r.decision).toBe("deny");
    expect(r.ruleHits).toContain("x402-total-budget");
  });
  const replace = (to: any, spent = { sourcing: 0.1, support: 0, treasury: 0 }, price = 0.06) =>
    evaluateX402({ type: "x402.replace_mandates", idempotencyKey: "r", from: L(10, 4, 6), to, spent, queryPriceFrom: 0.05, queryPriceTo: price, upstreamPrice: 0.04, rationale: "" }, fresh());
  it("always escalates a mandate replacement to a human", () => {
    const r = replace(L(11, 3, 6, 0.04));
    expect(r.decision).toBe("escalate");
    expect(r.ruleHits).toContain("x402-mandate-change");
  });
  it("denies replacements that break the total, spend carry-over, or the margin", () => {
    expect(replace(L(12, 3, 6, 0.04)).ruleHits).toContain("x402-total-budget");
    expect(replace(L(11, 3, 6, 0.04), { sourcing: 0.1, support: 3, treasury: 0 }).ruleHits).toContain("x402-replacement-budget");
    expect(replace(L(11, 3, 6, 0.04), undefined, 0.05).ruleHits).toContain("x402-margin");
    expect(replace(L(11, 3, 6, 0.03)).ruleHits).toContain("x402-cap-below-upstream");
    expect(replace(L(12, 3, 6, 0.04)).decision).toBe("deny");
  });
  it("refunds only verified orders with wrong data, once, within budget", () => {
    const base = { type: "x402.refund" as const, idempotencyKey: "f", orderId: "Q2", amount: 0.05, charged: 0.05, orderVerified: true, dataWrong: true, supportRemaining: 4 };
    const s = fresh();
    expect(evaluateX402(base, s).decision).toBe("allow");
    expect(evaluateX402({ ...base, dataWrong: false }, s).ruleHits).toContain("x402-refund-evidence");
    expect(evaluateX402({ ...base, orderVerified: false }, s).ruleHits).toContain("x402-order-unverified");
    expect(evaluateX402({ ...base, amount: 0.06 }, s).ruleHits).toContain("x402-refund-amount");
    expect(evaluateX402({ ...base, supportRemaining: 0.01 }, s).ruleHits).toContain("x402-support-budget");
    s.refundedOrders.add("Q2");
    expect(evaluateX402(base, s).ruleHits).toContain("x402-refund-once");
  });
  it("binds the licence approval to amount, currency, counterparty and invoice", () => {
    const f = kit11Config.licenceFee;
    const base = { type: "x402.pay_licence" as const, idempotencyKey: "l", amount: f.amount, currency: f.currency, beneficiaryId: f.beneficiaryId, invoice: f.invoice, counterparty: f.counterparty };
    const s = fresh();
    expect(evaluateX402(base, s).decision).toBe("escalate");
    expect(evaluateX402({ ...base, amount: 16 }, s).decision).toBe("deny");
    expect(evaluateX402({ ...base, currency: "USD" }, s).decision).toBe("deny");
    s.paidInvoices.add(f.invoice);
    expect(evaluateX402(base, s).ruleHits).toContain("x402-invoice-paid");
  });
  it("caps moved earnings at net earnings and the treasury budget", () => {
    expect(evaluateX402({ type: "x402.move_earnings", idempotencyKey: "e", amount: 0.07, netEarnings: 0.07, treasuryRemaining: 6 }, fresh()).decision).toBe("allow");
    expect(evaluateX402({ type: "x402.move_earnings", idempotencyKey: "e", amount: 0.08, netEarnings: 0.07, treasuryRemaining: 6 }, fresh()).decision).toBe("deny");
  });
});

describe("Simulation connector mirrors Metal mandate semantics", () => {
  async function setup() {
    const m = new SimMetalConnector();
    const biz = (await m.account("business")).address;
    await m.ensureFunded(biz, 5);
    const up = await m.address("upstream");
    const sales: any[] = [];
    const store = await m.serve([{ resource: "GET /r", payTo: up, price: () => price, signedOrder: true, handler: async () => ({ status: 200, body: { ok: 1 } }) }], (s) => sales.push(s));
    let price = 0.02;
    const mandate = await m.issueMandate({ agent: "sourcing", principal: biz, cap: 0.03, budget: 1, payees: [{ address: up }], description: "t" }, "run");
    return { m, store, mandate, sales, setPrice: (p: number) => (price = p), up };
  }
  it("pays under the cap, refuses above it with mandate_cap_exceeded, nothing paid", async () => {
    const { m, store, mandate, setPrice } = await setup();
    const ok = await m.pay(mandate, store.urlOf("GET /r"));
    expect(ok.ok).toBe(true);
    setPrice(0.04);
    const no = await m.pay(mandate, store.urlOf("GET /r"));
    expect(no.status).toBe(402);
    expect(no.refusal?.reason).toBe("mandate_cap_exceeded");
    expect((await m.mandateState(mandate)).spent).toBe(0.02);
  });
  it("replace carries spend over and revokes the old credential", async () => {
    const { m, store, mandate, setPrice } = await setup();
    await m.pay(mandate, store.urlOf("GET /r"));
    await expect(m.replaceMandate(mandate, { cap: 0.04, budget: 0.02, description: "t" }, "run")).rejects.toThrow(/exceed/);
    const r = await m.replaceMandate(mandate, { cap: 0.04, budget: 2, description: "t" }, "run");
    expect(r.spent).toBe(0.02);
    setPrice(0.04);
    expect((await m.pay(mandate, store.urlOf("GET /r"))).refusal?.reason).toBe("mandate_revoked");
    expect((await m.pay(r.mandate, store.urlOf("GET /r"))).ok).toBe(true);
    expect((await m.mandateState(r.mandate)).spent).toBe(0.06);
  });
  it("refuses payees the mandate does not name", async () => {
    const { m, mandate } = await setup();
    const r = await m.pull(mandate, "0x000000000000000000000000000000000000dEaD", 0.01, "x");
    expect(r.outcome).toBe("refused");
    expect(r.reason).toBe("mandate_payee_not_listed");
  });
  it("pull pays at most once per payment id", async () => {
    const { m, mandate, up } = await setup();
    expect((await m.pull(mandate, up, 0.02, "refund-1")).outcome).toBe("paid");
    expect((await m.pull(mandate, up, 0.02, "refund-1")).outcome).toBe("already_paid");
    expect((await m.mandateState(mandate)).spent).toBe(0.02);
  });
  it("a signed order verifies only against its own payment", async () => {
    const { m, store, mandate, sales } = await setup();
    await m.pay(mandate, store.urlOf("GET /r"));
    await m.pay(mandate, store.urlOf("GET /r"));
    expect((await m.verifyOrder(sales[0].tx, sales[0].signedOffer)).ok).toBe(true);
    expect((await m.verifyOrder(sales[1].tx, sales[0].signedOffer)).ok).toBe(false);
    const [p, sig] = sales[0].signedOffer.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), amount: 0.01 })).toString("base64url") + "." + sig;
    expect((await m.verifyOrder(sales[0].tx, forged)).ok).toBe(false);
  });
  it("seller error cancels settlement: in doubt, and no settlement found", async () => {
    const m = new SimMetalConnector();
    const biz = (await m.account("business")).address;
    await m.ensureFunded(biz, 5);
    const up = await m.address("upstream");
    const store = await m.serve([{ resource: "GET /e", payTo: up, price: () => 0.02, signedOrder: true, handler: async () => ({ status: 502, body: { error: "x" } }) }], () => {});
    const mandate = await m.issueMandate({ agent: "sourcing", principal: biz, cap: 0.03, budget: 1, payees: [{ address: up }], description: "t" }, "run");
    const r = await m.pay(mandate, store.urlOf("GET /e"));
    expect(r.inDoubt).toBe(true);
    expect((await m.findSettlement(up, r.nonce!)).found).toBe(false);
    expect((await m.mandateState(mandate)).spent).toBe(0);
  });
  it("parses metal-agent `name value` output", () => {
    const { map, all } = parseLines("mandate 0xabc\nspent 0.02 *USDZ of 11 *USDZ\nheader a: b\nheader c: d\n");
    expect(map.mandate).toBe("0xabc");
    expect(map.spent).toBe("0.02 *USDZ of 11 *USDZ");
    expect(all.filter(([k]) => k === "header")).toHaveLength(2);
  });
});

describe("Kit 11 scenario (simulation + mock Airwallex)", () => {
  it("runs all six beats end to end, with human approvals, and keeps the audit chain valid", async () => {
    const c = new Commander();
    const s = new X402Scenario(c, () => new SimMetalConnector(), new MockTreasury());
    const { done } = s.start({ autoApprove: true });
    await done;
    const r = s.run;
    expect(r.status).toBe("done");
    expect(r.beats.every((b) => b.status === "done")).toBe(true);
    expect(r.ledger).toMatchObject({ revenue: 0.31, upstream: 0.14, refunds: 0.1, net: 0.07, movedOut: 0.07 });
    const refunded = r.orders.filter((o) => o.refund?.outcome === "paid").map((o) => o.queryId);
    expect(refunded).toEqual(["Q2", "Q4"]);
    expect(r.orders.filter((o) => ["Q1", "Q2", "Q3", "Q4"].includes(o.queryId)).every((o) => o.verified)).toBe(true);
    expect(r.mandates.find((m) => m.agent === "sourcing")).toMatchObject({ version: 2, cap: 0.04, budget: 11 });
    expect(r.retired.map((m) => m.agent).sort()).toEqual(["sourcing", "support"]);
    const metalApprovals = c.queue.items.filter((a) => a.connector === "metal");
    expect(metalApprovals.map((a) => (a.action as any).type)).toEqual(["x402.replace_mandates", "x402.pay_licence"]);
    expect(metalApprovals.every((a) => a.status === "approved")).toBe(true);
    const events = c.audit.entries().map((e) => e.event);
    for (const e of ["x402.mandate.replaced", "x402.purchase.refused", "x402.refund.paid", "x402.refund.duplicate_attempt", "x402.airwallex.deposit_recorded", "x402.airwallex.licence_paid"])
      expect(events).toContain(e);
    expect(c.audit.entries().filter((e) => e.event.startsWith("x402.")).every((e) => (e.data as any).name === "metal")).toBe(true);
    expect(c.audit.verify().valid).toBe(true);
  });
  it("owner denial leaves mandates unchanged and Q6 unsold; no fiat moves without approval", async () => {
    const c = new Commander();
    const t = new MockTreasury();
    const s = new X402Scenario(c, () => new SimMetalConnector(), t);
    c.bus.on("x402", () => {
      const p = s.run.pendingApproval;
      if (p) setImmediate(() => s.decide(p.id, false, "tester", "no").catch(() => {}));
    });
    await s.start().done;
    expect(s.run.status).toBe("done");
    expect(s.run.mandates.find((m) => m.agent === "sourcing")?.version).toBe(1);
    expect(s.run.orders.some((o) => o.queryId === "Q6")).toBe(false);
    expect(t.transfers.size).toBe(0);
    expect(c.queue.items.filter((a) => a.connector === "metal").every((a) => a.status === "denied")).toBe(true);
  });
});

describe("Kit 11 HTTP routes", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));
  it("runs from POST /api/x402/run, approves via the x402 approval route, and keeps Kit 3 approvals separate", async () => {
    const c = new Commander();
    const s = new X402Scenario(c, () => new SimMetalConnector(), new MockTreasury());
    server = createApp(c, { x402: s }).listen(0, "127.0.0.1");
    await new Promise<void>((r) => server!.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
    const post = (p: string, b: unknown = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json() as Promise<any>);
    const get = (p: string) => fetch(base + p).then((r) => r.json() as Promise<any>);
    expect((await get("/x402")).run.status).toBe("idle");
    await post("/x402/run");
    expect((await fetch(base + "/x402/run", { method: "POST" })).status).toBe(409);
    for (let i = 0; i < 2; i++) {
      let run: any;
      for (let n = 0; n < 200 && !(run = (await get("/x402")).run).pendingApproval; n++) await new Promise((r) => setTimeout(r, 10));
      expect((await get("/approvals")).length).toBe(0); // Kit 3 view never shows Kit 11 approvals
      const d = await post(`/x402/approvals/${run.pendingApproval.id}/approve`, { approver: "Josh (owner)" });
      expect(d.approval.status).toBe("approved");
    }
    for (let n = 0; n < 200 && (await get("/x402")).run.status !== "done"; n++) await new Promise((r) => setTimeout(r, 10));
    expect((await get("/x402")).run.status).toBe("done");
    expect((await get("/audit/verify")).valid).toBe(true);
  });
});

it("an approval executes at most once, even if decided twice concurrently", async () => {
  const c = new Commander();
  const s = new X402Scenario(c, () => new SimMetalConnector(), new MockTreasury());
  let replaced = 0;
  c.bus.on("x402", () => {
    const p = s.run.pendingApproval;
    if (p?.type === "x402.replace_mandates")
      setImmediate(() => {
        void s.decide(p.id, true, "a", "").catch(() => {});
        void s.decide(p.id, true, "b", "").catch(() => {});
      });
    else if (p) setImmediate(() => void s.decide(p.id, true, "a", "").catch(() => {}));
  });
  await s.start().done;
  replaced = c.audit.entries().filter((e) => e.event === "x402.mandate.replaced").length;
  expect(replaced).toBe(2); // sourcing + support, once each
  expect(s.run.status).toBe("done");
});
