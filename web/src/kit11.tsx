import React, { useEffect, useRef, useState } from "react";

type BeatItem = { at: string; kind: string; text: string; tx?: string; link?: string };
type Beat = { id: string; n: number; title: string; subtitle: string; status: string; summary?: string; items: BeatItem[] };
type PublicMandate = { agent: string; id: string; version: number; cap: number; budget: number; spent: number; revoked: boolean; payees: string[]; bindTx?: string; link?: string };
type Order = { queryId: string; amount: number; tx: string; upstreamCost: number; verified?: boolean; refund?: { amount: number; tx?: string; outcome: string }; delivered?: any };
type Run = {
  id: string;
  status: "idle" | "running" | "waiting_approval" | "done" | "failed";
  mode: "testnet" | "simulation";
  metalLabel: string;
  network: string;
  treasuryMode: "sandbox" | "mock";
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
};

const AZ = new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", hour: "numeric", minute: "2-digit", second: "2-digit" });
const azTime = (iso?: string) => (iso ? AZ.format(new Date(iso)) + " AZ" : "");
const z = (n?: number) => (n == null ? "–" : n.toFixed(2));
const shortTx = (t?: string) => (t ? t.slice(0, 8) + "…" + t.slice(-4) : "");
const ICON: Record<string, string> = { ok: "✔", refused: "⛔", policy: "§", chain: "⛓", fiat: "€", approval: "⏸", warn: "⚠", info: "•" };

