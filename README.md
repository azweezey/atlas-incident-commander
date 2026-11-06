# Atlas Incident Commander

A governed AI agent that investigates payment incidents and prevents duplicate payments. Built by **Joshua Laliberte** for the Airwallex Agentic Banking Hackathon (Tracks 3 and 2) and PayPal AI Hackathon.

Money-moving agents need more than a plausible diagnosis: they need explicit spending authority, duplicate checks, human escalation, and an inspectable record of every decision. Atlas separates planning from authorization and execution. It runs fully offline in mock mode after dependencies are installed, with no API keys or remote assets.

## Quickstart

Requires Node.js 22.12+ and npm 10+.

```bash
npm install
npm run dev
```

Open http://localhost:5173. The API listens on http://localhost:4000. Simulate an incident, select it, and click **Run governed agent**. Try **Invalid beneficiary** to exercise the approval queue. Approvals require an operator name; an optional note is recorded in the audit log.

```bash
npm test          # server unit and end-to-end tests
npm run build    # server TypeScript check, web TypeScript check and Vite build
npm run start:server
npm run start:web
```

The start scripts run the server with tsx and the frontend with Vite. The dashboard updates live over Server-Sent Events (`/api/events`), with a slow 15-second poll as a fallback. No API keys are needed for any mock scenario. The server binds to localhost. Install-time dependency downloads require network access; running mock mode does not.

## Configuration

Copy `.env.example` to `.env`, or `server/.env.example` to `server/.env`. Existing environment variables take precedence. Server-local configuration takes precedence over root configuration when using the workspace scripts.

