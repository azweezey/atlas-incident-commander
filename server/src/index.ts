import dotenv from "dotenv";
dotenv.config({ path: [".env", "../.env"], quiet: true } as any);
const { createApp } = await import("./app.js");
const { Commander } = await import("./service.js");
const { TransferPoller } = await import("./live/poller.js");
const port = Number(process.env.PORT || 4000);
const commander = new Commander();
let poller;
const aw = commander.connectors.airwallex;
if (aw.mode === "sandbox" && process.env.AIRWALLEX_POLL !== "off") {
  poller = new TransferPoller(commander, aw).start();
  const o = poller.opts;
  console.log(
    `Polling Airwallex transfers every ${o.intervalMs / 1000}s (stuck after ${o.stuckMs / 1000}s, lookback ${o.lookbackMs / 60000} min)`,
  );
}
if (!process.env.AIRWALLEX_WEBHOOK_SECRET)
  console.log(
    "Webhook POST /webhooks/airwallex is DISABLED (fail closed): AIRWALLEX_WEBHOOK_SECRET is not set. Polling still works.",
  );
createApp(commander, { poller }).listen(port, "127.0.0.1", () =>
  console.log(`Atlas Incident Commander listening on http://localhost:${port}`),
);