async function api(path: string, body?: unknown) {
  const r = await fetch("/api" + path, body !== undefined ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Request failed");
  return d;
}

function TxLink({ tx, link, sim }: { tx?: string; link?: string; sim: boolean }) {
  if (!tx) return null;
  if (sim || !link) return <span className="k11-tx mono" title={sim ? "Simulation hash — not on any chain" : tx}>{sim ? "sim " : ""}{shortTx(tx)}</span>;
  return (
    <a className="k11-tx mono" href={link} target="_blank" rel="noreferrer" title="Open on the Metal testnet explorer">
      {shortTx(tx)} ↗
    </a>
  );
}

function MandateCard({ m, sim }: { m: PublicMandate; sim: boolean }) {
  const pct = Math.min(100, (m.spent / m.budget) * 100);
  return (
    <div className={"k11-mandate" + (m.revoked ? " revoked" : "")} data-testid={"mandate-" + m.agent + "-v" + m.version}>
      <div className="row">
        <strong>{m.agent === "customer" ? "customer's agent" : m.agent + " agent"}</strong>
        <span className="badge">v{m.version}{m.revoked ? " · revoked" : ""}</span>
      </div>
      <div className="k11-bar"><span style={{ width: pct + "%" }} /></div>
      <div className="row tiny">
        <span>spent {z(m.spent)} / {m.budget} *USDZ</span>
        <span>cap {z(m.cap)} / payment</span>
      </div>
      <div className="tiny muted">pays only: {m.payees.join(", ")} {m.bindTx && <TxLink tx={m.bindTx} link={m.link} sim={sim} />}</div>
    </div>
  );
}

export function Kit11App({ approverDefault = "Josh (owner)" }: { approverDefault?: string }) {
  const [run, setRun] = useState<Run>();
  const [config, setConfig] = useState<any>();
  const [error, setError] = useState("");
  const [deciding, setDeciding] = useState("");
  const [verify, setVerify] = useState<{ valid: boolean; count: number }>();
  const [live, setLive] = useState("connecting");
  const [pinned, setPinned] = useState("");
  const activeRef = useRef<HTMLDivElement>(null);
  async function refresh() {
    const [d, v] = await Promise.all([api("/x402"), api("/audit/verify")]);
    setRun(d.run);
    setConfig(d.config);
    setVerify(v);
  }
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(pending);
      pending = setTimeout(() => refresh().catch((e) => setError(e.message)), 120);
    };
    refresh().catch((e) => setError(e.message));
    const es = new EventSource("/api/events");
    es.addEventListener("hello", () => setLive("live"));
    es.addEventListener("x402", soon);
    es.addEventListener("audit", soon);
    es.onerror = () => setLive("offline");
    const id = setInterval(soon, 2000);
    return () => {
      es.close();
      clearInterval(id);
      clearTimeout(pending);
    };
  }, []);
  const following = run?.beats.find((b) => b.status === "running" || b.status === "waiting");
  const active = (pinned && !following?.status.startsWith("wait") ? run?.beats.find((b) => b.id === pinned && b.status !== "pending") : undefined) ?? run?.beats.find((b) => b.status === "running" || b.status === "waiting") ?? run?.beats.filter((b) => b.status !== "pending").at(-1);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active?.id, active?.items.length]);
  if (!run) return <div className="shell"><p className="muted">Loading Kit 11…</p></div>;
  const sim = run.mode === "simulation";
  const running = run.status === "running" || run.status === "waiting_approval";
  const start = () => {
    setError("");
    setPinned("");
    api("/x402/run", {}).then((d) => setRun(d.run)).catch((e) => setError(e.message));
  };
  const decide = (approve: boolean) => {
    const p = run.pendingApproval;
    if (!p) return;
    setDeciding(approve ? (p.type === "x402.replace_mandates" ? (sim ? "Replacing mandates (simulation)…" : "Replacing mandates on Metal testnet…") : "Converting USD→EUR and sending SWIFT in the Airwallex sandbox…") : "Recording denial…");
    api(`/x402/approvals/${p.id}/${approve ? "approve" : "deny"}`, { approver: approverDefault, note: "" })
      .then((d) => setRun(d.run))
      .catch((e) => setError(e.message))
      .finally(() => setDeciding(""));
  };
  const agents = run.mandates.filter((m) => m.agent !== "customer");
  const customer = run.mandates.find((m) => m.agent === "customer");
  return (
    <div className="shell k11" data-testid="kit11">
      <header>
        <div className="brand">
          <span className="mark k11-mark">x</span>
          <div>
            <h1>
              Atlas <span>x402 Business Agents</span>
            </h1>
            <p>Agents earn, spend and refund on their own — inside limits a human sets.</p>
          </div>
        </div>
        <div className="connection">
          <span className={"badge " + (sim ? "escalate" : "allow")} data-testid="metal-mode" title={run.metalLabel}>
            {sim ? "Simulation · no chain" : "Metal testnet · test tokens"}
          </span>
          <span className={"badge " + (run.treasuryMode === "sandbox" ? "allow" : "")} title={run.treasuryLabel}>
            {run.treasuryMode === "sandbox" ? "Airwallex sandbox · test money" : "Airwallex mock"}
          </span>
          <span className="badge">{run.planner.startsWith("rule") ? "rule-based planner" : run.planner}</span>
          <span className={"badge " + (live === "live" ? "allow" : "deny")}>{live === "live" ? "● live" : live}</span>
        </div>
      </header>
      <section className="hero k11-hero">
        <div>
          <span className="eyebrow">KIT 11 / A DATA BUSINESS RUN BY AGENTS</span>
          <h2>
            Sell at {z(run.queryPrice)}. Buy under a cap. <em>Refund only what's wrong.</em>
          </h2>
          <p className="muted">
            Three agent mandates (sourcing · support · treasury), {config?.totalBudget ?? 20} *USDZ total held in code. Every action: policy → approval → execution → hash-chained audit.
          </p>
          <button className="primary" data-testid="x402-run" disabled={running} onClick={start}>
            {running ? <>Running… {run.status === "waiting_approval" ? "waiting for you" : ""}</> : run.status === "idle" ? "▶ Run the Kit 11 scenario" : "▶ Run again"}
          </button>
          {run.id && <span className="tiny muted k11-runid"> run {run.id} · started {azTime(run.startedAt)}{run.finishedAt ? " · finished " + azTime(run.finishedAt) : ""}</span>}
        </div>
        <div className="stats k11-ledger" data-testid="x402-ledger">
          <div><strong>{z(run.ledger.revenue)}</strong><span>Revenue</span></div>
          <div><strong>{z(run.ledger.upstream)}</strong><span>Upstream cost</span></div>
          <div><strong>{z(run.ledger.refunds)}</strong><span>Refunds</span></div>
          <div><strong className="green">{z(run.ledger.net)}</strong><span>Net · *USDZ (test)</span></div>
          <div>
            <strong className={verify?.valid ? "green" : "red"}>{verify ? (verify.valid ? "✔ Verified" : "Broken") : "…"}</strong>
            <span>Audit chain · {verify?.count ?? 0}</span>
          </div>
        </div>
      </section>
      {error && <div className="error" role="alert">{error}</div>}
      {run.error && <div className="error" role="alert">Run stopped: {run.error}</div>}
      <main className="k11-main">
        <section className="panel k11-steps">
          <div className="panel-title"><h3>Beats</h3><span>{run.beats.filter((b) => b.status === "done").length}/6</span></div>
          <ol>
            {run.beats.map((b) => (
              <li
                key={b.id}
                className={"k11-step " + b.status + (active?.id === b.id ? " shown" : "")}
                data-testid={"beat-" + b.id}
                title="Show this beat (click again to follow the run)"
                onClick={() => setPinned(pinned === b.id ? "" : b.id)}
              >
                <span className="k11-num">{b.status === "done" ? "✔" : b.status === "waiting" ? "⏸" : b.status === "failed" ? "✖" : b.n}</span>
                <div>
                  <strong>{b.title}</strong>
                  <p>{b.summary ?? b.subtitle}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
        <section className="panel k11-feed" data-testid="x402-feed">
          {!active && (
            <div className="empty">
              Press <strong>Run</strong>. The scenario sets up mandates, sells queries, hits an upstream price rise, asks you to approve new limits, handles a dispute,
              and moves earnings to Airwallex.
            </div>
          )}
          {active && (
            <div ref={activeRef}>
              <div className="panel-title">
                <h3>
                  Beat {active.n} · {active.title}
                </h3>
                <span className={"status " + (active.status === "done" ? "st-approved" : active.status === "waiting" ? "st-escalated" : active.status === "failed" ? "st-blocked" : "st-running")}>
                  {active.status === "running" ? <><span className="spinner" aria-hidden /> running</> : active.status}
                </span>
              </div>
              <p className="muted">{active.subtitle}</p>
              <ul className="k11-items">
                {active.items.map((i, n) => (
                  <li key={n} className={"k11-item " + i.kind}>
                    <span className="k11-icon">{ICON[i.kind] ?? "•"}</span>
                    <span className="k11-text">{i.text}</span>
                    <TxLink tx={i.tx} link={i.link} sim={sim} />
                    <time>{azTime(i.at)}</time>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {run.pendingApproval && (
            <div className="k11-approval" data-testid="x402-approval">
              <span className="eyebrow">OWNER APPROVAL REQUIRED</span>
              <h3>{run.pendingApproval.summary}</h3>
              <ul className="tiny">
                {run.pendingApproval.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <div className="buttons">
                <button className="primary" data-testid="x402-approve" disabled={!!deciding} onClick={() => decide(true)}>
                  ✔ Approve as {approverDefault}
                </button>
                <button data-testid="x402-deny" disabled={!!deciding} onClick={() => decide(false)}>
                  Deny
                </button>
              </div>
              {deciding && <p className="tiny"><span className="spinner" aria-hidden /> {deciding}</p>}
            </div>
          )}
        </section>
        <section className="panel k11-side">
          <div className="panel-title"><h3>Mandates</h3><span>{sim ? "simulated" : "bound on " + run.network}</span></div>
          {agents.map((m) => <MandateCard key={m.id} m={m} sim={sim} />)}
          {run.retired.map((m) => <MandateCard key={m.id} m={m} sim={sim} />)}
          {customer && <MandateCard m={customer} sim={sim} />}
          {!run.mandates.length && <div className="empty">No mandates yet.</div>}
          <div className="panel-title k11-orders-title"><h3>Orders</h3><span>query {z(run.queryPrice)} · upstream {z(run.upstreamPrice)}</span></div>
          <table className="k11-orders" data-testid="x402-orders">
            <thead><tr><th>Query</th><th>Paid</th><th>Upstream</th><th>Order</th><th>Refund</th></tr></thead>
            <tbody>
              {run.orders.map((o) => (
                <tr key={o.queryId}>
                  <td>{o.queryId}</td>
                  <td>{z(o.amount)}</td>
                  <td>{z(o.upstreamCost)}</td>
                  <td>{o.verified == null ? "signed" : o.verified ? "✔ verified" : "✖"}</td>
                  <td>{o.refund ? (o.refund.outcome === "paid" ? z(o.refund.amount) : o.refund.outcome) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
      <footer>
        KIT 11 · x402 BUSINESS AGENTS{" "}
        <span>
          {sim ? "Simulation mode: no chain, hashes are labeled sim." : "Metal testnet (chain 63825) with *USDZ test tokens — no mainnet, no real money."} Customer and upstream provider are simulated parties we run. Airwallex {run.treasuryMode}: earnings arrival is a simulated deposit.
        </span>
      </footer>
    </div>
  );
}