| Variable | Default / purpose |
| --- | --- |
| `PORT` | `4000`; if changed, update the Vite proxy target as well |
| `CONNECTOR` | `airwallex`; alternatively `paypal` |
| `AIRWALLEX_CLIENT_ID` | Airwallex sandbox client ID |
| `AIRWALLEX_API_KEY` | Airwallex sandbox API key; both credentials enable sandbox mode |
| `AIRWALLEX_BASE_URL` | `https://api.sandbox.airwallex.com` |
| `PAYPAL_CLIENT_ID` | PayPal sandbox client ID |
| `PAYPAL_CLIENT_SECRET` | PayPal sandbox secret; both credentials enable sandbox mode |
| `PAYPAL_BASE_URL` | `https://api-m.sandbox.paypal.com` |
| `ANTHROPIC_API_KEY` | Optional Claude planner; omit for deterministic offline planning |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5` |
| `METAL_RPC_URL` | Kit 11: Metal testnet RPC URL (secret); unset = labelled simulation |
| `METAL_MODE` | Kit 11: `testnet` or `simulation`; see [docs/KIT11_X402.md](docs/KIT11_X402.md) |
| `AUDIT_LOG_PATH` | `server/data/audit.jsonl`; absolute override recommended |

The provider toggle changes the active connector at runtime. Each connector has separate mock data and approvals. The mode badge reflects the credentials for that connector. The header planner badge indicates the configured planner; the incident and audit record show the actual planner used, including rule-based fallback.

Edit `server/src/policy/config.ts` to configure limits and the beneficiary allowlist. Current defaults:

- Under $500: automatic execution if all other rules pass.
- $500 through $5,000: human approval required for money movement.
- Above $5,000: denied by the approval ceiling; above $10,000 also hits the absolute hard-cap rule.
- Only USD is enabled; unsupported currencies are denied rather than compared without FX conversion.
- Same beneficiary + amount + currency + normalized reference within 24 hours: deny when already succeeded or pending. References are trimmed and compared case-insensitively.
- Completed idempotency keys remain blocked regardless of age. Pending/uncertain keys remain reserved. Retries require a confirmed failed original payout and identical payment identity.
- Purchases require a trusted user intent containing merchant category, exact item, and maximum budget. Mismatch or budget overrun is denied; an in-intent purchase can still require spending approval.

## Mock and sandbox

Mock providers keep payouts in memory and use deterministic fixture beneficiaries. Successful payments and execution reservations are also recorded in the audit journal, so restarting does not discard duplicate protection. Incidents and approval queues are session-local and are not restored after restart. Mock reset clears the selected provider's demo state and establishes a new journal epoch for that provider; it never deletes audit entries.

Sandbox credentials activate real provider HTTP requests. Use only test credentials and sandbox URLs.

**Airwallex (tested against the real sandbox on Oct 27, 2026; see [docs/SANDBOX_RUN_LOG.md](docs/SANDBOX_RUN_LOG.md)).** The adapter:

- logs in at `POST /api/v1/authentication/login`, caches the token and refreshes it 5 minutes before its 30-minute `expires_at` (and once more on a 401);
- reads `GET /api/v1/balances/current`;
- maps the policy allowlist ids `vendor-acme` / `vendor-bad` to sandbox contacts, found by nickname (`GET /api/v1/beneficiaries?nick_name=`) or validated (`POST /api/v1/beneficiaries/validate`) and created (`POST /api/v1/beneficiaries/create`) once;
- creates transfers with `POST /api/v1/transfers/create` using the Atlas idempotency key as `request_id`. If Airwallex answers `400 duplicate_request_id`, the adapter returns the existing transfer (flagged `providerDuplicate`) instead of paying again. If the outcome is unknown (timeout, 409, 5xx) it looks the transfer up with `GET /api/v1/transfers?request_id=` before giving up;
- maps statuses conservatively: only `PAID` is `succeeded`; `SCHEDULED`, `PROCESSING`, `SENT` and `OVERDUE` stay `pending`; `FAILED`, or `CANCELLED` with a failure object, is `failed`;
- treats a beneficiary as invalid when Airwallex validation fails or a transfer to it failed for account/routing reasons since its last update;
- cancels with `POST /api/v1/transfers/{id}/cancel` (Airwallex only allows NEW or FAILED transfers);
- drives sandbox incidents with `POST /api/v1/simulation/transfers/{id}/transition`.

In Airwallex sandbox mode, the dashboard's scenario buttons create small real test-money transfers ($12 duplicate, $5 bad beneficiary, $7 stuck; the purchase scenario moves no money). Run all four headless with `npm run sandbox:run -w server`, which regenerates the run log. Sandbox quirks seen on Oct 27: `PROCESSING -> FAILED` returns `500 operation_failed`, so the bad-beneficiary setup goes `SENT -> FAILED`; a FAILED transfer then settles straight to `CANCELLED` with `failure.details.type = INCORRECT_ROUTING`.

PayPal uses OAuth client credentials and `/v1/payments/payouts`, with `sender_batch_header.sender_batch_id` for idempotency. Its status normalization uses the individual payout item's status: a completed batch alone does not prove the recipient was paid. The PayPal sandbox has not been tested with real credentials yet.

Provider references: [Airwallex transfers](https://www.airwallex.com/docs/api/payouts/transfers), [Airwallex transfer simulation](https://www.airwallex.com/docs/api/simulation/transfers/transition), [PayPal Payouts API](https://developer.paypal.com/docs/api/payments.payouts-batch/v1/).

Mock-only behaviour: reset, the 48-hour-old "stuck" transfer (a real sandbox transfer is minutes old, so sandbox uses the unresolved `PROCESSING` status as the stuck signal), and PayPal scenarios. There is no webhook ingestion yet. Airwallex history reads one page of up to 200 transfers from the last 30 days. This prototype is not sufficient for unattended production payments.

Beneficiary updates fail closed with an explicit manual-reconciliation error. PayPal supports cancellation of unclaimed items, not arbitrary batch reversal. The agent never fabricates replacement banking details: approving a repair records a manual verification task and does not send a payment. The `retryPayout` connector operation permits only confirmed failures; the governed executor uses `createPayout` with its explicitly audited idempotency key for retries.

## Live incident detection

Incidents also appear on their own, with no button press. See [docs/LIVE_UPDATES.md](docs/LIVE_UPDATES.md).

- **Polling fallback** (on automatically in sandbox mode): every 10s it reads recent Airwallex transfers and opens incidents for FAILED, CANCELLED, or PROCESSING longer than `AIRWALLEX_STUCK_AFTER_SECONDS` (default 120).
- **Webhooks:** `POST /webhooks/airwallex` verifies Airwallex's `x-timestamp` + `x-signature` HMAC-SHA256, rejects stale timestamps, dedupes by event id, and maps `payout.transfer.failed` / `cancelled` / `overdue` / `funding.*` into incidents. It **fails closed** (503) until `AIRWALLEX_WEBHOOK_SECRET` is set.
- Webhook, poller and manual simulations share one rule: **one incident per transfer**.
- Detected incidents run the governed agent automatically (policy, escalation and audit as usual; `ATLAS_AUTORUN=false` turns this off).
- To switch on real webhooks, use `npm run webhook:register -w server -- --url https://<host>/webhooks/airwallex --create` (or the web-app steps), with a public URL from `cloudflared tunnel --url http://localhost:4000`.

## Scenarios

