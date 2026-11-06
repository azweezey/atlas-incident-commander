import { describe, it, expect } from "vitest";
import { evaluate, type Action } from "../src/policy/engine.js";
import type { Payout } from "../src/connectors/types.js";
const action: Action = {
  type: "create",
  beneficiaryId: "vendor-acme",
  amount: 100,
  currency: "USD",
  reference: "INV-1",
  idempotencyKey: "new-key",
};
const paid: Payout = {
  ...action,
  id: "paid-1",
  status: "succeeded",
  idempotencyKey: "old-key",
  createdAt: new Date().toISOString(),
};
describe("payment governance", () => {
  it("denies paying the same invoice twice", () =>
    expect(evaluate(action, [paid]).ruleHits).toContain("duplicate-invoice"));
  it("denies completed idempotency keys even with different references", () =>
    expect(
      evaluate({ ...action, reference: "other", idempotencyKey: "old-key" }, [
        paid,
      ]).ruleHits,
    ).toContain("completed-key"));
  it("denies retrying successful payouts", () =>
    expect(
      evaluate({ ...action, type: "retry", payoutId: paid.id }, [paid])
        .ruleHits,
    ).toContain("retry-status"));
  it("allows a different amount", () =>
    expect(evaluate({ ...action, amount: 101 }, [paid]).decision).toBe(
      "allow",
    ));
  it("denies pending duplicate invoices", () =>
    expect(evaluate(action, [{ ...paid, status: "pending" }]).decision).toBe(
      "deny",
    ));
  it("limits invoice matching to 24h but keeps completed key protection", () => {
    const old = {
      ...paid,
      createdAt: new Date(Date.now() - 25 * 3600000).toISOString(),
    };
    expect(evaluate(action, [old]).decision).toBe("allow");
    expect(
      evaluate({ ...action, idempotencyKey: old.idempotencyKey }, [old])
        .decision,
    ).toBe("deny");
  });
  it.each([
    [499, "allow"],
    [500, "escalate"],
    [5000, "escalate"],
    [5001, "deny"],
    [10001, "deny"],
  ])("amount %s gives %s", (amount, decision) =>
    expect(evaluate({ ...action, amount: Number(amount) }, []).decision).toBe(
      decision,
    ),
  );
  it("denies unapproved beneficiaries", () =>
    expect(
      evaluate({ ...action, beneficiaryId: "unknown" }, []).ruleHits,
    ).toContain("allowlist"));
  it("denies currencies without a configured conversion", () =>
    expect(evaluate({ ...action, currency: "JPY" }, []).decision).toBe("deny"));
  it("enforces purchase intent and budget", () => {
    const purchase = {
      ...action,
      type: "purchase" as const,
      merchantCategory: "office",
      item: "chair",
    };
    const intent = {
      merchantCategory: "office",
      item: "chair",
      maxBudget: 150,
    };
    expect(evaluate(purchase, [], intent).decision).toBe("allow");
    expect(evaluate({ ...purchase, item: "watch" }, [], intent).decision).toBe(
      "deny",
    );
    expect(
      evaluate({ ...purchase, merchantCategory: "luxury" }, [], intent)
        .decision,
    ).toBe("deny");
    expect(evaluate({ ...purchase, amount: 151 }, [], intent).decision).toBe(
      "deny",
    );
    expect(evaluate(purchase, []).decision).toBe("deny");
  });
  it("rejects invalid amounts", () =>
    expect(evaluate({ ...action, amount: -1 }, []).decision).toBe("deny"));
  it("rejects unbound or pending retries", () => {
    expect(
      evaluate({ ...action, type: "retry", payoutId: "missing" }, []).decision,
    ).toBe("deny");
    expect(
      evaluate({ ...action, type: "retry", payoutId: paid.id }, [
        { ...paid, status: "pending" },
      ]).decision,
    ).toBe("deny");
  });
});
