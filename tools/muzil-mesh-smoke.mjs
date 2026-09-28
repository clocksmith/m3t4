import { chromium } from 'playwright';
import { createDevServer } from './dev-serve.mjs';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';

// Real GPU inference only. Local fixtures require pinned sibling model artifacts.
const out = process.env.MUZIL_PROOF_OUT || '/tmp/muzil-mesh-proof';
await mkdir(out, { recursive: true });
const server = createDevServer({ modelRoot: fileURLToPath(new URL('../../doppler/models/local/', import.meta.url)) });
if (!process.env.MUZIL_PROOF_ORIGIN) await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = process.env.MUZIL_PROOF_ORIGIN || `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
let remoteBrowser = null;
const pages = [], report = { scope: 'Real Doppler partitions over authenticated Reploid WebRTC',
  events: [], requesterWeights: [], requesterRuntime: [], errors: [] };
const personalized = process.argv.includes('--personalized');

async function page(instance, url, { requester = false, persistent = false } = {}) {
  const p = persistent ? await instance.contexts()[0].newPage() : await instance.newPage();
  pages.push(p);
  if (requester) p.on('request', r => {
    if (/\.bin(?:\?|$)/.test(r.url())) report.requesterWeights.push(r.url());
    if (r.url().includes('/vendor/doppler/src/')) report.requesterRuntime.push(r.url());
  });
  await p.addInitScript(stun => {
    globalThis.MUZIL_RTC_CONFIG = { iceServers: stun ? [{ urls: stun }] : [] };
    globalThis.wireBytes = { sentBinary: 0, receivedBinary: 0 };
    const watched = new WeakSet();
    const watch = channel => {
      if (watched.has(channel)) return; watched.add(channel);
      channel.addEventListener('message', e => { if (typeof e.data !== 'string') wireBytes.receivedBinary += e.data.byteLength ?? e.data.size; });
      const send = channel.send.bind(channel);
      channel.send = data => { if (typeof data !== 'string') wireBytes.sentBinary += data.byteLength ?? data.size; return send(data); };
      return channel;
    };
    const Original = RTCPeerConnection;
    globalThis.peerConnections = [];
    globalThis.RTCPeerConnection = class extends Original {
      constructor(...args) { super(...args); peerConnections.push(this); this.addEventListener('datachannel', e => watch(e.channel)); }
      createDataChannel(...args) { return watch(super.createDataChannel(...args)); }
    };
  }, process.env.MUZIL_PROOF_STUN || null);
  p.on('pageerror', e => report.errors.push(e.stack));
  await p.goto(url);
  await p.evaluate(async () => { window.mesh = (await import('/muzil/app.mjs')).mesh; });
  return p;
}
async function connect(from, to, kind) {
  console.log('connect', kind);
  await from.evaluate(async kind => { window.link = await mesh.connect(true, kind); }, kind);
  const offer = await from.evaluate(() => link.exportCode());
  await to.evaluate(async ({ kind, offer }) => { window.link = await mesh.connect(false, kind); link.acceptCode(offer); }, { kind, offer });
  const answer = await to.evaluate(() => link.exportCode());
  await from.evaluate(c => link.acceptCode(c), answer);
  await Promise.all([from, to].map(p => p.waitForFunction(() => link.getState().ready, null, { timeout: 30000 })));
}
async function prepare(p, index, phase) {
  console.log('prepare', phase, index);
  await p.evaluate(index => mesh.prepare(index), index);
  const info = await p.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    return { vendor: adapter?.info.vendor, architecture: adapter?.info.architecture, userAgent: navigator.userAgent };
  });
  report.events.push({ phase, index, info, receipt: await p.evaluate(() => mesh.metrics.contribution) });
  console.log('ready', phase, index);
}
async function runRound(p, trained) {
  return p.evaluate(async trained => {
    const { createPhone, applyAction, observe, makeReplay, replay, advance } = await import('/muzil/engine.mjs');
    const { SCENARIOS } = await import('/muzil/scenarios.mjs');
    const { createDecisionOwner } = await import('/muzil/decision.mjs');
    // Recorded human-input fixture teaches only the first scenario. The agent must
    // choose every action on the second scenario using inference, including its new time.
    let lesson = createPhone({ roundId: crypto.randomUUID() });
    for (const [target, value] of [['start'], ['app:calendar'], ['home'], ['app:messages'], ['contact:mom'], ['reply', 'Pick me up at 5:40 PM.'], ['send']]) {
      lesson = applyAction(lesson, { id: crypto.randomUUID(), roundId: lesson.roundId,
        type: value ? 'type' : 'tap', target, ...(value ? { value } : {}) }).state;
    }
    const profile = { objective: 'finish', examples: trained ? lesson.demonstrations : [] };
    const decisions = createDecisionOwner(), context = { matchId: crypto.randomUUID(), controllerId: 'mesh-agent' };
    let state = createPhone({ roundId: crypto.randomUUID(), controller: 'agent', scenario: SCENARIOS[trained ? 1 : 0] });
    const memory = [observe(state)], steps = [], started = performance.now();
    state = applyAction(state, { id: 'start', roundId: state.roundId, type: 'tap', target: 'start' }).state;
    for (let i = 0; i < 16 && state.phase === 'playing'; i++) {
      state = advance(state, performance.now() - started);
      const pending = decisions.begin(state, context), before = performance.now();
      const result = await mesh.generate({ kind: 'action', binding: pending.binding, observation: pending.observation,
        history: state.log.map(e => ({ type: e.action.type, target: e.action.target, value: e.action.value })), memory, profile }, pending.signal);
      state = advance(state, performance.now() - started);
      const row = { text: result.text, elapsedMs: performance.now() - before, execution: result.execution }; steps.push(row);
      try {
        const applied = decisions.accept(state, result, context);
        if (!applied.accepted) throw Error(applied.reason);
        state = applied.state; memory.push(observe(state));
      } catch (e) { row.error = e.message; break; }
    }
    const record = makeReplay(state);
    return { phase: state.phase, trained, steps, actions: decisions.receipts, replay: record,
      replayAgrees: JSON.stringify(replay(record)) === JSON.stringify(state), metrics: mesh.metrics };
  }, trained);
}
async function beginAction(p, key) {
  await p.evaluate(async key => {
    const { createPhone, observe, applyAction } = await import('/muzil/engine.mjs');
    const { createDecisionOwner } = await import('/muzil/decision.mjs');
    let state = createPhone({ roundId: crypto.randomUUID(), controller: 'agent' });
    const memory = [observe(state)]; state = applyAction(state, { id: 'start', roundId: state.roundId, type: 'tap', target: 'start' }).state;
    const owner = createDecisionOwner(), context = { matchId: crypto.randomUUID(), controllerId: key };
    const pending = owner.begin(state, context), started = performance.now();
    window[key] = mesh.generate({ kind: 'action', binding: pending.binding, observation: pending.observation, memory,
      profile: { objective: 'finish', examples: [] } }, pending.signal).then(result => {
      const applied = owner.accept(state, result, context);
      return { accepted: applied.accepted, error: applied.reason, elapsedMs: performance.now() - started, actions: owner.receipts,
        execution: result.execution, recovery: result.recovery, text: result.text };
    }).catch(error => ({ accepted: false, error: error.message, elapsedMs: performance.now() - started }));
  }, key);
}
async function finishAction(p, key) { return p.evaluate(key => window[key], key); }

try {
  const requester = await page(browser, origin, { requester: true }), a = await page(browser, origin);
  if (process.env.MUZIL_REMOTE_CDP) remoteBrowser = await chromium.connectOverCDP(process.env.MUZIL_REMOTE_CDP);
  const b = await page(remoteBrowser || browser, process.env.MUZIL_REMOTE_ORIGIN || origin, { persistent: !!remoteBrowser });
  await prepare(a, 0, 'initial'); await prepare(b, 1, 'initial');
  await connect(a, b, 'stage'); await connect(requester, a, 'entry'); await requester.evaluate(() => mesh.refresh());
  report.result = await runRound(requester, personalized);
  console.log('ROUND', JSON.stringify({ phase: report.result.phase, steps: report.result.steps.map(s => ({ text: s.text, error: s.error, ms: s.elapsedMs })) }));
  if (!report.result.actions.some(a => a.accepted)) throw Error('No valid distributed agent action');
  if (!report.result.replayAgrees) throw Error('Recorded replay differs from resulting phone');

  if (process.argv.includes('--lifecycle')) {
    const replacementA = await page(browser, origin), newcomerB = await page(browser, origin);
    await prepare(replacementA, 0, 'replacement');
    await beginAction(requester, 'baseline'); report.baseline = await finishAction(requester, 'baseline');
    await beginAction(requester, 'duringJoin');
    await b.waitForFunction(() => mesh.resident.getState().activeAttempts > 0);
    const joining = prepare(newcomerB, 1, 'newcomer');
    report.duringJoin = await finishAction(requester, 'duringJoin'); await joining;
    await connect(replacementA, newcomerB, 'stage'); await connect(requester, replacementA, 'entry');
    const unrelated = await page(browser, origin, { requester: true }); await connect(unrelated, replacementA, 'entry');
    await beginAction(unrelated, 'unrelated'); await beginAction(requester, 'recover');
    await b.waitForFunction(() => mesh.resident.getState().activeAttempts > 0);
    const lostAt = Date.now();
    // Abruptly close B's tab: no drain or graceful model handoff runs.
    await b.close();
    report.recovery = await finishAction(requester, 'recover'); report.recovery.lossToResultMs = Date.now() - lostAt;
    report.unrelated = await finishAction(unrelated, 'unrelated');
    await beginAction(requester, 'duringDrain');
    await newcomerB.waitForFunction(() => mesh.resident.getState().activeAttempts > 0);
    await newcomerB.evaluate(() => { window.drained = mesh.drain(); });
    await replacementA.evaluate(() => Promise.all([...mesh.chats.values()].map(chat => chat.refresh())));
    report.duringDrain = await finishAction(requester, 'duringDrain'); await newcomerB.evaluate(() => window.drained);
    report.afterDrainReady = await requester.evaluate(() => mesh.refresh());
    report.backgroundInterferenceMs = report.duringJoin.elapsedMs - report.baseline.elapsedMs;
    for (const key of ['baseline', 'duringJoin', 'recovery', 'unrelated', 'duringDrain']) {
      if (!report[key].accepted) throw Error(`${key} did not produce a valid model action: ${report[key].error}`);
    }
    if (report.recovery.recovery.attempts < 2 || report.recovery.execution.placementGeneration < 1 || report.afterDrainReady) {
      throw Error('Recovery generation or drain admission failed');
    }
  }
  report.requesterWire = await requester.evaluate(() => wireBytes);
  report.executorWire = await a.evaluate(() => wireBytes);
  if (report.requesterWeights.length || report.requesterRuntime.length || report.requesterWire.sentBinary || report.requesterWire.receivedBinary) {
    throw Error('Requester loaded weights/runtime or relayed binary activations');
  }
  if (process.argv.includes('--require-completion') && report.result.phase !== 'finished') throw Error('Agent did not complete task');
  report.pass = true;
} catch (error) {
  report.pass = false; report.errors.push(error.stack); console.error(error.stack); process.exitCode = 1;
} finally {
  await writeFile(out + '/report.json', JSON.stringify(report, null, 2)); console.log('Evidence', out);
  for (const p of pages) if (!p.isClosed()) { await p.evaluate(() => mesh.close()).catch(() => {}); await p.close(); }
  await browser.close(); await remoteBrowser?.close(); if (server.listening) await new Promise(r => server.close(r));
}
