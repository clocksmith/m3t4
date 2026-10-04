import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDevServer } from './dev-serve.mjs';

const args = process.argv.slice(2);
const value = flag => {
  const result = args[args.indexOf(flag) + 1];
  if (!result || result.startsWith('--')) throw Error(flag + ' requires a value');
  return result;
};
if (!args.includes('--model-dir')) throw Error('Usage: node tools/muzil-model-qualification.mjs --model-dir DIRECTORY --out DIRECTORY [--cdp URL --origin URL --model-url URL]');
const remoteCdp = args.includes('--cdp') ? value('--cdp') : null;
if (remoteCdp && (!args.includes('--origin') || !args.includes('--model-url'))) throw Error('Remote qualification requires explicit --origin and --model-url');
const modelDir = resolve(value('--model-dir'));
const out = resolve(args.includes('--out') ? value('--out') : '/tmp/muzil-model-qualification');
const manifestBytes = await readFile(join(modelDir, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
const server = createDevServer({ modelRoot: dirname(modelDir) });
let browser, page;
const report = {
  scope: 'Real Chrome Doppler inference on one executor, complete model. No distributed execution claim.',
  modelId: manifest.modelId,
  manifestIdentity: 'sha256:' + createHash('sha256').update(manifestBytes).digest('hex'),
  weightBytes: manifest.shards.reduce((sum, shard) => sum + shard.size, 0),
  runs: [], errors: [],
};
report.sources = {};
for (const path of ['client/muzil/controller.mjs', 'client/muzil/engine.mjs',
  'client/muzil/scenarios.mjs', 'client/muzil/decision.mjs', 'tools/muzil-model-qualification.mjs']) {
  const bytes = await readFile(new URL('../' + path, import.meta.url));
  report.sources[path] = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}
report.runtimeSources = JSON.parse(await readFile(new URL('../client/muzil/runtime-sources.json', import.meta.url)));
try {
  if (!remoteCdp) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = remoteCdp ? await chromium.connectOverCDP(remoteCdp)
    : await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] });
  page = remoteCdp ? await browser.contexts()[0].newPage() : await browser.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(remoteCdp ? value('--origin') : `http://127.0.0.1:${server.address().port}/muzil/`);
  report.preparation = await page.evaluate(async ({ directory, modelUrl, identity, sources }) => {
    for (const [path, expected] of Object.entries(sources)) {
      if (!path.startsWith('client/')) continue;
      const response = await fetch('/' + path.slice('client/'.length));
      if (!response.ok) throw Error('Cannot verify served source: ' + path);
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
      if ('sha256:' + hash !== expected) throw Error('Served source differs from the qualification checkout: ' + path);
    }
    const { LocalController } = await import('/muzil/controller.mjs');
    const baseUrl = modelUrl || new URL('/__models/' + directory, location.href).href;
    const bytes = await (await fetch(baseUrl + '/manifest.json')).arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    if ('sha256:' + digest !== identity) throw Error('Served manifest differs from the selected artifact');
    const manifest = JSON.parse(new TextDecoder().decode(bytes));
    window.candidate = new LocalController({ source: { manifest, baseUrl } });
    const started = performance.now();
    await candidate.prepare();
    const adapter = await navigator.gpu.requestAdapter();
    return { elapsedMs: performance.now() - started, modelId: candidate.model,
      gpu: { vendor: adapter.info.vendor, architecture: adapter.info.architecture }, userAgent: navigator.userAgent };
  }, { directory: encodeURIComponent(basename(modelDir)), modelUrl: args.includes('--model-url') ? value('--model-url') : null,
    identity: report.manifestIdentity, sources: report.sources });
  if (report.preparation.modelId !== report.modelId) throw Error('Loaded model identity does not match the candidate');

  // The first scenario supplies a fixed demonstration fixture. Both baseline and
  // personalized agents attempt the second scenario without its evaluator data.
  for (const personalized of [false, true]) {
    const result = await page.evaluate(async personalized => {
      const { createPhone, applyAction, observe, advance, makeReplay, replay } = await import('/muzil/engine.mjs');
      const { SCENARIOS, RULES } = await import('/muzil/scenarios.mjs');
      const { createDecisionOwner } = await import('/muzil/decision.mjs');
      let lesson = createPhone({ roundId: crypto.randomUUID() });
      for (const [target, value] of [['start'], ['app:calendar'], ['home'], ['app:messages'],
        ['contact:mom'], ['reply', 'Pick me up at 5:40 PM.'], ['send']]) {
        const applied = applyAction(lesson, { id: crypto.randomUUID(), roundId: lesson.roundId,
          type: value ? 'type' : 'tap', target, ...(value ? { value } : {}) });
        if (!applied.accepted) throw Error('Invalid demonstration fixture: ' + applied.reason);
        lesson = applied.state;
      }
      const profile = { objective: 'finish', examples: personalized ? lesson.demonstrations.slice(-6) : [] };
      const owner = createDecisionOwner(), context = { matchId: crypto.randomUUID(), controllerId: 'qualification' };
      let state = createPhone({ roundId: crypto.randomUUID(), controller: 'agent', scenario: SCENARIOS[1] });
      const memory = [observe(state)], steps = [], started = performance.now();
      let firstValidActionMs = null;
      state = applyAction(state, { id: 'start', roundId: state.roundId, type: 'tap', target: 'start' }).state;
      try {
        for (let index = 0; index < 16 && state.phase === 'playing'; index++) {
          state = advance(state, performance.now() - started);
          if (state.phase !== 'playing') break;
          const pending = owner.begin(state, context), before = performance.now();
          const result = await candidate.generate({ kind: 'action', binding: pending.binding,
            observation: pending.observation, memory, profile,
            history: state.log.map(({ action }) => ({ type: action.type, target: action.target,
              ...(action.value !== undefined ? { value: action.value } : {}) })) },
          AbortSignal.any([pending.signal, AbortSignal.timeout(Math.max(1, RULES.durationMs - state.elapsed))]));
          state = advance(state, performance.now() - started);
          const row = { screen: pending.observation.screen, text: result.text, elapsedMs: performance.now() - before,
            execution: result.execution, model: result.model };
          steps.push(row);
          const applied = owner.accept(state, result, context);
          if (!applied.accepted) { row.error = applied.reason; break; }
          state = applied.state; memory.push(observe(state));
          firstValidActionMs ??= performance.now() - started;
        }
      } catch (error) { state = advance(state, performance.now() - started); steps.push({ error: error.message }); }
      finally { owner.cancel(); }
      const record = makeReplay(state);
      return { personalized, phase: state.phase, firstValidActionMs, elapsedMs: performance.now() - started,
        steps, actions: owner.receipts, record, replayAgrees: JSON.stringify(replay(record)) === JSON.stringify(state) };
    }, personalized);
    report.runs.push(result);
    console.log(JSON.stringify({ personalized, phase: result.phase,
      acceptedActions: result.actions.filter(action => action.accepted).length,
      firstValidActionMs: result.firstValidActionMs, last: result.steps.at(-1) }));
  }
  report.reply = await page.evaluate(() => candidate.generate({ kind: 'reply',
    message: 'When should I pick you up?', context: 'My appointment finishes at 3:15 PM.' }, AbortSignal.timeout(60000)));
  report.passed = report.errors.length === 0 && report.runs.every(run => run.phase === 'finished' && run.replayAgrees);
  if (!report.passed) process.exitCode = 1;
} catch (error) { report.errors.push(error.stack); report.passed = false; process.exitCode = 1; }
finally {
  if (page) {
    try { await page.evaluate(() => globalThis.candidate?.close()); }
    catch (error) { report.errors.push('Executor cleanup: ' + error.message); report.passed = false; process.exitCode = 1; }
  }
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Evidence: ' + out);
  await page?.close(); await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
