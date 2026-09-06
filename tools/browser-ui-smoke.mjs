// Real browser + shipped client + local static assets. External services are
// blocked: this proves local UI/render behavior, not ranked/auth/P2P authority.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../client/", import.meta.url));
const output = await fs.mkdtemp(path.join(os.tmpdir(), "m3t4-ui-smoke-"));
const mime = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };
const server = http.createServer(async (req, res) => {
  try {
    let file = decodeURIComponent(new URL(req.url, "http://local").pathname);
    if (!path.extname(file)) file = "/index.html";
    const target = path.resolve(root, "." + file);
    if (!target.startsWith(root)) throw new Error("invalid path");
    const data = await fs.readFile(target);
    res.setHeader("Content-Type", mime[path.extname(file)] ?? "application/octet-stream");
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { scope: "Headless Chromium; local UI, Canvas2D, and static assets only. No production writes or physical-device qualification.", checks: [] };
let browser;

async function checkSubscriptionContract() {
  const page = await browser.newPage();
  await page.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.route("**/lib/firebase-client.js", route => route.fulfill({ contentType: "text/javascript", body: "export const firebase = () => ({ firestore: {} });" }));
  // Contract fixture only: no credentials, sockets, or cloud mutations.
  await page.route("https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js", route => route.fulfill({ contentType: "text/javascript", body: `
    export const doc = () => ({ kind: "doc" });
    export const collection = () => ({});
    export const orderBy = () => ({});
    export const limit = () => ({});
    export const query = () => ({ kind: "query" });
    export function onSnapshot(ref, next) {
      window.fixtureStarts = (window.fixtureStarts || 0) + 1;
      if (ref.kind === "doc") next({ data: () => ({ latestMatchId: "fixture" }) });
      else next({ docChanges: () => [{ type: "added", doc: { data: () => ({ matchId: "fixture" }) } }] });
      return () => { window.fixtureStops = (window.fixtureStops || 0) + 1; };
    }
    export const getDoc = async () => ({ exists: () => true, data: () => ({ matchId: "fixture" }) });
  ` }));
  try {
    await page.goto(origin + "/about");
    const result = await page.evaluate(async () => {
      const feed = await import("/lib/match-feed.js");
      let cancelledCalls = 0;
      const cancelled = feed.subscribeCurrentMatchId(() => cancelledCalls++);
      cancelled();
      const heads = [], matches = [], failures = [];
      let readyHead, readyMatch;
      const headReady = new Promise(resolve => { readyHead = resolve; });
      const matchReady = new Promise(resolve => { readyMatch = resolve; });
      const stopHead = feed.subscribeCurrentMatchId(row => { heads.push(row); readyHead(); }, error => { failures.push(String(error)); readyHead(); });
      const stopMatch = feed.subscribeLatestMatch(row => { matches.push(row); readyMatch(); }, error => { failures.push(String(error)); readyMatch(); });
      const doc = await feed.fetchMatchDoc("fixture");
      let timeout;
      try {
        await Promise.race([
          Promise.all([headReady, matchReady]),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Subscription fixture did not become ready")), 5000); }),
        ]);
      } finally { clearTimeout(timeout); }
      stopHead();
      stopMatch();
      return { cancelledCalls, heads, matches, doc, failures, starts: window.fixtureStarts, stops: window.fixtureStops };
    });
    assert.equal(result.cancelledCalls, 0);
    assert.equal(result.starts, 2);
    assert.equal(result.stops, 2);
    assert.equal(result.heads[0].matchId, "fixture");
    assert.equal(result.matches[0].matchId, "fixture");
    assert.equal(result.doc.matchId, "fixture");
    assert.deepEqual(result.failures, []);
    report.subscriptionContract = { fixture: true, ...result };
  } finally { await page.close(); }
}

async function inspectSprites(page) {
  return page.evaluate(async () => {
    const { setupCanvas, drawFrame } = await import("/render/canvas2d.js");
    const { STAGES } = await import("/lib/public-sim.js");
    const panel = document.createElement("section");
    panel.className = "panel";
    const canvas = document.createElement("canvas");
    panel.append(canvas);
    document.querySelector("#app").append(panel);
    const { ctx, teardown } = setupCanvas(canvas);
    const rows = [];
    const nativeDraw = ctx.drawImage.bind(ctx);
    let draws = [];
    ctx.drawImage = (img, ...args) => {
      if (img.src?.endsWith("/sprite.png")) draws.push({ src: img.src, row: args[1] / 64, width: args[2], height: args[3], facing: Math.sign(ctx.getTransform().a), upright: ctx.getTransform().d > 0, smoothing: ctx.imageSmoothingEnabled });
      nativeDraw(img, ...args);
    };
    const fighter = { x: 450, y: 420, vx: 0, vy: 0, onGround: true, wall: 0, facing: 1, stun: 0, swipeT: 0, diveT: 0, lastClashTick: -9999, dead: false };
    const frame = { tick: 500, roundStartTick: 0, p0: { ...fighter }, p1: { ...fighter, x: 850, facing: -1 }, token: { exists: false, carrier: -1 }, goal: { exists: false }, scoreboard: [0, 0], rounds: [0, 0] };
    try {
      for (const body of ["sama", "darrius", "demis", "mark"]) {
        const labels = { p1: body, p2: body, cosmetics: [{ body }, { body }] };
        for (const [pose, patch, row, expectedFacing] of [
          ["idle", { onGround: true, wall: 0, vx: 0, vy: 0 }, 0, [1, -1]],
          ["run", { onGround: true, wall: 0, vx: 100, vy: 0 }, 1, [1, -1]],
          ["wall-slide", { onGround: false, vx: 0, vy: 100 }, 4, [-1, 1]],
        ]) {
          Object.assign(frame.p0, patch, { facing: 1, wall: pose === "wall-slide" ? -1 : 0 });
          Object.assign(frame.p1, patch, { facing: -1, wall: pose === "wall-slide" ? 1 : 0 });
          for (let attempt = 0; attempt < 100; attempt++) {
            draws = [];
            drawFrame(ctx, STAGES.datacenter, frame, labels);
            if (draws.length === 2) break;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          rows.push({ body, pose, expectedRow: row, expectedFacing, draws });
          frame.tick += 20;
        }
      }
    } finally { teardown(); panel.remove(); }
    return rows;
  });
}

try {
  browser = await chromium.launch({ headless: true, ...(process.env.M3T4_CHROMIUM_EXECUTABLE ? { executablePath: process.env.M3T4_CHROMIUM_EXECUTABLE } : {}), args: ["--no-sandbox"] });
  await checkSubscriptionContract();
  for (const width of [1440, 900, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
    await page.addInitScript(() => {
      const nativeDraw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (img, ...args) {
        if (img.src?.endsWith("/sprite.png")) window.uiSmokeSpriteDraws = (window.uiSmokeSpriteDraws || 0) + 1;
        return nativeDraw.call(this, img, ...args);
      };
    });
    const errors = [], badAssets = [], requests = [];
    page.on("console", msg => { if (msg.type() === "error" && msg.text().includes("failed to load route")) console.error(msg.text()); });
    page.on("pageerror", e => errors.push(e.message));
    page.on("response", r => { if (r.url().startsWith(origin) && r.status() >= 400) badAssets.push(r.url()); });
    page.on("request", r => requests.push(r.url()));
    await page.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    if (width === 390) await page.route("**/layers/sky.webp", route => route.abort());
    await page.goto(origin);
    await page.waitForFunction(() => document.querySelector("#build-stat-server")?.textContent === "local");
    await page.waitForFunction(() => parseInt(document.querySelector("#build-stat-tick")?.textContent, 10) > 60);
    assert.equal(await page.locator("h1").textContent(), "Workshop");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
    assert.equal(requests.some(url => url.endsWith("/api/build/simulate")), false, "opening match must not require a server");
    assert.equal(requests.some(url => /\/render\/(webgpu|webgl)\.js$|\/modes\/intro\.js$/.test(url)), false, "unused modes and renderers are lazy");
    const backing = await page.locator("canvas").evaluate(c => ({ width: c.width, height: c.height, cssWidth: c.getBoundingClientRect().width }));
    if (width === 390) assert.equal(backing.width * backing.height, 1280 * 720);
    if (width === 390) await page.waitForFunction(() => performance.getEntriesByType("resource").some(r => r.name.endsWith("/layers/sky.png")));
    await page.screenshot({ path: path.join(output, `workshop-${width}.png`), fullPage: true });

    const advanced = page.locator('[data-knobs="0"] .knobs-advanced');
    await advanced.locator("summary").focus();
    await page.keyboard.press("Space");
    assert.equal(await advanced.evaluate(el => el.open), true, "Space opens Advanced, not a new fight");
    const trait = page.locator('input[data-knob="discipline"][data-slot="0"]');
    await trait.fill("23");
    await advanced.locator("summary").click();
    assert.equal(await trait.inputValue(), "23");
    const seed = await page.locator("#build-stat-seed").textContent();
    await page.locator("#test-resim").click();
    assert.equal(await page.locator("#build-stat-seed").textContent(), seed, "retesting holds seed fixed");
    await page.locator('#topnav [data-route="tune"]').click();
    assert.equal(await trait.inputValue(), "23", "home alias preserves editor state");

    // A controlled failed preset request must not overwrite the authored build.
    await page.locator('label[data-mode="preset"]').first().click();
    await page.waitForFunction(() => document.querySelector("#build-stat-server")?.textContent === "failed");
    await page.locator('label[data-mode="user"]').first().click();
    assert.equal(await trait.inputValue(), "23");
    await page.locator('label[data-mode="human"]').first().click();
    assert.equal(await page.locator("#build-stat-server").textContent(), "local");
    await page.keyboard.press("KeyD");
    await page.locator('label[data-mode="user"]').first().click();
    assert.equal(await trait.inputValue(), "23");
    await page.locator(".slot-submit").first().click();
    await page.waitForSelector('[aria-label="Workshop"] a[href="/roster"][aria-current="page"]');
    assert.equal(await page.locator('#topnav [data-route="tune"]').getAttribute("aria-current"), "page");
    assert.equal(await page.evaluate(() => Boolean(sessionStorage.getItem("m3t4:pendingSubmit"))), true, "save handoff preserves config");

    for (const [route, heading] of [["/live", "Watch"], ["/duel", "Play"], ["/about", "About"], ["/intro", null]]) {
      await page.goto(origin + route);
      await page.waitForFunction(() => document.querySelector("#app")?.children.length > 0);
      if (heading) assert.match(await page.locator("#app").textContent(), new RegExp(heading, "i"));
      if (route === "/live") {
        assert.match(await page.locator(".page-subtitle").textContent(), /archive/);
        await page.waitForFunction(() => document.querySelector("#stat-p1")?.textContent?.startsWith("@"));
        await page.waitForFunction(() => window.uiSmokeSpriteDraws > 4);
        assert.equal(requests.some(url => url.endsWith("/lib/firebase-compute.js")), false, "watching without opt-in must not load compute");
      }
      if (route === "/duel") {
        await page.locator("#duel-start").click();
        await page.waitForFunction(() => parseInt(document.querySelector("#duel-stat-tick")?.textContent, 10) > 0);
        await page.waitForFunction(() => window.uiSmokeSpriteDraws > 4);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${route} overflow at ${width}`);
      await page.screenshot({ path: path.join(output, `${route.slice(1)}-${width}.png`), fullPage: true });
    }
    await page.goto(origin + "/about");
    await page.waitForSelector(".rules-page");
    const sprites = await inspectSprites(page);
    for (const row of sprites) {
      assert.equal(row.draws.length, 2, `${row.body} ${row.pose}: both sprites loaded`);
      assert.deepEqual(row.draws.map(d => d.row), [row.expectedRow, row.expectedRow]);
      assert.deepEqual(row.draws.map(d => d.facing), row.expectedFacing);
      assert.ok(row.draws.every(d => d.upright && !d.smoothing && d.width === 64 && d.height === 64));
    }
    assert.deepEqual(errors, [], "browser page errors");
    assert.deepEqual(badAssets, [], "missing local assets");
    report.checks.push({ width, backing, sprites, pageErrors: errors, missingAssets: badAssets });
    console.log(`PASS ${width}px: local fight, traits, modes, save handoff, routes, 4 sprite sheets × 3 poses × 2 facings`);
    await page.close();
  }
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  await browser?.close();
  server.close();
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`UI evidence: ${output}`);
}
