# Live updates: webhooks, polling fallback, dashboard stream

Incidents now appear on their own. Two detectors feed one entry point (`Commander.ingestTransfer`), and the dashboard updates over Server-Sent Events.

```
Airwallex ──webhook──> POST /webhooks/airwallex ─┐
                                                 ├─> ingestTransfer (one incident per transfer id)
Airwallex <──poll───── TransferPoller (sandbox) ─┘        │
                                                          ├─> governed agent auto-run: plan -> policy -> escalate/execute
                                                          └─> audit log ──> GET /api/events (SSE) ──> dashboard
```

## 1. Webhook endpoint: `POST /webhooks/airwallex`

Implemented per [Listen for webhook events](https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events) and the [Webhooks overview](https://www.airwallex.com/docs/developer-tools/webhooks/webhooks-overview):

- **Signature:** `x-signature` must equal `hex(HMAC-SHA256(AIRWALLEX_WEBHOOK_SECRET, x-timestamp + raw body))`. The raw body is captured before JSON parsing (the route is mounted ahead of `express.json`) and compared in constant time.
- **Freshness:** `x-timestamp` is Unix **milliseconds**. Events older or newer than `AIRWALLEX_WEBHOOK_TOLERANCE_SECONDS` (default 300) are rejected with 400, checked after the signature as the docs describe.
- **Fail closed:** if `AIRWALLEX_WEBHOOK_SECRET` is not set, every request gets **503** with `Webhook secret not configured: set AIRWALLEX_WEBHOOK_SECRET…`, and the server logs it on startup. Airwallex retries non-200 deliveries with back-off for about 3 days, so nothing is lost while the secret is missing, and polling keeps working.
- **Dedupe:** the event `id` is stable across Airwallex retries. Seen ids get `200 {duplicate:true}` and nothing else happens. Accepted ids are written to the audit log (`webhook.received`) and reloaded on restart.
- **Fast ack:** responds 200 right after verification; processing runs asynchronously (as the docs recommend).
- **Payload:** for `payout.transfer.*` events, `data` *is* the transfer (same shape as `GET /api/v1/transfers/{id}`); other resources nest under `data.object`. Both are handled.
- **Test events from the web app:** the docs say these are signed with the secret in the event's `client-secret-key` header. We deliberately do **not** trust a secret supplied by the request itself, so a web-app test event only verifies if that secret equals `AIRWALLEX_WEBHOOK_SECRET`.

Event mapping (event names from [Transfer webhooks](https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events/transfers)):

| Event | Effect |
| --- | --- |
| `payout.transfer.failed` | Incident. Beneficiary/account/routing failure → `bad-beneficiary` (repair, escalated to a human); any other failure → `transfer-failed` (read-only reconcile → manual review, never auto-retried) |
| `payout.transfer.cancelled` | Incident. With a failure object (sandbox auto-cancels failed transfers) → treated as failed; otherwise `transfer-cancelled` |
| `payout.transfer.overdue`, `payout.transfer.funding.failed`, `payout.transfer.funding.reversed` | Incident `transfer-funding` (read-only reconcile → manual review) |
| `payout.transfer.processing` / `sent` / `paid` and other transfer events | No new incident; recorded as `transfer.status_observed` if the transfer already has an incident (e.g. a stuck transfer that later reaches PAID) |

Stuck-in-PROCESSING has no webhook event; the poller detects it.

## 2. Polling fallback (sandbox mode, no webhook needed)

Starts automatically when Airwallex credentials are present (`AIRWALLEX_POLL=off` disables it). Every `AIRWALLEX_POLL_INTERVAL_SECONDS` (10) it calls `GET /api/v1/transfers?from_created_at=<now − AIRWALLEX_POLL_LOOKBACK_MINUTES (15)>` and opens incidents for:

- `FAILED`, or `CANCELLED` with a failure object → failed
- `CANCELLED` → cancelled
- `PROCESSING` for longer than `AIRWALLEX_STUCK_AFTER_SECONDS` (120; use 30 for a snappy demo) → stuck

Ticks never overlap; errors are logged and shown in `GET /api/live/status`, not thrown.

**No duplicates:** webhook, poller, and the manual "Simulate" buttons all register the transfer id. A transfer gets **one** incident, whichever source sees it first; later sightings only add a `transfer.status_observed` audit entry when the status actually changes. Known transfer ids are rebuilt from `incident.detected` audit entries on restart.

**Auto-run:** live-detected incidents run the governed agent straight away (`ATLAS_AUTORUN=false` turns it off). This is safe because the planner is bound to the deterministic resolution scope and the policy engine gates every action: failed payouts are escalated or reconciled read-only, and nothing is retried automatically.

## 3. Dashboard live updates

`GET /api/events` is an SSE stream. It sends `hello` on connect, an `audit` message for every audit entry (incidents, plans, policy decisions, approvals, executions), and a keep-alive ping every 25s. The dashboard refreshes on each message (bursts are coalesced), shows a **● live** badge, tags auto-detected incidents with `auto-detected (poller|webhook)`, and keeps a slow 15s poll as a safety net. The Vite dev proxy forwards `/api/events` like any other `/api` route.

`GET /api/live/status` shows whether the webhook secret is configured, plus the poller's settings, last run, last error and how many incidents it has created.

## 4. Switching on real webhooks

Airwallex supports both routes ([Webhooks API](https://www.airwallex.com/docs/api/webhooks/webhooks): `POST /api/v1/webhooks/create`, `GET /api/v1/webhooks`, update, delete). Our sandbox key can read the webhooks API: `--list` returned 0 webhooks on Oct 27, 2026. **Nothing has been registered yet.**

### a) Public URL (demo): Cloudflare quick tunnel

`cloudflared` is installed on the build box at `~/.local/bin/cloudflared` (2026.10.5). Elsewhere, install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/.

```bash
npm run start:server                                  # terminal 1 (localhost:4000)
~/.local/bin/cloudflared tunnel --url http://localhost:4000   # terminal 2
# prints https://<random>.trycloudflare.com. Your notification URL is
#   https://<random>.trycloudflare.com/webhooks/airwallex
# Ctrl-C stops the tunnel. Don't leave it running after the demo.
```

The quick-tunnel URL changes every time it starts, so re-register (or update) the webhook after each restart. Only `/webhooks/airwallex` is meant for Airwallex, but the tunnel exposes the whole local API (dashboard API included, which has no auth), so run it only during the demo. Airwallex sends sandbox webhooks from 35.240.211.132, 35.187.239.216, 34.87.139.23, 136.110.35.143, 34.142.189.194 and 35.197.128.86, if you want to firewall.

### b1) Register by API script (recommended; writes the secret for you)

```bash
npm run webhook:register -w server -- --list                       # read-only
npm run webhook:register -w server -- --url https://<host>/webhooks/airwallex            # dry run, prints the request
npm run webhook:register -w server -- --url https://<host>/webhooks/airwallex --create   # creates it
```

`--create` subscribes to the events in the table above (API version `2025-06-30`; override it with `--version` or `AIRWALLEX_WEBHOOK_VERSION`). It saves the returned `secret` into `.env` as `AIRWALLEX_WEBHOOK_SECRET` without printing it. Restart the server afterwards. Per the Airwallex docs, API-created webhooks don't show up under Developer > Webhooks in the web app, so use `--list` to see them. Events can't be changed after creation, so delete and recreate the webhook to change them (or to change the URL, use `POST /api/v1/webhooks/{id}/update`).

### b2) Or register in the web app

1. Log in to the Airwallex **sandbox** web app (https://www.sandbox.airwallex.com) → **Developer** → **Webhooks**.
2. Click **New webhook**. Name: `atlas-incident-commander`. Notification URL: `https://<host>/webhooks/airwallex`. API version: leave the account default.
3. Select the events: Transfer → Failed, Cancelled, Overdue, Processing, Sent, Paid; Transfer → Funding → Failed, Reversed.
4. **Submit**, open the webhook, copy its **secret key** into `.env` as `AIRWALLEX_WEBHOOK_SECRET=…`, and restart the server.
5. To re-deliver an event while debugging, go to **Settings → Developer → Events**, pick the event and re-trigger it.

## Proof

- Real sandbox, polling: `npm run live:proof -w server` (results in `docs/SANDBOX_RUN_LOG.md`, "Live detection proof").
- Webhook handler: `server/test/live.test.ts` uses locally signed fake events (good/bad/stale signature, missing secret, event-id and transfer-id dedupe, restart memory, SSE stream, poller with the recorded-response fake).
