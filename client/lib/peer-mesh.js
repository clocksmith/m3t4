// Spectator peer-mesh: tree-fanout for action streams over WebRTC. The
// first spectator of a matchId becomes the "primary" — they fetch the
// match doc from Firestore and are the source. Subsequent spectators
// pick an existing peer (round-robin via meshSessions/<matchId>/peers),
// open a WebRTC data channel to it, and receive the action log + frames
// directly. Each connected spectator advertises themselves as available
// for further fanout, capping at MAX_FANOUT children to keep tree depth
// shallow.
//
// Falls back to direct Firestore subscription (the non-mesh path in
// match-feed.js) if no peer answers within JOIN_TIMEOUT_MS.
//
// Signaling: webrtcSignal callable Function relays offer/answer/ICE
// candidates via webrtc/<sessionId> Firestore docs. Once the data
// channel opens, signaling is done and Firestore is out of the data
// path.

import { firebase, httpsCallable, signInAnonymously } from "./firebase-client.js";
import { ensureIceServers, iceServers as currentIceServers } from "./ice-config.js";

const MAX_FANOUT = 4;        // children per node — tree fans out fast
// Hard cap on tree depth. Each level adds ~hop latency, and unlimited
// depth lets pathological cases (sparse arrival, churn) build long
// chains. With MAX_FANOUT=4 this allows 1+4+16+64+256 = 341 spectators
// at depth 4 — plenty of headroom for current scale, and bounded
// latency at ~4 × hop.
const MAX_DEPTH = 4;
const JOIN_TIMEOUT_MS = 4_000;
const PEER_HEARTBEAT_MS = 30_000;
const ICE_GATHER_TIMEOUT_MS = 5_000;

function makePeerId() {
  return "peer-" + crypto.randomUUID().slice(0, 12);
}

async function ensureAnonAuth() {
  const fb = firebase();
  if (!fb) throw new Error("Firebase not configured");
  if (!fb.auth.currentUser) await signInAnonymously(fb.auth);
  return fb;
}

async function callSignal(fb, op, payload) {
  const fn = httpsCallable(fb.functions, "webrtcSignal");
  const res = await fn({ op, ...payload });
  return res.data;
}

function defaultIceServers() {
  return currentIceServers();
}

// Public entry point.
//
// joinMesh({ matchId, onPayload, onMatchDoc })
//   matchId      — the match the spectator is watching
//   onPayload    — invoked with { type, ...data } messages received over
//                  the data channel from the upstream peer (action log,
//                  match doc, etc.)
//   onMatchDoc   — invoked with the match doc once available (whether
//                  fetched directly or relayed from upstream)
//
// Returns a stop() function that tears down all WebRTC connections and
// drops the local presence entry from Firestore.
export async function joinMesh({ matchId, onPayload, onMatchDoc, onError }) {
  if (!matchId) throw new Error("matchId required");
  const fb = await ensureAnonAuth();
  const peerId = fb.auth.currentUser?.uid ?? makePeerId();

  const ctx = {
    matchId,
    fb,
    peerId,
    onPayload: typeof onPayload === "function" ? onPayload : () => {},
    onMatchDoc: typeof onMatchDoc === "function" ? onMatchDoc : () => {},
    onError: typeof onError === "function" ? onError : (e) => console.warn("[peer-mesh]", e),
    upstreamConn: null,
    childConns: new Map(), // childPeerId → { pc, channel }
    presenceUnsub: null,
    heartbeatTimer: null,
    matchDoc: null,
    role: "joining",
    depth: 0,
    // Set of peerIds we know are downstream of us (children + their
    // children). Filtered out when picking an upstream candidate so we
    // don't form cycles after a rebalance — a node whose upstream dies
    // will look for a NEW upstream, and must not pick its own descendant.
    descendants: new Set(),
    stopped: false,
  };
  // Best-effort TURN/STUN config fetch before any RTCPeerConnection is
  // created. STUN-only fallback applies if signaling is unreachable.
  await ensureIceServers().catch(() => {});

  try {
    await joinAsConsumer(ctx);
  } catch (e) {
    ctx.onError(e);
    if (!ctx.stopped) {
      // Fall back to becoming a primary directly from Firestore.
      try { await joinAsPrimary(ctx); } catch (err) { ctx.onError(err); }
    }
  }

  return async () => {
    ctx.stopped = true;
    if (ctx.heartbeatTimer) clearInterval(ctx.heartbeatTimer);
    if (ctx.presenceUnsub) ctx.presenceUnsub();
    if (ctx.upstreamConn) {
      try { ctx.upstreamConn.pc.close(); } catch {}
    }
    for (const { pc } of ctx.childConns.values()) {
      try { pc.close(); } catch {}
    }
    ctx.childConns.clear();
    await dropPresence(ctx).catch(() => {});
  };
}

