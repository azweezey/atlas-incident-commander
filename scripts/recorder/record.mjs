// Records the Atlas dashboard on a dedicated Xvfb display with ffmpeg (x11grab, H.264, 30fps).
// Usage: node record.mjs safety|escalation <out.mp4> <stillsDir>
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
const [, , clip, out, stills] = process.argv;
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
await page.request.post(BASE + "api/demo/clean", { data: {} });
await page.goto(BASE);
await page.waitForSelector("[data-testid=run-safety]");
await page.waitForFunction(() => document.body.innerText.includes("LIVE"));
await sleep(6000); // let the "exit full screen" hint fade out before recording
console.log("viewport", await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]));
if (clip === "probe") {
  spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "x11grab", "-video_size", `${W}x${H}`, "-i", DISPLAY + ".0", "-frames:v", "1", out], { stdio: "inherit" }).on("close", async () => { await browser.close(); xvfb.kill(); process.exit(0); });
  await new Promise(() => {});
}
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
const scrollTo = (sel, block = "start") =>
  page.evaluate(([s, b]) => document.querySelector(s)?.scrollIntoView({ behavior: "smooth", block: b }), [sel, block]);
const t0 = Date.now();
const marks = [];
const mark = (label) => { const t = (Date.now() - t0) / 1000; marks.push({ t: +t.toFixed(1), label }); console.log(`[${t.toFixed(1)}s] ${label}`); };
const still = async (name) => { await page.screenshot({ path: `${stills}/${name}.png` }); mark("still " + name); };

const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0", "-framerate", "30",
  "-video_size", `${W}x${H}`, "-i", DISPLAY + ".0", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
  "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
await sleep(700);
mark("recording start");
try {
  if (clip === "safety") {
    await sleep(3000);
    await still("01-clean-dashboard");
    await click("[data-testid=run-safety]");
    mark("clicked Run Safety Test");
    await sleep(600);
    await scrollTo("[data-testid=safety-panel]");
    await page.mouse.move(1700, 980, { steps: 25 });
    let seen = 0;
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const n = await page.locator(".attempt-row").count();
      if (n > seen) {
        seen = n;
        mark("row " + n + " visible");
        await sleep(400);
        await page.locator(".attempt-row").nth(n - 1).scrollIntoViewIfNeeded();
        if (n === 1) await still("02-duplicate-two-layers");
        if (n === 6) await still("03-prompt-injection-refused");
      }
      if (await page.locator("[data-testid=scoreboard]").count()) break;
      await sleep(150);
    }
    await page.evaluate(() => document.querySelector("[data-testid=scoreboard]")?.scrollIntoView({ behavior: "smooth", block: "center" }));
    mark("scoreboard visible");
    await sleep(1200);
    await still("04-scoreboard");
    await sleep(2800);
    await scrollTo("[data-testid=timeline]");
    mark("audit timeline");
    await sleep(1500);
    {
      const b = await page.locator("[data-testid=chain-badge]").boundingBox();
      await page.mouse.move(b.x - 40, b.y + b.height + 30, { steps: 30 });
    }
    await still("05-audit-chain-verified");
    await sleep(4000);
    mark("end");
  } else {
    await sleep(2500);
    await still("06-escalation-start");
    await click("[data-testid=scenario-bad-beneficiary]");
    mark("clicked 02 Invalid beneficiary");
    await sleep(500);
    await page.evaluate(() => scrollTo({ top: document.querySelector(".simulator").getBoundingClientRect().top + scrollY - 16, behavior: "smooth" }));
    await page.waitForSelector(".incident", { timeout: 60000 });
    mark("incident appears");
    await sleep(2200);
    await still("07-incident-detected");
    await page.waitForSelector("[data-testid=approve]", { timeout: 60000 });
    mark("escalated to approval queue");
    await sleep(1500);
    await moveTo(".diagnosis", 30);
    await sleep(3500);
    await still("08-agent-escalates");
    await moveTo("[data-testid=approvals] .action", 30);
    await sleep(3000);
    await click("[data-testid=approval-note]");
    await page.keyboard.type("Calling vendor to verify bank details before any repayment", { delay: 38 });
    await sleep(700);
    await click("[data-testid=approve]");
    mark("human approves");
    await page.waitForFunction(() => !document.querySelector("[data-testid=approve]"), null, { timeout: 60000 });
    await sleep(1500);
    await still("09-approved-manual-task");
    await sleep(4500);
    mark("end");
  }
} finally {
  ff.stdin.write("q");
  await new Promise((r) => ff.on("close", r));
  await browser.close();
  xvfb.kill();
  console.log(JSON.stringify(marks));
}
