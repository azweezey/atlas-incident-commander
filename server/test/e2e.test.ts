import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { Commander } from "../src/service.js";
import { createApp } from "../src/app.js";
let dir: string;
let server: Server | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-e2e-"));
  vi.stubEnv("AUDIT_LOG_PATH", join(dir, "audit.jsonl"));
  for (const key of [
    "AIRWALLEX_CLIENT_ID",
    "AIRWALLEX_API_KEY",
    "PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
    "ANTHROPIC_API_KEY",
  ])
    vi.stubEnv(key, "");
  vi.stubEnv("CONNECTOR", "airwallex");
});
afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((e) => (e ? reject(e) : resolve())),
    );
    server = undefined;
  }
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
it("runs duplicate scenario through HTTP agent and approval, never paying twice", async () => {
  const c = new Commander();
  server = createApp(c).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server!.once("listening", r));
  const addr = server.address() as { port: number };
  const call = async (path: string, body: unknown = {}) => {
    const r = await fetch(`http://127.0.0.1:${addr.port}/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(r.ok).toBe(true);
    return r.json() as Promise<any>;
  };
  const i = await call("/simulate/duplicate");
  const result = await call("/agent/run/" + i.id);
  expect(result.status).toBe("blocked");
  expect(result.planner).toBe("rule-based");
  expect(result.actions[0].policy.ruleHits).toContain("duplicate-invoice");
  // A stale or externally queued approval must not bypass the final duplicate check.
  const stale = c.queue.enqueue(i.id, c.selected, {
    ...result.actions[0].action,
    type: "create",
    idempotencyKey: "stale-approval",
  });
  const approval = await call(`/approvals/${stale.id}/approve`, {
    approver: "Test operator",
    note: "Check settlement first",
  });
  expect(approval.status).toBe("denied");
  expect(approval.outcome).toMatch(/^Blocked/);
  expect(approval.approver).toBe("Test operator");
  expect((await c.connector.listPayouts()).length).toBe(1);
  expect(c.audit.verify().valid).toBe(true);
});
it("serializes concurrent approvals so the second invoice payment is denied", async () => {
  const c = new Commander();
  const action = {
    type: "create" as const,
    beneficiaryId: "vendor-acme",
    amount: 1200,
    currency: "USD",
    reference: "race-invoice",
    idempotencyKey: "one",
  };
  const a = c.queue.enqueue("one", c.selected, action),
    b = c.queue.enqueue("two", c.selected, {
      ...action,
      idempotencyKey: "two",
    });
  const results = await Promise.all(
    [a, b].map((a) =>
      c.exclusive(() => c.decide(a.id, true, "Tester", "Reviewed")),
    ),
  );
  expect(results.map((a) => a.status)).toEqual(["approved", "denied"]);
  expect((await c.connector.listPayouts()).length).toBe(1);
  const restarted = new Commander();
  expect(
    await restarted.execute(
      { ...action, idempotencyKey: "three" },
      undefined,
      true,
    ),
  ).toMatch(/^Blocked/);
});
it("records uncertain executions and prevents repeat attempts", async () => {
  const c = new Commander();
  vi.spyOn(c.connector, "createPayout").mockRejectedValue(new Error("Timeout"));
  const action = {
    type: "create" as const,
    beneficiaryId: "vendor-acme",
    amount: 100,
    currency: "USD",
    reference: "timeout",
    idempotencyKey: "timeout-key",
  };
  expect(await c.execute(action)).toMatch(/^Manual review/);
  expect(await c.execute(action)).toMatch(/^Blocked/);
  expect(await new Commander().execute(action)).toMatch(/^Blocked/);
});
it("handles repair approval, stuck transfer and intent violations", async () => {
  const c = new Commander();
  const repair = await c.simulate("bad-beneficiary");
  expect((await c.run(repair.id)).status).toBe("awaiting_approval");
  const a = c.queue.items[0];
  expect(
    (await c.decide(a.id, true, "Operator", "Verify details")).outcome,
  ).toMatch(/^Manual review/);
  expect((await c.connector.getPayout(repair.payout!.id)).status).toBe(
    "failed",
  );
  const stuck = await c.simulate("stuck");
  expect((await c.run(stuck.id)).status).toBe("manual_review");
  const purchase = await c.simulate("purchase");
  expect((await c.run(purchase.id)).status).toBe("blocked");
  expect(c.audit.verify().valid).toBe(true);
});
it("isolates connector state and preserves audit history on mock reset", async () => {
  const c = new Commander();
  await c.simulate("duplicate");
  c.switch("paypal");
  expect(await c.connector.listPayouts()).toEqual([]);
  const i = await c.simulate("duplicate");
  expect((await c.run(i.id)).status).toBe("blocked");
  const count = c.audit.entries().length;
  c.reset();
  expect(c.audit.entries().length).toBe(count + 1);
  expect(await c.history()).toEqual([]);
  c.switch("airwallex");
  expect((await c.connector.listPayouts()).length).toBe(1);
});
