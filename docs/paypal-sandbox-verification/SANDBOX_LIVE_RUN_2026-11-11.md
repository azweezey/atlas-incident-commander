# PayPal sandbox live run — November 11, 2026

Run started: Nov 11, 2026, 9:40:15 AM America/Phoenix (MST)
Run finished: Nov 11, 2026, 9:40:44 AM America/Phoenix (MST)
Endpoint: `https://api-m.sandbox.paypal.com` (sandbox only; test money).
Connector: PayPal, mode: sandbox. Planner: rule-based (Claude disabled for this run).
Recipient: configured sandbox personal account mapped from allowlisted vendor `vendor-acme` (`PAYPAL_SANDBOX_RECEIVER_EMAIL`, domain `personal.example.com`).
Amount: $1.00 USD plus PayPal's sandbox payout fee. No live/production API calls were made.
Credentials and access tokens are not recorded in this file.

## Results

| Scenario | Result | Details |
| --- | --- | --- |
| OAuth client-credentials token fetch | **PASS** | HTTP 200 Bearer token, expires_in 32313s |
| Governed plan + policy (human approval required, autoLimit=0 in PayPal sandbox) | **PASS** | incident `c92dd47a-cdad-47d9-8401-84c47319fa04` → awaiting_approval; policy escalate (spend-limit); idempotencyKey `pp-c92dd47a-cdad-47d9-8401-84c47319fa04`; creates before approval: 0 |
| Execute the planned payout before approval | **PASS** | Blocked: Irreversible money movement requires human approval at or above the automatic limit |
| Real sandbox payout create after human approval ($1.00 USD) | **PASS** | batch `DRC79NSTMWMZC`; initial item PENDING; batch_status PENDING; 1 USD |
| Item-level status read (batch SUCCESS alone is not treated as paid) | **PASS** | batch `DRC79NSTMWMZC`; item SUCCESS; Atlas status succeeded; batch_status PROCESSING; txn `34H77350B4423192U` |
| Duplicate payout denial via sender_batch_id idempotency | **PASS** | raw HTTP 400 USER_BUSINESS_ERROR; Batch with given sender_batch_id already exists; connector: PayPal request: 400 |
| Governed re-execution of the same approved action is blocked (including after restart) | **PASS** | Blocked: Irreversible money movement requires human approval at or above the automatic limit; Completed idempotency key cannot be reused; Same beneficiary, amount, currency and reference already paid or pending within 24 hours / after restart: Blocked: Irreversible money movement requires human approval at or above the automatic limit; Completed idempotency key cannot be reused; Same beneficiary, amount, currency and reference already paid or pending within 24 hours |
| Audit chain verifies | **PASS** | 17 entries, valid=true |

## Item-status polls

| Attempt | Time (America/Phoenix) | Atlas status | Item transaction_status | Batch status | Transaction id |
| --- | --- | --- | --- | --- | --- |
| 1 | Nov 11, 2026, 9:40:20 AM America/Phoenix (MST) | pending / PENDING | PENDING | PENDING | — |
| 2 | Nov 11, 2026, 9:40:26 AM America/Phoenix (MST) | pending / PENDING | PENDING | PROCESSING | — |
| 3 | Nov 11, 2026, 9:40:33 AM America/Phoenix (MST) | pending / PENDING | PENDING | PROCESSING | — |
| 4 | Nov 11, 2026, 9:40:40 AM America/Phoenix (MST) | succeeded / SUCCESS | SUCCESS | PROCESSING | 34H77350B4423192U |

## Policy decisions

- After `simulate("paypal-payout")` and `run`: policy decision **escalate** (rule hits: spend-limit).
- Reasons: Irreversible money movement requires human approval at or above the automatic limit.
- PayPal sandbox execution policy sets `autoLimit: 0`, so every money movement requires human approval even at $1.00.
- Unapproved execute outcome: Blocked: Irreversible money movement requires human approval at or above the automatic limit.
- Approval by Joshua Laliberte (sandbox run) authorized exactly one $1.00 USD payout with idempotency key `pp-c92dd47a-cdad-47d9-8401-84c47319fa04`.
- Re-execute after settlement: Blocked: Irreversible money movement requires human approval at or above the automatic limit; Completed idempotency key cannot be reused; Same beneficiary, amount, currency and reference already paid or pending within 24 hours.
- Re-execute after process restart against the same audit journal: Blocked: Irreversible money movement requires human approval at or above the automatic limit; Completed idempotency key cannot be reused; Same beneficiary, amount, currency and reference already paid or pending within 24 hours.

