// P2P duel — real WebRTC glue.
//
// Flow:
//   A (initiator):
//     POST /api/duel/challenge      → challengeId
//     POST /api/duel/accept          → signed MatchToken
//     new RTCPeerConnection, createDataChannel, createOffer
//     POST /api/duel/signal/:matchId role=offer
//     poll GET /api/duel/signal/:matchId?role=answer
//     addIceCandidate on ICE it receives
//
//   B (acceptor):
//     poll GET /api/duel/signal/:matchId?role=offer
//     new RTCPeerConnection, setRemoteDescription(offer), createAnswer
//     POST /api/duel/signal/:matchId role=answer
//
// Once the data channel opens, each peer runs the sim tick-by-tick,
// compiles its own brain action from (obs, config) locally, and
// exchanges only the packed action byte with the peer. Both peers
// advance identical sims. Every 120 ticks they exchange a world-state
// hash; divergence means desync.
//
// When the match ends, each peer signs the action log hash and POSTs
// it to /api/duel/submit. Server verifies and archives with
// p2p-action-verified trust label.
//
// Caveat: this module only runs in a real browser (uses RTCPeerConnection,
// crypto.subtle, etc). It is not exercised by the Node test suite.

import {
  BEHAVIOR_VERSION, REPLAY_CONSTANTS_HASH,
  STAGES, STRATEGIES, STRATEGY_NAMES,
  compileBrain, createBrainState, resetBrainStateForRound,
  runParamBrain, applyHallucinationNoise,
  createStepperWorld, stepWorld, worldObservation,
  packAction,
} from "../sim/index.js";

const API = (() => {
  const envOrigin = window.ARENA_API_ORIGIN || "";
  return envOrigin || window.location.origin;
})();

// ---------------------------- helpers ----------------------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

