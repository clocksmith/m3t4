// P2P duel pairing + lockstep input wire. Host creates a webrtc session
// (via the same webrtcSignal callable used by the spectator mesh),
// shares the sessionId as a "code". Guest pastes the code, posts an
// answer, both peers exchange ICE candidates through the signaling doc
// until a data channel opens. From there:
//
//   1. Host broadcasts the match parameters (seed + stageId + public
//      cosmetics) once both sides are linked. Later joiners on the same
//      link become read-only spectators and receive those match
//      parameters plus streamed render frames.
//   2. Each peer reads its local keyboard for the current sim tick and
//      forwards {tick,input} to the other peer over the data channel.
//   3. The duel loop only advances a tick after the matching remote
//      input for that same tick has arrived. That keeps both peers on
//      the same deterministic input stream at the cost of pausing under
//      network jitter.
//
// Other known limitations: no prediction, no rollback, no NAT traversal
// beyond a public STUN. Symmetric-NAT peers may fail to connect; a TURN
// relay is the planned fix.

import { firebase, httpsCallable, signInAnonymously } from "./firebase-client.js";

const ICE_GATHER_TIMEOUT_MS = 5_000;
// Bumped from 30s — invitations frequently take longer than that to
// deliver and act on (Slack/SMS round-trip, friend grabbing their
// laptop, etc.). 5 minutes matches the Firestore session TTL so the
// client gives up at the same time as the server-side cleanup.
const PAIR_TIMEOUT_MS = 5 * 60_000;
// Once the guest has POSTed an answer to the session doc, the host's
// data channel should open within seconds; if it doesn't, the host's
// RTCPeerConnection is dead (host tab was closed, or the host already
// hit its own pair timeout earlier) and there's no point waiting the
// full PAIR_TIMEOUT_MS.
const ANSWER_LINK_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 1_000;
const PING_STALE_MS = 5_000;

export function isP2PSupported() {
  if (typeof window === "undefined") return false;
  if (typeof RTCPeerConnection === "undefined") return false;
  const fb = firebase();
  return !!fb;
}

