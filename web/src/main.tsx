import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { Kit11App } from "./kit11";
type Action = {
  type: string;
  amount: number;
  currency: string;
  reference: string;
  beneficiaryId?: string;
};
type Incident = {
  id: string;
  title: string;
  severity: string;
  status: string;
  source?: string;
  detectedAt?: string;
  diagnosis?: string;
  planner?: string;
  actions?: {
    action: Action;
    policy: { decision: string; reasons: string[]; ruleHits?: string[] };
    outcome?: string;
  }[];
};
type Approval = {
  id: string;
  incidentId: string;
  action: Action;
  status: string;
  outcome?: string;
  approver?: string;
  note?: string;
};
type Entry = {
  seq: number;
  timestamp: string;
  event: string;
  data: unknown;
  hash: string;
};
type Attempt = {
  n: number;
  key: string;
  title: string;
  attempted: string;
  decision: string;
  rules: string[];
  reasons: string[];
  outcome: string;
  blocked: boolean;
  moneyMoved: number;
  provider?: {
    httpStatus?: number;
    code?: string;
    sameTransferReturned: boolean;
    transfersWithRequestId?: number;
    note: string;
  };
  injection?: { flagged: boolean; findings: string[]; text: string };
};
type SafetyRun = {
  id: string;
  status: "running" | "completed" | "failed";
  mode: string;
  phase: string;
  setup?: { payout: { id: string; amount: number; reference: string; providerStatus?: string }; note: string };
  balanceBefore?: number | null;
  balanceAfter?: number | null;
  attempts: Attempt[];
  total: number;
  blocked?: number;
  moneyMoved?: number;
  chain?: { valid: boolean; count: number };
  error?: string;
};
type Verify = { valid: boolean; count: number; sessionCount?: number };

const AZ = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Phoenix",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const azTime = (iso?: string) => (iso ? AZ.format(new Date(iso)) + " AZ" : "");
const usd = (n?: number | null) =>
  n == null
    ? "n/a"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const DEMO_PACE_MS = 2200;

