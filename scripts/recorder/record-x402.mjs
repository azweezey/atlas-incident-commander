// Records the Atlas dashboard on a dedicated Xvfb display with ffmpeg (x11grab, H.264, 30fps).
// Kit 11 (x402) variant. Usage: node record-x402.mjs <out.mp4> <stillsDir>
// Records the whole run in real time, marks chain-wait spans, then speeds those spans up (labeled on screen).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
const [, , out, stills] = process.argv;
const RAW = out.replace(/\.mp4$/, ".raw.mp4");
const FAST = Number(process.env.FAST || 4);
const DISPLAY = ":99";
const BASE = "http://localhost:5173/";
const W = 1920, H = 1080, SCALE = Number(process.env.SCALE || 1.1);
mkdirSync(stills, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const xvfb = spawn("Xvfb", [DISPLAY, "-screen", "0", `${W}x${H}x24`, "-nolisten", "tcp"], { stdio: "ignore" });
await sleep(1200);
const browser = await chromium.launch({
  headless: false,
  env: { ...process.env, DISPLAY },
  args: [`--window-position=0,0`, `--window-size=${Math.round(W / SCALE)},${Math.round(H / SCALE)}`, "--no-first-run",
    "--disable-infobars", `--force-device-scale-factor=${SCALE}`, "--hide-crash-restore-bubble"],
});
const ctx = await browser.newContext({ viewport: null });
// Visible cursor + click ripple (synthetic mouse events do not move the X pointer).
await ctx.addInitScript(() => {
  addEventListener("DOMContentLoaded", () => {
    const c = document.createElement("div");
    c.id = "rec-cursor";
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.4-6.9L4 20z" fill="#fff" stroke="#0b1520" stroke-width="1.4"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "-50px", top: "-50px", zIndex: 99999, pointerEvents: "none", transition: "transform .08s", filter: "drop-shadow(0 2px 4px #0009)" });
    document.body.appendChild(c);
    addEventListener("mousemove", (e) => { c.style.left = e.clientX - 3 + "px"; c.style.top = e.clientY - 2 + "px"; }, true);
    addEventListener("mousedown", (e) => {
      c.style.transform = "scale(.85)";
      const r = document.createElement("div");
      Object.assign(r.style, { position: "fixed", left: e.clientX - 22 + "px", top: e.clientY - 22 + "px", width: "44px", height: "44px", borderRadius: "50%", border: "3px solid #68dfc7", zIndex: 99998, pointerEvents: "none", transition: "all .5s ease-out", opacity: "1" });
      document.body.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = "scale(2)"; r.style.opacity = "0"; });
      setTimeout(() => r.remove(), 600);
    }, true);
    addEventListener("mouseup", () => (c.style.transform = ""), true);
  });
});
const page = await ctx.newPage();
{
  // Real fullscreen (no tab strip / address bar) on the virtual display.
  const cdp = await ctx.newCDPSession(page);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "fullscreen" } });
  await sleep(800);
  spawn("xdotool", ["mousemove", String(W - 2), String(H - 2)], { env: { ...process.env, DISPLAY }, stdio: "ignore" }).on("error", () => {});
}

await page.goto(BASE);
await page.waitForSelector("[data-testid=kit-kit11]");
await page.waitForFunction(() => document.body.innerText.includes("LIVE"));
await sleep(6000); // let the "exit full screen" hint fade out before recording
let mouse = { x: 1500, y: 700 };
await page.mouse.move(mouse.x, mouse.y);
async function moveTo(sel, steps = 30) {
  const box = await page.locator(sel).first().boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps });
  mouse = { x, y };
  await sleep(350);
}
async function click(sel) {
  await moveTo(sel);
  await page.mouse.down(); await sleep(90); await page.mouse.up();
}
const t0 = Date.now();
const marks = [];
const fast = []; // [start, end] seconds of the raw recording that get sped up
const now = () => (Date.now() - t0) / 1000;
const mark = (label) => { marks.push({ t: +now().toFixed(1), label }); console.log(`[${now().toFixed(1)}s] ${label}`); };
const still = async (name) => { await page.screenshot({ path: `${stills}/${name}.png` }); mark("still " + name); };
// On-screen label while a span is sped up (it is visible only in those spans of the final clip).
const label = (on, text = "") => page.evaluate(([on, text]) => {
  let el = document.getElementById("rec-fast");
  if (!el) {
    el = document.createElement("div");
    el.id = "rec-fast";
    Object.assign(el.style, { position: "fixed", right: "28px", bottom: "26px", zIndex: 99997, padding: "10px 16px", borderRadius: "30px",
      background: "#2c2416ee", border: "1px solid #6f5733", color: "#ffd892", font: "600 15px Inter, system-ui, sans-serif", letterSpacing: ".02em" });
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.display = on ? "block" : "none";
}, [on, text]);
let fastStart = null;
const speedUp = async (text) => { await label(true, `⏩ ${FAST}× · ${text}`); fastStart = now(); };
const normal = async () => { if (fastStart != null) { fast.push([fastStart, now()]); fastStart = null; } await label(false); };
const runState = () => page.evaluate(() => fetch("/api/x402").then((r) => r.json()).then((d) => d.run));

const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0", "-framerate", "30",
  "-video_size", `${W}x${H}`, "-i", DISPLAY + ".0", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
  "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", RAW], { stdio: ["pipe", "inherit", "inherit"] });
