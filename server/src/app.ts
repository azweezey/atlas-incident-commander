import express from "express";
import { z } from "zod";
import { Commander } from "./service.js";
import {
  DEFAULT_TOLERANCE_MS,
  INCIDENT_EVENTS,
  eventObject,
  parseEvent,
  verifySignature,
} from "./live/webhook.js";
import type { TransferPoller } from "./live/poller.js";
import { AirwallexConnector } from "./connectors/airwallex.js";
import { runSafetyTest } from "./safety/safetyTest.js";
import { X402Scenario, createMetal, preloadTestnet } from "./x402/scenario.js";
import { createTreasury } from "./x402/treasury.js";
import { kit11Config } from "./x402/config.js";
export function createApp(
  commander = new Commander(),
  opts: { poller?: TransferPoller; x402?: X402Scenario } = {},
) {
  const app = express();
  // Kit 11 (x402 Business Agents): separate scenario runner; shares the policy/approval/audit stack.
  const x402 =
    opts.x402 ??
    new X402Scenario(commander, createMetal, createTreasury(commander.connectors.airwallex), {
      paceMs: Number(process.env.X402_PACE_MS || 0),
      beatHoldMs: Number(process.env.X402_BEAT_HOLD_MS ?? (process.env.VITEST ? 0 : 3000)),
    });
  // Airwallex webhooks: raw body is required for signature verification, so this route
  // is mounted BEFORE the JSON parser. Verify -> dedupe by event id -> ack 200 -> process async.
  app.post(
    "/webhooks/airwallex",
    express.raw({ type: "*/*", limit: "256kb" }),
    (req, res) => {
      const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const tolerance = Number(process.env.AIRWALLEX_WEBHOOK_TOLERANCE_SECONDS) * 1000;
      const v = verifySignature({
        secret: process.env.AIRWALLEX_WEBHOOK_SECRET,
        timestamp: req.get("x-timestamp"),
        signature: req.get("x-signature"),
        rawBody: raw,
        toleranceMs: tolerance > 0 ? tolerance : DEFAULT_TOLERANCE_MS,
      });
      if (!v.ok) {
        if (v.status === 503) console.warn("[webhook] " + v.reason);
        return res.status(v.status).json({ error: v.reason });
      }
      let event;
      try {
        event = parseEvent(raw);
      } catch (e) {
        return res.status(400).json({ error: "Invalid event payload" });
      }
      if (commander.seenEvents.has(event.id))
        return res.status(200).json({ ok: true, duplicate: true });
      commander.seenEvents.add(event.id);
      res.status(200).json({ ok: true });
      void (async () => {
        const obj = eventObject(event);
        const isTransfer = event.name.startsWith("payout.transfer.") && obj?.id;
        await commander.exclusive(async () =>
          commander.audit.append("webhook.received", {
            eventId: event.id,
            eventName: event.name,
            createdAt: event.created_at,
            ...(isTransfer ? { transferId: obj.id, providerStatus: obj.status } : {}),
          }),
        );
        if (!isTransfer) return;
        const payout = commander.connectors.airwallex.normalize(obj);
        const kind = INCIDENT_EVENTS[event.name as keyof typeof INCIDENT_EVENTS];
        if (kind)
          await commander.ingestTransfer(payout, {
            kind,
            source: "webhook",
            eventId: event.id,
            eventName: event.name,
          });
        else await commander.observeTransfer(payout, "webhook", event.id);
      })().catch((e) => console.warn("[webhook] processing failed:", e?.message || e));
    },
  );
  app.use(express.json({ limit: "64kb" }));
  // Live updates (Server-Sent Events): one "audit" message per audit entry. Every incident,
  // plan, policy decision, approval and execution writes an audit entry, so the dashboard
  // refreshes on these instead of a page reload.
  app.get("/api/events", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write(`event: hello\ndata: ${JSON.stringify({ connector: commander.info() })}\n\n`);
    const onAudit = (e: { seq: number; event: string; timestamp: string; data: any }) =>
      res.write(
        `id: ${e.seq}\nevent: audit\ndata: ${JSON.stringify({
          seq: e.seq,
          event: e.event,
          timestamp: e.timestamp,
          incidentId: e.data?.incidentId ?? e.data?.incident?.id,
        })}\n\n`,
      );
    commander.bus.on("audit", onAudit);
    const onX402 = (e: { runId: string }) => res.write(`event: x402\ndata: ${JSON.stringify(e)}\n\n`);
    commander.bus.on("x402", onX402);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      commander.bus.off("audit", onAudit);
      commander.bus.off("x402", onX402);
    });
  });
  app.get("/api/live/status", (_req, res) =>
    res.json({
      webhook: {
        path: "/webhooks/airwallex",
        secretConfigured: Boolean(process.env.AIRWALLEX_WEBHOOK_SECRET),
      },
      poller: opts.poller
        ? { ...opts.poller.status, ...opts.poller.opts }
        : { enabled: false },
      autoRun: commander.autoRun,
    }),
  );
  const route =
    (fn: (req: express.Request) => unknown) =>
    async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      try {
        res.json(await fn(req));
      } catch (e) {
        next(e);
      }
    };
  app.get(
    "/api/health",
    route(() => ({ ok: true, ...commander.info() })),
  );
  app.get(
    "/api/connector",
    route(() => commander.info()),
  );
  app.post(
    "/api/connector",
    route((req) =>
      commander.exclusive(async () =>
        commander.switch(
          z.object({ name: z.enum(["airwallex", "paypal"]) }).parse(req.body)
            .name,
        ),
      ),
    ),
  );
  app.get(
    "/api/incidents",
    route(() =>
      commander.incidents.filter(
        (i) => i.connector === commander.selected && commander.inSession(i.detectedAt),
      ),
    ),
  );
  app.get(
    "/api/incidents/:id",
    route((req) => {
      const i = commander.incidents.find(
        (i) => i.id === req.params.id && i.connector === commander.selected,
      );
      if (!i) throw new Error("Incident not found");
      return i;
    }),
  );
  app.post(
    "/api/agent/run/:incidentId",
    route((req) =>
      commander.exclusive(() => commander.run(req.params.incidentId)),
    ),
  );
  app.get(
    "/api/approvals",
    route(() =>
      commander.queue.items.filter(
        (a) => a.connector === commander.selected && commander.inSession(a.createdAt),
      ),
    ),
  );
  for (const decision of ["approve", "deny"])
    app.post(
      `/api/approvals/:id/${decision}`,
      route((req) => {
        const body = z
          .object({
            approver: z.string().trim().min(1).max(100),
            note: z.string().max(1000).default(""),
          })
          .parse(req.body);
        return commander.exclusive(() =>
          commander.decide(
            req.params.id,
            decision === "approve",
            body.approver,
            body.note,
          ),
        );
      }),
    );
  app.get(
    "/api/audit",
    route((req) => {
      const all = commander.audit.entries();
      return req.query.all ? all : all.filter((e) => e.seq >= commander.session.startSeq);
    }),
  );
  app.get(
    "/api/audit/verify",
    route(() => {
      const v = commander.audit.verify();
      return {
        ...v,
        sessionCount: Math.max(0, (v.count ?? 0) - commander.session.startSeq + 1),
        session: commander.session,
      };
    }),
  );
  app.post(
    "/api/demo/clean",
    route(() => commander.exclusive(async () => commander.cleanDemo())),
  );
  app.get(
    "/api/safety",
    route(() => commander.safety ?? null),
  );
  app.post(
    "/api/safety/run",
    route(async (req) => {
      if (commander.safety?.status === "running") throw new Error("Safety test already running");
      const body = z
        .object({ paceMs: z.number().int().min(0).max(5000).default(0) })
        .parse(req.body ?? {});
      return commander.exclusive(() => runSafetyTest(commander, { paceMs: body.paceMs }));
    }),
  );
  // ---------- Kit 11: x402 Business Agents ----------
  app.get(
    "/api/x402",
    route(() => ({ run: x402.run, config: kit11Config })),
  );
  app.post(
    "/api/x402/run",
    route(async () => {
      if (x402.busy) throw new Error("Kit 11 scenario is already running");
      if (x402.run.mode === "testnet") await preloadTestnet();
      const { run, done } = x402.start();
      done.catch(() => {});
      return { run };
    }),
  );
  for (const decision of ["approve", "deny"])
    app.post(
      `/api/x402/approvals/:id/${decision}`,
      route(async (req) => {
        const body = z
          .object({
            approver: z.string().trim().min(1).max(100),
            note: z.string().max(1000).default(""),
          })
          .parse(req.body);
        const a = await x402.decide(String(req.params.id), decision === "approve", body.approver, body.note);
        return { approval: a, run: x402.run };
      }),
    );
  app.get(
    "/api/balance",
    route(async () => {
      const c = commander.connector;
      if (!(c instanceof AirwallexConnector) || c.mode !== "sandbox")
        return { mode: c.mode, currency: "USD", available: null };
      const usd = (await c.balances()).find((b) => b.currency === "USD");
      return { mode: c.mode, currency: "USD", available: usd ? Number(usd.available_amount) : null };
    }),
  );
  app.get(
    "/api/payouts",
    route(() => commander.connector.listPayouts()),
  );
  app.post(
    "/api/simulate/:scenario",
    route((req) =>
      commander.exclusive(async () => commander.simulate(req.params.scenario)),
    ),
  );
  app.post(
    "/api/reset",
    route(() => commander.exclusive(async () => commander.reset())),
  );
  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(
          error instanceof z.ZodError
            ? 400
            : /not found/i.test(error.message)
              ? 404
              : 409,
        )
        .json({ error: error.message });
    },
  );
  return app;
}
