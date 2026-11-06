/**
 * Kit 11 — x402 Business Agents. One runner, six beats, every action through:
 *   policy (evaluateX402) -> approval queue (when escalated) -> execution -> hash-chained audit entry.
 * The chain side goes through MetalConnector (testnet or simulation); fiat through Treasury
 * (Airwallex sandbox or mock). Planner is rule-based: the numbers below come from kit11Config.
 */
import { randomUUID } from "node:crypto";
import type { Commander } from "../service.js";
import { evaluateX402, type X402Action, type X402State } from "../policy/x402.js";
import type { PolicyResult } from "../policy/engine.js";
import { cents, fromCents, kit11Config, type AgentRole } from "./config.js";
import type { Mandate, MetalConnector, PayResult, SaleRecord, Storefront } from "./metal.js";
import { SimMetalConnector } from "./metalSim.js";
import type { Treasury } from "./treasury.js";

export type BeatStatus = "pending" | "running" | "waiting" | "done" | "failed";
export interface BeatItem {
  at: string;
  kind: "info" | "ok" | "refused" | "policy" | "chain" | "fiat" | "approval" | "warn";
  text: string;
  tx?: string;
  link?: string;
}
export interface Beat {
  id: string;
  n: number;
  title: string;
  subtitle: string;
  status: BeatStatus;
  summary?: string;
  items: BeatItem[];
}
export interface Order {
  queryId: string;
  amount: number;
  tx: string;
  signedOffer: string;
  delivered: any;
  upstreamCost: number;
  upstreamTx?: string;
  verified?: boolean;
  refund?: { amount: number; tx?: string; outcome: string };
}
export interface PublicMandate {
  agent: string;
  id: string;
  version: number;
  cap: number;
  budget: number;
  spent: number;
  revoked: boolean;
  payees: string[];
  bindTx?: string;
  link?: string;
}
export interface X402Run {
  id: string;
  status: "idle" | "running" | "waiting_approval" | "done" | "failed";
  mode: MetalConnector["mode"];
  metalLabel: string;
  network: string;
  treasuryMode: Treasury["mode"];
  treasuryLabel: string;
  planner: string;
  startedAt?: string;
  finishedAt?: string;
  beats: Beat[];
  queryPrice: number;
  upstreamPrice: number;
  mandates: PublicMandate[];
  retired: PublicMandate[];
  orders: Order[];
  ledger: { revenue: number; upstream: number; refunds: number; net: number; movedOut: number };
  accounts: Record<string, string>;
  pendingApproval?: { id: string; type: string; summary: string; reasons: string[]; details: any };
  error?: string;
}

const BEATS: [string, string, string][] = [
  ["setup", "Mandates", "Owner issues three agent mandates (20 *USDZ total, held in code)"],
  ["sell", "Sell queries", "Customer's agent buys queries at 0.05 under its mandate; sourcing buys upstream at 0.02"],
  ["rise", "Upstream price rise", "Upstream goes to 0.04, above sourcing's 0.03 cap: Metal refuses, customer not charged"],
  ["replace", "Human approves new limits", "Treasury proposes new limits; owner approves; mandates replaced, old credential refused"],
  ["dispute", "Dispute & refunds", "Signed orders verified; only the orders with stale data are refunded, once"],
  ["treasury", "Earnings → Airwallex", "Net earnings pulled out; simulated deposit; FX + SWIFT licence fee after approval"],
];

const STALE_QUERIES = new Set(["Q2", "Q4"]);

export function createMetal(): MetalConnector {
  const mode = process.env.METAL_MODE || (process.env.METAL_RPC_URL ? "testnet" : "simulation");
  if (mode === "testnet") {
    // Lazy import keeps the CLI/x402 stack out of simulation mode and tests.
    const { TestnetMetalConnector } = requireTestnet();
    return new TestnetMetalConnector();
  }
  return new SimMetalConnector(Number(process.env.METAL_SIM_LATENCY_MS ?? 350));
}
let testnetModule: typeof import("./metalTestnet.js") | undefined;
export async function preloadTestnet() {
  testnetModule = await import("./metalTestnet.js");
}
function requireTestnet() {
  if (!testnetModule) throw new Error("testnet module not loaded; call preloadTestnet() first");
  return testnetModule;
}

