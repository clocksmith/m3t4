import { chromium } from 'playwright';
import { createDevServer } from './dev-serve.mjs';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real GPU inference only. Local fixtures require pinned sibling model artifacts.
const out = process.env.MUZIL_PROOF_OUT || '/tmp/muzil-mesh-proof';
const remoteStage = Number(process.env.MUZIL_REMOTE_STAGE ?? 1);
if (![0, 1].includes(remoteStage)) throw Error('MUZIL_REMOTE_STAGE must be 0 or 1');
await mkdir(out, { recursive: true });
const server = createDevServer({ modelRoot: process.env.MUZIL_PROOF_MODEL_ROOT
  || fileURLToPath(new URL('../../doppler/models/local/', import.meta.url)) });
if (!process.env.MUZIL_PROOF_ORIGIN) await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = process.env.MUZIL_PROOF_ORIGIN || `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
let remoteBrowser = null;
const contributorContexts = [], contributorDirectories = [];
const pages = [], requesterPages = [], report = { scope: 'Real Doppler partitions over authenticated Reploid WebRTC',
  controller: process.argv.includes('--ui') ? 'Actual phone UI agent loop' : 'Engine qualification loop',
  physicalHosts: process.env.MUZIL_REMOTE_CDP ? 2 : 1, remoteStage,
  executorStorage: 'Separate persistent Chrome profiles for local contributors; existing profile for remote contributors. Requesters remain fresh private contexts.',
  policyUrl: process.env.MUZIL_PROOF_POLICY_URL || '/muzil/mesh-policy.json',
  events: [], requesterWeights: [], requesterRuntime: [], errors: [] };
const personalized = process.argv.includes('--personalized');
report.sources = {};
for (const path of ['client/muzil/app.mjs', 'client/muzil/mesh.mjs', 'client/muzil/controller.mjs',
  'client/muzil/engine.mjs', 'client/muzil/scenarios.mjs', 'client/muzil/decision.mjs', 'tools/muzil-mesh-smoke.mjs']) {
  const bytes = await readFile(new URL('../' + path, import.meta.url));
  report.sources[path] = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}
report.runtimeSources = JSON.parse(await readFile(new URL('../client/muzil/runtime-sources.json', import.meta.url)));

async function page(instance, url, { requester = false, persistent = false } = {}) {
  const p = persistent ? await instance.contexts()[0].newPage() : await instance.newPage();
  pages.push(p);
  if (requester) requesterPages.push(p);
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
  if (process.env.MUZIL_PROOF_POLICY_URL) {
    await p.route('**/muzil/mesh-policy.json', async route => {
      const response = await route.fetch({ url: new URL(process.env.MUZIL_PROOF_POLICY_URL, url).href });
      const body = await response.body();
      const identity = 'sha256:' + createHash('sha256').update(body).digest('hex');
      if (report.policyIdentity && report.policyIdentity !== identity) {
        await route.fulfill({ status: 409, body: 'Candidate policy changed during proof' }); return;
      }
      report.policyIdentity = identity;
      await route.fulfill({ response, body });
    });
  }
  await p.goto(new URL('/muzil/', url).href);
  await p.evaluate(async sources => {
    for (const [path, expected] of Object.entries(sources)) {
      if (!path.startsWith('client/')) continue;
      const response = await fetch('/' + path.slice('client/'.length));
      if (!response.ok) throw Error('Cannot verify served source: ' + path);
      const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
      const identity = 'sha256:' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      if (identity !== expected) throw Error('Served source differs from the proof checkout: ' + path);
    }
  }, report.sources);
  await p.evaluate(async () => { window.mesh = (await import('/muzil/app.mjs')).mesh; });
  if (requester) await p.evaluate(() => {
    window.meshJobs = [];
    const generate = mesh.generate.bind(mesh);
    mesh.generate = (job, signal) => {
      meshJobs.push({ submittedAt: Date.now(), job: structuredClone(job) });
      return generate(job, signal);
    };
  });
  if (requester && personalized && process.argv.includes('--ui')) {
    // The lesson uses real phone controls before any model is prepared.
    await p.locator('#start-round').click(); await p.locator('#dismiss-reveal').click();
    await p.locator('[data-action="app:calendar"]').first().click();
    await p.locator('#phone-home').click(); await p.locator('[data-action="app:notes"]').click();
    await p.locator('#phone-home').click(); await p.locator('[data-action="app:messages"]').first().click();
    await p.locator('[data-action="contact:mom"]').click(); await p.locator('#phone-reply').fill('Pick me up at 5:40 PM, side entrance.');
    await p.getByRole('button', { name: 'Send message', exact: true }).click(); await p.locator('#next-round').waitFor();
  }
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
  try { await p.evaluate(index => mesh.prepare(index), index); }
  catch (error) {
    report.events.push({ phase, index, failures: await p.evaluate(() => mesh.metrics.preparationFailures) });
    throw error;
  }
  const info = await p.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    const manifest = await (await fetch(new URL('manifest.json', mesh.modelBase))).json();
    return { vendor: adapter?.info.vendor, architecture: adapter?.info.architecture, userAgent: navigator.userAgent,
      storage: await navigator.storage.estimate(),
      fullModelWeightBytes: manifest.shards.reduce((sum, shard) => sum + shard.size, 0) };
  });
  const receipt = await p.evaluate(() => mesh.metrics.contribution);
  report.events.push({ phase, index, info, receipt });
  if (!receipt.descriptor.ready || receipt.descriptor.index !== index
    || receipt.storage.verifiedBytes >= info.fullModelWeightBytes) {
    throw Error('Contribution did not become ready through selective verified acquisition');
  }
  console.log('ready', phase, index);
}
let productRoundIndex = 0;
async function runProductRound(p) {
  const number = ++productRoundIndex;
  try {
    await p.evaluate(() => mesh.refresh());
    const before = await p.evaluate(() => ({
      roundId: JSON.parse(localStorage.getItem('muzil.replay.v1') || 'null')?.roundId,
      decisions: mesh.metrics.decisions.length,
      jobs: meshJobs.length,
    }));
    await p.locator('#site-menu summary').click();
    await p.locator('#agent-round').click();
    await p.waitForFunction(previous => {
      const saved = JSON.parse(localStorage.getItem('muzil.replay.v1') || 'null');
      return (saved && saved.roundId !== previous)
        || document.getElementById('round-status').textContent.includes('You can take over.');
    }, before.roundId, { timeout: 210000 });
    const result = await p.evaluate(async before => {
      const { replay } = await import('/muzil/engine.mjs');
      const record = JSON.parse(localStorage.getItem('muzil.replay.v1') || 'null');
      const steps = mesh.metrics.decisions.slice(before.decisions);
      const requests = meshJobs.slice(before.jobs);
      if (!record || record.roundId === before.roundId) return {
        phase: 'error', error: document.getElementById('round-status').textContent,
        steps, requests, actions: [], replayAgrees: false,
      };
      const rebuilt = replay(record);
      const accepted = record.log.filter(row => row.action.decision);
      const uiFinished = document.getElementById('phone-overlay').textContent.includes('INTENTION KEPT');
      const uiExpired = document.getElementById('phone-overlay').textContent.includes('LOST IN THE PHONE');
      return { phase: rebuilt.phase, steps, requests, replay: record, elapsedMs: record.elapsed,
        firstValidActionMs: accepted[0]?.at ?? null,
        actions: accepted.map(row => ({ ...row.action.decision, accepted: true, at: row.at })),
        replayAgrees: JSON.stringify(rebuilt.log) === JSON.stringify(record.log)
          && (rebuilt.phase === 'finished' ? uiFinished : rebuilt.phase === 'expired' && uiExpired),
        metrics: mesh.metrics,
      };
    }, before);
    await p.screenshot({ path: `${out}/phone-round-${number}.png`, fullPage: true });
    console.log('PHONE ROUND', number, result.phase, result.firstValidActionMs);
    return result;
  } catch (error) {
    return { phase: 'error', error: error.message, steps: [], actions: [], replayAgrees: false };
  }
}
async function runRound(p, trained) {
  if (process.argv.includes('--ui')) return runProductRound(p);
  return p.evaluate(async trained => {
    const { createPhone, applyAction, observe, makeReplay, replay, advance } = await import('/muzil/engine.mjs');
    const { SCENARIOS, RULES } = await import('/muzil/scenarios.mjs');
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
    let firstValidActionMs = null;
    state = applyAction(state, { id: 'start', roundId: state.roundId, type: 'tap', target: 'start' }).state;
    try { for (let i = 0; i < 16 && state.phase === 'playing'; i++) {
      state = advance(state, performance.now() - started);
      if (state.phase !== 'playing') break;
      const pending = decisions.begin(state, context), before = performance.now();
      const result = await mesh.generate({ kind: 'action', binding: pending.binding, observation: pending.observation,
        history: state.log.map(e => ({ type: e.action.type, target: e.action.target, value: e.action.value })), memory, profile },
      AbortSignal.any([pending.signal, AbortSignal.timeout(Math.max(1, RULES.durationMs - state.elapsed))]));
      state = advance(state, performance.now() - started);
      const row = { text: result.text, elapsedMs: performance.now() - before, completedAt: Date.now(),
        execution: result.execution, recovery: result.recovery }; steps.push(row);
      try {
        const applied = decisions.accept(state, result, context);
        if (!applied.accepted) throw Error(applied.reason);
        state = applied.state; memory.push(observe(state)); firstValidActionMs ??= performance.now() - started;
      } catch (e) { row.error = e.message; break; }
    } } catch (error) { state = advance(state, performance.now() - started); steps.push({ error: error.message }); }
    finally { decisions.cancel(); }
    const record = makeReplay(state);
    return { phase: state.phase, trained, steps, actions: decisions.receipts, replay: record,
      firstValidActionMs, elapsedMs: performance.now() - started,
      replayAgrees: JSON.stringify(replay(record)) === JSON.stringify(state), metrics: mesh.metrics };
  }, trained).catch(error => ({ phase: 'error', error: error.message, steps: [], actions: [], replayAgrees: false }));
}

try {
  const requester = await page(browser, origin, { requester: true });
  if (process.env.MUZIL_REMOTE_CDP) remoteBrowser = await chromium.connectOverCDP(process.env.MUZIL_REMOTE_CDP);
  const executorPage = async index => {
    if (remoteBrowser && index === remoteStage) return page(remoteBrowser, process.env.MUZIL_REMOTE_ORIGIN || origin, { persistent: true });
    const directory = await mkdtemp(join(tmpdir(), 'muzil-contributor-')); contributorDirectories.push(directory);
    const context = await chromium.launchPersistentContext(directory, { channel: 'chrome', headless: true,
      args: ['--enable-unsafe-webgpu', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
    contributorContexts.push(context);
    return page(context, origin);
  };
  const a = await executorPage(0), b = await executorPage(1);
  await prepare(a, 0, 'initial'); await prepare(b, 1, 'initial');
  await connect(a, b, 'stage'); await connect(requester, a, 'entry'); await requester.evaluate(() => mesh.refresh());
  report.result = await runRound(requester, personalized);
  console.log('ROUND', JSON.stringify({ phase: report.result.phase, steps: report.result.steps.map(s => ({ text: s.text, error: s.error, ms: s.elapsedMs })) }));
  if (!report.result.actions.some(a => a.accepted)) throw Error('No valid distributed agent action');
  if (!report.result.replayAgrees) throw Error('Recorded replay differs from resulting phone');
  if ((process.argv.includes('--require-completion') || process.argv.includes('--lifecycle'))
    && report.result.phase !== 'finished') throw Error('Agent did not complete the initial task');

  if (process.argv.includes('--lifecycle')) {
    const replacementA = await executorPage(0), newcomerB = await executorPage(1);
    await prepare(replacementA, 0, 'replacement');
    const joiningRound = runRound(requester, personalized);
    await b.waitForFunction(() => mesh.resident.getState().activeAttempts > 0);
    report.joinStartedAt = Date.now();
    const joining = prepare(newcomerB, 1, 'newcomer').then(() => { report.joinReadyAt = Date.now(); });
    [report.duringJoin] = await Promise.all([joiningRound, joining]);
    await connect(replacementA, newcomerB, 'stage'); await connect(requester, replacementA, 'entry');

    // Drain during an admitted decision, then finish the same round using the
    // newly prepared path. No pending generation state is transplanted.
    const drainingRound = runRound(requester, personalized);
    await b.waitForFunction(() => mesh.resident.getState().activeAttempts > 0);
    report.drainStartedAt = Date.now();
    await b.evaluate(() => { window.drained = mesh.drain(); });
    report.duringDrain = await drainingRound; await b.evaluate(() => window.drained);
    report.drainedResident = await b.evaluate(() => mesh.resident);

    // Rebuild the original prepared path after draining. New endpoints bind to
    // the new resident; an old endpoint must never silently change its owner.
    await a.evaluate(() => mesh.close()); await b.evaluate(() => mesh.close());
    await prepare(a, 0, 'recovery-standby'); await prepare(b, 1, 'recovery-standby');
    await connect(a, b, 'stage'); await connect(requester, a, 'entry');
    const unrelated = await page(browser, origin, { requester: true }); await connect(unrelated, a, 'entry');
    const unrelatedRound = runRound(unrelated, personalized);
    const recoveringRound = runRound(requester, personalized);
    await newcomerB.waitForFunction(() => mesh.resident.getState().activeAttempts > 0);
    const lostAt = Date.now();
    // Abrupt tab loss skips every graceful handoff. The affected round must
    // restart that decision on the standby while the other round continues.
    await newcomerB.close();
    report.recovery = await recoveringRound; report.unrelated = await unrelatedRound;
    const recovered = report.recovery.steps.find(step => step.recovery?.attempts > 1
      && step.execution?.placementGeneration > 0 && !step.error);
    report.recoveryInterruptionMs = recovered ? recovered.completedAt - lostAt : null;
    report.backgroundInterferenceMs = report.duringJoin.firstValidActionMs == null || report.result.firstValidActionMs == null
      ? null : report.duringJoin.firstValidActionMs - report.result.firstValidActionMs;
    for (const key of ['duringJoin', 'duringDrain', 'recovery', 'unrelated']) {
      if (report[key].phase !== 'finished' || !report[key].replayAgrees) {
        throw Error(`${key} did not finish a replayable round: ${report[key].error || report[key].phase}`);
      }
    }
    if (!recovered || report.drainedResident !== null
      || report.unrelated.steps.some(step => step.recovery?.attempts > 1)) {
      throw Error('Recovery generation or drain admission failed');
    }
  }
  report.requesterWire = await Promise.all(requesterPages.map(p => p.evaluate(() => wireBytes)));
  report.executorWire = await a.evaluate(() => wireBytes);
  if (report.requesterWeights.length || report.requesterRuntime.length
    || report.requesterWire.some(wire => wire.sentBinary || wire.receivedBinary)) {
    throw Error('Requester loaded weights/runtime or relayed binary activations');
  }
  if (process.argv.includes('--require-completion') && report.result.phase !== 'finished') throw Error('Agent did not complete task');
  report.pass = true;
} catch (error) {
  report.pass = false; report.errors.push(error.stack); console.error(error.stack); process.exitCode = 1;
} finally {
  report.requesterWire = await Promise.all(requesterPages.map(async p => {
    try { return await p.evaluate(() => wireBytes); }
    catch (error) { return { error: error.message }; }
  }));
  await writeFile(out + '/report.json', JSON.stringify(report, null, 2)); console.log('Evidence', out);
  for (const p of pages) if (!p.isClosed()) { await p.evaluate(() => mesh.close()).catch(() => {}); await p.close(); }
  for (const context of contributorContexts) await context.close();
  for (const directory of contributorDirectories) await rm(directory, { recursive: true, force: true });
  await browser.close(); await remoteBrowser?.close(); if (server.listening) await new Promise(r => server.close(r));
}