## sender_batch_id idempotency

A second `POST /v1/payments/payouts` reused sender_batch_id `pp-c92dd47a-cdad-47d9-8401-84c47319fa04`.
PayPal responded HTTP 400 name=`USER_BUSINESS_ERROR` message="User business error.".
Details:
- field: `SENDER_BATCH_ID`; issue: Batch with given sender_batch_id already exists
The Atlas connector retry threw `PayPal request: 400`. It does not currently map this error onto a `providerDuplicate` payout object; the denial is still at the PayPal API layer, and the governed executor also blocks a second send via the reserved/completed idempotency key.

## HTTP calls (paths and status only)

| Time (UTC) | Method | Host | Path | HTTP |
| --- | --- | --- | --- | --- |
| 2026-11-11T16:40:17.638Z | POST | api-m.sandbox.paypal.com | /v1/oauth2/token | 200 |
| 2026-11-11T16:40:18.202Z | POST | api-m.sandbox.paypal.com | /v1/payments/payouts | 201 |
| 2026-11-11T16:40:19.556Z | GET | api-m.sandbox.paypal.com | /v1/payments/payouts/DRC79NSTMWMZC | 200 |
| 2026-11-11T16:40:20.007Z | GET | api-m.sandbox.paypal.com | /v1/payments/payouts/DRC79NSTMWMZC | 200 |
| 2026-11-11T16:40:20.465Z | GET | api-m.sandbox.paypal.com | /v1/payments/payouts/DRC79NSTMWMZC | 200 |
| 2026-11-11T16:40:26.043Z | GET | api-m.sandbox.paypal.com | /v1/payments/payouts/DRC79NSTMWMZC | 200 |
| 2026-11-11T16:40:26.657Z | GET | api-m.sandbox.paypal.com | /v1/payments/payouts/DRC79NSTMWMZC | 200 |
| 2026-11-11T16:40:31.947Z | GET | api-m.sandbox.paypal.com | /v1/payments/payouts/DRC79NSTMWMZC | 200 |
| 2026-11-11T16:40:33.609Z | GET | api-m.sandbox.paypal.com | /v1/payments/payouts/DRC79NSTMWMZC | 200 |
| 2026-11-11T16:40:38.837Z | GET | api-m.sandbox.paypal.com | /v1/payments/payouts/DRC79NSTMWMZC | 200 |
| 2026-11-11T16:40:40.420Z | GET | api-m.sandbox.paypal.com | /v1/payments/payouts/DRC79NSTMWMZC | 200 |
| 2026-11-11T16:40:40.943Z | GET | api-m.sandbox.paypal.com | /v1/payments/payouts/DRC79NSTMWMZC | 200 |
| 2026-11-11T16:40:41.413Z | POST | api-m.sandbox.paypal.com | /v1/payments/payouts | 400 |
| 2026-11-11T16:40:42.765Z | POST | api-m.sandbox.paypal.com | /v1/payments/payouts | 400 |
| 2026-11-11T16:40:43.189Z | GET | api-m.sandbox.paypal.com | /v1/payments/payouts/DRC79NSTMWMZC | 200 |
| 2026-11-11T16:40:43.544Z | POST | api-m.sandbox.paypal.com | /v1/oauth2/token | 200 |
| 2026-11-11T16:40:43.961Z | GET | api-m.sandbox.paypal.com | /v1/payments/payouts/DRC79NSTMWMZC | 200 |

No Authorization headers, access tokens, or client credentials are stored here. Machine-readable copy: [SANDBOX_LIVE_RUN_2026-11-11.json](SANDBOX_LIVE_RUN_2026-11-11.json).

Overall: **PASS**.
