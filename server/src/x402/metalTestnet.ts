/**
 * TESTNET MODE — real Metal testnet (chain id 63825, *USDZ test token; no mainnet, no real money).
 * Chain side uses Metal's own tooling:
 *   - `metal-agent` CLI (account create, mandate credential create / bind / replace / pull, pay --mandate)
 *   - `@metalntwx/metal-pay` + the official x402 Express middleware for the seller routes
 *     (requireSignedOffer, signedOfferOf, verifyMandatePayment).
 * Owner keys, mandate keys and the RPC endpoint never leave the gitignored state dir (chmod 600/700)
 * and are never logged. Agents are given only their mandate credential + mandate key, never an owner key.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import express from "express";
import {
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

const require = createRequire(import.meta.url);
const USDZ = "0x000000000000000000000000000000000000B5d5";
const NETWORK = "eip155:63825";
const FACILITATOR = "https://x402-testnet.metalntwx.com/x402/facilitator";
const EXPLORER = "https://testnet.metalntwx.com/tx/";

export const defaultStateDir = () =>
  process.env.METAL_STATE_DIR || resolve(dirname(fileURLToPath(import.meta.url)), "../../.metal");

function metalAgentBin() {
  const pkgPath = require.resolve("@metalntwx/metal-agent/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin["metal-agent"];
  return join(dirname(pkgPath), bin);
}

/** `name value` lines -> map (first occurrence wins; repeated keys collected in .all). */
export function parseLines(text: string) {
  const map: Record<string, string> = {};
  const all: [string, string][] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^([a-z][a-z0-9-]*) (.*)$/);
    if (!m) continue;
    all.push([m[1], m[2]]);
    if (!(m[1] in map)) map[m[1]] = m[2];
  }
  return { map, all };
}

const usdz = (s?: string) => (s ? Number(s.replace(/\s*\*USDZ.*/, "")) : undefined);

export class TestnetMetalConnector implements MetalConnector {
  mode = "testnet" as const;
  label = "Metal testnet (real chain 63825, *USDZ test token)";
  network = NETWORK;
  private bin = metalAgentBin();
  private keyFiles = new Map<string, string>();
  private ownerKeyOf = new Map<string, string>();
  private servers: Server[] = [];
  constructor(
    private rpcUrl = process.env.METAL_RPC_URL || "",
    public stateDir = defaultStateDir(),
    private port = Number(process.env.METAL_SELLER_PORT || 4411),
  ) {
    if (!rpcUrl) throw new Error("METAL_RPC_URL is not set");
    for (const d of ["", "business", "customer", "eoa", "runs", "home"]) {
      mkdirSync(join(stateDir, d), { recursive: true, mode: 0o700 });
      chmodSync(join(stateDir, d), 0o700);
    }
  }
  private lockDown(dir: string) {
    for (const f of require("node:fs").readdirSync(dir) as string[])
      if (f.endsWith(".json")) chmodSync(join(dir, f), 0o600);
  }
  /** Runs the CLI. Output carries no private keys (metal-agent never prints them); the RPC URL is redacted from errors. */
  private cli(args: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
    return new Promise((res) => {
      execFile(
        process.execPath,
        [this.bin, ...args],
        {
          cwd: cwd ?? this.stateDir,
          env: { ...process.env, HOME: join(this.stateDir, "home"), METAL_RPC_URL: this.rpcUrl },
          timeout: 180_000,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) =>
          res({
            code: error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0,
            out: String(stdout),
            err: String(stderr).split(this.rpcUrl).join("<rpc-endpoint>"),
          }),
      );
    });
  }
  private chain = () => ["--network", "testnet", "--rpc-url", this.rpcUrl];

