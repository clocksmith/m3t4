// P2P duel pairing + lockstep input wire. Host creates a webrtc session
// (via the same webrtcSignal callable used by the spectator mesh),
// shares the sessionId as a "code". Guest pastes the code, posts an
// answer, both peers exchange ICE candidates through the signaling doc
// until a data channel opens. From there:
//
//   1. Host broadcasts the match seed once both sides are linked.
//   2. Each peer reads its local keyboard each tick and forwards the
//      input bitmask to the other peer over the data channel. The remote
//      side applies the latest received input to the non-local fighter.
//   3. The deterministic stepper sim (createStepperWorld) consumes the
//      same seed + same input stream on both ends, producing identical
//      worlds. No per-tick handshake / no rollback — the inputs stream
//      ahead of consumption with the sim's natural input-delay buffer.
//
// This is intentionally simple. No prediction, no rollback, no NAT
// traversal beyond a public STUN. Two peers behind symmetric NATs may
// fail to connect — that's a known limitation we'll address with a
// TURN relay later.

import { firebase, httpsCallable, signInAnonymously } from "./firebase-client.js";

const ICE_GATHER_TIMEOUT_MS = 5_000;
const PAIR_TIMEOUT_MS = 30_000;

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

// startP2PDuel({ role, sessionId, onStatus, onLink, onSeed, onRemoteInput, onClose })
//   role          - "host" or "join"
//   sessionId     - required when role==="join", the code shared by host
//   onStatus(msg) - human-readable progress messages
//   onLink()      - both peers connected, data channel open
//   onSeed(seed)  - guest-only: receives host's seed
//   onRemoteInput(input) - the latest input received from the remote peer
//   onClose()     - data channel closed
//
// Returns { stop(), sendInput(tick, input), broadcastSeed(seed), sessionId, linked }.
export async function startP2PDuel({
  role,
  sessionId: joinSessionId,
  onStatus = () => {},
  onLink = () => {},
  onSeed = () => {},
  onRemoteInput = () => {},
  onClose = () => {},
}) {
  if (!isP2PSupported()) throw new Error("P2P not supported in this environment");
  const fb = await ensureAnonAuth();

  if (role === "host") {
    return runHost(fb, { onStatus, onLink, onSeed, onRemoteInput, onClose });
  }
  if (role === "join") {
    if (!joinSessionId) throw new Error("session code required to join");
    return runGuest(fb, joinSessionId, { onStatus, onLink, onSeed, onRemoteInput, onClose });
  }
  throw new Error(`unknown p2p role: ${role}`);
}

async function runHost(fb, { onStatus, onLink, onSeed, onRemoteInput, onClose }) {
  onStatus("creating session…");
  const session = await callSignal(fb, "create", {});
  const sessionId = session.sessionId;
  if (!sessionId) throw new Error("no sessionId from webrtcSignal create");

  const pc = new RTCPeerConnection({ iceServers: defaultIceServers() });
  const channel = pc.createDataChannel("duel", { ordered: true });
  channel.binaryType = "arraybuffer";

  const handle = makeHandle(sessionId, channel, () => {
    try { pc.close(); } catch {}
    if (handle._unsub) try { handle._unsub(); } catch {}
  });

  channel.onopen = () => {
    handle.linked = true;
    onStatus("linked");
    onLink();
  };
  channel.onmessage = (ev) => handleRemoteMessage(ev.data, { onSeed, onRemoteInput });
  channel.onclose = () => { handle.linked = false; onClose(); };

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

  onStatus(`code: ${sessionId.slice(0, 8)} (full code in console)`);
  console.info("[p2p-duel] session code:", sessionId);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceGathering(pc);
  await callSignal(fb, "post", {
    sessionId, role: "offerer",
    payload: { offer: pc.localDescription, purpose: "duel" },
  });

  setTimeout(() => {
    if (channel.readyState !== "open") {
      onStatus("pairing timed out");
      handle.stop();
    }
  }, PAIR_TIMEOUT_MS);

  return handle;
}

async function runGuest(fb, sessionId, { onStatus, onLink, onSeed, onRemoteInput, onClose }) {
  onStatus("connecting…");
  const pc = new RTCPeerConnection({ iceServers: defaultIceServers() });

  const handlePromise = new Promise((resolve) => {
    pc.ondatachannel = (ev) => {
      const channel = ev.channel;
      channel.binaryType = "arraybuffer";
      const handle = makeHandle(sessionId, channel, () => {
        try { pc.close(); } catch {}
        if (handle._unsub) try { handle._unsub(); } catch {}
      });
      channel.onopen = () => {
        handle.linked = true;
        onStatus("linked");
        onLink();
      };
      channel.onmessage = (e) => handleRemoteMessage(e.data, { onSeed, onRemoteInput });
      channel.onclose = () => { handle.linked = false; onClose(); };
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

  const { doc, getDoc, onSnapshot } = await import(
    "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
  );
  const sessionRef = doc(fb.firestore, "webrtc", sessionId);
  const initial = await getDoc(sessionRef);
  if (!initial.exists()) throw new Error("session not found");
  const data = initial.data();
  if (!data?.offer) {
    onStatus("no offer yet — wait for host");
  }

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
      payload: { answer: pc.localDescription },
    });
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

  // Race: data channel arrives or pairing times out.
  const handle = await Promise.race([
    handlePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("pairing timed out")), PAIR_TIMEOUT_MS)),
  ]);
  handle._unsub = unsub;
  return handle;
}

function makeHandle(sessionId, channel, teardown) {
  const handle = {
    sessionId,
    linked: false,
    stop() {
      try { channel.close(); } catch {}
      teardown?.();
      handle.linked = false;
    },
    sendInput(tick, input) {
      if (!handle.linked || channel.readyState !== "open") return;
      // 1 byte tick-tag (mod 256) + 1 byte input bitmask. The receiver
      // treats the latest packed input as the remote's current state.
      // Tick is informational; the sim uses input freshness, not echo.
      const buf = new Uint8Array(2);
      buf[0] = tick & 0xff;
      buf[1] = packInput(input);
      try { channel.send(buf); } catch {}
    },
    broadcastSeed(seed) {
      if (!handle.linked || channel.readyState !== "open") return;
      try {
        channel.send(JSON.stringify({ type: "seed", seed: seed >>> 0 }));
      } catch {}
    },
  };
  return handle;
}

function handleRemoteMessage(raw, { onSeed, onRemoteInput }) {
  if (raw instanceof ArrayBuffer) {
    const view = new Uint8Array(raw);
    if (view.length < 2) return;
    onRemoteInput(unpackInput(view[1]));
    return;
  }
  // JSON control messages (seed, etc.) come over the same channel.
  if (typeof raw === "string") {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg && msg.type === "seed" && Number.isFinite(msg.seed)) {
      onSeed(msg.seed >>> 0);
    }
  }
}
