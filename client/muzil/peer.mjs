// Reploid owns the WebRTC transport; this adapter carries bounded game inference jobs.
// Prepared whole-model execution is usable here. Partition placement/acquisition remains
// owned by the sibling libraries and is not simulated by this page.
export class PeerController {
  transport = null; pending = new Map(); active = null; remote = null; sharing = false;
  constructor({ local, onChange = () => {}, onGame = () => {} }) { this.local = local; this.onChange = onChange; this.onGame = onGame; }
  get ready() { return this.transport?.getState() === 'connected' && this.remote?.ready && Date.now() - this.remote.at < 16000; }
  get state() { return this.transport?.getState() || 'offline'; }
  async connect(initiator) {
    await this.close();
    const [{ createP2PTransport }, { resolveConfig }] = await Promise.all([
      import('../vendor/reploid/packages/reploid/src/transport/assignment.js'),
      import('../vendor/reploid/packages/reploid/src/config/index.js'),
    ]);
    this.signals = []; this.receiveSignal = null; this.code = ''; this.replies = new Map();
    const output = (type, payload) => { this.signals.push({ type, payload }); };
    const config = resolveConfig({ overrides: { webrtc: { connectTimeoutMs: 180000, pendingRemoteIceTtlMs: 180000, dataChannelLabel: 'muzil-inference-v1' } } });
    this.transport = createP2PTransport({ config, initiator,
      rtcConfig: globalThis.MUZIL_RTC_CONFIG || { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
      signaling: { subscribe: fn => { this.receiveSignal = fn; return () => { this.receiveSignal = null; }; }, sendOffer: p => output('offer', p), sendAnswer: p => output('answer', p), sendIceCandidate: p => output('ice-candidate', p), sendClose: () => {} },
      onStateChange: state => {
        if (state === 'connected') { this.announce(); this.heartbeat = setInterval(() => { this.announce(); this.onChange(); }, 5000); }
        if (['closed','failed','closing'].includes(state)) { clearInterval(this.heartbeat); this.remote = null; this.active?.abort(); for (const entry of this.pending.values()) entry.reject(new Error('Peer disconnected. You can reconnect or continue playing.')); this.pending.clear(); }
        this.onChange();
      },
      onMessage: message => { this.handle(message).catch(() => {}); },
    });
    void this.transport.connect().catch(error => { this.error = error.message; this.onChange(); });
  }
  async exportCode() {
    const started = Date.now();
    while (!this.signals.some(s => ['offer','answer'].includes(s.type))) { if (Date.now() - started > 12000) throw new Error('Could not create a connection code'); await new Promise(r => setTimeout(r, 50)); }
    const pc = this.transport.getPeerConnection();
    while (pc && pc.iceGatheringState !== 'complete' && Date.now() - started < 12000) await new Promise(r => setTimeout(r, 100));
    this.code = btoa(JSON.stringify({ schema: 'muzil.pair/v1', signals: this.signals }));
    return this.code;
  }
  async acceptCode(code) {
    if (code.length > 90000) throw new Error('Connection code is too large');
    const packet = JSON.parse(atob(code.trim()));
    if (packet.schema !== 'muzil.pair/v1' || !Array.isArray(packet.signals) || packet.signals.length > 70 || !this.receiveSignal) throw new Error('Invalid connection code');
    for (const signal of packet.signals) {
      if (!['offer','answer','ice-candidate'].includes(signal.type)) throw new Error('Invalid signal type');
      this.receiveSignal(signal);
    }
  }
  announce() {
    if (this.state === 'connected') this.transport.send({ schema: 'muzil.inference/v1', type: 'ready', ready: this.sharing && !!this.local.session && !this.local.busy && !this.local.draining, model: this.local.model });
    this.onChange();
  }
  async handle(m) {
    if (m?.schema === 'muzil.race/v1') { this.onGame(m); return; }
    if (m?.schema !== 'muzil.inference/v1') return;
    if (m.type === 'ready') { this.remote = { ready: m.ready === true, model: String(m.model || '').slice(0, 150), at: Date.now() }; this.onChange(); return; }
    if (m.type === 'result' || m.type === 'error') {
      const entry = this.pending.get(m.id); if (!entry) return;
      if (m.type === 'error') entry.reject(new Error(String(m.error).slice(0, 300)));
      else if (typeof m.result?.text === 'string' && m.result.text.length < 12000) entry.resolve(m.result);
      else entry.reject(new Error('Invalid peer response'));
      this.pending.delete(m.id); return;
    }
    if (m.type === 'cancel' && this.activeId === m.id) { this.active?.abort(); return; }
    if (m.type !== 'request' || typeof m.id !== 'string' || m.id.length > 100) return;
    const assignedTransport = this.transport;
    const respond = payload => { if (this.transport === assignedTransport && this.state === 'connected') assignedTransport.send({ schema: 'muzil.inference/v1', id: m.id, ...payload }); };
    if (this.replies.has(m.id)) { respond(this.replies.get(m.id)); return; }
    if (!this.sharing || !this.local.session || this.active || this.local.busy) { respond({ type: 'error', error: 'Executor is unavailable or draining' }); return; }
    if (!['action','reply'].includes(m.job?.kind) || JSON.stringify(m.job).length > 42000 || (m.job.kind === 'action' && (!Array.isArray(m.job.observation?.actions) || !Array.isArray(m.job.observation?.text)))) { respond({ type: 'error', error: 'Invalid bounded inference request' }); return; }
    this.active = new AbortController(); this.activeId = m.id; const signal = this.active.signal;
    const deadline = setTimeout(() => this.active?.abort(), 45000);
    let response = null;
    try {
      const result = await this.local.generate(m.job, signal);
      if (!signal.aborted) { const payload = { type: 'result', result }; this.replies.set(m.id, payload); if (this.replies.size > 32) this.replies.delete(this.replies.keys().next().value); response = payload; }
    } catch (error) { response = { type: 'error', error: error.message }; }
    finally { clearTimeout(deadline); this.active = null; this.activeId = null; if (this.transport === assignedTransport) this.announce(); }
    if (response) respond(response);
  }
  generate(job, signal) {
    if (!this.ready) return Promise.reject(new Error('Connect to a prepared peer, or load a model on this device.'));
    if (this.pending.size) return Promise.reject(new Error('An inference request is already running'));
    signal?.throwIfAborted(); const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const finish = fn => value => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.pending.delete(id); fn(value); };
      const cancel = () => { try { this.transport.send({ schema: 'muzil.inference/v1', type: 'cancel', id }); } catch {} finish(reject)(new Error('Inference cancelled')); };
      const timer = setTimeout(() => { cancel(); }, 45000);
      this.pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.transport.send({ schema: 'muzil.inference/v1', type: 'request', id, job }); }
      catch (error) { finish(reject)(error); }
    });
  }
  sendGame(message) {
    if (this.state !== 'connected') throw new Error('Connect another player first');
    this.transport.send({ ...message, schema: 'muzil.race/v1' });
  }
  async close() {
    clearInterval(this.heartbeat); this.active?.abort();
    await this.transport?.close(); this.transport = null; this.remote = null;
    for (const entry of this.pending.values()) entry.reject(new Error('Connection closed'));
    this.pending.clear(); this.onChange();
  }
}
