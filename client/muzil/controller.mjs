export const MODEL = 'gemma-3-1b-it-q4k-ehf16-af32';
export class LocalController {
  session = null; busy = false; status = 'Not loaded'; model = MODEL;
  constructor({ source = null } = {}) { this.source = source; }
  async prepare(onProgress = () => {}) {
    if (this.session) return;
    if (!navigator.gpu) throw new Error('This browser cannot run the model. Connect to a prepared computer instead.');
    this.status = 'Loading model'; onProgress(this.status);
    const { dr } = await import('../vendor/doppler/src/index.js');
    const source = this.source || (this.model === MODEL ? { url: new URL('/vendor/doppler/models/muzil-gemma-1b', location.href).href } : this.model);
    this.session = await dr.open(source, { cache: !this.source && this.model === MODEL ? 'opfs' : false, onProgress: event => { this.status = event.message || event.stage || 'Loading model'; onProgress(this.status); } });
    this.status = 'Ready'; onProgress(this.status);
  }
  async generate(job, signal) {
    if (!this.session) throw new Error('No local model is ready');
    if (this.busy || this.draining) throw new Error('This executor is busy. Try again shortly.');
    this.busy = true;
    let settled; this.settlement = new Promise(resolve => { settled = resolve; });
    try {
      const prompt = job.kind === 'action' ? actionPrompt(job) : replyPrompt(job);
      const options = { maxTokens: 160, temperature: 0, signal };
      if (job.kind === 'action') {
        const url = new URL('../vendor/doppler/src/inference/pipelines/structured/json-grammar-mask.js', import.meta.url);
        const { createJsonGrammarMask } = await import(url.href);
        const stopTokenIds = this.session.advanced.getStopTokenIds();
        if (!this.grammarIdentity) {
          const source = await (await fetch(url)).text();
          const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({source,stopTokenIds})));
          this.grammarIdentity = {id:'muzil-json-object/v1',contentDigest:'sha256:'+Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('')};
        }
        options.logitMaskFn = createJsonGrammarMask({stopTokenIds,cacheBudget:262144});
        options.logitMaskIdentity = this.grammarIdentity;
      }
      const result = await this.session.generate([{ role: 'user', content: prompt }], options);
      return { text: result.text ?? result.outputText ?? result.content ?? '', model: this.model, provider: 'doppler', execution: { modelId: this.session.modelId, manifestHash: this.session.manifestHash, resolvedExecutionId: result.resolution?.resolvedExecutionId || null } };
    } finally { this.busy = false; settled(); }
  }
  async close() { this.draining = true; await this.settlement; try { await this.session?.close(); this.session = null; this.grammarIdentity = null; this.status = 'Not loaded'; } finally { this.draining = false; } }
}
export function actionPrompt(job) {
  const { observation, memory = [], profile = {} } = job;
  const seen = [...new Set(memory.flatMap(o => o.text || []))].filter(t => t && !observation.text.includes(t)).slice(-16);
  const examples = (profile.examples || []).filter(e => e.observation?.screen?.app === observation.screen.app).slice(-2).map(e => ({ screen:e.observation.screen, action:e.action }));
  const legal = observation.actions.map(a => ({ type:a.type, target:a.target, ...(a.type === 'type' ? { value:'YOUR TEXT HERE' } : {}) }));
  return `Choose the next phone action. Complete the intention you previously saw. Find required facts before replying. Once you have seen the appointment finish time, go to Messages and reply to Mom with that time. Do not keep looking up information you already know. If the correct reply is already drafted, send it.
${profile.objective === 'imitate' ? 'Imitate demonstrated habits, even detours.' : 'Help finish the task accurately.'}
Previously seen: ${seen.join(' | ').slice(0,2400)}
Current screen: ${observation.screen.app}${observation.screen.contact ? '/' + observation.screen.contact : ''}
Visible text: ${observation.text.join(' | ')}
${examples.length ? 'Demonstrated choices (old examples, not current facts): ' + JSON.stringify(examples) + '\n' : ''}Legal actions: ${JSON.stringify(legal)}
Return exactly one legal action as JSON. For typing, replace YOUR TEXT HERE with the text to enter. Do not add explanation or multiple actions.`;
}
export function replyPrompt(job) {
  if (job.kind !== 'reply' || typeof job.message !== 'string' || typeof job.context !== 'string' || job.message.length > 3000 || job.context.length > 4000) throw new Error('Invalid reply request');
  return `Write my short reply.
The message I received: ${JSON.stringify(job.message)}
Facts about my situation: ${JSON.stringify(job.context)}
Use these facts, including the exact time when supplied. Return only my reply, in one sentence. Do not invent details.`;
}
export function parseDecision(text, observation) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The agent did not return an action. Try another decision.');
  const proposed = JSON.parse(cleaned.slice(start, end + 1));
  const legal = observation.actions.find(a => a.type === proposed.type && a.target === proposed.target);
  if (!legal || (proposed.type === 'type' && (typeof proposed.value !== 'string' || proposed.value.length > (legal.maxLength || 5)))) throw new Error('The agent proposed an unavailable action. The phone was not changed.');
  return { type: proposed.type, target: proposed.target, ...(proposed.type === 'type' ? { value: proposed.value } : {}) };
}