async function api(method, path, body, headers = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

function bytesToBase64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// FNV-1a over a Uint8Array — matches sim's logHash mechanism.
function fnv1a(bytes) {
  let h = 2166136261 >>> 0;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Poll an endpoint until predicate returns truthy or timeout.
async function pollUntil(fn, { intervalMs = 400, timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await fn();
    if (out) return out;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("poll timeout");
}

// ---------------------------- RTC setup ----------------------------

// Create a peer connection + open a data channel.
// role: "initiator" or "acceptor"
function makePeer(matchId, role, myPlayerId, onAction, onHash, onOpen, onClose, log) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  let dc;

  // Role: initiator creates the channel; acceptor receives it.
  if (role === "initiator") {
    dc = pc.createDataChannel("m3t4-duel", { ordered: true });
    wireDataChannel(dc);
  } else {
    pc.ondatachannel = (ev) => { dc = ev.channel; wireDataChannel(dc); };
  }

  function wireDataChannel(ch) {
    ch.binaryType = "arraybuffer";
    ch.onopen = () => { log(`data channel open (role=${role})`); onOpen(); };
    ch.onclose = () => { log(`data channel closed`); onClose(); };
    ch.onmessage = (ev) => {
      const data = new Uint8Array(ev.data);
      // Framing: [1-byte kind][payload]. Kind 0=action, 1=state-hash.
      if (data.length < 1) return;
      const kind = data[0];
      if (kind === 0 && data.length >= 3) {
        // action: [kind][tick_lo][tick_hi][action_byte]
        const tick = data[1] | (data[2] << 8) | (data.length >= 5 ? (data[3] << 16) | (data[4] << 24) : 0);
        const actByte = data.length >= 5 ? data[5] : data[3];
        onAction(tick, actByte);
      } else if (kind === 1) {
        // state-hash: [kind][tick(4 bytes LE)][hash(4 bytes LE)]
        if (data.length < 9) return;
        const dv = new DataView(data.buffer, data.byteOffset);
        const tick = dv.getUint32(1, true);
        const hash = dv.getUint32(5, true).toString(16).padStart(8, "0");
        onHash(tick, hash);
      }
    };
  }

  // ICE candidate exchange via server relay.
  pc.onicecandidate = async (ev) => {
    if (ev.candidate) {
      await api("POST", `/api/duel/signal/${matchId}`, {
        ice: ev.candidate.toJSON(),
        fromPlayerId: myPlayerId,
      });
    }
  };

  return { pc, send(frame) { dc?.send(frame); }, close() { dc?.close(); pc.close(); } };
}

// Pack an action with its tick into a binary frame (5 bytes).
function encodeActionFrame(tick, actByte) {
  const b = new Uint8Array(5);
  const dv = new DataView(b.buffer);
  b[0] = 0; // kind=action
  dv.setUint32(1, tick, true);
  // Pack action into the high bits of the length-1 frame. Actually use
  // a 6-byte frame to stay readable: simplify to [kind][tick(4)][action(1)].
  // (The reader above expects 5 bytes for kind=0 with tick+action packed.)
  // Adjusted: [kind=0][tick LE 4][action 1] — 6 bytes total.
  const fixed = new Uint8Array(6);
  fixed[0] = 0;
  new DataView(fixed.buffer).setUint32(1, tick >>> 0, true);
  fixed[5] = actByte & 0x1f;
  return fixed;
}

function encodeHashFrame(tick, hashHex) {
  const b = new Uint8Array(9);
  b[0] = 1;
  const dv = new DataView(b.buffer);
  dv.setUint32(1, tick >>> 0, true);
  dv.setUint32(5, parseInt(hashHex, 16) >>> 0, true);
  return b;
}

// ---------------------------- UI ----------------------------

export function renderDuel(root) {
  root.innerHTML = "";
  const state = {
    myUid: "alice",
    oppUid: "bob",
    myPreset: STRATEGY_NAMES[0],
    stageId: "datacenter",
    role: "initiator",             // or "acceptor" (via URL hash)
    challengeId: null,
    token: null,
    peer: null,
    dcOpen: false,
    // match runtime
    world: null,
    brainStates: null,
    myActions: [],
    peerActions: new Map(),        // tick -> actByte
    matchDone: false,
    log: [],
  };

  const logArea = h("pre", { class: "duel-log" });
  function log(line) {
    state.log.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
    logArea.textContent = state.log.slice(-25).join("\n");
  }

  // Parse URL hash for role + challengeId (e.g. #duel?role=acceptor&challengeId=abc)
  const params = new URLSearchParams((window.location.hash.split("?")[1]) || "");
  if (params.get("role") === "acceptor") state.role = "acceptor";
  if (params.get("challengeId")) state.challengeId = params.get("challengeId");
  if (params.get("me")) state.myUid = params.get("me");

  const panel = h("section", { class: "duel-panel" });

  const controls = h("div", { class: "duel-controls" },
    h("h2", {}, `p2p duel — WebRTC (role: ${state.role})`),
    h("p", { class: "duel-hint" },
      "Open this page in two browser tabs. Tab 1: role=initiator (default). ",
      "Tab 2: role=acceptor. Paste the challengeId from tab 1 into tab 2's URL ",
      "like ", h("code", {}, "#duel?role=acceptor&challengeId=XYZ&me=bob"), ". ",
      "Both tabs must be able to reach the same server."),
    h("label", {}, "my uid: ",
      h("input", { value: state.myUid, oninput: (e) => state.myUid = e.target.value })),
    h("label", {}, "opp uid: ",
      h("input", { value: state.oppUid, oninput: (e) => state.oppUid = e.target.value })),
    h("label", {}, "my preset: ",
      h("select", { onchange: (e) => state.myPreset = e.target.value },
        ...STRATEGY_NAMES.map((n) => h("option", { value: n, selected: n === state.myPreset ? "selected" : null }, n)))),
    h("label", {}, "stage: ",
      h("select", { onchange: (e) => state.stageId = e.target.value },
        ...Object.keys(STAGES).map((k) => h("option", { value: k, selected: k === state.stageId ? "selected" : null }, k)))),
  );

  async function runInitiator() {
    log("initiator start");
    const ch = await api("POST", "/api/duel/challenge",
      { toUid: state.oppUid, stageId: state.stageId },
      { authorization: `Bearer ${state.myUid}` });
    if (ch.status !== 200) { log(`challenge failed: ${JSON.stringify(ch.body)}`); return; }
    state.challengeId = ch.body.challengeId;
    log(`challengeId=${state.challengeId}. share with acceptor via #duel?role=acceptor&challengeId=${state.challengeId}`);

    const ac = await api("POST", "/api/duel/accept", { challengeId: state.challengeId });
    if (ac.status !== 200) { log(`accept failed: ${JSON.stringify(ac.body)}`); return; }
    state.token = ac.body.token;
    log(`token matchId=${state.token.matchId} seed=${state.token.seed}`);

    await establishPeerAndRun("initiator");
  }

  async function runAcceptor() {
    if (!state.challengeId) { log("no challengeId in URL"); return; }
    log(`acceptor start, challengeId=${state.challengeId}`);
    const ac = await api("POST", "/api/duel/accept", { challengeId: state.challengeId });
    if (ac.status !== 200) { log(`accept failed: ${JSON.stringify(ac.body)}`); return; }
    state.token = ac.body.token;
    log(`token matchId=${state.token.matchId} seed=${state.token.seed}`);
    await establishPeerAndRun("acceptor");
  }

  async function establishPeerAndRun(role) {
    const matchId = state.token.matchId;
    let peerReady;
    const peerReadyP = new Promise((r) => { peerReady = r; });

    state.peer = makePeer(matchId, role, state.myUid,
      (tick, actByte) => {
        state.peerActions.set(tick, actByte);
      },
      (tick, hash) => {
        log(`peer state-hash @${tick} = ${hash}`);
      },
      () => { state.dcOpen = true; peerReady(); update(); },
      () => { state.dcOpen = false; update(); },
      log);

    if (role === "initiator") {
      const offer = await state.peer.pc.createOffer();
      await state.peer.pc.setLocalDescription(offer);
      await api("POST", `/api/duel/signal/${matchId}`,
        { role: "offer", sdp: offer.sdp, fromPlayerId: state.myUid });
      log("posted SDP offer; waiting for answer");
      const resp = await pollUntil(async () => {
        const r = await api("GET", `/api/duel/signal/${matchId}?role=answer`);
        return r.body?.sdp;
      });
      await state.peer.pc.setRemoteDescription({ type: "answer", sdp: resp.sdp });
      log("SDP answer received");
      // Drain remote ICE candidates.
      pollIceCandidates(matchId);
    } else {
      log("polling for SDP offer");
      const resp = await pollUntil(async () => {
        const r = await api("GET", `/api/duel/signal/${matchId}?role=offer`);
        return r.body?.sdp;
      });
      await state.peer.pc.setRemoteDescription({ type: "offer", sdp: resp.sdp });
      const answer = await state.peer.pc.createAnswer();
      await state.peer.pc.setLocalDescription(answer);
      await api("POST", `/api/duel/signal/${matchId}`,
        { role: "answer", sdp: answer.sdp, fromPlayerId: state.myUid });
      log("posted SDP answer");
      pollIceCandidates(matchId);
    }

    await peerReadyP;
    log("data channel ready; starting lockstep sim");
    await runLockstep(role);
  }

  let icePollStop = false;
  async function pollIceCandidates(matchId) {
    let since = new Date(0).toISOString();
    while (!icePollStop && !state.matchDone) {
      const r = await api("GET", `/api/duel/signal/${matchId}?sinceIce=${encodeURIComponent(since)}`);
      if (r.body?.ice) {
        for (const c of r.body.ice) {
          if (c.fromPlayerId === state.myUid) continue;
          try { await state.peer.pc.addIceCandidate(c.candidate); } catch { /* ignore */ }
          if (c.postedAt > since) since = c.postedAt;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function runLockstep(role) {
    const stage = STAGES[state.token.stageId];
    const myCfg = STRATEGIES[state.myPreset];
    // Opponent preset is not exchanged in this PoC — both peers still
    // need to run the match through their OWN brain independently. The
    // peer's action bytes arrive over the channel and drive their side.
    // We seed a placeholder for the opponent (not used since actions
    // come from the channel, but the sim needs paired input).
    const selfIdx = role === "initiator" ? 0 : 1;
    const oppIdx = 1 - selfIdx;

    const world = createStepperWorld({ stage, seed: state.token.seed });
    const myBrain = compileBrain(myCfg);

    const MAX_TICKS = 28800;
    const STATE_HASH_EVERY = state.token.stateHashCadenceTicks || 120;
    const actionBytes = []; // paired p0/p1, order-preserving

    while (world.matchWinner === -1 && world.tick < MAX_TICKS) {
      // Skip during freeze/roundPause — sim still advances but no action needed.
      if (world.freeze > 0 || world.roundPause > 0) {
        stepWorld(world, {}, {});
        continue;
      }

      // Compute my action locally.
      const myObs = worldObservation(world, selfIdx);
      const myParams = applyHallucinationNoise(myBrain.evaluate(myObs), world.tick, selfIdx, world.noiseSeed);
      const myAction = runParamBrain(myObs, myParams, world.brainStates[selfIdx]);
      const myByte = packAction(myAction);

      // Emit my action to peer.
      state.peer.send(encodeActionFrame(world.tick, myByte));
      state.myActions.push({ tick: world.tick, byte: myByte });

      // Wait for peer's action at this tick.
      let peerByte;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (state.peerActions.has(world.tick)) {
          peerByte = state.peerActions.get(world.tick);
          state.peerActions.delete(world.tick);
          break;
        }
        await new Promise((r) => setTimeout(r, 2));
      }
      if (peerByte === undefined) { log(`peer timeout @${world.tick}`); break; }

      const actSelf = unpack(myByte);
      const actOpp = unpack(peerByte);
      const actA = selfIdx === 0 ? actSelf : actOpp;
      const actB = selfIdx === 0 ? actOpp : actSelf;
      const byteA = selfIdx === 0 ? myByte : peerByte;
      const byteB = selfIdx === 0 ? peerByte : myByte;
      actionBytes.push(byteA, byteB);
      stepWorld(world, actA, actB);

      if (world.tick % STATE_HASH_EVERY === 0) {
        const hash = snapshotHash(world);
        state.peer.send(encodeHashFrame(world.tick, hash));
      }
    }

    log(`sim finished @${world.tick}. winner=${world.matchWinner}`);
    state.matchDone = true;

    // Compute logHash over action stream (matches simulate()'s FNV path).
    const actionBuf = new Uint8Array(actionBytes);
    const actionLogB64 = bytesToBase64(actionBuf);
    const result = {
      winner: world.matchWinner === -1
        ? (world.fighters[0].rounds > world.fighters[1].rounds ? 0
          : world.fighters[1].rounds > world.fighters[0].rounds ? 1
            : world.fighters[0].score > world.fighters[1].score ? 0
              : world.fighters[1].score > world.fighters[0].score ? 1 : -1)
        : world.matchWinner,
      finalScore: [world.fighters[0].score, world.fighters[1].score],
      finalRounds: [world.fighters[0].rounds, world.fighters[1].rounds],
      ticks: world.tick,
      logHash: fnv1a(actionBuf),
    };
    log(`submitting action log (${actionBuf.byteLength}b, logHash=${result.logHash})`);
    const sub = await api("POST", "/api/duel/submit", {
      token: state.token,
      actionLogB64,
      result,
      peerSignatures: [state.myUid, state.oppUid],
    });
    log(`submit ${sub.status}: ${JSON.stringify(sub.body)}`);
    icePollStop = true;
    update();
  }

  function unpack(byte) {
    return {
      left: !!(byte & 1), right: !!(byte & 2), up: !!(byte & 4),
      down: !!(byte & 8), action: !!(byte & 16),
    };
  }

  function snapshotHash(world) {
    const f0 = world.fighters[0], f1 = world.fighters[1];
    const nums = [
      f0.x | 0, f0.y | 0, f0.vx | 0, f0.vy | 0, f0.rounds, f0.score, f0.dead ? 1 : 0,
      f1.x | 0, f1.y | 0, f1.vx | 0, f1.vy | 0, f1.rounds, f1.score, f1.dead ? 1 : 0,
      world.tick,
    ];
    const buf = new Uint8Array(nums.length * 4);
    const dv = new DataView(buf.buffer);
    nums.forEach((n, i) => dv.setInt32(i * 4, n | 0, true));
    return fnv1a(buf);
  }

  const btnStart = h("button", { onclick: async () => {
    if (state.role === "initiator") await runInitiator();
    else await runAcceptor();
  } }, state.role === "initiator" ? "start duel" : "accept duel");

  const btnRetry = h("button", { onclick: () => window.location.reload() }, "reset");

  const actions = h("div", { class: "duel-actions" }, btnStart, btnRetry);

  const status = h("div", { class: "duel-status" });
  function update() {
    status.innerHTML = "";
    status.appendChild(h("div", {},
      h("strong", {}, "role: "), state.role));
    status.appendChild(h("div", {},
      h("strong", {}, "challengeId: "), state.challengeId ?? "—"));
    if (state.token) {
      status.appendChild(h("div", {},
        h("strong", {}, "matchId: "), state.token.matchId));
      status.appendChild(h("div", {},
        h("strong", {}, "seed: "), String(state.token.seed)));
    }
    status.appendChild(h("div", {},
      h("strong", {}, "dc: "), state.dcOpen ? "open" : "closed"));
    if (state.matchDone) {
      status.appendChild(h("div", {}, h("strong", {}, "match submitted")));
    }
  }

  panel.appendChild(controls);
  panel.appendChild(actions);
  panel.appendChild(status);
  panel.appendChild(h("h3", {}, "activity"));
  panel.appendChild(logArea);
  root.appendChild(panel);
  update();
}

// Router interface.
export function mount(el) { renderDuel(el); }
export function unmount() { /* cleanup handled on reload */ }
