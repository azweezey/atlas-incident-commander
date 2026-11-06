/** Headless Kit 11 run (auto-approves). METAL_MODE=simulation|testnet. Prints beat summaries + tx hashes (no secrets). */
import dotenv from "dotenv";
dotenv.config({ path: [".env", "../.env"], quiet: true } as any);
const { Commander } = await import("../src/service.js");
const { X402Scenario, createMetal, preloadTestnet } = await import("../src/x402/scenario.js");
const { createTreasury } = await import("../src/x402/treasury.js");
await preloadTestnet().catch(() => {});
const commander = new Commander();
const s = new X402Scenario(commander, createMetal, createTreasury(commander.connectors.airwallex));
const t0 = Date.now();
const { run, done } = s.start({ autoApprove: true });
await done;
const r = s.run;
console.log(`run ${r.id} status=${r.status} mode=${r.mode} treasury=${r.treasuryMode} ${(Date.now() - t0) / 1000}s`);
for (const b of r.beats) {
  console.log(`\n[${b.n}] ${b.title} — ${b.status}: ${b.summary ?? ""}`);
  for (const i of b.items) console.log(`   ${i.kind.padEnd(8)} ${i.text}${i.tx ? "  tx=" + i.tx : ""}`);
}
console.log("\nledger", JSON.stringify(r.ledger));
console.log("mandates", JSON.stringify(r.mandates.map((m) => [m.agent, "v" + m.version, m.cap, m.budget, m.spent])));
if (r.error) console.log("ERROR", r.error);
console.log("audit verify", JSON.stringify(commander.audit.verify()));
process.exit(r.status === "done" ? 0 : 1);
