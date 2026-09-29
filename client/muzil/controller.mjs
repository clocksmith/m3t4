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
    this.model = this.session.modelId;
    this.status = 'Ready'; onProgress(this.status);
  }
  async generate(job, signal) {
    if (!this.session) throw new Error('No local model is ready');
    if (this.busy || this.draining) throw new Error('This executor is busy. Try again shortly.');
    this.busy = true;
    let settled; this.settlement = new Promise(resolve => { settled = resolve; });
    try {
      const prompt = job.kind === 'action' ? actionPrompt(job) : replyPrompt(job);
      const options = { maxTokens: 96, temperature: 0, topK: 0, topP: 1,
        repetitionPenalty: 1, repetitionPenaltyWindow: 0, presencePenalty: 0,
        useChatTemplate: true, signal };
      const result = await this.session.generate([{ role: 'user', content: prompt }], options);
      return { binding: job.binding ? structuredClone(job.binding) : null, text: result.text ?? result.outputText ?? result.content ?? '', model: this.session.modelId, provider: 'doppler', execution: { modelId: this.session.modelId, manifestHash: this.session.manifestHash, resolvedExecutionId: result.resolution?.resolvedExecutionId || null } };
    } finally { this.busy = false; settled(); }
  }
  async close() { this.draining = true; await this.settlement; try { await this.session?.close(); this.session = null; this.status = 'Not loaded'; } finally { this.draining = false; } }
}
export function actionPrompt(job, { format = 'command' } = {}) {
  const { observation, memory = [], profile = {}, history = [] } = job;
  // Availability distinguishes states such as an empty draft from a send-ready
  // draft. Transient notification controls do not change that app interaction.
  const controls = observed => JSON.stringify((observed.actions || [])
    .filter(a => !a.target.startsWith('notification:') && !a.target.startsWith('dismiss:'))
    .map(a => JSON.stringify([a.type, a.target])).sort());
  const currentControls = controls(observation);
  const seen = [...new Set(memory.flatMap(o => o.text || []))].filter(t => t && !observation.text.includes(t)).slice(-16);
  const examples = (profile.examples || []).filter(e => e.observation?.screen?.app === observation.screen.app
    && e.observation.screen.contact === observation.screen.contact
    && controls(e.observation) === currentControls
    && observation.actions.some(a => a.type === e.action?.type && a.target === e.action.target)).slice(-8)
    .map(e => ({ app: e.observation.screen, visible: e.observation.text || [],
      action: format === 'json' ? e.action : `${e.action.type} ${e.action.target}${e.action.type === 'type' ? ' = ' + e.action.value : ''}`,
      ...(e.after ? { result: { phase: e.after.phase, app: e.after.screen, visible: e.after.text } } : {}) }));
  const legal = observation.actions.map(a => ({ type:a.type, target:a.target, label:a.label,
    ...(a.type === 'type' ? { value:'YOUR TEXT HERE' } : {}) }));
  return `You control a phone. Choose one next action to complete the intention you saw.
Read memory before opening another app. If you already know a requested fact, use it instead of looking it up again. To reply, open Messages, select the contact, type the answer, then send it. Use the CURRENT appointment end time, not its start time or a demonstration time.
The current screen replaces earlier screen and draft states. Do not retype an unchanged draft. If the current draft already answers the intention using facts you saw, send it. Historical examples show their results; their facts are not this round's facts.
${profile.objective === 'imitate' ? 'Imitate the demonstrated habits, including detours.' : 'Complete the task accurately. Use facts already seen. Avoid repeating actions that did not help.'}
${examples.length ? 'Earlier demonstrations from other rounds (their facts are not current): ' + JSON.stringify(examples) + '\n' : ''}Memory of visible information: ${seen.join(' | ').slice(0,2400)}
Recent actions: ${JSON.stringify(history.slice(-8))}
Current app: ${observation.screen.app}${observation.screen.contact ? '/' + observation.screen.contact : ''}
Visible information: ${observation.text.join(' | ')}
Available controls:\n${format === 'json' ? JSON.stringify(legal) : observation.actions.map(a => a.type + ' ' + a.target + (a.type === 'type' ? ' = TEXT' : '') + ' (' + a.label + ')').join('\n')}
${format === 'json' ? 'Return one JSON action with type and target. For typing include value containing your actual message.' : 'Output only one command: tap TARGET or type TARGET = TEXT. Copy TARGET exactly from a listed control. For typing, TEXT is the actual message. Do not quote a tap target.'} No explanation.\nNext action:`;
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
  let proposed;
  if (start >= 0 && end >= start) proposed = JSON.parse(cleaned.slice(start, end + 1));
  else {
    let command = cleaned.replace(/^(tap|type)\s+/, '');
    if (command.startsWith('"') && command.endsWith('"')) command = JSON.parse(command);
    const tapped = observation.actions.find(a => a.type === 'tap' && a.target === command);
    const typed = observation.actions.find(a => a.type === 'type' && command.startsWith(a.target + ' = '));
    if (tapped) proposed = {type:'tap',target:tapped.target};
    else if (typed) proposed = {type:'type',target:typed.target,value:command.slice(typed.target.length + 3)};
    else throw new Error('The agent did not return one permitted command. Try another decision.');
  }
  const legal = observation.actions.find(a => a.type === proposed.type && a.target === proposed.target);
  if (!legal || (proposed.type === 'type' && (typeof proposed.value !== 'string' || proposed.value.length > (legal.maxLength || 5)))) throw new Error('The agent proposed an unavailable action. The phone was not changed.');
  return { type: proposed.type, target: proposed.target, ...(proposed.type === 'type' ? { value: proposed.value } : {}) };
}