export class X402Scenario {
  run: X402Run;
  private metal?: MetalConnector;
  private store?: Storefront;
  private mandates = {} as Record<AgentRole | "customer", Mandate>;
  private spent = {} as Record<AgentRole | "customer", number>;
  private retiredMandates: Mandate[] = [];
  private policyState: X402State = { refundedOrders: new Set(), paidInvoices: new Set() };
  private lastOutcome = "";
  private waiters = new Map<string, { resolve: (approved: boolean) => void; execute: () => Promise<string> }>();
  private upstreamCosts = new Map<string, { cost: number; tx?: string }>();
  private beat!: Beat;
  constructor(
    private commander: Commander,
    private makeMetal: () => MetalConnector,
    private treasury: Treasury,
    private opts: { paceMs?: number; beatHoldMs?: number } = {},
  ) {
    this.run = this.blank();
  }
  private blank(metal?: MetalConnector): X402Run {
    const m = metal ?? { mode: (process.env.METAL_MODE || (process.env.METAL_RPC_URL ? "testnet" : "simulation")) as any, label: "", network: "" };
    return {
      id: "",
      status: "idle",
      mode: m.mode,
      metalLabel: m.label || (m.mode === "testnet" ? "Metal testnet (real chain 63825, *USDZ test token)" : "Local simulation (no chain)"),
      network: m.network || (m.mode === "testnet" ? "eip155:63825" : "sim:metal-testnet-shape"),
      treasuryMode: this.treasury.mode,
      treasuryLabel: this.treasury.label,
      planner: "rule-based (limits held in code)",
      beats: BEATS.map(([id, title, subtitle], i) => ({ id, n: i + 1, title, subtitle, status: "pending", items: [] })),
      queryPrice: kit11Config.queryPrice,
      upstreamPrice: kit11Config.upstreamPrice,
      mandates: [],
      retired: [],
      orders: [],
      ledger: { revenue: 0, upstream: 0, refunds: 0, net: 0, movedOut: 0 },
      accounts: {},
    };
  }
  get busy() {
    return this.run.status === "running" || this.run.status === "waiting_approval";
  }

  // ---------- plumbing ----------
  private audit(event: string, data: Record<string, unknown>) {
    this.commander.audit.append("x402." + event, { name: "metal", scenario: "kit11", mode: this.run.mode, runId: this.run.id, ...data });
  }
  private item(kind: BeatItem["kind"], text: string, tx?: string) {
    this.beat.items.push({ at: new Date().toISOString(), kind, text, ...(tx ? { tx, link: this.metal?.explorer(tx) } : {}) });
    this.commander.bus.emit("x402", { runId: this.run.id });
  }
  private pace() {
    return this.opts.paceMs ? new Promise((r) => setTimeout(r, this.opts.paceMs)) : Promise.resolve();
  }
  private policy(action: X402Action): PolicyResult {
    const r = evaluateX402(action, this.policyState);
    this.audit("policy.evaluated", { action, decision: r.decision, reasons: r.reasons, ruleHits: r.ruleHits });
    this.item("policy", `Policy ${r.decision.toUpperCase()} · ${action.type.replace("x402.", "")} — ${r.reasons.join("; ")}`);
    return r;
  }
  private publicMandate(m: Mandate, revoked = false): PublicMandate {
    return {
      agent: m.agent,
      id: m.id,
      version: m.version,
      cap: m.cap,
      budget: m.budget,
      spent: revoked ? fromCents(cents(this.spent[m.agent] ?? 0)) : fromCents(cents(this.spent[m.agent] ?? 0)),
      revoked,
      payees: (m.payees ?? []).map((p) => p.name ?? p.address),
      bindTx: m.bindTx,
      link: this.metal?.explorer(m.bindTx),
    };
  }
  private refreshMandates() {
    this.run.mandates = (["sourcing", "support", "treasury", "customer"] as const).filter((r) => this.mandates[r]).map((r) => this.publicMandate(this.mandates[r]));
  }
  private refreshLedger() {
    const l = this.run.ledger;
    l.revenue = fromCents(this.run.orders.reduce((t, o) => t + cents(o.amount), 0));
    l.upstream = fromCents([...this.upstreamCosts.values()].reduce((t, c) => t + cents(c.cost), 0));
    l.refunds = fromCents(this.run.orders.reduce((t, o) => t + (o.refund?.outcome === "paid" ? cents(o.refund.amount) : 0), 0));
    l.net = fromCents(cents(l.revenue) - cents(l.upstream) - cents(l.refunds));
  }
  private async step<T>(id: string, fn: () => Promise<T>) {
    this.beat = this.run.beats.find((b) => b.id === id)!;
    this.beat.status = "running";
    this.audit("beat.started", { beat: id });
    const out = await fn();
    if (this.beat.status === "running" || this.beat.status === "waiting") this.beat.status = "done";
    this.refreshMandates();
    this.refreshLedger();
    this.audit("beat.completed", { beat: id, summary: this.beat.summary });
    this.commander.bus.emit("x402", { runId: this.run.id });
    // Dashboard runs hold each finished beat on screen briefly so its outcome can be read.
    if (this.opts.beatHoldMs) await new Promise((r) => setTimeout(r, this.opts.beatHoldMs));
    await this.pace();
    return out;
  }
  /** Escalated actions wait here for a human decision made through POST /api/x402/approvals/:id/... */
  private awaitApproval(action: X402Action, summary: string, reasons: string[], details: any, execute: () => Promise<string>) {
    const a = this.commander.queue.enqueue(this.run.id, "metal", action as any);
    this.run.pendingApproval = { id: a.id, type: action.type, summary, reasons, details };
    this.run.status = "waiting_approval";
    this.beat.status = "waiting";
    this.audit("approval.requested", { approvalId: a.id, action, summary });
    const waiting = new Promise<boolean>((resolve) => this.waiters.set(a.id, { resolve, execute }));
    this.item("approval", `Waiting for owner approval: ${summary}`);
    return waiting;
  }
  async decide(id: string, approve: boolean, approver: string, note: string) {
    const w = this.waiters.get(id);
    if (!w) throw new Error("Approval not found or already decided");
    this.waiters.delete(id); // claim it: a second click / request cannot execute the action twice
    this.run.pendingApproval = undefined; // the card closes as soon as the owner decides
    const a = await this.commander.queue.decide(
      id,
      approve,
      approver,
      note,
      async () => {
        this.run.status = "running";
        this.beat.status = "running";
        try {
          return await w.execute();
        } catch (e: any) {
          return "Blocked: " + (e?.message ?? String(e));
        }
      },
      (a) => this.audit("approval.decided", { approvalId: a.id, status: a.status, approver, note, outcome: a.outcome }),
    );
    this.waiters.delete(id);
    this.lastOutcome = a.outcome ?? "";
    this.run.pendingApproval = undefined;
    this.run.status = "running";
    w.resolve(a.status === "approved");
    return a;
  }