async function listAvailablePeers(ctx) {
  const { collection, getDocs, query, where, orderBy, limit } = await import(
    "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
  );
  const peersRef = collection(ctx.fb.firestore, "meshSessions", ctx.matchId, "peers");
  const q = query(
    peersRef,
    where("childCount", "<", MAX_FANOUT),
    orderBy("childCount", "asc"),
    limit(8),
  );
  const snap = await getDocs(q);
  const stale = Date.now() - PEER_HEARTBEAT_MS * 3;
  return snap.docs
    .map((d) => d.data())
    .filter((p) => {
      if (!p.peerId || p.peerId === ctx.peerId) return false;
      // Reject stale advertisements (no heartbeat for ~90s = peer's tab
      // closed without dropping presence).
      if (Number(p.lastSeenAt ?? 0) < stale) return false;
      const peerDepth = Number(p.depth ?? 0);
      // Don't pick a peer whose depth is already at the cap (joining
      // them would push us over MAX_DEPTH).
      if (peerDepth >= MAX_DEPTH - 1) return false;
      // Cycle avoidance after a rebalance. Two complementary checks:
      //  (a) explicit descendants set — children we know we serve. Used
      //      as the strong guarantee for the immediate hop.
      //  (b) depth-monotonic guard — only allow upstreams strictly
      //      *above* our previous depth. Without this, a node that just
      //      lost its upstream could pick a sibling that itself is also
      //      orphaned, and the pair would never make progress. The
      //      first joiner has ctx.depth=0 so the guard reduces to
      //      "anything is fine," which is correct for a fresh consumer.
      if (ctx.descendants.has(p.peerId)) return false;
      if (ctx.depth > 0 && peerDepth >= ctx.depth) return false;
      return true;
    });
}