await sleep(700);
mark("recording start");
try {
  await sleep(2500);
  await click("[data-testid=kit-kit11]");
  mark("switched to Kit 11");
  await page.waitForSelector("[data-testid=x402-run]");
  await sleep(3200);
  await still("10-kit11-ready");
  await click("[data-testid=x402-run]");
  mark("clicked Run");
  await sleep(1500);
  await speedUp("Metal testnet: binding mandates, selling queries (real transactions)");
  // Beats 1-3 run on their own until the replacement approval.
  let shotSell = false, shotRefused = false;
  for (;;) {
    const r = await runState();
    const beat = (id) => r.beats.find((b) => b.id === id);
    if (!shotSell && beat("sell").status === "running" && beat("sell").items.length >= 4) { await normal(); await sleep(1800); await still("11-x402-selling"); await speedUp("Metal testnet: selling queries (real transactions)"); shotSell = true; }
    if (!shotRefused && beat("rise").items.some((i) => i.text.includes("customer charged"))) { await normal(); await sleep(400); await still("12-x402-cap-refused"); await sleep(3500); await speedUp("Metal testnet"); shotRefused = true; }
    if (r.pendingApproval || r.status === "failed") break;
    await sleep(300);
  }
  await normal();
  mark("approval: replace mandates");
  await page.waitForSelector("[data-testid=x402-approve]");
  await moveTo("[data-testid=x402-approval] h3", 25);
  await sleep(3500);
  await still("13-x402-approval-new-limits");
  await click("[data-testid=x402-approve]");
  mark("approved new limits");
  await sleep(1200);
  await speedUp("Metal testnet: replacing mandates, retrying Q6, verifying orders, refunds");
  let shotReplaced = false, shotDispute = false;
  for (;;) {
    const r = await runState();
    const beat = (id) => r.beats.find((b) => b.id === id);
    if (!shotReplaced && beat("replace").status === "done") { await normal(); await sleep(400); await still("14-x402-mandates-replaced"); await sleep(3000); await speedUp("Metal testnet: verifying signed orders, refunds"); shotReplaced = true; }
    if (!shotDispute && beat("dispute").status === "done") { await normal(); await sleep(400); await still("15-x402-dispute-refunds"); await sleep(3500); await speedUp("Metal testnet → Airwallex sandbox"); shotDispute = true; }
    if (r.pendingApproval?.type === "x402.pay_licence" || r.status === "failed") break;
    await sleep(300);
  }
  await normal();
  mark("approval: licence fee");
  await page.waitForSelector("[data-testid=x402-approve]");
  await moveTo("[data-testid=x402-approval] h3", 25);
  await sleep(3000);
  await still("16-x402-licence-approval");
  await click("[data-testid=x402-approve]");
  mark("approved licence fee");
  for (;;) {
    const r = await runState();
    if (r.status === "done" || r.status === "failed") break;
    await sleep(300);
  }
  await sleep(1500);
  await moveTo("[data-testid=x402-ledger]", 30);
  await still("17-x402-done");
  await sleep(5000);
  mark("end");
} finally {
  await normal().catch(() => {});
  ff.stdin.write("q");
  await new Promise((r) => ff.on("close", r));
  await browser.close();
  xvfb.kill();
  console.log(JSON.stringify({ marks, fast }));
}
// Post: keep normal spans at 1x, play marked spans at FAST x.
const total = marks.at(-1).t + 1.5;
const segs = [];
let cur = 0;
for (const [a, b] of fast) { if (a > cur) segs.push([cur, a, 1]); segs.push([a, b, FAST]); cur = b; }
segs.push([cur, total, 1]);
const parts = segs.filter(([a, b]) => b - a > 0.05).map(([a, b, s], i) => `[0:v]trim=start=${a.toFixed(2)}:end=${b.toFixed(2)},setpts=(PTS-STARTPTS)/${s}[v${i}]`);
const n = parts.length;
const filter = parts.join(";") + ";" + Array.from({ length: n }, (_, i) => `[v${i}]`).join("") + `concat=n=${n}:v=1:a=0,fps=30[out]`;
await new Promise((res, rej) => spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", RAW, "-filter_complex", filter, "-map", "[out]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", out], { stdio: "inherit" }).on("close", (c) => (c ? rej(new Error("ffmpeg " + c)) : res())));
console.log("segments", JSON.stringify(segs.map(([a, b, s]) => [+a.toFixed(1), +b.toFixed(1), s])));
