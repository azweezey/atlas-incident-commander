import { it, expect, vi, afterEach } from "vitest";
import { AirwallexConnector } from "../src/connectors/airwallex.js";
import { PayPalConnector } from "../src/connectors/paypal.js";
const req = {
  beneficiaryId: "vendor-acme",
  amount: 100,
  currency: "USD",
  reference: "INV-42",
  idempotencyKey: "stable-key",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("Airwallex authenticates and sends request_id, reusing the token", async () => {
  vi.stubEnv("AIRWALLEX_CLIENT_ID", "test-id");
  vi.stubEnv("AIRWALLEX_API_KEY", "test-key");
  vi.stubEnv("AIRWALLEX_BASE_URL", "https://airwallex.invalid");
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ token: "bearer" }))
    .mockResolvedValueOnce(Response.json({ id: "transfer", status: "PAID" }))
    .mockResolvedValueOnce(Response.json({ items: [] }));
  vi.stubGlobal("fetch", fetcher);
  const c = new AirwallexConnector();
  expect(c.mode).toBe("sandbox");
  expect(
    (await c.createPayout({ ...req, beneficiaryId: "258a6edc-4d85-4be2-b9ac-2379041e0b04" }))
      .status,
  ).toBe("succeeded");
  await c.listPayouts();
  expect(fetcher.mock.calls[0][0]).toBe(
    "https://airwallex.invalid/api/v1/authentication/login",
  );
  expect(fetcher.mock.calls[0][1].headers["x-client-id"]).toBe("test-id");
  expect(fetcher.mock.calls[1][0]).toBe(
    "https://airwallex.invalid/api/v1/transfers/create",
  );
  expect(JSON.parse(fetcher.mock.calls[1][1].body).request_id).toBe(
    "stable-key",
  );
  expect(fetcher.mock.calls[1][1].headers.Authorization).toBe("Bearer bearer");
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("PayPal uses OAuth and sender batch id, requiring item settlement before success", async () => {
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
  vi.stubEnv("PAYPAL_BASE_URL", "https://paypal.invalid");
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ access_token: "bearer", expires_in: 3600 }),
    )
    .mockResolvedValueOnce(
      Response.json({
        batch_header: { payout_batch_id: "batch", batch_status: "SUCCESS" },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        batch_header: { payout_batch_id: "batch", batch_status: "SUCCESS" },
        items: [{ transaction_status: "SUCCESS" }],
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const c = new PayPalConnector();
  expect(c.mode).toBe("sandbox");
  expect((await c.createPayout(req)).status).toBe("pending");
  expect((await c.getPayout("batch")).status).toBe("succeeded");
  expect(fetcher.mock.calls[0][0]).toBe(
    "https://paypal.invalid/v1/oauth2/token",
  );
  expect(fetcher.mock.calls[0][1].body).toBe("grant_type=client_credentials");
  expect(
    JSON.parse(fetcher.mock.calls[1][1].body).sender_batch_header
      .sender_batch_id,
  ).toBe("stable-key");
  expect(fetcher.mock.calls[2][0]).toBe(
    "https://paypal.invalid/v1/payments/payouts/batch",
  );
});
it("mock connector idempotency returns a single payment and refuses settled retries", async () => {
  vi.stubEnv("AIRWALLEX_CLIENT_ID", "");
  const c = new AirwallexConnector();
  const first = await c.createPayout(req);
  expect((await c.createPayout(req)).id).toBe(first.id);
  expect(await c.listPayouts()).toHaveLength(1);
  await expect(c.retryPayout(first.id)).rejects.toThrow("confirmed failed");
});