async function joinAsConsumer(ctx) {
  const peers = await listAvailablePeers(ctx);
  if (!peers.length) {
    await joinAsPrimary(ctx);
    return;
  }
  // Pick the peer with lowest childCount (already ordered).
  const upstream = peers[0];

  // Create signaling session.
  const session = await callSignal(ctx.fb, "create", {});
  const sessionId = session.sessionId;
  if (!sessionId) throw new Error("no sessionId from webrtcSignal create");

  const pc = new RTCPeerConnection({ iceServers: defaultIceServers() });
  const channel = pc.createDataChannel("mesh", { ordered: true });
  channel.binaryType = "arraybuffer";

  channel.onopen = async () => {
    ctx.role = "secondary";
    await advertisePresence(ctx);
    startHeartbeat(ctx);
    listenForChildren(ctx);
  };
  channel.onmessage = (ev) => handleIncomingPayload(ctx, ev.data);
  channel.onclose = () => {
    if (ctx.stopped) return;
    ctx.onError(new Error("upstream channel closed"));
    // Rebalance: try a different peer; if that fails, fall back to
    // becoming primary so children downstream of us don't go silent.
    setTimeout(async () => {
      if (ctx.stopped) return;
      closeUpstream(ctx);
      try {
        await joinAsConsumer(ctx);
      } catch (err) {
        if (ctx.stopped) return;
        try { await joinAsPrimary(ctx); } catch (e) { ctx.onError(e); }
      }
    }, 1000);
  };

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    callSignal(ctx.fb, "post", {
      sessionId,
      role: "offerer",
      payload: { candidates: [ev.candidate.toJSON()] },
    }).catch(() => {});
  };

  // Subscribe for the answerer's reply.
  const { doc, onSnapshot } = await import(
    "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
  );
  const sessionRef = doc(ctx.fb.firestore, "webrtc", sessionId);
  const unsub = onSnapshot(sessionRef, async (snap) => {
    const data = snap.data();
    if (!data) return;
    if (data.answer && !pc.currentRemoteDescription) {
      try {
        await pc.setRemoteDescription({
          type: data.answer.type,
          sdp: data.answer.sdp,
        });
      } catch (e) { ctx.onError(e); }
    }
    if (Array.isArray(data.candidatesB)) {
      for (const c of data.candidatesB) {
        try { await pc.addIceCandidate(c); } catch {}
      }
    }
  });
  ctx.upstreamConn = { pc, channel, sessionRef, unsub, sessionId };

  // Track expected depth based on chosen upstream so subsequent peer
  // pickers (and the depth cap) reflect our position correctly even
  // before the welcome message arrives.
  ctx.depth = Math.max(0, Number(upstream.depth ?? 0)) + 1;

  // Create offer + post.
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceGathering(pc);
  await callSignal(ctx.fb, "post", {
    sessionId,
    role: "offerer",
    payload: { offer: pc.localDescription, peerId: ctx.peerId, target: upstream.peerId },
  });

  // Time-bound the join. If channel doesn't open in time, fall back.
  setTimeout(() => {
    if (channel.readyState !== "open" && !ctx.stopped && !ctx.upstreamConn?.fellBack) {
      ctx.upstreamConn.fellBack = true;
      try { pc.close(); } catch {}
      closeUpstream(ctx);
      joinAsPrimary(ctx).catch(ctx.onError);
    }
  }, JOIN_TIMEOUT_MS);
}

function closeUpstream(ctx) {
  const conn = ctx.upstreamConn;
  if (!conn) return;
  if (conn.unsub) {
    try { conn.unsub(); } catch {}
  }
  if (conn.pc) {
    try { conn.pc.close(); } catch {}
  }
  ctx.upstreamConn = null;
}

async function joinAsPrimary(ctx) {
  ctx.role = "primary";
  ctx.depth = 0;
  // Primary fetches the match doc directly from Firestore.
  const { doc, onSnapshot } = await import(
    "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
  );
  const matchRef = doc(ctx.fb.firestore, "matches", ctx.matchId);
  ctx.upstreamConn = {
    isFirestore: true,
    unsub: onSnapshot(matchRef, (snap) => {
      const data = snap.data();
      if (!data) return;
      ctx.matchDoc = data;
      ctx.onMatchDoc(data);
      // Fan out to children too.
      broadcastToChildren(ctx, { type: "matchDoc", matchDoc: data });
    }),
  };
  await advertisePresence(ctx);
  startHeartbeat(ctx);
  listenForChildren(ctx);
}

async function advertisePresence(ctx) {
  const { doc, setDoc } = await import(
    "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
  );
  const ref = doc(ctx.fb.firestore, "meshSessions", ctx.matchId, "peers", ctx.peerId);
  await setDoc(ref, {
    peerId: ctx.peerId,
    matchId: ctx.matchId,
    role: ctx.role,
    depth: ctx.depth ?? 0,
    childCount: ctx.childConns.size,
    lastSeenAt: Date.now(),
    createdAt: Date.now(),
  }, { merge: true });
}

async function dropPresence(ctx) {
  const { doc, deleteDoc } = await import(
    "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
  );
  const ref = doc(ctx.fb.firestore, "meshSessions", ctx.matchId, "peers", ctx.peerId);
  await deleteDoc(ref);
}

function startHeartbeat(ctx) {
  if (ctx.heartbeatTimer) clearInterval(ctx.heartbeatTimer);
  ctx.heartbeatTimer = setInterval(async () => {
    if (ctx.stopped) return;
    try { await advertisePresence(ctx); } catch (e) { ctx.onError(e); }
  }, PEER_HEARTBEAT_MS);
}