async function api(path: string, body?: unknown) {
  const r = await fetch(
    "/api" + path,
    body !== undefined
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Request failed");
  return d;
}

/** One visual language for outcomes: Blocked / Escalated / Manual review / Approved / Resolved. */
function statusKind(s: string): { cls: string; icon: string; label: string } {
  const v = s.toLowerCase();
  if (v.startsWith("blocked") || v === "deny" || v === "denied")
    return { cls: "st-blocked", icon: "⛔", label: v === "deny" ? "Deny" : v === "denied" ? "Denied" : "Blocked" };
  if (v === "escalate" || v.startsWith("awaiting") || v === "pending")
    return { cls: "st-escalated", icon: "⏸", label: v === "escalate" ? "Escalate" : v === "pending" ? "Pending approval" : "Escalated" };
  if (v.startsWith("manual"))
    return { cls: "st-manual", icon: "🔍", label: "Manual review" };
  if (v === "approved") return { cls: "st-approved", icon: "✔", label: "Approved" };
  if (v === "allow") return { cls: "st-approved", icon: "✔", label: "Allow" };
  if (v === "resolved" || v.startsWith("reconciled"))
    return { cls: "st-approved", icon: "✔", label: v === "resolved" ? "Resolved" : "Reconciled" };
  if (v === "running") return { cls: "st-running", icon: "◌", label: "Running" };
  return { cls: "st-open", icon: "●", label: s.replaceAll("_", " ") };
}
function Status({ value }: { value: string }) {
  const k = statusKind(value);
  return (
    <span className={"status " + k.cls}>
      <span aria-hidden>{k.icon}</span> {k.label}
    </span>
  );
}
/** One-line, human-readable gloss for an audit entry (the full JSON stays in the expandable body). */
function summarize(e: Entry): string {
  const d = (e.data || {}) as any;
  const money = (n: any) => (typeof n === "number" ? usd(n) : "");
  switch (e.event) {
    case "safety.attempt":
      return `#${d.n} ${d.title} → ${String(d.decision).toUpperCase()} (${(d.rules || []).join(", ")}) · moved ${money(d.moneyMoved)}`;
    case "safety.provider_idempotency":
      return `Airwallex replay: ${d.httpStatus ? "HTTP " + d.httpStatus + " " : ""}${d.code || "existing payout"} · ${d.transfersWithRequestId ?? "?"} transfer for request_id`;
    case "safety.setup":
      return `Legit invoice ${d.payout?.reference} ${money(d.payout?.amount)} · ${d.payout?.providerStatus || d.payout?.status}`;
    case "safety.balance":
      return `USD available ${d.available == null ? "n/a" : money(d.available)} (${d.when})`;
    case "safety.completed":
      return `${d.blocked}/${d.total} blocked · ${money(d.moneyMoved)} moved`;
    case "policy.rechecked":
    case "policy.evaluated":
      return `${d.action?.type} ${money(d.action?.amount)} → ${String(d.policy?.decision).toUpperCase()} (${(d.policy?.ruleHits || []).join(", ")})`;
    case "incident.detected":
      return d.incident?.title || "";
    case "approval.queued":
      return `${d.action?.type} ${money(d.action?.amount)} waiting for a human`;
    case "approval.decided":
      return `${d.status} by ${d.approver}`;
    case "incident.updated":
      return String(d.status || "").replaceAll("_", " ");
    case "transfer.status_observed":
      return `transfer ${String(d.transferId || "").slice(0, 8)} → ${d.providerStatus}`;
    case "demo.session_started":
      return "Clean demo session started (earlier entries kept in the chain)";
    default:
      return "";
  }
}
function Spinner() {
  return <span className="spinner" aria-hidden />;
}

function SafetyPanel({
  run,
  balanceNow,
  verify,
  busy,
  onRun,
  mode,
}: {
  run: SafetyRun | null;
  balanceNow: number | null | undefined;
  verify?: Verify;
  busy: boolean;
  onRun: () => void;
  mode: string;
}) {
  const done = run?.status === "completed";
  const allBlocked = done && run!.blocked === run!.total;
  const balanceSame =
    done && run!.balanceBefore != null && run!.balanceBefore === run!.balanceAfter;
  return (
    <section className="safety" data-testid="safety-panel">
      <div className="safety-head">
        <div>
          <span className="eyebrow">LIVE SAFETY TEST · {mode === "sandbox" ? "AIRWALLEX SANDBOX · TEST MONEY" : "MOCK MODE"}</span>
          <h3>Try to make the agent misuse money</h3>
          <p>
            Six unsafe actions against the governed agent. Every one must be stopped before it
            reaches the payment rail.
          </p>
        </div>
        <button
          className="primary big"
          data-testid="run-safety"
          disabled={busy || run?.status === "running"}
          onClick={onRun}
        >
          {run?.status === "running" ? (
            <>
              <Spinner /> Running safety test…
            </>
          ) : (
            "▶ Run Safety Test"
          )}
        </button>
      </div>
      {run && (
        <>
          <div className="safety-meta">
            <div>
              <span className="label">Setup (legitimate)</span>
              <strong>
                {run.setup
                  ? `${usd(run.setup.payout.amount)} ${run.setup.payout.reference} · ${run.setup.payout.providerStatus || "paid"}`
                  : "…"}
              </strong>
            </div>
            <div>
              <span className="label">Balance before attempts</span>
              <strong className="mono-num">{run.mode === "sandbox" ? usd(run.balanceBefore) : "mock"}</strong>
            </div>
            <div>
              <span className="label">Balance after attempts</span>
              <strong className={"mono-num " + (balanceSame ? "green" : "")}>
                {run.mode === "sandbox" ? (done ? usd(run.balanceAfter) : "…") : "mock"}
                {balanceSame && " · unchanged"}
              </strong>
            </div>
            <div className="phase">
              {run.status === "running" && <Spinner />}
              <span>{run.status === "failed" ? "Failed: " + run.error : run.phase}</span>
            </div>
          </div>
          <table className="attempts" data-testid="safety-rows">
            <thead>
              <tr>
                <th>#</th>
                <th>Attempted action</th>
                <th>Rule that fired</th>
                <th>Decision</th>
                <th>Money moved</th>
              </tr>
            </thead>
            <tbody>
              {run.attempts.map((a) => (
                <tr key={a.key} className="attempt-row" data-testid={"attempt-" + a.key}>
                  <td className="n">{String(a.n).padStart(2, "0")}</td>
                  <td>
                    <strong>{a.title}</strong>
                    <span className="sub">{a.attempted}</span>
                    {a.injection && (
                      <span className="quote">“{a.injection.text}”</span>
                    )}
                  </td>
                  <td>
                    <div className="rules">
                      {a.rules.map((r) => (
                        <code key={r}>{r}</code>
                      ))}
                    </div>
                    <span className="sub">{a.reasons[0]}</span>
                    {a.provider && (
                      <span className="layer2">
                        Layer 2 · Airwallex:{" "}
                        <code>
                          {a.provider.httpStatus ? `HTTP ${a.provider.httpStatus} ` : ""}
                          {a.provider.code || "existing payout returned"}
                        </code>{" "}
                        · {a.provider.transfersWithRequestId ?? 1} transfer for this request_id
                      </span>
                    )}
                  </td>
                  <td>
                    <Status value={a.blocked ? a.decision : "allow"} />
                  </td>
                  <td className={"money " + (a.moneyMoved === 0 ? "green" : "red")}>
                    {usd(a.moneyMoved)}
                  </td>
                </tr>
              ))}
              {run.status === "running" &&
                Array.from({ length: Math.max(0, run.total - run.attempts.length) }).map((_, i) => (
                  <tr key={"p" + i} className="pending-row">
                    <td className="n">{String(run.attempts.length + i + 1).padStart(2, "0")}</td>
                    <td colSpan={4}>
                      {i === 0 ? (
                        <>
                          <Spinner /> {run.phase}
                        </>
                      ) : (
                        "Queued"
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          {done && (
            <div className={"scoreboard " + (allBlocked ? "ok" : "bad")} data-testid="scoreboard">
              <span className="big-num">
                {run.blocked}/{run.total}
              </span>
              <span>unsafe actions blocked</span>
              <span className="sep">·</span>
              <span className="big-num">{usd(run.moneyMoved)}</span>
              <span>moved</span>
              <span className="sep">·</span>
              <span className={"chain " + (run.chain?.valid && verify?.valid ? "green" : "red")}>
                {run.chain?.valid && verify?.valid ? "✔ audit chain verified" : "audit chain broken"}
              </span>
            </div>
          )}
        </>
      )}
      {!run && balanceNow != null && (
        <p className="muted">Sandbox USD balance now: {usd(balanceNow)} (test money)</p>
      )}
    </section>
  );
}

function Kit3App() {
  const [info, setInfo] = useState({
      name: "airwallex",
      mode: "mock",
      planner: "rule-based",
    }),
    [incidents, setIncidents] = useState<Incident[]>([]),
    [approvals, setApprovals] = useState<Approval[]>([]),
    [audit, setAudit] = useState<Entry[]>([]),
    [verify, setVerify] = useState<Verify>(),
    [safety, setSafety] = useState<SafetyRun | null>(null),
    [balance, setBalance] = useState<number | null>(),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [autoRun, setAutoRun] = useState(true),
    [approver, setApprover] = useState("Josh (operator)"),
    [note, setNote] = useState(""),
    [live, setLive] = useState<"connecting" | "live" | "offline">("connecting"),
    [lastEvent, setLastEvent] = useState("");
  const safetyRunning = useRef(false);
  async function refresh() {
    const [c, i, a, l, v, s] = await Promise.all(
      ["/connector", "/incidents", "/approvals", "/audit", "/audit/verify", "/safety"].map((p) => api(p)),
    );
    setInfo(c);
    setIncidents(i);
    setApprovals(a);
    setAudit(l);
    setVerify(v);
    setSafety(s);
  }
  const refreshBalance = () =>
    api("/balance")
      .then((b) => setBalance(b.available))
      .catch(() => setBalance(null));
  useEffect(() => {
    let active = true;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      if (active) refresh().catch((e) => setError(e.message));
    };
    const soon = () => {
      clearTimeout(pending);
      pending = setTimeout(poll, 120);
    };
    poll();
    refreshBalance();
    const es = new EventSource("/api/events");
    es.addEventListener("hello", () => setLive("live"));
    es.addEventListener("audit", (m) => {
      setLive("live");
      try {
        setLastEvent(JSON.parse((m as MessageEvent).data).event);
      } catch {}
      soon();
    });
    es.onerror = () => setLive("offline");
    const id = setInterval(poll, 15000);
    return () => {
      active = false;
      es.close();
      clearTimeout(pending);
      clearInterval(id);
    };
  }, []);
  async function mutate(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy("");
    }
  }
  const simulate = (key: string) =>
    mutate(info.mode === "sandbox" ? "Creating a sandbox transfer…" : "Simulating incident…", async () => {
      const i = await api("/simulate/" + key, {});
      setSelected(i.id);
      await refresh();
      if (autoRun) {
        setBusy("Governed agent is diagnosing and checking policy…");
        await api("/agent/run/" + i.id, {});
      }
    });
  const runSafety = () => {
    if (safetyRunning.current) return;
    safetyRunning.current = true;
    setError("");
    api("/safety/run", { paceMs: DEMO_PACE_MS })
      .then(setSafety)
      .catch((e) => setError(e.message))
      .finally(() => {
        safetyRunning.current = false;
        refresh().catch(() => {});
        refreshBalance();
      });
    setTimeout(() => refresh().catch(() => {}), 300);
  };
  const incident = incidents.find((i) => i.id === selected) || incidents[0];
  const pendingCount = approvals.filter((a) => a.status === "pending").length;
  return (
    <div className="shell">
      {busy && (
        <div className="progress" role="status" data-testid="busy">
          <div className="bar" />
          <span>
            <Spinner /> {busy}
          </span>
        </div>
      )}
      <header>
        <div className="brand">
          <span className="mark">A</span>
          <div>
            <h1>
              Atlas <span>Incident Commander</span>
            </h1>
            <p>Governed resolution. Every payment accountable.</p>
          </div>
        </div>
        <div className="connection">
          <select
            aria-label="Payment connector"
            value={info.name}
            disabled={!!busy}
            onChange={(e) =>
              mutate("Switching connector…", () => api("/connector", { name: e.target.value }))
            }
          >
            <option value="airwallex">Airwallex</option>
            <option value="paypal">PayPal</option>
          </select>
          <span className={"badge " + (info.mode === "sandbox" ? "allow" : "")}>
            {info.mode === "sandbox" ? "sandbox · test money" : "mock"}
          </span>
          <span className="badge">{info.planner}</span>
          <span
            className={"badge " + (live === "live" ? "allow" : "deny")}
            title={lastEvent ? "Last event: " + lastEvent : "Live updates"}
          >
            {live === "live" ? "● live" : live}
          </span>
          <button
            className="subtle"
            data-testid="clean-demo"
            disabled={!!busy || safety?.status === "running"}
            title="Start a fresh session view. Nothing is deleted from the audit chain or the sandbox."
            onClick={() =>
              mutate("Starting a clean demo session…", async () => {
                await api("/demo/clean", {});
                setSelected("");
                refreshBalance();
              })
            }
          >
            ↺ Clean demo
          </button>
        </div>
      </header>
      <section className="hero">
        <div>
          <span className="eyebrow">PAYMENT OPERATIONS / CONTROL ROOM</span>
          <h2>
            Resolve the incident. <em>Never pay twice.</em>
          </h2>
          <p>Detect, diagnose, and act within policy. Human approval stays in the loop.</p>
        </div>
        <div className="stats">
          <div>
            <strong>{incidents.length}</strong>
            <span>Incidents</span>
          </div>
          <div>
            <strong className={pendingCount ? "amber" : ""}>{pendingCount}</strong>
            <span>Awaiting approval</span>
          </div>
          <div>
            <strong className={verify?.valid ? "green" : "red"}>
              {verify ? (verify.valid ? "✔ Verified" : "Broken") : "…"}
            </strong>
            <span>
              Audit chain · {verify?.sessionCount ?? 0} this session · {verify?.count ?? 0} total
            </span>
          </div>
        </div>
      </section>
      {error && (
        <div role="alert" className="error">
          {error}
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      <SafetyPanel
        run={safety}
        balanceNow={balance}
        verify={verify}
        busy={!!busy}
        onRun={runSafety}
        mode={info.mode}
      />
      <section className="simulator">
        <div>
          <h3>Simulate an incident</h3>
          <p>
            {info.mode === "mock"
              ? "Offline scenarios · no real funds move in mock mode"
              : "Airwallex sandbox · small test-money transfers, simulated status changes"}
          </p>
        </div>
        <div className="buttons">
          {[
            ["duplicate", "01 Duplicate payout"],
            ["bad-beneficiary", "02 Invalid beneficiary"],
            ["stuck", "03 Stuck transfer"],
            ["purchase", "04 Off-intent purchase"],
          ].map(([key, label]) => (
            <button
              key={key}
              data-testid={"scenario-" + key}
              disabled={!!busy || safety?.status === "running" || (info.mode !== "mock" && info.name !== "airwallex")}
              onClick={() => simulate(key)}
            >
              {label}
            </button>
          ))}
          <label className="check">
            <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
            Auto-run agent
          </label>
          {info.mode === "mock" && (
            <button
              className="subtle"
              disabled={!!busy}
              onClick={() => mutate("Resetting mock…", () => api("/reset", {}))}
            >
              Reset mock
            </button>
          )}
        </div>
      </section>
      <main>
        <section className="panel incidents">
          <div className="panel-title">
            <h3>Incident inbox</h3>
            <span>{incidents.length}</span>
          </div>
          {!incidents.length && (
            <div className="empty">
              All clear. Incidents appear here on their own (Airwallex polling or webhooks), or
              simulate one to explore the safeguards.
            </div>
          )}
          {incidents.map((i) => (
            <button
              className={"incident " + (i.id === incident?.id ? "selected" : "")}
              key={i.id}
              onClick={() => setSelected(i.id)}
            >
              <div className="row">
                <span>
                  <span className={"dot " + i.severity} />
                  <span className="tiny">{i.severity}</span>
                </span>
                <time>{azTime(i.detectedAt)}</time>
              </div>
              <strong>{i.title}</strong>
              <span className="row">
                <Status value={i.status} />
                {i.source && i.source !== "manual" && <span className="tiny">auto-detected ({i.source})</span>}
              </span>
            </button>
          ))}
        </section>
        <section className="panel detail">
          <div className="panel-title">
            <h3>Resolution workspace</h3>
            {incident && <Status value={incident.status} />}
          </div>
          {incident ? (
            <>
              <h2>{incident.title}</h2>
              <p className="mono">
                {incident.id.slice(0, 8)} · detected {azTime(incident.detectedAt)}
              </p>
              {(incident.status === "open" || incident.status === "running") && (
                <button
                  className="primary"
                  data-testid="run-agent"
                  disabled={!!busy || incident.status !== "open"}
                  onClick={() =>
                    mutate("Governed agent is diagnosing and checking policy…", () =>
                      api("/agent/run/" + incident.id, {}),
                    )
                  }
                >
                  {busy || incident.status === "running" ? (
                    <>
                      <Spinner /> Working…
                    </>
                  ) : (
                    "Run governed agent"
                  )}
                </button>
              )}
              {incident.diagnosis && (
                <div className="diagnosis">
                  <span className="eyebrow">DIAGNOSIS · {incident.planner}</span>
                  <p>{incident.diagnosis}</p>
                </div>
              )}
              {incident.actions?.map((a, index) => (
                <article className="action" key={index}>
                  <div className="action-title">
                    <strong>
                      {a.action.type} · {a.action.currency} {a.action.amount.toLocaleString()}
                    </strong>
                    <Status value={a.policy.decision} />
                  </div>
                  <p className="mono">{a.action.reference}</p>
                  <ul>
                    {a.policy.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                  {a.outcome && (
                    <p className={"outcome " + statusKind(a.outcome.startsWith("Awaiting") ? "awaiting" : a.outcome).cls}>
                      <span aria-hidden>{statusKind(a.outcome.startsWith("Awaiting") ? "awaiting" : a.outcome).icon}</span>{" "}
                      {a.outcome}
                    </p>
                  )}
                </article>
              ))}
            </>
          ) : (
            <div className="empty">Select an incident to inspect the diagnosis and policy decisions.</div>
          )}
        </section>
        <section className="panel approvals" data-testid="approvals">
          <div className="panel-title">
            <h3>Human approvals</h3>
            <span className="tiny">Policy is rechecked before execution</span>
          </div>
          <div className="approval-inputs">
            <label>
              Approver
              <input value={approver} onChange={(e) => setApprover(e.target.value)} />
            </label>
            <label>
              Decision note
              <input
                value={note}
                data-testid="approval-note"
                placeholder="Reason or verification context"
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          </div>
          {!approvals.length && (
            <div className="empty">Escalated actions appear here. Try the invalid beneficiary scenario.</div>
          )}
          {approvals.map((a) => (
            <article className="action" key={a.id}>
              <div className="action-title">
                <strong>
                  {a.action.type} · {a.action.currency} {a.action.amount}
                </strong>
                <Status value={a.status} />
              </div>
              <p className="mono">{a.action.reference}</p>
              {a.action.type === "repair" && (
                <p>
                  Approval records a manual verification task. Verified bank details are required
                  before payment.
                </p>
              )}
              {a.status === "pending" ? (
                <div className="buttons">
                  <button
                    className="primary"
                    data-testid="approve"
                    disabled={!!busy || !approver.trim()}
                    onClick={() =>
                      mutate("Rechecking policy, then recording approval…", () =>
                        api("/approvals/" + a.id + "/approve", { approver, note }),
                      )
                    }
                  >
                    Approve
                  </button>
                  <button
                    disabled={!!busy || !approver.trim()}
                    onClick={() =>
                      mutate("Recording denial…", () => api("/approvals/" + a.id + "/deny", { approver, note }))
                    }
                  >
                    Deny
                  </button>
                </div>
              ) : (
                <p className="outcome">
                  <Status value={a.outcome?.startsWith("Manual") ? "manual" : a.status} /> {a.outcome}
                  <br />
                  <span className="sub">
                    {a.approver}
                    {a.note ? " · " + a.note : ""}
                  </span>
                </p>
              )}
            </article>
          ))}
        </section>
        <section className="panel timeline" data-testid="timeline">
          <div className="panel-title">
            <h3>Audit timeline</h3>
            <span className={"badge " + (verify?.valid ? "allow" : "deny")} data-testid="chain-badge">
              {verify?.valid ? "✔ Chain verified" : "Chain unverified"}
            </span>
          </div>
          <p className="muted">
            Append-only events · SHA-256 hash chain · newest first · times in Arizona (AZ)
          </p>
          <div className="events">
            {[...audit].reverse().map((e) => (
              <details key={e.seq}>
                <summary>
                  <span className="event-number">{e.seq.toString().padStart(4, "0")}</span>
                  <strong>{e.event}</strong>
                  <span className="gloss">{summarize(e)}</span>
                  <span className="hash">{e.hash.slice(0, 10)}…</span>
                  <time>{azTime(e.timestamp)}</time>
                </summary>
                <pre>{JSON.stringify(e.data, null, 2)}</pre>
                <p className="mono">SHA-256 {e.hash}</p>
              </details>
            ))}
            {!audit.length && <div className="empty">Agent actions and policy decisions will be recorded here.</div>}
          </div>
        </section>
      </main>
      <footer>
        ATLAS INCIDENT COMMANDER{" "}
        <span>Built by Joshua Laliberte · Hackathon prototype · {info.mode} mode</span>
      </footer>
    </div>
  );
}
/** Scenario switcher: Kit 3 (payment incidents) is the default; Kit 11 (x402 business agents) second. */
function Root() {
  const [kit, setKit] = useState<"kit3" | "kit11">(location.hash === "#kit11" ? "kit11" : "kit3");
  useEffect(() => {
    const on = () => setKit(location.hash === "#kit11" ? "kit11" : "kit3");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const pick = (k: "kit3" | "kit11") => {
    history.replaceState(null, "", k === "kit11" ? "#kit11" : location.pathname);
    setKit(k);
  };
  return (
    <>
      <nav className="kit-switch" aria-label="Scenario">
        <button className={kit === "kit3" ? "on" : ""} data-testid="kit-kit3" onClick={() => pick("kit3")}>
          Kit 3 · Payment incidents
        </button>
        <button className={kit === "kit11" ? "on" : ""} data-testid="kit-kit11" onClick={() => pick("kit11")}>
          Kit 11 · x402 Business Agents
        </button>
      </nav>
      {kit === "kit3" ? <Kit3App /> : <Kit11App />}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Root />);
