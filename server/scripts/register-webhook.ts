/**
 * Airwallex webhook subscription helper (Airwallex supports this via API:
 * POST /api/v1/webhooks/create, GET /api/v1/webhooks — https://www.airwallex.com/docs/api/webhooks/webhooks).
 *
 *   npm run webhook:register -w server -- --list
 *       Read-only: list existing API-created webhooks (ids, urls, events; never secrets).
 *   npm run webhook:register -w server -- --url https://<public-host>/webhooks/airwallex
 *       DRY RUN (default): prints the exact request it would send. Nothing is created.
 *   npm run webhook:register -w server -- --url https://<public-host>/webhooks/airwallex --create
 *       Creates the subscription and writes the returned secret into ../.env as
 *       AIRWALLEX_WEBHOOK_SECRET. The secret is never printed.
 *
 * Note from the Airwallex docs: webhooks created through the API are not shown in the web app's
 * Developer > Webhooks page; use --list to see them.
 */
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");
dotenv.config({ path: envPath, quiet: true } as any);
const { AirwallexConnector } = await import("../src/connectors/airwallex.js");
const { SUBSCRIBED_EVENTS } = await import("../src/live/webhook.js");

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const value = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const aw = new AirwallexConnector();
if (aw.mode !== "sandbox") {
  console.error("Set AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY in .env first.");
  process.exit(1);
}
const redact = (w: any) => ({ id: w.id, url: w.url, version: w.version, events: w.events, created_at: w.created_at });

if (flag("--list")) {
  const d = await aw.api("GET", "/api/v1/webhooks");
  const items = d.items || [];
  console.log(`${items.length} API-created webhook(s):`);
  for (const w of items) console.log(JSON.stringify(redact(w)));
  process.exit(0);
}
const url = value("--url");
if (!url || !/^https:\/\/[^/]+\/webhooks\/airwallex$/.test(url)) {
  console.error("Pass --url https://<public-host>/webhooks/airwallex (HTTPS, ending in /webhooks/airwallex).");
  process.exit(1);
}
const body = {
  url,
  events: SUBSCRIBED_EVENTS,
  version: value("--version") || process.env.AIRWALLEX_WEBHOOK_VERSION || "2025-06-30",
  request_id: randomUUID(),
};
if (!flag("--create")) {
  console.log("DRY RUN, nothing created. Would send POST /api/v1/webhooks/create with:");
  console.log(JSON.stringify(body, null, 2));
  console.log("Re-run with --create to register it.");
  process.exit(0);
}
const w = await aw.api("POST", "/api/v1/webhooks/create", body);
console.log("Created webhook:", JSON.stringify(redact(w)));
if (w.secret) {
  let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  env = env.replace(/^AIRWALLEX_WEBHOOK_SECRET=.*\n?/m, "");
  if (env && !env.endsWith("\n")) env += "\n";
  writeFileSync(envPath, env + `AIRWALLEX_WEBHOOK_SECRET=${w.secret}\n`);
  chmodSync(envPath, 0o600);
  console.log("Saved the webhook secret to .env as AIRWALLEX_WEBHOOK_SECRET (not printed). Restart the server.");
} else console.log("Airwallex returned no secret; copy it from the web app into AIRWALLEX_WEBHOOK_SECRET.");