async function listenForChildren(ctx) {
  // Subscribe to webrtc sessions targeting our peerId. We respond to each
  // by fielding the offer and creating an answer + child data channel.
  const { collection, query, where, onSnapshot } = await import(
    "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
  );
  const sessionsRef = collection(ctx.fb.firestore, "webrtc");
  const q = query(sessionsRef, where("offer.target", "==", ctx.peerId));
  const unsub = onSnapshot(q, (snap) => {
    snap.docChanges().forEach(async (change) => {
      if (change.type !== "added" && change.type !== "modified") return;
      const data = change.doc.data();
      const sessionId = change.doc.id;
      if (!data.offer || ctx.childConns.has(data.offer.peerId ?? sessionId)) return;
      if (ctx.childConns.size >= MAX_FANOUT) return;
      await acceptChild(ctx, sessionId, data);
    });
  });
  ctx.presenceUnsub = unsub;
}

async function acceptChild(ctx, sessionId, sessionData) {
  const childPeerId = sessionData.offer?.peerId ?? sessionId;
  const pc = new RTCPeerConnection({ iceServers: defaultIceServers() });
  ctx.childConns.set(childPeerId, { pc, channel: null });
  // Mark this peer as a descendant for cycle avoidance on rebalance.
  ctx.descendants.add(childPeerId);

  pc.ondatachannel = (ev) => {
    const channel = ev.channel;
    channel.binaryType = "arraybuffer";
    const conn = ctx.childConns.get(childPeerId);
    if (conn) conn.channel = channel;
    channel.onopen = async () => {
      // Bring the child up to date and tell them their depth so they
      // can include it in their own presence advertisement.
      try {
        channel.send(JSON.stringify({ type: "welcome", depth: (ctx.depth ?? 0) + 1 }));
      } catch {}
      if (ctx.matchDoc) channel.send(JSON.stringify({ type: "matchDoc", matchDoc: ctx.matchDoc }));
      await advertisePresence(ctx);
    };
    channel.onclose = () => {
      ctx.childConns.delete(childPeerId);
      ctx.descendants.delete(childPeerId);
      advertisePresence(ctx).catch(() => {});
    };
  };

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    callSignal(ctx.fb, "post", {
      sessionId,
      role: "answerer",
      payload: { candidates: [ev.candidate.toJSON()] },
    }).catch(() => {});
  };

  await pc.setRemoteDescription({
    type: sessionData.offer.type,
    sdp: sessionData.offer.sdp,
  });
  if (Array.isArray(sessionData.candidatesA)) {
    for (const c of sessionData.candidatesA) {
      try { await pc.addIceCandidate(c); } catch {}
    }
  }
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitIceGathering(pc);
  await callSignal(ctx.fb, "post", {
    sessionId,
    role: "answerer",
    payload: { answer: pc.localDescription },
  });
}

function broadcastToChildren(ctx, payload) {
  const wire = JSON.stringify(payload);
  for (const { channel } of ctx.childConns.values()) {
    if (channel && channel.readyState === "open") {
      try { channel.send(wire); } catch {}
    }
  }
}

function handleIncomingPayload(ctx, raw) {
  let msg;
  try {
    msg = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return;
  }
  if (msg.type === "welcome" && Number.isFinite(msg.depth)) {
    // Authoritative depth from upstream. Update presence so subsequent
    // peer-pickers see the right value (initial advertise used an
    // estimate based on the upstream presence row).
    const next = Number(msg.depth) || 0;
    if (next !== ctx.depth) {
      ctx.depth = next;
      advertisePresence(ctx).catch(() => {});
    }
    return; // welcome is bookkeeping only — don't fan out to children
  }
  if (msg.type === "matchDoc" && msg.matchDoc) {
    ctx.matchDoc = msg.matchDoc;
    ctx.onMatchDoc(msg.matchDoc);
    broadcastToChildren(ctx, msg);
    return;
  }
  ctx.onPayload(msg);
  broadcastToChildren(ctx, msg);
}

function waitIceGathering(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", function onChange() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timeout);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    });
  });
}
