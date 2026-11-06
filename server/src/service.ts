import { AirwallexConnector } from "./connectors/airwallex.js";
import { PayPalConnector } from "./connectors/paypal.js";
import { AuditLog } from "./audit/log.js";
import { ApprovalQueue } from "./approvals/queue.js";
import { evaluate, type Action, type Intent } from "./policy/engine.js";
import { deterministicPlan, plan } from "./agent/planner.js";
import { simulate, type Incident } from "./simulator/scenarios.js";
import { simulateSandbox } from "./simulator/sandbox.js";
import type { Payout } from "./connectors/types.js";
import { EventEmitter } from "node:events";
import { incidentFromTransfer, type Detection } from "./live/detector.js";
import { scanUntrusted } from "./safety/injection.js";
import type { PolicyResult } from "./policy/engine.js";
import type { SafetyRun } from "./safety/safetyTest.js";
export class Commander {
  connectors = {
    airwallex: new AirwallexConnector(),
    paypal: new PayPalConnector(),
  };
  selected: "airwallex" | "paypal" =
    process.env.CONNECTOR === "paypal" ? "paypal" : "airwallex";
  incidents: Incident[] = [];
  queue = new ApprovalQueue();
  private tail: Promise<unknown> = Promise.resolve();
  /** Live update bus: "audit" fires for every audit entry (incidents, plans, approvals all audit). */
  bus = new EventEmitter();
  /** Transfer ids that already have an incident (any source), seeded from the audit log so restarts don't re-open them. */
  knownTransfers = new Set<string>();
  /** Webhook event ids already accepted (Airwallex retries with the same id). */
  seenEvents = new Set<string>();
  private lastStatus = new Map<string, string>();
  /** Auto-run the governed agent on live-detected incidents (policy still gates every action). */
  autoRun = process.env.ATLAS_AUTORUN !== "false";
  /** Latest safety-test run (live progress for the dashboard). */
  safety?: SafetyRun;
  /** Clean-demo session: the dashboard shows only audit entries/incidents from this point. Nothing is deleted. */
  session = { startSeq: 1, startedAt: "" };
  constructor(public audit = new AuditLog()) {
    this.bus.setMaxListeners(100);
    audit.onAppend = (entry) => this.bus.emit("audit", entry);
    for (const e of audit.entries()) {
      const d = e.data as any;
      if (e.event === "incident.detected" && d?.incident?.payout?.id)
        this.knownTransfers.add(d.incident.payout.id);
      if (e.event === "webhook.received" && d?.eventId) this.seenEvents.add(d.eventId);
      if (e.event === "safety.setup" && d?.payout?.id) this.knownTransfers.add(d.payout.id);
      if (e.event === "demo.session_started")
        this.session = { startSeq: e.seq, startedAt: e.timestamp };
    }
  }
  /**
   * Clean demo: start a fresh session view. Appends a marker to the (unbroken) audit chain and hides
   * earlier incidents/approvals from the dashboard. No audit entries and no sandbox data are deleted.
   */
  cleanDemo() {
    const pending = this.queue.items.filter((a) => a.status === "pending").length;
    const e = this.audit.append("demo.session_started", {
      ...this.info(),
      hiddenIncidents: this.incidents.length,
      pendingApprovalsHidden: pending,
      note: "Session view reset; earlier audit entries remain in the chain and sandbox data is untouched",
    });
    this.session = { startSeq: e.seq, startedAt: e.timestamp };
    this.safety = undefined;
    return { ok: true, session: this.session };
  }
  inSession(iso?: string) {
    return !this.session.startedAt || (iso ?? "") >= this.session.startedAt;
  }
  private airwallexInfo() {
    return { ...this.info(), name: "airwallex", mode: this.connectors.airwallex.mode };
  }
  /**
   * Single entry point for live detection (webhook + poller). One incident per transfer id,
   * whichever source sees it first; later sightings are recorded as status observations.
   */
  async ingestTransfer(p: Payout, d: Detection) {
    const r = await this.exclusive(async () => {
      const existing = this.incidents.find((i) => i.payout?.id === p.id);
      if (existing || this.knownTransfers.has(p.id)) {
        this.recordObservation(p, d.source, existing?.id, d.eventId);
        return { created: false as const, incident: existing };
      }
      const incident = incidentFromTransfer(p, d);
      this.knownTransfers.add(p.id);
      this.lastStatus.set(p.id, p.providerStatus || p.status);
      this.audit.append("incident.detected", {
        ...this.airwallexInfo(),
        source: d.source,
        ...(d.eventId ? { eventId: d.eventId, eventName: d.eventName } : {}),
        incident,
      });
      this.incidents.unshift(incident);
      return { created: true as const, incident };
    });
    if (r.created && this.autoRun && this.selected === r.incident.connector)
      await this.exclusive(() => this.run(r.incident.id)).catch((e) =>
        console.warn("[live] auto-run failed:", e instanceof Error ? e.message : e),
      );
    return r;
  }
  /** Status change on a transfer that already has an incident (e.g. stuck -> PAID). No new incident. */
  async observeTransfer(p: Payout, source: Detection["source"], eventId?: string) {
    if (!this.knownTransfers.has(p.id)) return;
    await this.exclusive(async () => {
      const i = this.incidents.find((x) => x.payout?.id === p.id);
      this.recordObservation(p, source, i?.id, eventId);
    });
  }
  private recordObservation(p: Payout, source: string, incidentId?: string, eventId?: string) {
    const status = p.providerStatus || p.status;
    if (this.lastStatus.get(p.id) === status) return;
    this.lastStatus.set(p.id, status);
    this.audit.append("transfer.status_observed", {
      ...this.airwallexInfo(),
      source,
      transferId: p.id,
      providerStatus: status,
      ...(incidentId ? { incidentId } : {}),
      ...(eventId ? { eventId } : {}),
    });
  }
  get connector() {
    return this.connectors[this.selected];
  }
  // All state changes, provider calls and final duplicate checks share one critical section.
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
  info() {
    return {
      name: this.selected,
      mode: this.connector.mode,
      planner: process.env.ANTHROPIC_API_KEY ? "Claude" : "rule-based",
    };
  }
  switch(name: "airwallex" | "paypal") {
    this.audit.append("connector.switched", { name });
    this.selected = name;
    return this.info();
  }
  async simulate(scenario: string) {
    const i =
      this.connector.mode === "sandbox" && this.connector instanceof AirwallexConnector
        ? await simulateSandbox(scenario, this.connector)
        : simulate(scenario, this.connector);
    i.source = "manual";
    i.detectedAt = new Date().toISOString();
    if (i.payout?.id) {
      this.knownTransfers.add(i.payout.id);
      this.lastStatus.set(i.payout.id, i.payout.providerStatus || i.payout.status);
    }
    this.audit.append("incident.detected", { ...this.info(), source: "manual", incident: i });
    this.incidents.unshift(i);
    return i;
  }
  reset() {
    if (this.connector.mode !== "mock") throw new Error("Reset is mock-only");
    this.audit.append("mock.reset", { name: this.selected });
    this.connector.reset();
    this.incidents = this.incidents.filter(
      (i) => i.connector !== this.selected,
    );
    this.queue.items = this.queue.items.filter(
      (a) => a.connector !== this.selected,
    );
    return { ok: true };
  }
  async history() {
    const map = new Map<string, Payout>();
    for (const e of this.audit.entries()) {
      const d = e.data as any;
      if (
        e.event === "mock.reset" &&
        d.name === this.selected &&
        this.connector.mode === "mock"
      )
        map.clear();
      if (d.name !== this.selected || d.mode !== this.connector.mode) continue;
      if (e.event === "incident.detected" && d.incident.payout)
        map.set(d.incident.payout.id, d.incident.payout);
      if (
        e.event === "execution.reserved" ||
        e.event === "execution.completed" ||
        e.event === "safety.setup"
      )
        map.set(d.payout.id, d.payout);
    }
    const remote = await this.connector.listPayouts();
    for (const p of remote) {
      for (const [id, r] of map)
        if (r.idempotencyKey === p.idempotencyKey && id.startsWith("reserved:"))
          map.delete(id);
      map.set(p.id, p);
    }
    return [...map.values()];
  }
  async execute(
    action: Action,
    intent?: Intent,
    approved = false,
    opts: { untrusted?: string[]; onPolicy?: (p: PolicyResult) => void } = {},
  ): Promise<string> {
    const history = await this.history();
    if (action.type === "retry" && action.payoutId) {
      const live = await this.connector.getPayout(action.payoutId);
      const index = history.findIndex((p) => p.id === live.id);
      if (index >= 0) history[index] = live;
      else history.push(live);
    }
    const policy = withInjectionGuard(
      action,
      evaluate(action, history, intent),
      opts.untrusted,
    );
    opts.onPolicy?.(policy);
    this.audit.append("policy.rechecked", {
      ...this.info(),
      action,
      policy,
      approved,
    });
    if (
      policy.decision === "deny" ||
      (policy.decision === "escalate" && !approved)
    )
      return "Blocked: " + policy.reasons.join("; ");
    if (action.type === "inspect") {
      const payout = action.payoutId
        ? await this.connector.getPayout(action.payoutId)
        : null;
      this.audit.append("reconciliation.completed", { ...this.info(), payout });
      if (payout?.status === "failed" || payout?.status === "cancelled")
        return `Manual review: transfer ${payout.providerStatus || payout.status}${payout.failureReason ? " (" + payout.failureReason + ")" : ""}; no automatic retry`;
      return payout?.status === "pending"
        ? "Manual review: payout is still pending; no replacement sent"
        : "Reconciled: " + (payout?.status || "no funds moved");
    }
    if (action.type === "repair") {
      this.audit.append("beneficiary.manual-review", {
        ...this.info(),
        action,
      });
      return "Manual review: independently verify beneficiary details before retrying";
    }
    const b = await this.connector.getBeneficiary(action.beneficiaryId);
    if (!b.valid) return "Blocked: beneficiary details remain invalid";
    const reservation: Payout = {
      ...action,
      id: "reserved:" + action.idempotencyKey,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.audit.append("execution.reserved", {
      ...this.info(),
      payout: reservation,
    });
    try {
      const p = await this.connector.createPayout(action);
      this.audit.append("execution.completed", {
        ...this.info(),
        payout: { ...p, id: reservation.id },
      });
      this.audit.append("payout.received", { ...this.info(), payout: p });
      return `Payout ${p.status}: ${p.id}`;
    } catch (error) {
      this.audit.append("execution.uncertain", {
        ...this.info(),
        idempotencyKey: action.idempotencyKey,
        error: error instanceof Error ? error.message : "Provider error",
      });
      return "Manual review: execution outcome uncertain; reservation prevents repeat payment";
    }
  }
  async run(id: string) {
    const i = this.incidents.find(
      (x) => x.id === id && x.connector === this.selected,
    );
    if (!i) throw new Error("Incident not found for current connector");
    if (i.status !== "open") return i;
    i.status = "running";
    try {
      const result = await plan(i);
      i.diagnosis = result.diagnosis;
      i.planner = result.planner;
      this.audit.append("agent.planned", {
        ...this.info(),
        incidentId: id,
        ...result,
      });
      i.actions = [];
      for (const action of result.actions) {
        const history = await this.history();
        let policy = withInjectionGuard(
          action,
          evaluate(action, history, i.intent),
          i.notes ? [i.notes] : undefined,
        );
        const base = deterministicPlan(i).actions;
        const bound = base.some(
          (a) =>
            a.type === action.type &&
            a.beneficiaryId === action.beneficiaryId &&
            a.amount === action.amount &&
            a.currency === action.currency &&
            a.reference === action.reference &&
            a.payoutId === action.payoutId &&
            a.item === action.item &&
            a.merchantCategory === action.merchantCategory &&
            a.idempotencyKey === action.idempotencyKey,
        );
        if (!bound)
          policy = {
            decision: "deny",
            ruleHits: ["incident-binding"],
            reasons: [
              "Planner action does not match the trusted incident resolution scope",
            ],
          };
        const entry: {
          action: Action;
          policy: typeof policy;
          outcome?: string;
        } = { action, policy };
        i.actions.push(entry);
        this.audit.append("policy.evaluated", {
          ...this.info(),
          incidentId: id,
          action,
          policy,
        });
        if (policy.decision === "escalate") {
          const a = this.queue.enqueue(id, this.selected, action, i.intent);
          this.audit.append("approval.queued", a);
          entry.outcome = "Awaiting approval";
        } else if (policy.decision === "deny") {
          entry.outcome = "Blocked";
          this.audit.append("action.blocked", {
            incidentId: id,
            action,
            policy,
          });
        } else
          entry.outcome = await this.execute(action, i.intent, false, {
            untrusted: i.notes ? [i.notes] : undefined,
          });
      }
      i.status = i.actions.some((a) => a.policy.decision === "escalate")
        ? "awaiting_approval"
        : i.actions.some(
              (a) =>
                a.policy.decision === "deny" ||
                a.outcome?.startsWith("Blocked"),
            )
          ? "blocked"
          : i.actions.some((a) => a.outcome?.startsWith("Manual"))
            ? "manual_review"
            : "resolved";
      this.audit.append("incident.updated", {
        incidentId: id,
        status: i.status,
      });
      return i;
    } catch (error) {
      i.status = "manual_review";
      throw error;
    }
  }
  async decide(id: string, approve: boolean, approver: string, note: string) {
    const a = this.queue.items.find((a) => a.id === id);
    if (!a || a.connector !== this.selected)
      throw new Error("Approval not found for current connector");
    this.audit.append("approval.requested", { id, approve, approver, note });
    const result = await this.queue.decide(
      id,
      approve,
      approver,
      note,
      (a) => this.execute(a.action, a.intent, true),
      (a) => this.audit.append("approval.decided", a),
    );
    const i = this.incidents.find((i) => i.id === a.incidentId);
    if (i) {
      const entry = i.actions?.find(
        (x) =>
          x.action.idempotencyKey === a.action.idempotencyKey &&
          x.action.type === a.action.type,
      );
      if (entry) entry.outcome = result.outcome;
      i.status = this.queue.items.some(
        (q) => q.incidentId === i.id && q.status === "pending",
      )
        ? "awaiting_approval"
        : result.status === "denied"
          ? "blocked"
          : result.outcome?.startsWith("Manual")
            ? "manual_review"
            : "resolved";
    }
    return result;
  }
}

/** Instruction-like text in untrusted incident data denies every money-moving action. */
export function withInjectionGuard(
  action: Action,
  policy: PolicyResult,
  untrusted?: string[],
): PolicyResult {
  if (!untrusted?.length || action.type === "inspect") return policy;
  const scan = scanUntrusted(...untrusted);
  if (!scan.flagged) return policy;
  return {
    decision: "deny",
    ruleHits: ["prompt-injection", ...policy.ruleHits.filter((r) => r !== "within-policy")],
    reasons: [
      "Untrusted incident data contains instructions (" +
        scan.findings.join("; ") +
        "); treated as data, never as a command",
      ...policy.reasons.filter((_, i) => policy.ruleHits[i] !== "within-policy"),
    ],
  };
}