  // ---------- run ----------
  start(opts: { autoApprove?: boolean } = {}) {
    if (this.busy) throw new Error("Kit 11 scenario is already running");
    const metal = this.makeMetal();
    this.metal = metal;
    this.run = this.blank(metal);
    this.run.id = "x402-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + randomUUID().slice(0, 4);
    this.run.status = "running";
    this.run.startedAt = new Date().toISOString();
    this.mandates = {} as any;
    this.spent = { sourcing: 0, support: 0, treasury: 0, customer: 0 };
    this.retiredMandates = [];
    this.policyState = { refundedOrders: new Set(), paidInvoices: new Set() };
    this.upstreamCosts.clear();
    this.audit("run.started", { network: metal.network, metal: metal.label, treasury: this.treasury.label, planner: this.run.planner });
    if (opts.autoApprove)
      this.commander.bus.on("x402", () => {
        const p = this.run.pendingApproval;
        if (p && this.waiters.has(p.id))
          setImmediate(() => {
            if (this.waiters.has(p.id)) void this.decide(p.id, true, "auto-approve (test)", "").catch(() => {});
          });
      });
    const done = this.execute()
      .then(() => {
        this.run.status = "done";
        this.audit("run.completed", { ledger: this.run.ledger });
      })
      .catch((e) => {
        this.run.status = "failed";
        this.run.error = String(e?.message ?? e);
        if (this.beat) {
          this.beat.status = "failed";
          this.item("warn", "Run stopped: " + this.run.error);
        }
        this.audit("run.failed", { error: this.run.error });
      })
      .finally(async () => {
        this.run.finishedAt = new Date().toISOString();
        if (opts.autoApprove) this.commander.bus.removeAllListeners("x402");
        await this.store?.close().catch(() => {});
        await metal.close().catch(() => {});
        this.commander.bus.emit("x402", { runId: this.run.id });
      });
    return { run: this.run, done };
  }

