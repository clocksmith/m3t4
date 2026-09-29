import { actionPrompt, replyPrompt } from './controller.mjs';

const root = '../vendor/reploid/packages/reploid/src/';
const load = path => import(new URL(root + path, import.meta.url));
const sha = async bytes => 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

/** Product composition only. Coordination, transfer, acquisition and model work
 * are imported from the synchronized sibling libraries when explicitly needed.
 */
export class MeshController {
  links = []; resident = null; chats = new Map(); ready = false; status = 'No prepared path';
  constructor({ onChange = () => {}, modelBase = null,
    policyUrl = new URL('./mesh-policy.json', import.meta.url) } = {}) {
    this.onChange = onChange; this.modelBase = modelBase; this.policyUrl = policyUrl;
    this.metrics = { attempts: [], decisions: [], contribution: null };
  }
  async initialize() {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const response = await fetch(this.policyUrl);
      if (!response.ok) throw new Error('Cannot load the selected mesh policy');
      this.policy = await response.json();
      if (typeof this.policy.artifacts?.baseUrl !== 'string' || !this.policy.artifacts.baseUrl.trim()
        || typeof this.policy.artifacts?.indexUrl !== 'string' || !this.policy.artifacts.indexUrl.trim()) {
        throw new Error('Mesh policy requires explicit model and piece-index URLs');
      }
      this.modelBase ??= new URL(this.policy.artifacts.baseUrl, response.url).href;
      this.indexUrl = new URL(this.policy.artifacts.indexUrl, response.url).href;
      const [identities, link, entry, chat, resident, grants, peer, config, acquisition] = await Promise.all([
        load('artifacts/identity.js'), load('mesh/partitions/partition-link.js'), load('mesh/partitions/partition-entry.js'),
        load('mesh/partitions/partition-chat.js'), load('mesh/partitions/resident-partition.js'),
        load('mesh/partitions/partition-grants.js'), load('mesh/partitions/partition-peer.js'), load('config/index.js'),
        load('artifacts/custody/piece-acquisition.js'),
      ]);
      this.api = { ...link, ...entry, ...chat, ...resident, ...grants, ...peer, ...acquisition };
      this.identity = await identities.createSigningIdentity({ algorithm: 'ECDSA' });
      this.config = config.resolveConfig({ overrides: { webrtc: { connectTimeoutMs: this.policy.connectTimeoutMs,
        pendingRemoteIceTtlMs: this.policy.connectTimeoutMs, dataChannelLabel: 'muzil-mesh-control' } } });
      this.authority = this.api.createPartitionGrantAuthority({ identity: this.identity, meshId: this.policy.roomId,
        maxGrants: this.policy.maxGrants, maxTtlMs: this.policy.grantTtlMs });
      this.requester = this.api.createPartitionRequester({ entries: () => this.links.filter(l => l.kind === 'entry' && l.initiator && l.link.endpoint).map(l => l.link.endpoint),
        requesterId: this.identity.peerId, meshId: this.policy.roomId, modelId: this.policy.model.id,
        modelIdentity: this.policy.model.identity, planId: this.policy.planId, maxPlacements: this.policy.maxPlacements,
        authorize: async placement => this.links.some(l => l.kind === 'entry' && l.initiator && l.link.remoteId === placement.participantA),
        onAttempt: attempt => { this.metrics.attempts.push(attempt); if (attempt.phase === 'restarting') this.status = 'Restarting on another approved helper'; this.onChange(); },
      });
      this.poll = setInterval(() => this.refresh().catch(() => {}), 4000);
    })();
    return this.initializing;
  }
  async prepare(index) {
    await this.initialize();
    if (this.resident) throw new Error('Drain the current contribution before preparing another');
    const started = performance.now(); this.status = 'Acquiring assigned weights'; this.onChange();
    this.runtime = await import('../vendor/doppler/src/partitions.js');
    const { createVerifiedPieceStorage } = this.runtime;
    const [manifestBytes, indexBytes] = await Promise.all([
      fetch(new URL(this.modelBase + 'manifest.json', location.href)).then(r => r.arrayBuffer()),
      fetch(this.indexUrl).then(r => r.arrayBuffer()),
    ]);
    if (await sha(manifestBytes) !== this.policy.model.identity) throw new Error('Model manifest pin mismatch');
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('muzil-verified-pieces', { create: true });
    const cache = {
      get: async identity => {
        try { return new Uint8Array(await (await (await directory.getFileHandle(identity.slice(7))).getFile()).arrayBuffer()); }
        catch (error) { if (error.name === 'NotFoundError') return null; throw error; }
      },
      put: async (identity, bytes) => {
        const writer = await (await directory.getFileHandle(identity.slice(7), { create: true })).createWritable();
        try { await writer.write(bytes); await writer.close(); } catch (error) { await writer.abort().catch(() => {}); throw error; }
      },
    };
    const base = new URL(this.modelBase, location.href);
    this.acquisition = this.api.createPieceAcquisition({ cache, limits: this.policy.acquisition,
      verify: async (piece, bytes) => bytes.byteLength === piece.size && await sha(bytes) === piece.identity,
      authorize: async ({ sourceId }) => sourceId === base.href,
      foregroundIdle: async signal => { signal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 0)); },
      sources: () => [{ id: base.href, read: async (piece, { signal }) => {
        const response = await fetch(new URL(piece.path, base), { signal, headers: { Range: `bytes=${piece.offset}-${piece.offset + piece.size - 1}` } });
        if (response.status !== 206 || !response.headers.get('Content-Range')?.startsWith(`bytes ${piece.offset}-${piece.offset + piece.size - 1}/`)) {
          await response.body?.cancel(); throw new Error('Weight source must support exact partial reads');
        }
        return new Uint8Array(await response.arrayBuffer());
      } }],
    });
    let storageReceipt;
    const factory = this.runtime.createManifestResidentPartitionFactory({ manifest, manifestIdentity: this.policy.model.identity,
      runtimeConfig: { inference: { session: { kvcache: { maxSeqLen: this.policy.model.generation.maxSeqLen } } } },
      createStorage: async ({ signal }) => {
        const verified = await createVerifiedPieceStorage({ manifestBytes, indexBytes, indexIdentity: this.policy.indexIdentity,
          acquire: (piece, options) => this.acquisition.acquire(piece, options), signal });
        storageReceipt = verified.getReceipt; return verified.storage;
      },
    });
    this.resident = this.api.createResidentPartition({ runtime: factory, model: this.policy.model, plan: this.policy.plan,
      planId: this.policy.planId, index, participantId: this.identity.peerId, limits: this.policy.limits,
      onChange: state => { this.status = `Stage ${index === 0 ? 'A' : 'B'}: ${state.phase}`; this.onChange(); },
    });
    try {
      await this.resident.prepare({ approved: true });
      this.metrics.contribution = { index, joinToReadyMs: performance.now() - started,
        acquisition: this.acquisition.getReceipt(), storage: storageReceipt(), descriptor: this.resident.getState().descriptor };
    } catch (error) {
      await this.resident.close(); this.resident = null;
      await this.acquisition.close(); this.acquisition = null; throw error;
    }
    finally { this.onChange(); }
  }
  async connect(initiator, kind) {
    await this.initialize();
    if (this.links.length >= this.policy.maxLinks) throw new Error('Connection limit reached');
    const entry = { kind, initiator, link: null };
    entry.link = this.api.createPartitionLink({ identity: this.identity, roomId: this.policy.roomId, kind, initiator,
      config: this.config, rtcConfig: globalThis.MUZIL_RTC_CONFIG || { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
      timeoutMs: this.policy.connectTimeoutMs, onChange: () => this.onChange(),
      createEndpoint: options => this.createEndpoint(options),
    });
    this.links.push(entry); await entry.link.connect(); return entry.link;
  }
  createEndpoint(options) {
    const { kind, initiator, remoteParticipantId } = options;
    if (kind === 'stage') {
      if (!this.runtime || !this.resident || this.resident.index !== (initiator ? 0 : 1)) throw new Error('Prepare the assigned stage before connecting A and B');
      return this.api.createPartitionPeer({ ...options, runtime: this.runtime, plan: this.policy.plan, planId: this.policy.planId,
        modelIdentity: this.policy.model.identity, authority: this.authority, contributor: initiator ? null : this.resident,
        limits: this.policy.channel, receiverLimits: this.policy.receiver });
    }
    let service = null;
    if (!initiator) {
      if (!this.resident || this.resident.index !== 0) throw new Error('Prepare stage A before accepting a requester');
      // A ready B link is selected for each entry. Existing conversations keep their
      // owned runner; joining B does not reshuffle their generation state.
      const remote = this.links.find(l => l.kind === 'stage' && l.initiator && l.link.getState().ready)?.link.endpoint;
      if (!remote) throw new Error('Connect stage A directly to a prepared stage B first');
      service = this.api.createPartitionChat({ runtime: this.runtime, local: this.resident, remote, authority: this.authority,
        model: this.policy.model, plan: this.policy.plan, planId: this.policy.planId, limits: this.policy.limits,
        grantTtlMs: this.policy.grantTtlMs, authorizeRequester: async request => request.participantId === remoteParticipantId });
      this.chats.set(remoteParticipantId, service);
    }
    return this.api.createPartitionEntry({ ...options, service, limits: this.policy.channel, inputLimits: this.policy.input,
      authorize: async input => input.meshId === this.policy.roomId && input.modelIdentity === this.policy.model.identity
        && input.planId === this.policy.planId && (initiator ? input.requesterId === this.identity.peerId : input.requesterId === remoteParticipantId) });
  }
  async refresh() {
    const entries = this.links.filter(l => l.kind === 'entry' && l.initiator && l.link.getState().ready);
    const states = await Promise.allSettled(entries.map(l => l.link.endpoint.refresh()));
    this.ready = states.some(s => s.status === 'fulfilled' && s.value.ready && s.value.descriptor.models.some(m => m.availability === 'ready'));
    if (this.ready) this.status = 'Prepared distributed helper';
    this.onChange(); return this.ready;
  }
  async generate(job, signal) {
    await this.initialize();
    const started = performance.now();
    const result = await this.requester.generate({ messages: [{ role: 'user', content: job.kind === 'action' ? actionPrompt(job) : replyPrompt(job) }],
      threadId: job.binding?.roundId || crypto.randomUUID() }, { signal });
    this.metrics.decisions.push({ binding: job.binding, elapsedMs: performance.now() - started,
      completedAt: Date.now(), ...(job.kind === 'action' ? { text: result.content } : {}),
      execution: result.execution, recovery: result.recovery });
    return { text: result.content, binding: job.binding ? structuredClone(job.binding) : null, model: this.policy.model.id,
      provider: 'reploid-doppler-partitions', execution: result.execution, recovery: result.recovery };
  }
  async drain() {
    await Promise.all(this.links.filter(l => l.kind === 'entry' && !l.initiator).map(l => l.link.endpoint?.drain()));
    await this.resident?.drain(); this.resident = null; await this.acquisition?.close(); this.onChange();
  }
  async close() {
    clearInterval(this.poll); await Promise.allSettled(this.links.map(l => l.link.close()));
    await Promise.allSettled([...this.chats.values()].map(chat => chat.close()));
    await this.resident?.close(); await this.acquisition?.close(); this.authority?.close(); this.ready = false;
    this.links = []; this.chats.clear(); this.resident = null; this.acquisition = null;
    this.initializing = null; this.status = 'Disconnected'; this.onChange();
  }
}