| Slug | Trigger | Expected result |
| --- | --- | --- |
| `duplicate` | $1,200 invoice already paid; retry storm | Deny duplicate retry, inspect original payment, no second payout |
| `bad-beneficiary` | $250 payout rejected for invalid account/routing | Escalate verification task; approval records manual follow-up without changing details or paying |
| `stuck` | Pending transfer exceeds the 24-hour SLA | Reconcile current status and leave manual review if still pending |
| `purchase` | Agent asks for a $1,800 luxury watch; user authorized an office chair up to $400 | Deny off-intent and over-budget purchase |

## Live safety test

Click **Run Safety Test** on the dashboard (or `POST /api/safety/run`). In sandbox mode it creates and pays one legitimate $9 test-money invoice, then tries six unsafe actions against it: pay it twice, retry the paid payout, overspend ($7,500), pay an unapproved vendor, a $1,800 off-intent purchase, and a prompt injection planted in incident notes. Each attempt shows the rule that fired, the decision and the money moved. The double payment is also replayed directly to Airwallex to show the provider's `duplicate_request_id` refusal as a second layer. The balance is read before and after, and everything goes to the audit chain. **Clean demo** (`POST /api/demo/clean`) starts a fresh dashboard session without deleting audit history (`/api/audit?all=1` returns everything). Recorded clips and a director brief are in [media/](media/DIRECTOR_BRIEF.md).

## Kit 11: x402 Business Agents

A second scenario, on the **Kit 11** tab (Kit 3 above remains the default). Three business agents (sourcing, support, treasury) each spend under a capped **Metal mandate** and sell market-data queries over **x402** to a simulated customer's agent. Everything goes through the same policy engine, approval queue and audit chain: Metal refuses a purchase over the cap, a human must approve new mandate limits (the old credential is then refused), disputed orders are checked against the customer's signed orders and only the stale ones are refunded, and earnings move to **Airwallex (sandbox, test money)**, where a EUR licence is paid after approval via FX and SWIFT.

It runs on **Metal testnet** (\*USDZ test tokens, no value) when `METAL_RPC_URL` is set, and otherwise on a clearly labelled in-memory simulation (`METAL_MODE=testnet|simulation`). The customer and the upstream provider are run by us; the Airwallex deposit of the earnings is simulated because the sandbox can't receive stablecoins. Not mainnet. Details, a recorded run with testnet tx hashes and setup: [docs/KIT11_X402.md](docs/KIT11_X402.md). Clip: [media/x402-scenario.mp4](media/x402-scenario.mp4).

## Tests

Vitest covers duplicate invoice prevention, completed and pending keys, successful/pending retry prevention, different amounts, time windows, spend boundaries, allowlists, currencies, purchase intent, audit chain verification and tamper detection. Integration tests use a temporary `AUDIT_LOG_PATH`, disabled API credentials, and mock connectors. `test/airwallex.test.ts` replays recorded Airwallex sandbox responses through a stateful fake (`test/fakeAirwallex.ts`) to cover token caching/refresh, 401 re-login, beneficiary resolve/validate, `duplicate_request_id` handling, timeout recovery by `request_id`, status mapping, and all four scenarios in sandbox mode. `test/live.test.ts` covers webhook signature verification (good, bad, stale, missing secret), event-id and transfer-id dedupe, event mapping, restart memory, the SSE stream, and the poller (failed/stuck/healthy transfers, webhook + poller dedupe). `test/x402.test.ts` covers Kit 11 policy, the simulated Metal connector, the full scenario and its routes. They exercise the Express duplicate scenario and stale approval, concurrent payment approvals, uncertain provider responses, restart protection, repair/stuck/purchase flows, provider isolation, and reset history.

## Hackathon mapping

- **Airwallex Track 3:** Incident detection, governed diagnosis, explicit policy decisions, human escalation, safe execution, and an auditable banking agent workflow.
- **Airwallex Track 2:** Purchasing-agent requests bound to a trusted user intent, allowlist, spending limits, and human approval boundaries.
- **PayPal AI Hackathon:** The same governance layer with a PayPal mock/sandbox payout connector and provider-specific idempotency.

MIT licensed. Builder: Joshua Laliberte.

## Project docs

- [docs/KIT11_X402.md](docs/KIT11_X402.md): Kit 11 x402 Business Agents on Metal testnet + Airwallex sandbox.
- [docs/LIVE_UPDATES.md](docs/LIVE_UPDATES.md): webhooks, polling fallback, SSE dashboard, and how to switch on real webhooks.

- [Sandbox credential setup](docs/SANDBOX_SETUP.md)
- [Airwallex sandbox run log](docs/SANDBOX_RUN_LOG.md)
- [Demo video script](docs/DEMO_SCRIPT.md)
- [Build plan](docs/BUILD_PLAN.md)