  private async execute() {
    const m = this.metal!;
    const c = kit11Config;
    const runId = this.run.id;
    // Beat 1 — accounts and mandates
    await this.step("setup", async () => {
      const biz = await m.account("business");
      const cust = await m.account("customer");
      const upstream = await m.address("upstream");
      const offramp = await m.address("offramp");
      this.run.accounts = { business: biz.address, customer: cust.address, upstream, offramp };
      this.item("chain", `Business account ${short(biz.address)}${biz.reused ? " (reused)" : ""}`, biz.tx);
      this.item("chain", `Customer account ${short(cust.address)}${cust.reused ? " (reused)" : ""} — simulated customer, run by us`, cust.tx);
      for (const [who, a, min] of [["Business", biz.address, 3], ["Customer", cust.address, 1]] as const) {
        const f = await m.ensureFunded(a, min);
        this.item(f.fundedTx ? "chain" : "info", `${who} balance ${f.balance.toFixed(2)} *USDZ${f.fundedTx ? (this.run.mode === "testnet" ? " after testnet faucet grant" : " after simulated faucet grant") : ""}`, f.fundedTx);
      }
      const limits = { sourcing: { ...c.mandates.sourcing }, support: { ...c.mandates.support }, treasury: { ...c.mandates.treasury } };
      const p = this.policy({ type: "x402.issue_mandates", idempotencyKey: runId + ":issue", limits });
      if (p.decision !== "allow") throw new Error("Mandate issue blocked by policy");
      const specs: [AgentRole, string, string][] = [
        ["sourcing", upstream, "Upstream data provider"],
        ["support", cust.address, "Customer refunds"],
        ["treasury", offramp, "Off-ramp (our address)"],
      ];
      for (const [role, payee, name] of specs) {
        const mm = await m.issueMandate(
          { agent: role, principal: biz.address, cap: c.mandates[role].cap, budget: c.mandates[role].budget, payees: [{ address: payee, name }], description: `Kit 11 ${role} agent` },
          runId,
        );
        this.mandates[role] = mm;
        this.audit("mandate.issued", { agent: role, mandate: mm.id, cap: mm.cap, budget: mm.budget, payee, tx: mm.bindTx });
        this.item("chain", `${role} mandate bound — cap ${mm.cap.toFixed(2)}, budget ${mm.budget}, pays only ${name}`, mm.bindTx);
        this.refreshMandates();
      }
      const cm = await m.issueMandate(
        { agent: "customer", principal: cust.address, cap: c.customer.cap, budget: c.customer.budget, payees: [{ address: biz.address, name: "Atlas data shop" }], description: "Simulated customer's buying agent" },
        runId,
      );
      this.mandates.customer = cm;
      this.audit("mandate.issued", { agent: "customer", mandate: cm.id, cap: cm.cap, budget: cm.budget, payee: biz.address, tx: cm.bindTx });
      this.item("chain", `Customer's agent mandate bound — cap ${cm.cap.toFixed(2)}, budget ${cm.budget}, pays only our shop`, cm.bindTx);
      this.beat.summary = `3 agent mandates, ${c.totalBudget} *USDZ total; customer mandate ${c.customer.budget} *USDZ`;
    });

    // Storefront: upstream (plain x402) + our shop (x402 with signed orders)
    this.store = await m.serve(
      [
        {
          resource: "GET /upstream/records",
          payTo: this.run.accounts.upstream,
          price: () => this.run.upstreamPrice,
          signedOrder: false,
          handler: async ({ queryId }) => {
            const hours = STALE_QUERIES.has(queryId ?? "") ? 30 : 0.1;
            return { status: 200, body: { queryId, records: [{ sku: "ACME-" + (queryId ?? "?"), price: 19.99 }], asOf: new Date(Date.now() - hours * 3600_000).toISOString(), provider: "upstream (simulated provider, run by us)" } };
          },
        },
        {
          resource: "GET /query",
          payTo: this.run.accounts.business,
          price: () => this.run.queryPrice,
          signedOrder: true,
          handler: async ({ queryId }) => this.source(queryId ?? "?"),
        },
      ],
      (s) => this.onSale(s),
    );

    // Beat 2 — sell Q1..Q5
    await this.step("sell", async () => {
      for (let i = 1; i <= c.initialQueries; i++) await this.buy("Q" + i);
      this.beat.summary = `${c.initialQueries} queries sold at ${c.queryPrice.toFixed(2)}; upstream ${c.upstreamPrice.toFixed(2)} each; signed orders stored`;
    });

    // Beat 3 — upstream price rise
    await this.step("rise", async () => {
      this.run.upstreamPrice = c.upstreamPriceAfterRise;
      this.audit("upstream.price_changed", { from: c.upstreamPrice, to: c.upstreamPriceAfterRise });
      this.item("warn", `Upstream raises its price to ${c.upstreamPriceAfterRise.toFixed(2)} (sourcing cap is ${this.mandates.sourcing.cap.toFixed(2)})`);
      const before = this.spent.customer;
      const r = await this.buy("Q6");
      if (r.ok) throw new Error("expected the Q6 purchase to be refused");
      let charged = cents(this.spent.customer) - cents(before);
      if (r.nonce) {
        const s = await m.findSettlement(this.run.accounts.business, r.nonce);
        this.audit("settlement.lookup", { queryId: "Q6", nonce: r.nonce, found: s.found, tx: s.tx });
        this.item(s.found ? "warn" : "ok", s.found ? `${this.run.mode === "testnet" ? "Facilitator" : "Simulated facilitator"} /settlements shows Q6 settled (${s.tx}) — would need a refund` : `${this.run.mode === "testnet" ? "Facilitator" : "Simulated facilitator"} /settlements: no settlement for Q6's nonce — customer charged 0.00`, s.tx);
        if (s.found) charged = cents(this.run.queryPrice);
      }
      this.beat.summary = `Sourcing refused by Metal (cap), shop returned 502, customer charged ${fromCents(charged).toFixed(2)}`;
    });

    // Beat 4 — treasury proposes, human approves, mandates replaced
    await this.step("replace", async () => {
      const cur = (r: AgentRole) => ({ budget: this.mandates[r].budget, cap: this.mandates[r].cap });
      const from = { sourcing: cur("sourcing"), support: cur("support"), treasury: cur("treasury") };
      const to = { sourcing: { budget: 11, cap: 0.04 }, support: { budget: 3, cap: 0.1 }, treasury: { budget: 6, cap: 1 } };
      const newPrice = 0.06;
      const rationale = `Upstream now ${this.run.upstreamPrice.toFixed(2)}; raise sourcing cap to 0.04 and the query price to ${newPrice.toFixed(2)} to keep a ${c.minMarginPerQuery.toFixed(2)} margin; move 1 from support to sourcing so the total stays ${c.totalBudget}`;
      this.item("info", "Treasury agent (rule-based) proposes: " + rationale);
      const action: X402Action = {
        type: "x402.replace_mandates",
        idempotencyKey: runId + ":replace-1",
        from,
        to,
        spent: { sourcing: this.spent.sourcing, support: this.spent.support, treasury: this.spent.treasury },
        queryPriceFrom: this.run.queryPrice,
        queryPriceTo: newPrice,
        upstreamPrice: this.run.upstreamPrice,
        rationale,
      };
      const p = this.policy(action);
      if (p.decision === "deny") throw new Error("Proposal denied by policy: " + p.reasons.join("; "));
      const approved = await this.awaitApproval(action, `Replace mandates: sourcing cap 0.03→0.04 (budget 10→11), support budget 4→3; query price 0.05→${newPrice.toFixed(2)}`, p.reasons, { from, to, queryPriceTo: newPrice }, async () => {
        for (const role of ["sourcing", "support"] as const) {
          const old = this.mandates[role];
          const r = await m.replaceMandate(old, { cap: to[role].cap, budget: to[role].budget, payees: old.payees, description: old.description + " (v" + (old.version + 1) + ")" }, runId);
          this.retiredMandates.push(old);
          this.run.retired.push(this.publicMandate(old, true));
          this.mandates[role] = r.mandate;
          this.audit("mandate.replaced", { agent: role, old: old.id, new: r.mandate.id, cap: r.mandate.cap, budget: r.mandate.budget, spentCarried: r.spent, tx: r.tx });
          this.item("chain", `${role} mandate replaced → v${r.mandate.version}: cap ${r.mandate.cap.toFixed(2)}, budget ${r.mandate.budget}; spent ${r.spent.toFixed(2)} carried over`, r.tx);
          this.refreshMandates();
        }
        this.run.queryPrice = newPrice;
        this.audit("price.changed", { resource: "GET /query", from: c.queryPrice, to: newPrice });
        return "Mandates replaced (sourcing, support); query price " + newPrice.toFixed(2);
      });
      if (!approved && this.lastOutcome.startsWith("Blocked")) throw new Error("Mandate replacement failed — " + this.lastOutcome);
      if (!approved) {
        this.item("warn", "Owner denied the new limits; mandates unchanged");
        this.beat.summary = "Owner denied; nothing changed";
        return;
      }
      const oldSourcing = this.retiredMandates.find((x) => x.agent === "sourcing")!;
      const probe = await m.pay(oldSourcing, this.store!.urlOf("GET /upstream/records"), { "x-atlas-query": "probe-old-credential" });
      this.audit("purchase.refused", { agent: "sourcing", credential: "v" + oldSourcing.version, reason: probe.refusal?.reason, detail: probe.refusal?.detail });
      this.item(probe.ok ? "warn" : "refused", probe.ok ? "Old credential unexpectedly paid" : `Old sourcing credential (v1) refused: ${probe.refusal?.reason} — nothing was paid`);
      const retry = await this.buy("Q6");
      this.beat.summary = `Approved by owner; mandates replaced; old credential refused; Q6 retried ${retry.ok ? "and sold at " + this.run.queryPrice.toFixed(2) : "but failed"}`;
    });

    // Beat 5 — dispute
    await this.step("dispute", async () => {
      this.item("info", `Customer disputes ${c.disputedBatch.join(", ")}: "we never placed these, and the data was wrong"`);
      this.audit("dispute.opened", { orders: c.disputedBatch, claim: "never placed / data wrong" });
      for (const q of c.disputedBatch) {
        const o = this.run.orders.find((x) => x.queryId === q);
        if (!o) continue;
        const v = await m.verifyOrder(o.tx, o.signedOffer);
        o.verified = v.ok;
        this.audit("order.verified", { queryId: q, tx: o.tx, ok: v.ok, steps: v.steps });
        const asOf = Date.parse(o.delivered?.asOf ?? "");
        const ageH = Number.isFinite(asOf) ? (Date.parse(o.delivered?.servedAt ?? new Date().toISOString()) - asOf) / 3600_000 : Infinity;
        const dataWrong = ageH > c.staleAfterHours;
        this.item(v.ok ? "ok" : "warn", `${q}: signed order ${v.ok ? "verifies against its payment — the customer's agent placed it" : "does NOT verify"}; data ${dataWrong ? `stale (${ageH.toFixed(0)}h old)` : "fresh"}`, o.tx);
        const action: X402Action = { type: "x402.refund", idempotencyKey: runId + ":refund-" + q, orderId: q, amount: o.amount, charged: o.amount, orderVerified: v.ok, dataWrong, supportRemaining: fromCents(cents(this.mandates.support.budget) - cents(this.spent.support)) };
        const p = this.policy(action);
        if (p.decision !== "allow") continue;
        const r = await m.pull(this.mandates.support, this.run.accounts.customer, o.amount, `refund-${runId}-${q}`);
        o.refund = { amount: o.amount, tx: r.tx, outcome: r.outcome };
        if (r.outcome === "paid") {
          this.spent.support = fromCents(cents(this.spent.support) + cents(o.amount));
          this.policyState.refundedOrders.add(q);
        }
        this.audit("refund." + r.outcome, { queryId: q, amount: o.amount, tx: r.tx, paymentId: `refund-${runId}-${q}`, reason: r.reason });
        this.item(r.outcome === "paid" ? "chain" : "warn", `Refund ${q}: ${o.amount.toFixed(2)} *USDZ from support mandate — ${r.outcome}`, r.tx);
      }
      // Duplicate refund attempt: blocked by policy, and the payment id makes Metal pay at most once anyway.
      const dup = [...this.policyState.refundedOrders][0];
      if (dup) {
        const o = this.run.orders.find((x) => x.queryId === dup)!;
        const p = this.policy({ type: "x402.refund", idempotencyKey: runId + ":refund-" + dup + "-again", orderId: dup, amount: o.amount, charged: o.amount, orderVerified: true, dataWrong: true, supportRemaining: 1 });
        const r = await m.pull(this.mandates.support, this.run.accounts.customer, o.amount, `refund-${runId}-${dup}`);
        this.audit("refund.duplicate_attempt", { queryId: dup, policy: p.decision, metal: r.outcome });
        this.item("ok", `Second refund for ${dup}: policy ${p.decision.toUpperCase()}; same payment id on Metal → ${r.outcome === "already_paid" ? "already paid, nothing sent" : r.outcome}`);
      }
      this.refreshLedger();
      const refunded = this.run.orders.filter((o) => o.refund?.outcome === "paid").map((o) => o.queryId);
      this.beat.summary = `${c.disputedBatch.length} orders verified; refunded ${refunded.join(", ") || "none"} (stale data); others declined with the signed order as evidence`;
    });

    // Beat 6 — earnings to Airwallex, licence fee
    await this.step("treasury", async () => {
      this.refreshLedger();
      const l = this.run.ledger;
      this.item("info", `Net earnings: revenue ${l.revenue.toFixed(2)} − upstream ${l.upstream.toFixed(2)} − refunds ${l.refunds.toFixed(2)} = ${l.net.toFixed(2)} *USDZ`);
      const amount = l.net;
      const p = this.policy({ type: "x402.move_earnings", idempotencyKey: runId + ":earnings", amount, netEarnings: l.net, treasuryRemaining: fromCents(cents(this.mandates.treasury.budget) - cents(this.spent.treasury)) });
      if (p.decision === "allow" && amount > 0) {
        const r = await m.pull(this.mandates.treasury, this.run.accounts.offramp, amount, `earnings-${runId}`);
        this.audit("earnings." + r.outcome, { amount, to: this.run.accounts.offramp, tx: r.tx });
        this.item("chain", `Treasury pulled ${amount.toFixed(2)} *USDZ to our off-ramp address — ${r.outcome}`, r.tx);
        if (r.outcome !== "paid" || !r.tx) throw new Error("earnings pull " + r.outcome);
        this.spent.treasury = fromCents(cents(this.spent.treasury) + cents(amount));
        l.movedOut = amount;
        this.audit("earnings.credited", { tx: r.tx, amount });
        const d = await this.treasury.recordEarnings(amount, r.tx);
        this.audit("airwallex.deposit_recorded", { ...d, simulated: true, treasury: this.treasury.mode });
        this.item("fiat", `Airwallex ${this.treasury.mode}: simulated deposit of ${amount.toFixed(2)} USD, reference = Metal tx; ${d.confirmed ? "found in GET /deposits" : "not yet listed"} (sandbox cannot receive stablecoins, so the arrival is simulated)`);
      }
      const f = c.licenceFee;
      const action: X402Action = { type: "x402.pay_licence", idempotencyKey: runId + ":" + f.invoice, amount: f.amount, currency: f.currency, beneficiaryId: f.beneficiaryId, invoice: f.invoice, counterparty: f.counterparty };
      const lp = this.policy(action);
      if (lp.decision === "deny") throw new Error("Licence payment denied: " + lp.reasons.join("; "));
      const usd = await this.treasury.usdAvailable().catch(() => null);
      const approved = await this.awaitApproval(
        action,
        `Pay licence ${f.invoice}: EUR ${f.amount.toFixed(2)} to ${f.counterparty} via SWIFT (fee EUR ${c.swiftFeeEur}); funded mostly from the existing sandbox balance, not from this run's earnings`,
        lp.reasons,
        { ...f, swiftFeeEur: c.swiftFeeEur, usdAvailable: usd },
        async () => {
          const r = await this.treasury.payLicence(`kit11-${runId}-${f.invoice}`);
          this.policyState.paidInvoices.add(f.invoice);
          this.audit("airwallex.licence_paid", { ...r, invoice: f.invoice, treasury: this.treasury.mode });
          this.item("fiat", `FX: bought EUR ${r.conversion.buyAmount.toFixed(2)} for USD ${r.conversion.sellAmount?.toFixed(2) ?? "?"}${r.rate ? " @ " + r.rate : ""} (${r.conversion.status})`);
          this.item("fiat", `SWIFT transfer EUR ${r.transfer.amount.toFixed(2)} → ${f.counterparty}: ${r.transfer.status} (${r.transfer.id})`);
          return `Paid ${f.invoice}: transfer ${r.transfer.id} ${r.transfer.status}`;
        },
      );
      if (!approved && this.lastOutcome.startsWith("Blocked")) throw new Error("Licence payment failed — " + this.lastOutcome);
      this.beat.summary = approved ? `Earnings ${amount.toFixed(2)} moved and recorded; licence ${f.invoice} paid in EUR after approval` : "Licence payment denied by owner";
      // Final balances on the agents' mandates
      for (const r of ["sourcing", "support", "treasury"] as const) {
        const s = await m.mandateState(this.mandates[r]).catch(() => undefined);
        if (s) this.spent[r] = s.spent;
      }
    });
  }