function defaultIceServers() {
  if (typeof window === "undefined") return [{ urls: "stun:stun.l.google.com:19302" }];
  const overrides = window.__M3T4_COMPUTE_ICE_SERVERS__;
  if (Array.isArray(overrides) && overrides.length > 0) return overrides;
  const stun = window.__M3T4_COMPUTE_STUN_URLS__;
  if (Array.isArray(stun) && stun.length > 0) return [{ urls: stun }];
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

async function ensureSignalAuth() {
  const fb = firebase();
  if (!fb) throw new Error("Firebase not configured");
  // Already authenticated (Google / handle / anon). Use that session.
  if (fb.auth.currentUser) return fb;
  // No session yet: silently sign the visitor in anonymously so the
  // signaling callable has a uid. The visitor sees no sign-in flow.
  // Requires Anonymous Auth to be enabled on the Firebase project; if
  // it is disabled the SDK throws auth/operation-not-allowed and we
  // surface a clear hint instead of the raw Firebase code.
  try {
    await signInAnonymously(fb.auth);
  } catch (err) {
    const code = String(err?.code ?? "");
    if (code === "auth/operation-not-allowed" || code === "auth/admin-restricted-operation") {
      throw new Error("P2P unavailable: enable Anonymous Auth in Firebase, or sign in first");
    }
    throw new Error(`P2P sign-in failed: ${err?.message ?? code}`);
  }
  return fb;
}

async function callSignal(fb, op, payload) {
  const fn = httpsCallable(fb.functions, "webrtcSignal");
  try {
    const res = await fn({ op, ...payload });
    return res.data;
  } catch (err) {
    const code = String(err?.code ?? "internal").replace(/^functions\//, "");
    const message = String(err?.message ?? "signaling failed");
    if (code === "internal" && /^internal$/i.test(message)) {
      const e = new Error("signaling service unavailable");
      e.code = code;
      throw e;
    }
    const e = new Error(message);
    e.code = code;
    throw e;
  }
}

function playerSlotTaken(sessionData) {
  return !!sessionData?.answer?.sdp;
}

function packDescription(desc) {
  if (!desc) return null;
  return {
    type: String(desc.type ?? ""),
    sdp: String(desc.sdp ?? ""),
  };
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

function packInput(input) {
  return (
    (input.left ? 1 : 0) |
    (input.right ? 2 : 0) |
    (input.up ? 4 : 0) |
    (input.down ? 8 : 0) |
    (input.action ? 16 : 0)
  );
}

function unpackInput(byte) {
  return {
    left: !!(byte & 1),
    right: !!(byte & 2),
    up: !!(byte & 4),
    down: !!(byte & 8),
    action: !!(byte & 16),
  };
}

// startP2PDuel({ role, sessionId, onStatus, onLink, onMatch, onRemoteInput, onClose })
//   role          - "host" or "join"
//   sessionId     - required when role==="join", the code shared by host
//   onStatus(msg) - human-readable progress messages
//   onLink()      - both peers connected, data channel open
//   onMatch({ seed, stageId, cosmetics, aliases }) - guest-only: receives host's match parameters
//   onAlias(side, alias) - peer changed their alias for the given side
//   onRemoteInput(tick, input) - input received from the remote peer for a sim tick
//   onClose()     - data channel closed
//
// Returns { stop(), sendInput(tick, input), broadcastMatch({seed, stageId, cosmetics, aliases}), sessionId, linked }.
export async function startP2PDuel({
  role,
  sessionId: joinSessionId,
  reuseSessionId,
  onStatus = () => {},
  onLink = () => {},
  onMatch = () => {},
  onFrame = () => {},
  onCosmetic = () => {},
  onAlias = () => {},
  onStage = () => {},
  onLatency = () => {},
  onStreamAge = () => {},
  onRemoteInput = () => {},
  onSpectatorLink = () => {},
  onClose = () => {},
}) {
  if (!isP2PSupported()) throw new Error("P2P not supported in this environment");
  const fb = await ensureSignalAuth();

  if (role === "host") {
    return runHost(fb, { reuseSessionId, onStatus, onLink, onMatch, onCosmetic, onAlias, onStage, onLatency, onRemoteInput, onSpectatorLink, onClose });
  }
  if (role === "join") {
    if (!joinSessionId) throw new Error("session code required to join");
    return runGuest(fb, joinSessionId, { onStatus, onLink, onMatch, onFrame, onCosmetic, onAlias, onStage, onLatency, onStreamAge, onRemoteInput, onClose });
  }
  throw new Error(`unknown p2p role: ${role}`);
}

async function runHost(fb, { reuseSessionId, onStatus, onLink, onMatch, onCosmetic, onAlias, onStage, onLatency, onRemoteInput, onClose }) {
  let sessionId = "";
  if (reuseSessionId) {
    onStatus("resuming session…");
    try {
      const reused = await callSignal(fb, "reuse", { sessionId: reuseSessionId });
      sessionId = String(reused?.sessionId ?? "");
    } catch (err) {
      // Reuse can fail if the doc was already cleaned up (TTL) or the
      // current uid doesn't match createdBy (e.g. signed in differently
      // since the session was created). Fall through to a fresh create
      // — the friend's old link will break, but at least the host can
      // get back online.
      console.warn("[p2p-duel] reuse failed, creating fresh session:", err?.message ?? err);
      sessionId = "";
    }
  }
  if (!sessionId) {
    onStatus("creating session…");
    const session = await callSignal(fb, "create", {});
    sessionId = session.sessionId;
  }
  if (!sessionId) throw new Error("no sessionId from webrtcSignal create");

  const pc = new RTCPeerConnection({ iceServers: defaultIceServers() });
  const channel = pc.createDataChannel("duel", { ordered: true });
  channel.binaryType = "arraybuffer";

  const handle = makeHandle(sessionId, channel, () => {
    try { pc.close(); } catch {}
    if (handle._unsub) try { handle._unsub(); } catch {}
  }, { fb, onLatency });
  handle.role = "host";

  channel.onopen = () => {
    handle.linked = true;
    handle.startLatencyProbe();
    onStatus("linked");
    onLink();
  };
  channel.onmessage = (ev) => handleRemoteMessage(ev.data, { handle, onMatch, onCosmetic, onAlias, onStage, onRemoteInput });
  channel.onclose = () => { handle.linked = false; handle.stopLatencyProbe(); onClose(); };

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    callSignal(fb, "post", {
      sessionId, role: "offerer",
      payload: { candidates: [ev.candidate.toJSON()] },
    }).catch(() => {});
  };

  const { doc, onSnapshot } = await import(
    "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
  );
  const sessionRef = doc(fb.firestore, "webrtc", sessionId);
  handle._unsub = onSnapshot(sessionRef, async (snap) => {
    const data = snap.data();
    if (!data) return;
    if (data.answer && !pc.currentRemoteDescription) {
      try {
        await pc.setRemoteDescription({ type: data.answer.type, sdp: data.answer.sdp });
      } catch (e) { onStatus(`webrtc: ${e?.message ?? e}`); }
    }
    if (Array.isArray(data.candidatesB)) {
      for (const c of data.candidatesB) {
        try { await pc.addIceCandidate(c); } catch {}
      }
    }
  });

  onStatus(`code: ${sessionId}`);
  console.info("[p2p-duel] session code:", sessionId);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceGathering(pc);
  await callSignal(fb, "post", {
    sessionId, role: "offerer",
    payload: { offer: packDescription(pc.localDescription), purpose: "duel" },
  });

  setTimeout(() => {
    if (channel.readyState !== "open") {
      onStatus("pairing timed out");
      handle.stop();
    }
  }, PAIR_TIMEOUT_MS);

  return handle;
}

async function runGuest(fb, sessionId, { onStatus, onLink, onMatch, onFrame, onCosmetic, onAlias, onStage, onLatency, onStreamAge, onRemoteInput, onClose }) {
  onStatus("connecting…");
  const { doc, getDoc, onSnapshot } = await import(
    "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
  );
  const sessionRef = doc(fb.firestore, "webrtc", sessionId);
  let initial;
  try {
    initial = await getDoc(sessionRef);
  } catch (err) {
    const e = new Error(`signaling unreachable: ${err?.message ?? err}`);
    e.code = "signal-down";
    throw e;
  }
  if (!initial.exists()) {
    const e = new Error("host session not found — they may have left");
    e.code = "host-gone";
    throw e;
  }
  const data = initial.data();
  if (playerSlotTaken(data)) {
    return runSpectator(fb, sessionId, { onStatus, onLink, onMatch, onFrame, onStreamAge, onClose });
  }

  const pc = new RTCPeerConnection({ iceServers: defaultIceServers() });

  const handlePromise = new Promise((resolve) => {
    pc.ondatachannel = (ev) => {
      const channel = ev.channel;
      channel.binaryType = "arraybuffer";
      const handle = makeHandle(sessionId, channel, () => {
        try { pc.close(); } catch {}
        if (handle._unsub) try { handle._unsub(); } catch {}
      }, { onLatency });
      channel.onopen = () => {
        handle.linked = true;
        handle.startLatencyProbe();
        onStatus("linked");
        onLink();
      };
      channel.onmessage = (e) => handleRemoteMessage(e.data, { handle, onMatch, onFrame, onCosmetic, onAlias, onStage, onRemoteInput });
      channel.onclose = () => { handle.linked = false; handle.stopLatencyProbe(); onClose(); };
      resolve(handle);
    };
  });

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    callSignal(fb, "post", {
      sessionId, role: "answerer",
      payload: { candidates: [ev.candidate.toJSON()] },
    }).catch(() => {});
  };

  if (!data?.offer) {
    onStatus("no offer yet — wait for host");
  }

  // Tracks when we POSTed our answer; the dead-host detector below uses
  // it to bail early instead of waiting the full PAIR_TIMEOUT_MS.
  let answerPostedAt = 0;

  const setOfferAndAnswer = async (sessionData) => {
    if (!sessionData?.offer || pc.currentRemoteDescription) return;
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
    await callSignal(fb, "post", {
      sessionId, role: "answerer",
      payload: { answer: packDescription(pc.localDescription) },
    });
    if (!answerPostedAt) answerPostedAt = Date.now();
  };

  // If offer was already there, accept it now.
  if (data?.offer) await setOfferAndAnswer(data);

  // Watch for late-arriving offer + offerer ICE candidates.
  const unsub = onSnapshot(sessionRef, async (snap) => {
    const sessionData = snap.data();
    if (!sessionData) return;
    await setOfferAndAnswer(sessionData);
    if (Array.isArray(sessionData.candidatesA) && pc.currentRemoteDescription) {
      for (const c of sessionData.candidatesA) {
        try { await pc.addIceCandidate(c); } catch {}
      }
    }
  });

  // Race: data channel arrives, dead-host is detected, or overall pair
  // timeout fires. The host-gone path lets the UI prompt the user to
  // take over and host themselves instead of waiting fruitlessly.
  let pairTimer = 0;
  let liveCheckTimer = 0;
  const cleanupTimers = () => {
    if (pairTimer) clearTimeout(pairTimer);
    if (liveCheckTimer) clearInterval(liveCheckTimer);
    pairTimer = 0;
    liveCheckTimer = 0;
  };
  try {
    const handle = await Promise.race([
      handlePromise,
      new Promise((_, reject) => {
        pairTimer = setTimeout(() => {
          cleanupTimers();
          const e = new Error("pairing timed out");
          e.code = "pair-timeout";
          reject(e);
        }, PAIR_TIMEOUT_MS);
        liveCheckTimer = setInterval(() => {
          if (answerPostedAt && Date.now() - answerPostedAt > ANSWER_LINK_TIMEOUT_MS) {
            cleanupTimers();
            const e = new Error("host has left — answer posted with no response");
            e.code = "host-gone";
            reject(e);
          }
        }, 1_000);
      }),
    ]);
    cleanupTimers();
    handle._unsub = unsub;
    return handle;
  } catch (err) {
    cleanupTimers();
    try { unsub?.(); } catch {}
    try { pc.close(); } catch {}
    throw err;
  }
}

async function runSpectator(fb, sessionId, { onStatus, onLink, onMatch, onFrame, onStreamAge, onClose }) {
  onStatus("joining as spectator…");
  const { doc, getDoc, onSnapshot } = await import(
    "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
  );
  const sessionRef = doc(fb.firestore, "webrtc", sessionId);
  const initial = await getDoc(sessionRef);
  if (!initial.exists()) {
    const e = new Error("host session not found — they may have left");
    e.code = "host-gone";
    throw e;
  }
  // If the host had been streaming frames but stopped a while ago, the
  // stream is dead. Don't silently drop the visitor into a "spectating"
  // state that just shows a frozen frame forever — surface host-gone so
  // the UI can offer a take-over button.
  const initialData = initial.data() ?? {};
  const initialFrameAt = Number(initialData.spectatorFrameAt ?? 0);
  if (initialFrameAt > 0 && Date.now() - initialFrameAt > 30_000) {
    const e = new Error("host stream went stale — they may have left");
    e.code = "host-gone";
    throw e;
  }

  let lastFrameAt = 0;
  let lastInitKey = "";
  const applySpectatorState = (data = {}) => {
    const init = data.spectatorInit;
    if (init) {
      const initKey = JSON.stringify(init);
      if (initKey !== lastInitKey) {
        lastInitKey = initKey;
        onMatch({
          seed: init.seed,
          stageId: init.stageId,
          cosmetics: init.cosmetics,
          aliases: Array.isArray(init.aliases) ? init.aliases : undefined,
        });
      }
    }
    const frameAt = Number(data.spectatorFrameAt ?? 0);
    if (data.spectatorFrame && frameAt >= lastFrameAt) {
      lastFrameAt = frameAt;
      if (frameAt > 0) onStreamAge?.(Math.max(0, Date.now() - frameAt));
      onFrame(data.spectatorFrame);
    }
  };

  const handle = makeSpectatorHandle(sessionId, () => {
    if (handle._unsub) try { handle._unsub(); } catch {}
    onClose();
  });
  handle.linked = true;
  onStatus("spectating");
  onLink({ spectator: true });
  applySpectatorState(initial.data());
  handle._unsub = onSnapshot(sessionRef, (snap) => applySpectatorState(snap.data()));
  return handle;
}

function makeSpectatorHandle(sessionId, teardown) {
  return {
    sessionId,
    linked: true,
    role: "spectator",
    spectator: true,
    stop() {
      teardown?.();
      this.linked = false;
    },
    sendInput() {},
    broadcastMatch() {},
    broadcastCosmetic() {},
    broadcastAlias() {},
    broadcastStage() {},
    postSpectatorFrame() {},
  };
}

function makeHandle(sessionId, channel, teardown, options = {}) {
  const fb = options.fb ?? null;
  const onLatency = options.onLatency ?? (() => {});
  const pendingPings = new Map();
  let pingTimer = 0;
  const handle = {
    sessionId,
    linked: false,
    role: "peer",
    spectator: false,
    latencyMs: null,
    lastLatencyAt: 0,
    _channel: channel,
    _pendingPings: pendingPings,
    stop() {
      try { channel?.close?.(); } catch {}
      handle.stopLatencyProbe();
      teardown?.();
      handle.linked = false;
    },
    startLatencyProbe() {
      sendPing();
      if (pingTimer) return;
      pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
    },
    stopLatencyProbe() {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = 0;
      pendingPings.clear();
    },
    recordLatency(ms) {
      if (!Number.isFinite(ms) || ms < 0) return;
      handle.latencyMs = handle.latencyMs === null
        ? ms
        : (handle.latencyMs * 0.72) + (ms * 0.28);
      handle.lastLatencyAt = Date.now();
      onLatency(Math.round(handle.latencyMs));
    },
    sendInput(tick, input) {
      if (!handle.linked || channel?.readyState !== "open") return;
      // 4-byte tick tag + 1-byte input bitmask. The duel loop consumes
      // only the input whose tick matches the world tick it is about to
      // simulate.
      const buf = new Uint8Array(5);
      const view = new DataView(buf.buffer);
      view.setUint32(0, tick >>> 0);
      buf[4] = packInput(input);
      try { channel.send(buf); } catch {}
    },
    broadcastMatch({ seed, stageId, cosmetics, aliases }) {
      const aliasPair = Array.isArray(aliases)
        ? [String(aliases[0] ?? ""), String(aliases[1] ?? "")]
        : undefined;
      const msg = {
        type: "match",
        seed: seed >>> 0,
        stageId: String(stageId ?? ""),
        cosmetics: Array.isArray(cosmetics) ? cosmetics : undefined,
        aliases: aliasPair,
      };
      if (handle.linked && channel?.readyState === "open") sendJson(channel, msg);
      // Mirror to Firestore so spectators that join after pairing get
      // the match parameters even though they aren't on the data
      // channel. Best-effort.
      if (fb) {
        callSignal(fb, "postFrame", {
          sessionId,
          init: {
            seed: seed >>> 0,
            stageId: String(stageId ?? ""),
            cosmetics: Array.isArray(cosmetics) ? cosmetics : undefined,
            aliases: aliasPair,
          },
        }).catch(() => {});
      }
    },
    postSpectatorFrame(frame) {
      if (!fb || !frame) return;
      callSignal(fb, "postFrame", { sessionId, frame }).catch(() => {});
    },
    broadcastCosmetic(side, cosmetic) {
      const slot = side === 1 ? 1 : 0;
      const msg = {
        type: "cosmetic",
        side: slot,
        body: typeof cosmetic?.body === "string" ? cosmetic.body : "",
        weapon: typeof cosmetic?.weapon === "string" ? cosmetic.weapon : "",
      };
      if (handle.linked && channel?.readyState === "open") sendJson(channel, msg);
    },
    broadcastAlias(side, alias) {
      const slot = side === 1 ? 1 : 0;
      const msg = {
        type: "alias",
        side: slot,
        alias: String(alias ?? ""),
      };
      if (handle.linked && channel?.readyState === "open") sendJson(channel, msg);
    },
    broadcastStage(stageId) {
      const msg = { type: "stage", stageId: String(stageId ?? "") };
      if (handle.linked && channel?.readyState === "open") sendJson(channel, msg);
    },
  };

  function sendPing() {
    if (!handle.linked || channel?.readyState !== "open") return;
    const now = nowMs();
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    pendingPings.set(id, now);
    const cutoff = now - PING_STALE_MS;
    for (const [key, sentAt] of pendingPings) {
      if (sentAt < cutoff) pendingPings.delete(key);
    }
    sendJson(channel, { type: "ping", id });
  }

  return handle;
}

function sendJson(channel, value) {
  try { channel.send(JSON.stringify(value)); } catch {}
}

function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function handleRemoteMessage(raw, { handle, onMatch, onFrame, onCosmetic, onAlias, onStage, onRemoteInput }) {
  if (raw instanceof ArrayBuffer) {
    const view = new Uint8Array(raw);
    if (view.length < 5) return;
    const tick = new DataView(raw).getUint32(0);
    onRemoteInput(tick, unpackInput(view[4]));
    return;
  }
  // JSON control messages (match start, cosmetics, stage, etc.) come
  // over the same channel.
  if (typeof raw === "string") {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "match" && Number.isFinite(msg.seed)) {
      onMatch?.({
        seed: msg.seed >>> 0,
        stageId: msg.stageId,
        cosmetics: msg.cosmetics,
        aliases: Array.isArray(msg.aliases) ? msg.aliases : undefined,
      });
    }
    if (msg.type === "frame" && msg.frame) {
      onFrame?.(msg.frame);
    }
    if (msg.type === "cosmetic" && (msg.side === 0 || msg.side === 1)) {
      onCosmetic?.(msg.side, { body: msg.body, weapon: msg.weapon });
    }
    if (msg.type === "alias" && (msg.side === 0 || msg.side === 1)) {
      onAlias?.(msg.side, typeof msg.alias === "string" ? msg.alias : "");
    }
    if (msg.type === "stage" && typeof msg.stageId === "string") {
      onStage?.(msg.stageId);
    }
    if (msg.type === "ping" && typeof msg.id === "string") {
      sendJson(handle?._channel, { type: "pong", id: msg.id });
    }
    if (msg.type === "pong" && typeof msg.id === "string" && handle?._pendingPings) {
      const sentAt = handle._pendingPings.get(msg.id);
      if (Number.isFinite(sentAt)) {
        handle._pendingPings.delete(msg.id);
        handle.recordLatency?.(nowMs() - sentAt);
      }
    }
  }
}
