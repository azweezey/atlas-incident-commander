/**
 * SIMULATION MODE — no chain. A local, in-memory stand-in for Metal testnet that mirrors the
 * metal-agent / metal-pay shapes (mandates with cap, budget, payees, replace/revoke, signed orders,
 * pull with payment ids, facilitator /settlements) so the scenario code is identical in both modes.
 * Signed orders here are real P-256 signatures by a per-mandate key, but nothing settles on any chain,
 * and transaction hashes are prefixed "0xs1m" so they can never be mistaken for testnet hashes.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import {
  REFUSAL_TEXT,
  type Mandate,
  type MandateSpec,
  type MandateState,
  type MetalConnector,
  type OrderCheck,
  type PayResult,
  type PullResult,
  type SaleRecord,
  type SellerRoute,
  type Storefront,
} from "./metal.js";
import { cents, fromCents } from "./config.js";

interface SimMandate {
  m: Mandate;
  spentCents: number;
  revoked: boolean;
  priv: KeyObject;
  pub: KeyObject;
}

const addr = (seed: string) => "0x" + createHash("sha256").update(seed).digest("hex").slice(0, 40);
const simTx = () => "0xs1m" + randomBytes(30).toString("hex");
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class SimMetalConnector implements MetalConnector {
  mode = "simulation" as const;
  label = "Local simulation (no chain) — mirrors Metal testnet API shapes";
  network = "sim:metal-testnet-shape";
  private balances = new Map<string, number>(); // cents
  private mandates = new Map<string, SimMandate>();
  private routes = new Map<string, SellerRoute>();
  private onSale?: (s: SaleRecord) => void;
  private settlements: { id: string; payTo: string; payer: string; amount: number; tx: string; nonce: string }[] = [];
  private payments = new Map<string, { mandateId: string; payee: string; amountCents: number; nonce: string }>();
  private pulls = new Map<string, PullResult>();
  /** Optional artificial latency per chain call (ms), so the UI paces like a real run. */
  constructor(public latencyMs = 0) {}
  private wait = () => (this.latencyMs ? new Promise((r) => setTimeout(r, this.latencyMs)) : Promise.resolve());

  async account(role: "business" | "customer") {
    await this.wait();
    return { address: addr("sim-account-" + role), tx: simTx(), reused: false };
  }
  async address(role: "upstream" | "offramp") {
    return addr("sim-eoa-" + role);
  }
  async balanceOf(address: string) {
    return fromCents(this.balances.get(address.toLowerCase()) ?? 0);
  }
  async ensureFunded(address: string, min: number) {
    const k = address.toLowerCase();
    let fundedTx: string | undefined;
    if ((this.balances.get(k) ?? 0) < cents(min)) {
      this.balances.set(k, (this.balances.get(k) ?? 0) + 100_00);
      fundedTx = simTx();
    }
    return { balance: await this.balanceOf(address), fundedTx };
  }
  private newMandate(spec: MandateSpec, version: number, keys?: { priv: KeyObject; pub: KeyObject }): SimMandate {
    const kp = keys ?? (({ privateKey, publicKey }) => ({ priv: privateKey, pub: publicKey }))(generateKeyPairSync("ec", { namedCurve: "P-256" }));
    const id = "0x" + randomBytes(32).toString("hex");
    const m: Mandate = { ...spec, id, credential: "sim:" + id, version, bindTx: simTx() };
    return { m, spentCents: 0, revoked: false, priv: kp.priv, pub: kp.pub };
  }
  async issueMandate(spec: MandateSpec, _runId?: string) {
    await this.wait();
    const s = this.newMandate(spec, 1);
    this.mandates.set(s.m.id, s);
    return { ...s.m };
  }
  async replaceMandate(old: Mandate, next: Omit<MandateSpec, "agent" | "principal">, _runId?: string) {
    await this.wait();
    const o = this.mandates.get(old.id);
    if (!o) throw new Error("mandate_not_bound");
    if (o.revoked) throw new Error("mandate_revoked: cannot replace a revoked mandate");
    if (cents(next.budget) <= o.spentCents)
      throw new Error("replacement budget must exceed what the mandate already spent");
    // Same mandate key (like --mandate-key-file naming the old key), spend carries over, old revoked in the same "transaction".
    const s = this.newMandate({ ...old, ...next, agent: old.agent, principal: old.principal }, old.version + 1, {
      priv: o.priv,
      pub: o.pub,
    });
    s.m.replaces = old.id;
    s.spentCents = o.spentCents;
    o.revoked = true;
    this.mandates.set(s.m.id, s);
    return { mandate: { ...s.m }, spent: fromCents(s.spentCents), tx: s.m.bindTx };
  }
  async mandateState(m: Mandate): Promise<MandateState> {
    const s = this.mandates.get(m.id);
    if (!s) throw new Error("mandate_not_bound");
    return { spent: fromCents(s.spentCents), budget: s.m.budget, revoked: s.revoked };
  }
  async serve(routes: SellerRoute[], onSale: (s: SaleRecord) => void): Promise<Storefront> {
    for (const r of routes) this.routes.set(r.resource, r);
    this.onSale = onSale;
    return {
      urlOf: (resource: string) => "sim://" + encodeURIComponent(resource),
      close: async () => {
        for (const r of routes) this.routes.delete(r.resource);
      },
    };
  }
  /** Same checks, same order, same reason names as the account's on-chain mandate check. */
  private check(s: SimMandate, payee: string, amountCents: number): string | undefined {
    if (s.revoked) return "mandate_revoked";
    if (s.m.payees?.length && !s.m.payees.some((p) => p.address.toLowerCase() === payee.toLowerCase()))
      return "mandate_payee_not_listed";
    if (amountCents > cents(s.m.cap)) return "mandate_cap_exceeded";
    if (s.spentCents + amountCents > cents(s.m.budget)) return "mandate_budget_spent";
    if ((this.balances.get(s.m.principal.toLowerCase()) ?? 0) < amountCents) return "transfer_would_fail";
    return undefined;
  }
  private transfer(s: SimMandate, to: string, amountCents: number) {
    const from = s.m.principal.toLowerCase();
    this.balances.set(from, (this.balances.get(from) ?? 0) - amountCents);
    this.balances.set(to.toLowerCase(), (this.balances.get(to.toLowerCase()) ?? 0) + amountCents);
    s.spentCents += amountCents;
  }
  async pay(m: Mandate, url: string, headers: Record<string, string> = {}): Promise<PayResult> {
    await this.wait();
    const s = this.mandates.get(m.id);
    if (!s) return { ok: false, refusal: { reason: "mandate_not_bound", detail: REFUSAL_TEXT.mandate_not_bound } };
    const route = this.routes.get(decodeURIComponent(url.replace(/^sim:\/\//, "")));
    if (!route) return { ok: false, refusal: { reason: "seller_unreachable", detail: "no such route" } };
    const amountCents = cents(route.price());
    const reason = this.check(s, route.payTo, amountCents);
    if (reason)
      return {
        ok: false,
        status: 402,
        amount: fromCents(amountCents),
        refusal: { reason, detail: `${REFUSAL_TEXT[reason] ?? reason} (offer: ${fromCents(amountCents)} *USDZ); nothing was paid` },
      };
    const nonce = s.m.id.slice(0, 26) + randomBytes(19).toString("hex");
    let signedOffer: string | undefined;
    if (route.signedOrder) {
      const payload = b64u(
        JSON.stringify({ resource: route.resource, amount: fromCents(amountCents), payTo: route.payTo, network: this.network, mandate: s.m.id, nonce, iat: Date.now() }),
      );
      signedOffer = payload + "." + b64u(sign("sha256", Buffer.from(payload), s.priv));
    }
    const queryId = headers["x-atlas-query"];
    const res = await route.handler({ queryId });
    if (res.status >= 400)
      // Like the real middleware: an error status cancels the payment; nothing settles.
      return {
        ok: false,
        status: res.status,
        nonce,
        signedOffer,
        inDoubt: true,
        body: res.body,
        refusal: { reason: "seller_error", detail: `seller answered ${res.status}: ${res.body?.error ?? ""}; a payment was signed and may have settled` },
      };
    const tx = simTx();
    this.transfer(s, route.payTo, amountCents);
    this.payments.set(tx, { mandateId: s.m.id, payee: route.payTo, amountCents, nonce });
    this.settlements.push({ id: nonce, payTo: route.payTo, payer: s.m.principal, amount: amountCents, tx, nonce });
    if (signedOffer)
      this.onSale?.({
        queryId: queryId ?? "",
        resource: route.resource,
        amount: fromCents(amountCents),
        payer: s.m.principal,
        payTo: route.payTo,
        tx,
        signedOffer,
        delivered: res.body,
        settledAt: new Date().toISOString(),
      });
    return { ok: true, status: 200, amount: fromCents(amountCents), payer: s.m.principal, payee: route.payTo, tx, nonce, signedOffer, body: res.body };
  }
  async pull(m: Mandate, to: string, amount: number, paymentId: string): Promise<PullResult> {
    await this.wait();
    const key = m.id + ":" + paymentId;
    const prior = [...this.pulls.entries()].find(([k, v]) => k.endsWith(":" + paymentId) && v.outcome === "paid" && this.sameKey(k, m));
    if (prior) return { ...prior[1], outcome: "already_paid" };
    const s = this.mandates.get(m.id);
    if (!s) return { outcome: "refused", amount, to, reason: "mandate_not_bound" };
    const reason = this.check(s, to, cents(amount));
    if (reason) return { outcome: "refused", amount, to, reason };
    const tx = simTx();
    this.transfer(s, to, cents(amount));
    const r: PullResult = { outcome: "paid", amount, to, tx, spent: fromCents(s.spentCents) };
    this.pulls.set(key, r);
    return r;
  }
  private sameKey(k: string, m: Mandate) {
    const a = this.mandates.get(k.split(":")[0]);
    const b = this.mandates.get(m.id);
    return a && b && a.pub === b.pub;
  }
  async verifyOrder(tx: string, signedOffer: string): Promise<OrderCheck> {
    const p = this.payments.get(tx);
    if (!p) return { ok: false, steps: [{ outcome: "fail", title: "payment", detail: "no payment with this transaction" }] };
    const s = this.mandates.get(p.mandateId)!;
    const [payload, sig] = signedOffer.split(".");
    const sigOk = !!payload && !!sig && verify("sha256", Buffer.from(payload), s.pub, Buffer.from(sig, "base64url"));
    let order: any = {};
    try {
      order = JSON.parse(Buffer.from(payload, "base64url").toString());
    } catch {}
    const matches = order.nonce === p.nonce && order.payTo === p.payee && cents(order.amount) === p.amountCents;
    const steps = [
      { outcome: "pass", title: "mandate bound", detail: "payment made under a mandate the payer's account bound" },
      { outcome: sigOk ? "pass" : "fail", title: "order signature", detail: sigOk ? "signed by the payer agent's mandate key" : "signature does not verify" },
      { outcome: matches ? "pass" : "fail", title: "order matches payment", detail: matches ? "same payee, amount and nonce as the payment" : "the checkout mandate belongs to another payment" },
    ];
    return { ok: sigOk && matches, steps };
  }
  async findSettlement(payTo: string, nonce: string) {
    const s = this.settlements.find((x) => x.payTo.toLowerCase() === payTo.toLowerCase() && x.id.endsWith(nonce.slice(2)));
    return s ? { found: true, tx: s.tx } : { found: false };
  }
  explorer() {
    return undefined;
  }
  async close() {}
}
