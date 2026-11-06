import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AirwallexConnector, mapStatus, isBeneficiaryFailure } from "../src/connectors/airwallex.js";
import { simulateSandbox } from "../src/simulator/sandbox.js";
import { Commander } from "../src/service.js";
import { FakeAirwallex } from "./fakeAirwallex.js";

let fake: FakeAirwallex;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-aw-"));
  vi.stubEnv("AUDIT_LOG_PATH", join(dir, "audit.jsonl"));
  vi.stubEnv("AIRWALLEX_CLIENT_ID", "test-id");
  vi.stubEnv("AIRWALLEX_API_KEY", "test-key");
  vi.stubEnv("AIRWALLEX_BASE_URL", "https://airwallex.invalid");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("CONNECTOR", "airwallex");
  fake = new FakeAirwallex();
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
const req = {
  beneficiaryId: "vendor-acme",
  amount: 12,
  currency: "USD",
  reference: "INV-TEST",
  idempotencyKey: "original-key",
};

it("maps Airwallex transfer statuses conservatively", () => {
  for (const s of ["SCHEDULED", "PROCESSING", "SENT", "OVERDUE", "IN_APPROVAL"])
    expect(mapStatus({ status: s })).toBe("pending");
  expect(mapStatus({ status: "PAID" })).toBe("succeeded");
  expect(mapStatus({ status: "FAILED" })).toBe("failed");
  expect(mapStatus({ status: "CANCELLED" })).toBe("cancelled");
  expect(mapStatus({ status: "CANCELLED", failure: { code: "90101" } })).toBe("failed");
  expect(isBeneficiaryFailure({ failure: { details: { type: "INCORRECT_ROUTING" }, message: "Invalid account name/number" } })).toBe(true);
  expect(isBeneficiaryFailure({ failure: { details: { type: "INSUFFICIENT_FUNDS" }, message: "Insufficient funds" } })).toBe(false);
});

it("caches the token, refreshes it before the 30 minute expiry, and re-logs in on 401", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const c = new AirwallexConnector();
  await c.balances();
  await c.balances();
  expect(fake.logins).toBe(1);
  vi.setSystemTime(Date.now() + 26 * 60 * 1000); // inside the 5 minute refresh margin
  await c.balances();
  expect(fake.logins).toBe(2);
  fake.expiredOnce = true;
  await c.balances();
  expect(fake.logins).toBe(3);
});

it("creates the sandbox beneficiary once (validate then create) and reuses it", async () => {
  const c = new AirwallexConnector();
  const a = await c.resolveBeneficiary("vendor-acme");
  const b = await c.resolveBeneficiary("vendor-acme");
  expect(a).toBe(b);
  expect(fake.beneficiaries.size).toBe(1);
  expect(fake.calls.filter((x) => x.startsWith("POST /api/v1/beneficiaries/validate"))).toHaveLength(1);
  // A second connector finds the existing contact by nickname instead of creating another.
  await new AirwallexConnector().resolveBeneficiary("vendor-acme");
  expect(fake.beneficiaries.size).toBe(1);
});

it("reports validation errors for bad beneficiary details", async () => {
  const c = new AirwallexConnector();
  const v = await c.validateBeneficiary({
    beneficiary: { bank_details: { account_routing_value1: "123" } },
    transfer_methods: ["LOCAL"],
  });
  expect(v.valid).toBe(false);
  expect(v.errors[0].source).toBe("beneficiary.bank_details.account_routing_value1");
});

it("uses request_id idempotency: a repeated create returns the original transfer", async () => {
  const c = new AirwallexConnector();
  const first = await c.createPayout(req);
  const second = await c.createPayout(req);
  expect(second.id).toBe(first.id);
  expect(second.providerDuplicate).toBe(true);
  expect(fake.creates).toBe(1);
  expect(fake.transfers.size).toBe(1);
  expect(first.beneficiaryId).toBe("vendor-acme");
});

it("recovers an uncertain create (timeout) by looking the transfer up by request_id", async () => {
  const c = new AirwallexConnector();
  fake.failCreateWith = "timeout";
  const p = await c.createPayout(req);
  expect(p.idempotencyKey).toBe("original-key");
  expect(fake.transfers.size).toBe(1);
  expect(fake.calls.some((x) => x.includes("/api/v1/transfers?request_id=original-key"))).toBe(true);
});

it("marks a beneficiary invalid after a routing failure on a real transfer", async () => {
  const c = new AirwallexConnector();
  expect((await c.getBeneficiary("vendor-bad")).valid).toBe(true);
  const i = await simulateSandbox("bad-beneficiary", c);
  expect(i.payout!.status).toBe("failed");
  expect(i.payout!.providerStatus).toBe("CANCELLED");
  expect(i.payout!.failureCode).toBe("INCORRECT_ROUTING");
  expect((await c.getBeneficiary("vendor-bad")).valid).toBe(false);
});

it("runs all four scenarios in sandbox mode through the Commander without paying twice", async () => {
  const c = new Commander();
  expect(c.info().mode).toBe("sandbox");
  const dup = await c.simulate("duplicate");
  expect(dup.payout!.providerStatus).toBe("PAID");
  const r1 = await c.run(dup.id);
  expect(r1.status).toBe("blocked");
  expect(r1.actions![0].policy.ruleHits).toEqual(expect.arrayContaining(["duplicate-invoice", "retry-status"]));
  // Even if the policy were bypassed, the provider would refuse the reused request_id.
  const again = await c.connector.createPayout({ ...dup.payout!, idempotencyKey: dup.payout!.idempotencyKey });
  expect(again.providerDuplicate).toBe(true);

  const bad = await c.simulate("bad-beneficiary");
  expect((await c.run(bad.id)).status).toBe("awaiting_approval");
  const approval = c.queue.items.find((a) => a.incidentId === bad.id)!;
  expect((await c.decide(approval.id, true, "Josh", "verify")).outcome).toMatch(/^Manual review/);
  // A direct retry passes policy (small amount, failed payout) but is stopped by live beneficiary validity.
  const retry = await c.execute({
    type: "retry",
    payoutId: bad.payout!.id,
    beneficiaryId: "vendor-bad",
    amount: bad.payout!.amount,
    currency: "USD",
    reference: bad.payout!.reference,
    idempotencyKey: "retry-" + bad.id,
  });
  expect(retry).toBe("Blocked: beneficiary details remain invalid");

  const stuck = await c.simulate("stuck");
  expect(stuck.payout!.providerStatus).toBe("PROCESSING");
  expect((await c.run(stuck.id)).status).toBe("manual_review");

  const purchase = await c.simulate("purchase");
  expect((await c.run(purchase.id)).status).toBe("blocked");
  expect(fake.creates).toBe(3); // one original per payout scenario; nothing extra was ever created
  expect(c.audit.verify().valid).toBe(true);
});