  /** Our shop's handler: the sourcing agent buys the upstream record under its mandate. */
  private async source(queryId: string): Promise<{ status: number; body: any }> {
    const m = this.metal!;
    const mandate = this.mandates.sourcing;
    const p = evaluateX402({ type: "x402.purchase", idempotencyKey: this.run.id + ":src-" + queryId, agent: "sourcing", resource: "GET /upstream/records", queryId, maxPrice: mandate.cap, mandateCap: mandate.cap }, this.policyState);
    this.audit("policy.evaluated", { action: { type: "x402.purchase", queryId, maxPrice: mandate.cap }, decision: p.decision, reasons: p.reasons, ruleHits: p.ruleHits });
    if (p.decision !== "allow") return { status: 502, body: { error: "sourcing blocked by policy" } };
    const r: PayResult = await m.pay(mandate, this.store!.urlOf("GET /upstream/records"), { "x-atlas-query": queryId });
    if (!r.ok) {
      this.audit("purchase.refused", { agent: "sourcing", queryId, reason: r.refusal?.reason, detail: r.refusal?.detail });
      this.item("refused", `${queryId}: sourcing purchase at ${this.run.upstreamPrice.toFixed(2)} refused by Metal — ${r.refusal?.reason} (402); nothing was paid`);
      return { status: 502, body: { error: "upstream purchase refused: " + (r.refusal?.reason ?? "unknown") } };
    }
    this.spent.sourcing = fromCents(cents(this.spent.sourcing) + cents(r.amount ?? 0));
    this.upstreamCosts.set(queryId, { cost: r.amount ?? 0, tx: r.tx });
    this.audit("purchase.settled", { agent: "sourcing", queryId, amount: r.amount, tx: r.tx });
    this.item("chain", `${queryId}: sourcing paid upstream ${(r.amount ?? 0).toFixed(2)}`, r.tx);
    return { status: 200, body: { queryId, answer: r.body?.records ?? [], asOf: r.body?.asOf, servedAt: new Date().toISOString(), upstreamTx: r.tx } };
  }
  private onSale(s: SaleRecord) {
    const up = this.upstreamCosts.get(s.queryId);
    const amount = s.amount || this.run.queryPrice;
    this.run.orders = this.run.orders.filter((o) => o.queryId !== s.queryId);
    this.run.orders.push({ queryId: s.queryId, amount, tx: s.tx, signedOffer: s.signedOffer, delivered: s.delivered, upstreamCost: up?.cost ?? 0, upstreamTx: up?.tx });
    this.audit("sale.recorded", { queryId: s.queryId, amount, tx: s.tx, signedOrder: s.signedOffer.slice(0, 24) + "…", delivered: { asOf: s.delivered?.asOf } });
    this.refreshLedger();
  }
  private async buy(queryId: string) {
    const r = await this.metal!.pay(this.mandates.customer, this.store!.urlOf("GET /query"), { "x-atlas-query": queryId });
    if (r.ok) {
      this.spent.customer = fromCents(cents(this.spent.customer) + cents(r.amount ?? 0));
      // The sale is recorded by onAfterSettle (testnet) / onSale (sim); fall back to the CLI's view if the hook was missed.
      if (!this.run.orders.some((o) => o.queryId === queryId) && r.tx && r.signedOffer)
        this.onSale({ queryId, resource: "GET /query", amount: r.amount ?? this.run.queryPrice, payer: r.payer ?? "", payTo: r.payee ?? "", tx: r.tx, signedOffer: r.signedOffer, delivered: r.body, settledAt: new Date().toISOString() });
      this.item("ok", `${queryId}: customer's agent paid ${(r.amount ?? 0).toFixed(2)} with a signed order; data delivered`, r.tx);
    } else {
      this.audit("sale.failed", { queryId, reason: r.refusal?.reason, status: r.status, inDoubt: r.inDoubt, detail: r.refusal?.detail });
      this.item("warn", `${queryId}: shop answered ${r.status ?? "an error"} (${r.refusal?.reason === "seller_error" ? "it could not source the data" : r.refusal?.reason})${r.inDoubt ? " — the customer's payment was signed, so we check whether it settled" : ""}`);
    }
    this.refreshLedger();
    this.refreshMandates();
    return r;
  }
}

const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