  async account(role: "business" | "customer") {
    const dir = join(this.stateDir, role);
    const saved = join(dir, "account.json");
    if (existsSync(saved)) {
      const a = JSON.parse(readFileSync(saved, "utf8"));
      this.ownerKeyOf.set(a.address.toLowerCase(), join(dir, "owner-key.json"));
      return { address: a.address as string, reused: true };
    }
    const ownerKey = join(dir, "owner-key.json");
    const r = await this.cli(["account", "create", existsSync(ownerKey) ? "--key" : "--out", ownerKey, ...this.chain()], dir);
    this.lockDown(dir);
    const { map } = parseLines(r.out);
    if (r.code !== 0 || !map.account) throw new Error("metal-agent account create failed: " + r.err.trim());
    writeFileSync(saved, JSON.stringify({ address: map.account, owner: map.owner, tx: map.transaction }, null, 2), { mode: 0o600 });
    this.ownerKeyOf.set(map.account.toLowerCase(), ownerKey);
    return { address: map.account, tx: map.transaction, reused: false };
  }
  async address(role: "upstream" | "offramp") {
    const f = join(this.stateDir, "eoa", role + ".json");
    if (!existsSync(f)) {
      const r = await this.cli(["key", "create", "--out", f]);
      if (r.code !== 0) throw new Error("metal-agent key create failed: " + r.err.trim());
      chmodSync(f, 0o600);
    }
    return JSON.parse(readFileSync(f, "utf8")).address as string;
  }
  async balanceOf(address: string) {
    const data = "0x70a08231" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const r = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDZ, data }, "latest"] }),
      signal: AbortSignal.timeout(15000),
    });
    const j = (await r.json()) as any;
    if (!j.result) throw new Error("balance read failed");
    return Number(BigInt(j.result) / 10n ** 14n) / 10_000;
  }
  async ensureFunded(address: string, min: number) {
    let balance = await this.balanceOf(address);
    let fundedTx: string | undefined;
    if (balance < min) {
      const r = await this.cli(["fund", address, "--network", "testnet"]);
      if (r.code !== 0) throw new Error("faucet refused: " + r.err.trim());
      fundedTx = parseLines(r.out).map.transaction;
      balance = await this.balanceOf(address);
    }
    return { balance, fundedTx };
  }
  private credentialArgs(spec: Omit<MandateSpec, "agent">, ownerKey: string, out: string) {
    const a = ["mandate", "credential", "create", "--principal", spec.principal, "--cap", String(spec.cap), "--budget", String(spec.budget), "--key", ownerKey, "--out", out, "--network", "testnet", "--description", spec.description];
    for (const p of spec.payees ?? []) a.push("--payee", p.name ? `${p.address},${p.name.replace(/,/g, " ")}` : p.address);
    return a;
  }
  async issueMandate(spec: MandateSpec, runId: string): Promise<Mandate> {
    const ownerKey = this.ownerKeyOf.get(spec.principal.toLowerCase());
    if (!ownerKey) throw new Error("unknown principal; create the account first");
    const dir = join(this.stateDir, "runs", runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const cred = join(dir, `${spec.agent}-v1.json`);
    const c = await this.cli(this.credentialArgs(spec, ownerKey, cred), dir);
    const cm = parseLines(c.out).map;
    if (c.code !== 0 || !cm.mandate) throw new Error("credential create failed: " + c.err.trim());
    const b = await this.cli(["mandate", "bind", "--credential", cred, "--key", ownerKey, ...this.chain()], dir);
    this.lockDown(dir);
    const bm = parseLines(b.out).map;
    if (b.code !== 0 || !bm.bound) throw new Error("mandate bind failed: " + b.err.trim());
    this.keyFiles.set(cm.mandate, resolve(dir, cm["mandate-key-file"].replace(/ \(.*\)$/, "")));
    return { ...spec, id: cm.mandate, credential: cred, version: 1, bindTx: bm.transaction };
  }
  async replaceMandate(old: Mandate, next: Omit<MandateSpec, "agent" | "principal">, runId: string) {
    const ownerKey = this.ownerKeyOf.get(old.principal.toLowerCase())!;
    const dir = join(this.stateDir, "runs", runId);
    const version = old.version + 1;
    const cred = join(dir, `${old.agent}-v${version}.json`);
    const keyFile = this.keyFiles.get(old.id);
    if (!keyFile) throw new Error("mandate key of the replaced mandate is unknown");
    const spec = { ...old, ...next, agent: old.agent, principal: old.principal };
    const c = await this.cli([...this.credentialArgs(spec, ownerKey, cred), "--mandate-key-file", keyFile], dir);
    const cm = parseLines(c.out).map;
    if (c.code !== 0 || !cm.mandate) throw new Error("credential create failed: " + c.err.trim());
    const r = await this.cli(["mandate", "replace", "--credential", cred, "--replaces", old.credential, "--key", ownerKey, ...this.chain()], dir);
    this.lockDown(dir);
    const rm = parseLines(r.out).map;
    if (r.code !== 0 || !rm.bound) throw new Error("mandate replace failed: " + r.err.trim());
    this.keyFiles.set(cm.mandate, keyFile);
    return {
      mandate: { ...spec, id: cm.mandate, credential: cred, version, bindTx: rm.transaction, replaces: old.id },
      spent: usdz(rm.spent) ?? 0,
      tx: rm.transaction,
    };
  }
  async mandateState(m: Mandate): Promise<MandateState> {
    const r = await this.cli(["mandate", "status", "--credential", m.credential, ...this.chain()]);
    const map = parseLines(r.out).map;
    const spentLine = map.spent ?? "0 *USDZ of 0 *USDZ";
    const [spent, budget] = spentLine.split(" of ").map((x) => usdz(x) ?? 0);
    return { spent, budget, revoked: map.revoked === "yes" };
  }
  async serve(routes: SellerRoute[], onSale: (s: SaleRecord) => void): Promise<Storefront> {
    const { HTTPFacilitatorClient, x402ResourceServer } = await import("@x402/core/server");
    const { paymentMiddleware } = await import("@x402/express");
    const { METAL_NETWORKS, registerMetalScheme } = await import("@metalntwx/metal-pay");
    const { SIGNED_OFFER_REQUIRED, requireSignedOffer, signedOfferOf } = await import("@metalntwx/metal-pay/mandates");
    const facilitator = new HTTPFacilitatorClient({ url: METAL_NETWORKS.testnet.facilitatorUrl });
    const plain = registerMetalScheme(new x402ResourceServer(facilitator), { networks: ["testnet"] });
    const signed = requireSignedOffer(registerMetalScheme(new x402ResourceServer(facilitator), { networks: ["testnet"] }), { rpcUrl: this.rpcUrl });
    signed.onAfterSettle(async ({ paymentPayload, result, transportContext }: any) => {
      const settlement = result.extra?.settlement as { first: boolean } | undefined;
      if (!result.success || !settlement?.first) return;
      const order = signedOfferOf(paymentPayload);
      const req = transportContext?.request?.adapter;
      const route = routes.find((r) => r.signedOrder && req?.getUrl?.().includes(r.resource.split(" ")[1]));
      let delivered: any = transportContext?.responseBody;
      try {
        if (Buffer.isBuffer(delivered)) delivered = delivered.toString();
        if (typeof delivered === "string") delivered = JSON.parse(delivered);
      } catch {}
      onSale({
        queryId: req?.getHeader?.("x-atlas-query") ?? "",
        resource: route?.resource ?? "",
        amount: Number(paymentPayload?.accepted?.amount ?? 0) / 1e18 || route?.price() || 0,
        payer: result.payer ?? "",
        payTo: route?.payTo ?? "",
        tx: result.transaction,
        signedOffer: String(order ?? ""),
        delivered,
        settledAt: new Date().toISOString(),
      });
    });
    const app = express();
    const cache = new Map<string, express.RequestHandler>();
    for (const r of routes) {
      const [method, path] = r.resource.split(" ");
      app.use((req, res, next) => {
        if (req.path !== path) return next();
        const price = r.price().toFixed(2);
        const key = r.resource + "@" + price;
        if (!cache.has(key))
          cache.set(
            key,
            paymentMiddleware(
              {
                [r.resource]: {
                  accepts: {
                    scheme: "exact",
                    network: NETWORK,
                    payTo: r.payTo,
                    price,
                    ...(r.signedOrder ? { extra: { ...SIGNED_OFFER_REQUIRED, resource: r.resource } } : {}),
                  },
                  description: r.resource,
                },
              } as any,
              r.signedOrder ? signed : plain,
            ),
          );
        cache.get(key)!(req, res, next);
      });
      (app as any)[method.toLowerCase()](path, async (req: express.Request, res: express.Response) => {
        const out = await r.handler({ queryId: req.get("x-atlas-query") ?? undefined }).catch((e) => ({ status: 502, body: { error: String(e?.message ?? e) } }));
        res.status(out.status).json(out.body);
      });
    }
    const server = await new Promise<Server>((ok) => {
      const s = app.listen(this.port, "127.0.0.1", () => ok(s));
    });
    this.servers.push(server);
    const base = `http://127.0.0.1:${this.port}`;
    return {
      urlOf: (resource: string) => base + resource.split(" ")[1],
      close: () => new Promise<void>((ok) => server.close(() => ok())),
    };
  }
  async pay(m: Mandate, url: string, headers: Record<string, string> = {}): Promise<PayResult> {
    const args = ["pay", url, "--mandate", m.credential, "--network", "testnet"];
    for (const [k, v] of Object.entries(headers)) args.push("--header", `${k}: ${v}`);
    const r = await this.cli(args, dirname(m.credential));
    const { map } = parseLines(r.out);
    if (r.code === 0 && map.transaction) {
      let body: any = map.body;
      try {
        body = JSON.parse(map.body);
      } catch {}
      return { ok: true, status: Number(map.status), amount: usdz(map.amount), payer: map.payer, payee: map.payee, tx: map.transaction, nonce: map.nonce, signedOffer: map["signed-offer"], body };
    }
    const err = r.err.replace(/^error: /, "").trim();
    // Only the payer's own refusal ("payment refused: <reason>") is a refusal; a seller error body may quote other reasons.
    const reason = err.match(/payment refused: (mandate_[a-z_]+|transfer_would_fail)\b/)?.[1];
    const inDoubt = !reason && (!!map.nonce || /may have settled|in doubt/.test(err));
    const sellerStatus = Number(map.status) || Number(err.match(/\b(?:answered|status|HTTP) (\d{3})\b/)?.[1]) || undefined;
    return {
      ok: false,
      status: reason ? 402 : sellerStatus,
      nonce: map.nonce,
      signedOffer: map["signed-offer"],
      inDoubt,
      refusal: { reason: reason ?? (inDoubt ? "seller_error" : "payment_failed"), detail: err.slice(0, 400) },
    };
  }
  async pull(m: Mandate, to: string, amount: number, paymentId: string): Promise<PullResult> {
    const r = await this.cli(["mandate", "pull", "--credential", m.credential, "--to", to, "--amount", amount.toFixed(2), "--payment-id", paymentId, ...this.chain()], dirname(m.credential));
    const text = r.out + "\n" + r.err;
    const { map } = parseLines(r.out);
    const spent = usdz(map.spent?.split(" of ")[0]);
    if (/already paid, nothing sent/.test(text)) return { outcome: "already_paid", amount, to, tx: map.transaction, spent };
    if (map.outcome === "paid") return { outcome: "paid", amount, to, tx: map.transaction, spent };
    if (map.outcome === "pending" || r.code === 3) return { outcome: "pending", amount, to, tx: map.transaction, reason: map.reason };
    if (map.outcome === "held" || r.code === 4) return { outcome: "held", amount, to, tx: map.transaction };
    return { outcome: "refused", amount, to, reason: map.reason ?? r.err.replace(/^error: /, "").trim().slice(0, 300) };
  }
  async verifyOrder(tx: string, signedOffer: string): Promise<OrderCheck> {
    const { createPublicClient, http } = await import("viem");
    const { verifyMandatePayment } = await import("@metalntwx/metal-pay/mandates");
    const client = createPublicClient({ transport: http(this.rpcUrl) });
    try {
      const v: any = await verifyMandatePayment(client as any, { tx: tx as `0x${string}`, checkoutMandate: signedOffer } as any);
      return { ok: !!v.ok, steps: (v.steps ?? []).map((s: any) => ({ outcome: s.outcome, title: s.title, detail: s.detail })) };
    } catch (e: any) {
      return { ok: false, steps: [{ outcome: "fail", title: "verify", detail: String(e?.message ?? e).split(this.rpcUrl).join("<rpc-endpoint>").slice(0, 300) }] };
    }
  }
  async findSettlement(payTo: string, nonce: string) {
    const r = await fetch(`${FACILITATOR}/settlements?payTo=${payTo}&since=${Date.now() - 60 * 60 * 1000}`, { signal: AbortSignal.timeout(15000) });
    const j = (await r.json()) as any;
    const s = (j.settlements ?? []).find((x: any) => String(x.id).toLowerCase().endsWith(nonce.toLowerCase()));
    return s ? { found: true, tx: s.transaction } : { found: false };
  }
  explorer(tx?: string) {
    return tx ? EXPLORER + tx : undefined;
  }
  async close() {
    await Promise.all(this.servers.map((s) => new Promise((ok) => s.close(() => ok(null)))));
    this.servers = [];
  }
}
