import type { AirwallexConnector } from "../connectors/airwallex.js";
import type { Commander } from "../service.js";
import { classifyTransfer } from "./detector.js";

export interface PollerOptions {
  intervalMs: number;
  stuckMs: number;
  lookbackMs: number;
}
export function pollerOptionsFromEnv(): PollerOptions {
  const n = (k: string, d: number) => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    intervalMs: n("AIRWALLEX_POLL_INTERVAL_SECONDS", 10) * 1000,
    stuckMs: n("AIRWALLEX_STUCK_AFTER_SECONDS", 120) * 1000,
    lookbackMs: n("AIRWALLEX_POLL_LOOKBACK_MINUTES", 15) * 60 * 1000,
  };
}

/** Polling fallback: works with no webhook configured. Dedupe with webhooks happens in Commander.ingestTransfer. */
export class TransferPoller {
  private timer?: NodeJS.Timeout;
  private running = false;
  status = { enabled: false, lastRunAt: "", lastError: "", checked: 0, created: 0 };
  constructor(
    private commander: Commander,
    private connector: AirwallexConnector,
    public opts: PollerOptions = pollerOptionsFromEnv(),
  ) {}
  start() {
    if (this.connector.mode !== "sandbox")
      throw new Error("Polling needs Airwallex sandbox credentials");
    this.status.enabled = true;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref?.();
    void this.tick();
    return this;
  }
  stop() {
    clearInterval(this.timer);
    this.status.enabled = false;
  }
  async tick(now = Date.now()) {
    if (this.running) return; // never overlap
    this.running = true;
    try {
      const since = new Date(now - this.opts.lookbackMs).toISOString();
      const transfers = await this.connector.listRecentTransfers(since);
      this.status.checked = transfers.length;
      for (const p of transfers) {
        const kind = classifyTransfer(p, this.opts.stuckMs, now);
        if (kind) {
          const r = await this.commander.ingestTransfer(p, { kind, source: "poller" });
          if (r.created) this.status.created++;
        } else await this.commander.observeTransfer(p, "poller");
      }
      this.status.lastError = "";
    } catch (e) {
      this.status.lastError = e instanceof Error ? e.message : String(e);
      console.warn("[poller]", this.status.lastError);
    } finally {
      this.status.lastRunAt = new Date().toISOString();
      this.running = false;
    }
  }
}
