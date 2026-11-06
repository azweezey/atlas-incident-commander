# Sandbox credentials setup

Nothing here costs money; both are test environments. Keep keys in a local `.env` file (git-ignored), never in the repo.

## Airwallex sandbox (Client ID + API key)

Docs: https://www.airwallex.com/docs/developer-tools/sandbox-environment

1. Open the sandbox sign-up page: https://www.sandbox.airwallex.com/global/signup (also reachable from the "Get started in sandbox" button on the docs page above).
2. Enter business email, name, business country (United States) and a password, then click **Create sandbox account**. Sandbox accounts are activated instantly with test wallet balances and default beneficiaries.
   - If you ever add another entity, its name must be **"New Business Sandbox"** or **"Sandbox Business"**, otherwise it stays stuck "In review".
3. In the sandbox web app go to **Account > Developer > API keys** (newer UI: **Settings > Developer > API keys**) and generate a key. Copy the **Client ID** and **API key** immediately (the key is shown once). Docs: https://www.airwallex.com/docs/developer-tools/api/manage-api-keys
   - Leave the IP allowlist empty for local development.
4. Put them in `.env`:
   ```
   AIRWALLEX_CLIENT_ID=...
   AIRWALLEX_API_KEY=...
   AIRWALLEX_BASE_URL=https://api.sandbox.airwallex.com
   ```
5. Check they work (token lasts 30 minutes):
   ```sh
   curl -X POST https://api.sandbox.airwallex.com/api/v1/authentication/login \
     -H 'Content-Type: application/json' \
     -H "x-client-id: $AIRWALLEX_CLIENT_ID" \
     -H "x-api-key: $AIRWALLEX_API_KEY"
   ```
   Then `curl https://api.sandbox.airwallex.com/api/v1/balances/current -H "Authorization: Bearer <token>"`.

Hackathon note: the hackathon site (https://airwallex.hackerearth.com/) says every registered participant gets Airwallex sandbox access and workshops, and lists free Claude tokens among partner perks. Watch for instructions in the acceptance email (accepted teams are notified around Oct 27). The self-serve sandbox above works today and does not depend on that email.

6. Run the four scenarios against the sandbox: `npm run sandbox:run -w server` (writes `docs/SANDBOX_RUN_LOG.md`). The default sandbox account already holds test funds (10,000,000 each of USD, EUR, GBP and CNY), so no funding is needed.

### Airwallex MCP servers (optional, not installed)

Airwallex publishes MCP servers for AI coding agents (https://www.airwallex.com/docs/developer-tools/ai/developer-connector):
- **Developer MCP** (sandbox, OAuth login): `https://mcp.sandbox.airwallex.com/developer`, with docs search, sandbox simulation tools and some endpoints.
- **Docs MCP**: documentation-only, no authentication.
- **AgentOS MCP** + Airwallex CLI act on a **production** account (https://www.airwallex.com/docs/developer-tools/ai/agentos). Do not use it for this project.


## PayPal sandbox (Client ID + Client Secret)

Docs: https://developer.paypal.com/api/rest/ and https://developer.paypal.com/payouts/use-payouts/set-up

1. Go to https://developer.paypal.com/ and click **Log in to Dashboard** (use a PayPal account or sign up). A sandbox environment with one **business** and one **personal** test account is created automatically.
2. Make sure the dashboard toggle is on **Sandbox**, open **Apps & Credentials**, and either use the **Default Application** or click **Create App**: App name `Atlas Incident Commander`, Type **Merchant**, sandbox business account = the default business test account. Click **Create App**.
3. Copy the **Client ID** and **Secret** from the app details page. In the app's features, make sure **Payouts** is enabled for sandbox testing (sandbox Payouts does not need the live Payouts approval).
4. Put them in `.env`:
   ```
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
   ```
5. Check they work:
   ```sh
   curl -X POST https://api-m.sandbox.paypal.com/v1/oauth2/token \
     -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -d "grant_type=client_credentials"
   ```
6. Test-account logins (to watch money move): **Testing Tools > Sandbox Accounts > ⋮ > View/Edit Account**, then sign in at https://www.sandbox.paypal.com/signin.
7. Payouts test values (https://developer.paypal.com/api/payouts/test-go-live): put `POSPYO001` in `items[0].note` for a simulated success, or `ERRPYO002` for a simulated `SENDER_EMAIL_UNCONFIRMED` error. Useful for the failed-payout scenario.

## Claude (optional)

Set `ANTHROPIC_API_KEY` (from https://console.anthropic.com/) to switch the planner from rule-based to Claude. Without it, the demo still runs.
