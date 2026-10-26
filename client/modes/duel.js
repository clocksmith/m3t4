// Duel — local play surface. Three sub-modes:
//
//   vs-AI     : human (P1, WASD+F) vs a preset bot (P2 driven by sim brain)
//   hot-seat  : two humans on one keyboard, P1 WASD+F and P2 O/K/L/;+'
//               (right-hand mirror of WASD+F, same finger geometry as P1.
//                UI label: "LOCAL PVP"; the internal id stays "hot-seat")
//   p2p       : two humans on different machines, paired over WebRTC
//
// Reuses the same stepper sim primitives as tune's HUMAN mode
// (createStepperWorld + stepWorld + readKeyboard). The sim runs locally,
// never touches /api/build/simulate, never enters the canonical match
// feed. Sandbox only — there is no ranked write path here.
//
// The browser-trust boundary still holds: vs-AI compiles a *public*
// preset config (already shipped via @m3t4/sim's STRATEGIES) into a
// brain — no private/canonical brain code is exposed by being on this
// page that wasn't already in the bundle.

import { mountArenaShell } from "../ui/arena-shell.js";
import { createFrameRenderer, W, H, hudAvatarSideAt } from "../render/index.js";
import {
  createStepperWorld,
  stepWorld,
  worldToFrame,
  runBrainForWorld,
  compileBrain,
  STAGES as SIM_STAGES,
  STRATEGIES,
} from "../sim/index.js";
import { STAGES } from "../lib/public-sim.js";
import { escapeHtml } from "../ui/html.js";
import { getAudio, audioEnabledStored } from "../lib/audio.js";
import { EXECUTION_STORAGE_KEY, lethalSwingStored, lethalSwingSides, executionPresentation } from "../lib/execution-strike.js";
import { buttonHtml, toggleSwitchHtml } from "../ui/actions.js";
import { contextCardHtml, pageHeaderHtml, disclosureHtml } from "../ui/shell.js";
import presetRanking from "../data/preset-ranking.v1.json" with { type: "json" };
import rosterCatalog from "../content/roster-catalog.v1.json" with { type: "json" };
import gameCopy from "../content/game-copy.v1.json" with { type: "json" };
import { BODY_PORTRAIT_SHEETS, BODY_VARIANTS } from "../content/character-presentation.js";
import { isP2PSupported } from "../lib/p2p-capabilities.js";

const SIM_HZ = 120;
const STEP_MS = 1000 / SIM_HZ;
const MAX_CATCHUP_TICKS = 240;
const STAGE_IDS = Object.keys(STAGES);
const P2P_SPECTATOR_FRAME_STRIDE = 12;

const KEY_MAP = [
  { left: "KeyA", right: "KeyD", up: "KeyW", down: "KeyS", act: "KeyF",
    moveHint: "W/A/S/D", strikeHint: "F" },
  // Right-hand mirror of WASD+F so P2 has the same finger geometry as
  // P1: O/K/L/; for up/left/down/right, ' (apostrophe) for strike.
  { left: "KeyK", right: "Semicolon", up: "KeyO", down: "KeyL", act: "Quote",
    moveHint: "O/K/L/;", strikeHint: "'" },
];
const GAME_KEYS = new Set([
  "KeyA", "KeyD", "KeyW", "KeyS", "KeyF",
  "KeyO", "KeyK", "KeyL", "Semicolon", "Quote",
]);
const EMPTY_INPUT = Object.freeze({ left: false, right: false, up: false, down: false, action: false });
const REMOTE_INPUT_BUFFER_LIMIT = 720;

const SUB_MODES = ["vs-ai", "hot-seat", "p2p"];

const ALIAS_MAX = 18;
const LS_KEY_ALIAS = "m3t4:duel-alias";
// sessionStorage (per-tab): set when the local user creates a host
// session, cleared on explicit stop / submode switch / unmount. Survives
// a hard refresh of the same tab so we can re-pair the same invite link
// instead of treating our own URL hash as a foreign join code.
const SS_KEY_HOST_SESSION = "m3t4:duel-host-session";

const PRESET_NAMES = (presetRanking.rows ?? []).map((r) => r.name ?? r);
const DEFAULT_PRESET = PRESET_NAMES[0] ?? "standby";
const BODY_IDS = rosterCatalog.bodies ?? [];
const PLAYER_PALETTES = [
  { col: "#6ee7b7", trim: "#d1fae5", shadow: "#047857" },
  { col: "#fb923c", trim: "#fed7aa", shadow: "#9a3412" },
];

function weaponEntriesForBody(body) {
  return (rosterCatalog.weapons?.[body] ?? []).filter((weapon) => weapon.available);
}

function availableWeaponIds(body) {
  const ids = weaponEntriesForBody(body).map((weapon) => weapon.id).filter(Boolean);
  return ids.length ? ids : [""];
}

function defaultCosmetics(side) {
  const body = BODY_IDS[((side % BODY_IDS.length) + BODY_IDS.length) % BODY_IDS.length] ?? "sama";
  return { body, weapon: availableWeaponIds(body)[0] };
}

function normalizeCosmetics(value, side) {
  const fallback = defaultCosmetics(side);
  const body = BODY_IDS.includes(value?.body) ? value.body : fallback.body;
  const weapons = availableWeaponIds(body);
  const weapon = weapons.includes(value?.weapon) ? value.weapon : weapons[0];
  return { body, weapon };
}

function normalizeCosmeticsPair(value) {
  const pair = Array.isArray(value) ? value : [];
  return [normalizeCosmetics(pair[0], 0), normalizeCosmetics(pair[1], 1)];
}

function selectedCosmetics() {
  return normalizeCosmeticsPair(state?.cosmetics);
}

function bodyCopy(body) {
  const variant = BODY_VARIANTS[body];
  return gameCopy.characters?.[body]?.[variant] ?? {};
}

function bodyLabel(body) {
  return bodyCopy(body).name ?? body;
}

function bodyMeta(body) {
  return bodyCopy(body).label ?? bodyCopy(body).combatFantasy ?? body;
}

function weaponLabel(body, weapon) {
  return gameCopy.weapons?.[body]?.[weapon]?.name ?? weapon;
}

function weaponMeta(body, weapon) {
  return gameCopy.weapons?.[body]?.[weapon]?.class ?? "weapon";
}

function selectedCharacters() {
  return selectedCosmetics().map((cosmetic, side) => ({
    name: bodyLabel(cosmetic.body),
    label: weaponLabel(cosmetic.body, cosmetic.weapon),
    ...PLAYER_PALETTES[side],
    body: cosmetic.body,
    weapon: cosmetic.weapon,
    ...(state?.subMode !== 'p2p' ? {weaponMotionVersion:2}
      : state.matchWeaponMotionVersion ? {weaponMotionVersion:state.matchWeaponMotionVersion} : {}),
  }));
}

function cycleFighterForSide(side) {
  if (!state || !localOwnsSide(side)) return;
  const current = normalizeCosmetics(state.cosmetics[side], side);
  const currentIndex = BODY_IDS.indexOf(current.body);
  const nextBody = BODY_IDS[((currentIndex + 1) % BODY_IDS.length + BODY_IDS.length) % BODY_IDS.length];
  const weapons = availableWeaponIds(nextBody);
  const weapon = side === 1 && weapons.length > 1 ? weapons[1] : weapons[0];
  state.cosmetics[side] = normalizeCosmetics({ body: nextBody, weapon }, side);
  state.world = null;
  state.spectating = false;
  state.spectatorFrame = null;
  state.statusMsg = "";
  clearRemoteInputs();
  syncPlayClass();
  renderCharacterSelect();
  refreshHud();
  if (state.subMode === "p2p" && state.p2p?.linked && typeof state.p2p.broadcastCosmetic === "function") {
    state.p2p.broadcastCosmetic(side, state.cosmetics[side]);
  }
}

function sanitizeAlias(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ALIAS_MAX);
}

function loadStoredAlias() {
  try { return sanitizeAlias(localStorage.getItem(LS_KEY_ALIAS) || ""); } catch { return ""; }
}

function storeAlias(value) {
  try {
    if (value) localStorage.setItem(LS_KEY_ALIAS, value);
    else localStorage.removeItem(LS_KEY_ALIAS);
  } catch {}
}

function loadStoredHostSession() {
  try { return sessionStorage.getItem(SS_KEY_HOST_SESSION) || ""; } catch { return ""; }
}

function storeHostSession(sessionId) {
  try {
    if (sessionId) sessionStorage.setItem(SS_KEY_HOST_SESSION, sessionId);
    else sessionStorage.removeItem(SS_KEY_HOST_SESSION);
  } catch {}
}

function aliasFor(side) {
  return state?.aliases?.[side] ?? "";
}

// Cosmetics are editable for any locally-owned side (vs-AI lets you
// dress up the bot, hot-seat lets each chair pick), but the alias for
// vs-AI side 1 is the preset name selected via the opponent dropdown —
// renaming it inline would just be confusing, so the alias input is
// readonly there even though the body/weapon grids stay editable.
function aliasEditable(side) {
  if (!localOwnsSide(side)) return false;
  if (state?.subMode === "vs-ai" && side === 1) return false;
  return true;
}

function ownAliasSide() {
  if (!state) return -1;
  if (state.subMode === "p2p") return state.hostSide === 1 ? 1 : 0;
  return 0;
}

function aliasPlaceholderFor(side) {
  if (!state) return `P${side + 1}`;
  if (state.subMode === "vs-ai") return side === 0 ? "you" : (state.presetName || `P${side + 1}`);
  if (state.subMode === "hot-seat") return `P${side + 1}`;
  if (state.spectating || state.p2p?.spectator) return side === 0 ? "host" : "player";
  if (state.hostSide === side) return "you";
  return state.hostSide === 0 ? "P2" : "host";
}

// Place the persisted alias on whichever side the local user owns. In
// p2p, switching between host and join flips ownAliasSide(); we move
// the stored alias accordingly so the user's chosen name stays "theirs"
// and the other side stays empty until the peer broadcasts.
function placeStoredAliasOnOwnedSide() {
  if (!state) return;
  const stored = loadStoredAlias();
  const owned = ownAliasSide();
  if (owned !== 0 && owned !== 1) return;
  if (stored && state.aliases[owned] === "") state.aliases[owned] = stored;
  const other = 1 - owned;
  if (state.aliases[other] && state.aliases[other] === stored) state.aliases[other] = "";
}

// True when the device is a touch-first device held in landscape.
// Used to gate auto-fullscreen and the matching CSS rules.
function isLandscapeCoarse() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse) and (orientation: landscape)").matches;
}

// Opportunistically enter fullscreen on the duel page and lock the
// orientation to landscape so the bottom-bar UI hides on phones. Both
// requestFullscreen and screen.orientation.lock require a user gesture
// — call this from a click/touch handler. Best-effort; quietly ignores
// browsers that don't support either API (Safari iOS in particular).
async function tryEnterFullscreen(target) {
  if (typeof document === "undefined") return;
  if (document.fullscreenElement) return;
  const el = target ?? document.documentElement;
  try {
    if (typeof el.requestFullscreen === "function") {
      await el.requestFullscreen({ navigationUI: "hide" });
    } else if (typeof el.webkitRequestFullscreen === "function") {
      el.webkitRequestFullscreen();
    }
  } catch {}
  try {
    if (typeof screen !== "undefined" && screen.orientation && typeof screen.orientation.lock === "function") {
      await screen.orientation.lock("landscape");
    }
  } catch {}
}

// Ownership: in vs-AI / hot-seat the local user picks both sides; in
// p2p only the side this client controls is editable. Spectators can't
// edit either side. Drives both the rendered UI (read-only vs editable)
// and the click handler (ignore clicks on the other side).
function localOwnsSide(side) {
  if (!state) return false;
  if (state.spectating || state.p2p?.spectator) return false;
  if (state.subMode === "p2p") {
    if (state.world && state.world.matchWinner === -1) return false;
    return side === state.hostSide;
  }
  return true;
}

function localOwnsStage() {
  if (!state) return false;
  if (state.spectating || state.p2p?.spectator) return false;
  if (state.subMode === "p2p") {
    if (state.world && state.world.matchWinner === -1) return false;
    return state.hostSide === 0;
  }
  return true;
}

const WEAPON_CLASS = {
  worldcoin_orb_flail: "flail", backpack_maul: "maul", gpu_server_blade: "blade", heat_sink_greatsword: "greatsword",
  rolled_constitution_bat: "bat", alignment_baton: "club", red_team_pike: "pike", guardrail_greatsword: "greatsword",
  nobel_medal_flail: "flail", folded_chess_axe: "axe", go_board_maul: "maul", alphafold_blade: "blade",
  sunscreen_bottle_club: "club", controller_nunchucks: "nunchucks", shareholder_sauce_club: "club", quest_flail: "flail",
};

let prevDuelAudioFrame = null;
let lastDuelGruntMs = [0, 0];
let lastDuelFootstepMs = [0, 0];
let duelFootstepStep = [0, 0];

function playHitSound(audio, char, weapon) {
  const cue = `hit_${char}_${weapon}`;
  if (audio.play(cue, { impact: true })) return;
  const cls = WEAPON_CLASS[weapon] ?? "blade";
  if (cls === "flail") audio.play("hit_sama_worldcoin_orb_flail", { impact: true });
  else if (cls === "maul") audio.play("hit_sama_backpack_maul", { impact: true });
  else if (cls === "greatsword") audio.play("hit_sama_heat_sink_greatsword", { impact: true });
  else if (cls === "bat" || cls === "club") audio.play("hit_darrius_alignment_baton", { impact: true });
  else if (cls === "pike") audio.play("hit_darrius_red_team_pike", { impact: true });
  else if (cls === "axe") audio.play("hit_demis_folded_chess_axe", { impact: true });
  else if (cls === "nunchucks") audio.play("hit_mark_controller_nunchucks", { impact: true });
  else audio.play("hit_sama_gpu_server_blade", { impact: true });
}

function fireDuelGrunt(audio, side, char, kind) {
  if (!char) return;
  const now = performance.now();
  if (kind !== "ko" && now - lastDuelGruntMs[side] < 400) return;
  lastDuelGruntMs[side] = now;
  const cue = `grunt_${char}_${kind}`;
  if (!audio.play(cue)) {
    audio.play(side === 0 ? `grunt_sama_${kind}` : `grunt_darrius_${kind}`);
  }
}

function detectDuelAudioEdges(frame) {
  const audio = getAudio();
  if (!audio.isEnabled() || !audio.ready) { prevDuelAudioFrame = frame; return; }
  if (!prevDuelAudioFrame) { prevDuelAudioFrame = frame; return; }

  const cosmetics = selectedCosmetics();
  const chars = [frame.p0?.body ?? cosmetics[0]?.body ?? "sama", frame.p1?.body ?? cosmetics[1]?.body ?? "darrius"];
  const weapons = [frame.p0?.weapon ?? cosmetics[0]?.weapon ?? "gpu_server_blade", frame.p1?.weapon ?? cosmetics[1]?.weapon ?? "alignment_baton"];
  const now = performance.now();

  for (let i = 0; i < 2; i++) {
    const key = i === 0 ? "p0" : "p1";
    const prev = prevDuelAudioFrame[key];
    const curr = frame[key];
    if (!prev || !curr) continue;

    // 1. Weapon swings: initial swing or mid-swing cancellation / restart
    const startedSwipe = ((prev.swipeT ?? 0) <= 0 && (curr.swipeT ?? 0) > 0) ||
      ((curr.swipeT ?? 0) > (prev.swipeT ?? 0) + 0.04);
    if (startedSwipe) {
      const weapon = weapons[i];
      const cls = WEAPON_CLASS[weapon] ?? "blade";
      audio.play(`swipe_${cls}`);
      fireDuelGrunt(audio, i, chars[i], "effort");
    }

    // 2. Dive lunge
    if ((prev.diveT ?? 0) <= 0 && (curr.diveT ?? 0) > 0) {
      audio.play("dive_lunge");
    }

    // 3. Jumps and Wall jumps
    const jumped = prev.onGround && !curr.onGround && (curr.vy ?? 0) < -100 && (curr.diveT ?? 0) <= 0;
    const wallJumped = (prev.wall ?? 0) !== 0 && (curr.wall ?? 0) === 0 && (curr.vy ?? 0) < -100 && !curr.onGround;
    if (jumped) {
      audio.play("jump_boing");
    } else if (wallJumped) {
      audio.play("jump_boing", { playbackRate: 1.25 });
    }

    // 4. Platform / Ground landing
    if (!prev.onGround && curr.onGround && (prev.vy ?? 0) > 150) {
      audio.play("footstep_a", { impact: true, playbackRate: 0.85, volume: 0.7 });
    }

    // 5. Footsteps while running on ground
    const isRunning = curr.onGround && Math.abs(curr.vx ?? 0) > 60 && (curr.swipeT ?? 0) <= 0 && (curr.diveT ?? 0) <= 0 && !curr.dead;
    if (isRunning && now - lastDuelFootstepMs[i] > 180) {
      lastDuelFootstepMs[i] = now;
      const stepCue = (duelFootstepStep[i]++ % 2 === 0) ? "footstep_a" : "footstep_b";
      audio.play(stepCue, { volume: 0.5 });
    }

    // 6. Stun / Non-lethal weapon hit
    if ((prev.stun ?? 0) <= 0 && (curr.stun ?? 0) > 0 && !curr.dead) {
      const attacker = 1 - i;
      playHitSound(audio, chars[attacker], weapons[attacker]);
      fireDuelGrunt(audio, i, chars[i], "hurt");
    }

    // 7. Death from weapon hit
    if (!prev.dead && curr.dead) {
      const attacker = 1 - i;
      playHitSound(audio, chars[attacker], weapons[attacker]);
      audio.play("ko_flatline");
      fireDuelGrunt(audio, i, chars[i], "ko");
    }
  }

  // 8. Weapon clash
  const clashTick0 = frame.p0?.lastClashTick ?? -9999;
  const prevClash0 = prevDuelAudioFrame.p0?.lastClashTick ?? -9999;
  const clashTick1 = frame.p1?.lastClashTick ?? -9999;
  const prevClash1 = prevDuelAudioFrame.p1?.lastClashTick ?? -9999;
  if (clashTick0 > prevClash0 || clashTick1 > prevClash1) {
    audio.play("hit_sama_gpu_server_blade", { impact: true, playbackRate: 1.5 });
  }

  if (prevDuelAudioFrame.token && frame.token) {
    if (!prevDuelAudioFrame.token.exists && frame.token.exists) {
      audio.play("proof_spawn");
    }
    if (prevDuelAudioFrame.token.carrier === -1 && frame.token.carrier !== -1) {
      audio.play("proof_acquired");
    }
  }
  if (prevDuelAudioFrame.scoreboard && frame.scoreboard) {
    if (frame.scoreboard[0] > prevDuelAudioFrame.scoreboard[0] || frame.scoreboard[1] > prevDuelAudioFrame.scoreboard[1]) {
      audio.play("proof_delivered");
    }
  }
  if (prevDuelAudioFrame.rounds && frame.rounds) {
    if (frame.rounds[0] > prevDuelAudioFrame.rounds[0] || frame.rounds[1] > prevDuelAudioFrame.rounds[1]) {
      audio.play("round_taken");
    }
  }

  prevDuelAudioFrame = frame;
}

// --- module state ---
let state = null; // populated by mount()

function freshState() {
  return {
    matchEndFired: false,
    lethalSwing: lethalSwingStored(),
    executionImpact: null,
    executionWorld: null,
    subMode: "vs-ai",
    stageId: STAGE_IDS.includes("datacenter") ? "datacenter" : STAGE_IDS[0],
    presetName: DEFAULT_PRESET,
    keyset: new Set(),
    touchPointers: new Map(),
    touchInput: { ...EMPTY_INPUT },
    page: null,
    canvas: null,
    renderer: null,
    rendererId: 0,
    rafId: 0,
    running: false,
    paused: false,
    arenaShell: null,
    world: null,
    brainP2: null,
    seed: 0,
    playedAtMs: 0,
    accumMs: 0,
    p2p: null,        // populated when p2p sub-mode is active
    remoteInputs: new Map(),
    lastRemoteTick: -1,
    waitingRemoteTick: null,
    hostSide: 0,      // 0 = P1, 1 = P2 (for p2p, assigned when pairing)
    spectating: false,
    spectatorFrame: null,
    lastSpectatorFrameTick: -1,
    peerLatencyMs: null,
    peerLatencyAt: 0,
    streamAgeMs: null,
    streamAgeAt: 0,
    statusMsg: "",
    cosmetics: [defaultCosmetics(0), defaultCosmetics(1)],
    aliases: ["", ""],
  };
}

// --- input ---
function isTypingTarget(el) {
  if (!el) return false;
  const t = el.tagName;
  return t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || el.isContentEditable;
}
function onKeyDown(e) {
  if (!state || state.arenaShell?.dialog.open || state.paused || isTypingTarget(e.target) || e.target?.closest?.("button, summary, a")) return;
  if (e.code === "Space" && (!state.world || state.world.matchWinner !== -1)) {
    e.preventDefault();
    startMatch();
    refocusCanvas();
    return;
  }
  state.keyset.add(e.code);
  if (GAME_KEYS.has(e.code)) e.preventDefault();
}
function onKeyUp(e) {
  if (!state) return;
  state.keyset.delete(e.code);
}
function onBlur() {
  if (!state) return;
  state.keyset.clear();
  clearTouchInput();
}
function readKeyboard(slot) {
  const k = KEY_MAP[slot];
  const ks = state.keyset;
  return {
    left: ks.has(k.left), right: ks.has(k.right),
    up: ks.has(k.up), down: ks.has(k.down),
    action: ks.has(k.act),
  };
}

function readLocalInput() {
  if (state.arenaShell?.dialog.open || state.paused) return EMPTY_INPUT;
  const keys = readKeyboard(0);
  const touch = state.touchInput ?? EMPTY_INPUT;
  return {
    left: keys.left || touch.left,
    right: keys.right || touch.right,
    up: keys.up || touch.up,
    down: keys.down || touch.down,
    action: keys.action || touch.action,
  };
}

function updateTouchInput() {
  if (!state) return;
  const active = new Set(state.touchPointers.values());
  state.touchInput = {
    left: active.has("left"),
    right: active.has("right"),
    up: active.has("up"),
    down: active.has("down"),
    action: active.has("action"),
  };
  document.querySelectorAll(".duel-touch-control").forEach((button) => {
    button.classList.toggle("is-pressed", active.has(button.dataset.touchAction));
  });
}

function clearTouchInput() {
  if (!state) return;
  state.touchPointers.clear();
  updateTouchInput();
}

function normalizeInput(input = EMPTY_INPUT) {
  return {
    left: input.left === true,
    right: input.right === true,
    up: input.up === true,
    down: input.down === true,
    action: input.action === true,
  };
}

function clearRemoteInputs() {
  if (!state) return;
  state.remoteInputs.clear();
  state.lastRemoteTick = -1;
  state.waitingRemoteTick = null;
}

function syncLocalP2PSetupToPeer({ includeStage = false } = {}) {
  if (!state || state.subMode !== "p2p" || !state.p2p?.linked || state.p2p?.spectator) return;
  state.p2p.broadcastCosmetic?.(state.hostSide, state.cosmetics[state.hostSide]);
  state.p2p.broadcastAlias?.(state.hostSide, state.aliases[state.hostSide] ?? "");
  if (includeStage && state.hostSide === 0) {
    state.p2p.broadcastStage?.(state.stageId);
  }
}

function pruneRemoteInputs(currentTick) {
  if (!state || state.remoteInputs.size <= REMOTE_INPUT_BUFFER_LIMIT) return;
  for (const tick of state.remoteInputs.keys()) {
    if (tick < currentTick) state.remoteInputs.delete(tick);
    if (state.remoteInputs.size <= REMOTE_INPUT_BUFFER_LIMIT) break;
  }
}

function bufferRemoteInput(tick, input) {
  if (!state || !Number.isInteger(tick) || tick < 0) return;
  const currentTick = state.world?.tick ?? 0;
  if (tick < currentTick) return;
  state.remoteInputs.set(tick, normalizeInput(input));
  state.lastRemoteTick = Math.max(state.lastRemoteTick, tick);
  pruneRemoteInputs(currentTick);
}

// --- sim wiring ---
function freshSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

function startMatch() {
  if (!state) return;
  if (state.subMode === "p2p") {
    if (state.spectating || state.p2p?.spectator) {
      state.statusMsg = "spectating host match";
      refreshHud(state.spectatorFrame ?? emptyFrame());
      return;
    }
    if (!state.p2p?.linked) {
      state.world = null;
      state.statusMsg = state.p2p ? "waiting for opponent…" : "host or join first";
      syncPlayClass();
      refreshHud();
      return;
    }
    if (state.hostSide !== 0) {
      state.statusMsg = "waiting for host match";
      refreshHud();
      return;
    }
  }
  const stage = SIM_STAGES[state.stageId] ?? SIM_STAGES.datacenter;
  clearRemoteInputs();
  state.paused = false;
  state.seed = freshSeed();
  state.matchWeaponMotionVersion=state.subMode==='p2p' ? (state.p2p?.weaponMotionVersion ?? 0) : 2;
  state.world = createStepperWorld({ stage, seed: state.seed, chars: selectedCharacters() });
  state.executionImpact = null;
  state.executionWorld = null;
  prevDuelAudioFrame = null;
  state.matchEndFired = false;
  const audio = getAudio();
  audio.setStage(state.stageId ?? "datacenter");
  audio.play("match_start");
  state.brainP2 = state.subMode === "vs-ai"
    ? compileBrain(STRATEGIES[state.presetName] ?? STRATEGIES[DEFAULT_PRESET])
    : null;
  state.playedAtMs = performance.now();
  state.accumMs = 0;
  state.spectating = false;
  state.spectatorFrame = null;
  state.lastSpectatorFrameTick = -1;
  state.statusMsg = state.subMode === "p2p" && !state.p2p?.linked
    ? "waiting for opponent…"
    : "fight";
  if (state.p2p?.linked && typeof state.p2p.broadcastMatch === "function") {
    state.p2p.broadcastMatch({
      seed: state.seed,
      stageId: state.stageId,
      cosmetics: selectedCosmetics(),
      aliases: [...state.aliases],
      weaponMotionVersion: state.matchWeaponMotionVersion,
    });
    state.p2p.postSpectatorFrame?.(worldToFrame(state.world));
  }
  syncPlayClass();
  renderCharacterSelect();
  refreshHud();
}

function actionFor(slot) {
  if (state.subMode === "vs-ai") {
    if (slot === 0) return readLocalInput();
    return runBrainForWorld(state.world, state.brainP2, 1);
  }
  if (state.subMode === "hot-seat") {
    if (slot === 0) return readLocalInput();
    return readKeyboard(slot);
  }
  // p2p: local human drives one side, remote input drives the other.
  if (slot === state.hostSide) return readLocalInput();
  return EMPTY_INPUT;
}

function step(nowMs) {
  if (!state.world) return null;
  if (state.subMode !== "p2p" && (state.paused || state.arenaShell?.dialog.open)) {
    if (state.executionImpact) state.executionImpact.startedAt += Math.max(0, nowMs - state.playedAtMs);
    state.playedAtMs = nowMs;
    return worldToFrame(state.world);
  }
  if (state.world.matchWinner !== -1) return worldToFrame(state.world);
  let dt = nowMs - state.playedAtMs;
  state.playedAtMs = nowMs;
  if (!Number.isFinite(dt) || dt < 0) dt = 0;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const presentation = executionPresentation(state.executionWorld === state.world ? state.executionImpact : null, nowMs, reducedMotion);
  state.accumMs += dt * presentation.timeScale;
  let steps = 0;
  while (
    state.accumMs >= STEP_MS &&
    steps < MAX_CATCHUP_TICKS &&
    state.world.matchWinner === -1
  ) {
    let actA;
    let actB;
    if (state.subMode === "p2p") {
      if (!state.p2p?.linked) {
        state.statusMsg = "waiting for opponent…";
        break;
      }
      const tick = state.world.tick >>> 0;
      const localAct = readLocalInput();
      state.p2p.sendInput(tick, localAct);
      const remoteAct = state.remoteInputs.get(tick);
      if (!remoteAct) {
        state.waitingRemoteTick = tick;
        state.statusMsg = `waiting for ${state.hostSide === 0 ? "P2" : "host"} input @${tick}`;
        break;
      }
      state.remoteInputs.delete(tick);
      state.waitingRemoteTick = null;
      state.statusMsg = "fight";
      actA = state.hostSide === 0 ? localAct : remoteAct;
      actB = state.hostSide === 1 ? localAct : remoteAct;
    } else {
      actA = actionFor(0);
      actB = actionFor(1);
    }
    const result = stepWorld(state.world, actA, actB, {
      lethalSwings: lethalSwingSides(state.lethalSwing, state.subMode),
    });
    state.accumMs -= STEP_MS;
    steps++;
    if (result.execution) {
      state.executionImpact = { ...result.execution, startedAt: nowMs };
      state.executionWorld = state.world;
      getAudio().play('hit_sama_gpu_server_blade', { impact: true, playbackRate: 0.55 });
      // Do not consume an accumulated backlog before the impact is rendered.
      state.accumMs = 0;
      break;
    }
  }
  if (state.accumMs > STEP_MS * MAX_CATCHUP_TICKS) {
    state.accumMs = STEP_MS * MAX_CATCHUP_TICKS;
  }
  if (state.world.matchWinner !== -1 && !state.matchEndFired) {
    state.matchEndFired = true;
    const audio = getAudio();
    audio.play("match_end_win");
    audio.play("win_applause", { when: 0.25 });
  }
  return worldToFrame(state.world);
}

function loop() {
  if (!state || !state.running) return;
  if (state.renderer) {
    const stage = SIM_STAGES[state.stageId] ?? SIM_STAGES.datacenter;
    const frame = (state.subMode === "p2p" && (state.spectating || state.p2p?.spectator))
      ? (state.spectatorFrame ?? emptyFrame())
      : (step(performance.now()) ?? emptyFrame());
    maybePostSpectatorFrame(frame);
    const presentation = executionPresentation(state.executionWorld === state.world ? state.executionImpact : null,
      performance.now(), matchMedia('(prefers-reduced-motion: reduce)').matches);
    state.renderer.drawFrame(stage, frame, { ...labels(), execution: presentation.camera });
    detectDuelAudioEdges(frame);
    refreshHud(frame);
  }
  state.rafId = requestAnimationFrame(loop);
}

function maybePostSpectatorFrame(frame) {
  if (state.subMode !== "p2p" || state.hostSide !== 0 || state.p2p?.spectator) return;
  if (!state.p2p?.linked || !state.world || !frame) return;
  const tick = Number(frame.tick ?? -1);
  if (!Number.isInteger(tick) || tick < 0) return;
  if (tick === state.lastSpectatorFrameTick || tick % P2P_SPECTATOR_FRAME_STRIDE !== 0) return;
  state.lastSpectatorFrameTick = tick;
  state.p2p.postSpectatorFrame?.(frame);
}

function emptyFrame() {
  return {
    tick: 0, roundStartTick: 0,
    p0: { x: 300, y: 612, vx: 0, vy: 0, facing: 1, onGround: true, wall: 0, stun: 0, swipeT: 0, diveT: 0, lastClashTick: -9999, dead: false },
    p1: { x: 980, y: 612, vx: 0, vy: 0, facing: -1, onGround: true, wall: 0, stun: 0, swipeT: 0, diveT: 0, lastClashTick: -9999, dead: false },
    token: { exists: false, x: 0, y: 0, carrier: -1, dwellT: 0 },
    goal: { exists: false, x: 0, y: 0, label: "", timer: 0 },
    scoreboard: [0, 0],
    rounds: [0, 0],
  };
}

function labels() {
  const cosmetics = selectedCosmetics();
  const a0 = aliasFor(0);
  const a1 = aliasFor(1);
  if (state.subMode === "vs-ai") return { p1: a0 || "you", p2: a1 || state.presetName, cosmetics };
  if (state.subMode === "hot-seat") return { p1: a0 || "P1", p2: a1 || "P2", cosmetics };
  if (state.spectating || state.p2p?.spectator) return { p1: a0 || "host", p2: a1 || "player", cosmetics };
  return state.hostSide === 0
    ? { p1: a0 || "you", p2: a1 || "P2", cosmetics }
    : { p1: a0 || "host", p2: a1 || "you", cosmetics };
}

// --- HUD ---
function refreshHud(frame = state.world ? worldToFrame(state.world) : emptyFrame()) {
  const score = state.world
    ? `${state.world.fighters[0].score}-${state.world.fighters[1].score}`
    : Array.isArray(frame?.scoreboard)
      ? `${frame.scoreboard[0] ?? 0}-${frame.scoreboard[1] ?? 0}`
    : "0-0";
  const rounds = state.world
    ? `${state.world.fighters[0].rounds}-${state.world.fighters[1].rounds}`
    : Array.isArray(frame?.rounds)
      ? `${frame.rounds[0] ?? 0}-${frame.rounds[1] ?? 0}`
    : "0-0";
  setText("duel-stat-tick", String(frame?.tick ?? 0));
  setText("duel-stat-score", score);
  setText("duel-stat-rounds", rounds);
  setText("duel-stat-seed", state.seed ? String(state.seed) : "—");
  setText("duel-stat-link", linkStatText());
  setText("duel-status", duelStatusText());
  const pause = document.getElementById("duel-pause");
  if (pause) { pause.disabled = state.subMode === "p2p" || !state.world || state.world.matchWinner !== -1; pause.textContent = state.paused ? "Resume" : "Pause"; pause.setAttribute("aria-pressed", String(state.paused)); }
}

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return `${Math.round(ms)}ms`;
}

function linkStatText() {
  if (!state || state.subMode !== "p2p") return "local";
  const now = Date.now();
  if (state.spectating || state.p2p?.spectator) {
    if (!Number.isFinite(state.streamAgeMs) || now - state.streamAgeAt > 4_000) return "stream —";
    return `stream ${formatMs(state.streamAgeMs)}`;
  }
  if (!state.p2p) return "offline";
  if (!state.p2p.linked) return "pairing";
  if (!Number.isFinite(state.peerLatencyMs) || now - state.peerLatencyAt > 4_000) return "rtt —";
  return `rtt ${formatMs(state.peerLatencyMs)}`;
}

function startPrompt() {
  // Coarse pointer = touch-first device; show tap copy. Desktop falls
  // through to spacebar copy. Cached lookups would be brittle if the
  // user drags between displays, so we re-check on each call (cheap).
  if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) {
    return "tap to fight";
  }
  return "press space to fight";
}

function duelStatusText() {
  if (state.spectating || state.p2p?.spectator) return state.statusMsg || "spectating";
  if (!state.world) return state.statusMsg || startPrompt();
  if (state.world.matchWinner !== -1) {
    const w = state.world.matchWinner;
    return `${w === 0 ? labels().p1 : labels().p2} wins · ${startPrompt()} again`;
  }
  return state.paused ? "paused" : state.statusMsg || "fight";
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// --- HTML scaffolds ---
function presetOptions(selected) {
  const rows = presetRanking.rows ?? PRESET_NAMES.map((name) => ({ name, wr: 0 }));
  return rows.map((r) => {
    return `<option value="${escapeHtml(r.name)}" ${r.name === selected ? "selected" : ""}>${escapeHtml(r.name)}</option>`;
  }).join("");
}

function stageOptions(selected) {
  return STAGE_IDS.map(
    (id) => `<option value="${escapeHtml(id)}" ${id === selected ? "selected" : ""}>${escapeHtml(STAGES[id]?.name ?? id)}</option>`
  ).join("");
}

function subModeRowHtml() {
  return `
    <div class="duel-mode-row" role="radiogroup" aria-label="duel mode">
      ${SUB_MODES.map((m) => `
        <label class="mode-pill ${m === state.subMode ? "is-active" : ""}" data-submode="${m}">
          <input type="radio" name="duel-submode" value="${m}" ${m === state.subMode ? "checked" : ""}>
          <span>${m === "vs-ai" ? "VS AI" : m === "hot-seat" ? "LOCAL PVP" : "P2P"}</span>
        </label>`).join("")}
    </div>`;
}

function characterSelectHtml() {
  const cosmetics = selectedCosmetics();
  return cosmetics.map((cosmetic, side) => {
    const editable = localOwnsSide(side);
    const ownerHint = state.subMode === "p2p"
      ? (editable ? "you" : "remote")
      : "";
    const headHint = ownerHint ? `<span class="duel-fighter-owner tight">${escapeHtml(ownerHint)}</span>` : "";
    const alias = aliasFor(side);
    const placeholder = aliasPlaceholderFor(side);
    const canEditAlias = aliasEditable(side);
    const aliasBlock = canEditAlias
      ? `<label class="duel-alias tight">
           <span>alias</span>
           <input type="text" class="duel-alias-input" data-side="${side}" maxlength="${ALIAS_MAX}" value="${escapeHtml(alias)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false" />
         </label>`
      : `<div class="duel-alias tight is-readonly">
           <span>alias</span>
           <span class="duel-alias-readonly">${escapeHtml(alias || placeholder)}</span>
         </div>`;
    return `
    <div class="duel-fighter-slot${editable ? "" : " is-readonly"}" data-side="${side}">
      <div class="duel-fighter-head">
        <span class="duel-fighter-kicker">P${side + 1}</span>
        <strong>${escapeHtml(bodyLabel(cosmetic.body))}</strong>
        <span>${escapeHtml(weaponLabel(cosmetic.body, cosmetic.weapon))}</span>
        ${headHint}
      </div>
      ${aliasBlock}
      ${editable ? `
        <div class="duel-body-grid" aria-label="P${side + 1} character select">
          ${BODY_IDS.map((body) => {
            const selected = body === cosmetic.body;
            return `
              <button type="button" class="duel-body-option${selected ? " is-selected" : ""}" data-side="${side}" data-body="${escapeHtml(body)}" title="${escapeHtml(bodyMeta(body))}">
                ${bodyPortraitHtml(body)}
                <span>${escapeHtml(bodyLabel(body))}</span>
              </button>`;
          }).join("")}
        </div>
        <div class="duel-weapon-grid" aria-label="P${side + 1} weapon select">
          ${weaponEntriesForBody(cosmetic.body).map((weapon) => {
            const selected = weapon.id === cosmetic.weapon;
            return `
              <button type="button" class="duel-weapon-option${selected ? " is-selected" : ""}" data-side="${side}" data-weapon="${escapeHtml(weapon.id)}">
                ${weaponOptionVisualHtml(cosmetic.body, weapon)}
                <span class="duel-weapon-copy">
                  <span class="duel-weapon-name">${escapeHtml(weaponLabel(cosmetic.body, weapon.id))}</span>
                  <span class="duel-weapon-meta">${escapeHtml(weaponMeta(cosmetic.body, weapon.id))}</span>
                </span>
              </button>`;
          }).join("")}
        </div>` : `
        <div class="duel-fighter-readonly tight" aria-label="P${side + 1} locked to remote selection">
          ${bodyPortraitHtml(cosmetic.body)}
          <span class="duel-fighter-readonly-meta">picked by ${escapeHtml(ownerHint || "peer")}</span>
        </div>`}
    </div>`;
  }).join("");
}

function bodyPortraitHtml(body) {
  const url = BODY_PORTRAIT_SHEETS[body];
  const style = url ? ` style="background-image:url('${escapeHtml(url)}')"` : "";
  return `<span class="duel-body-portrait"${style} aria-hidden="true"></span>`;
}

function weaponOptionVisualHtml(body, weapon) {
  const spriteStyle = weaponSpriteStyle(body, weapon.asset);
  return `
    <span class="duel-weapon-visual" aria-hidden="true">
      <span class="duel-weapon-sprite${spriteStyle ? "" : " is-missing"}"${spriteStyle ? ` style="${spriteStyle}"` : ""}></span>
    </span>`;
}

function weaponSpriteStyle(body, asset) {
  if (!asset?.url) return "";
  const cols = Math.max(1, Number(asset.cols ?? 1) || 1);
  const cell = Math.max(0, Number(asset.cell ?? 0) || 0);
  const rows = weaponSheetRows(body, asset, cols);
  const col = cell % cols;
  const row = Math.floor(cell / cols);
  const x = cols > 1 ? (col / (cols - 1)) * 100 : 0;
  const y = rows > 1 ? (row / (rows - 1)) * 100 : 0;
  return [
    `background-image:url('${escapeHtml(asset.url)}')`,
    `background-size:${cols * 100}% ${rows * 100}%`,
    `background-position:${x}% ${y}%`,
  ].join(";");
}

function weaponSheetRows(body, asset, cols) {
  const maxCell = weaponEntriesForBody(body)
    .filter((weapon) => weapon.asset?.url === asset.url)
    .reduce((max, weapon) => Math.max(max, Number(weapon.asset?.cell ?? 0) || 0), Number(asset.cell ?? 0) || 0);
  return Math.max(1, Math.floor(maxCell / cols) + 1);
}

function controlsCardHtml() {
  return `
    <div class="duel-controls">
      ${subModeRowHtml()}
      <details class="duel-cosmetics-fold" open>
        <summary class="duel-cosmetics-summary tight" title="Choose fighters & weapons">
          <span>Choose fighters & weapons</span>
          <strong class="duel-cosmetics-current" id="duel-cosmetics-summary-label">${escapeHtml(bodyLabel(state.cosmetics[0].body))} vs ${escapeHtml(bodyLabel(state.cosmetics[1].body))}</strong>
        </summary>
        <div class="duel-character-select" id="duel-character-select">${characterSelectHtml()}</div>
      </details>

      <div class="duel-row">
        <label class="tight">stage
          <select id="duel-stage">${stageOptions(state.stageId)}</select>
        </label>
        <label class="tight" id="duel-preset-row" ${state.subMode === "vs-ai" ? "" : "hidden"}>
          opponent
          <select id="duel-preset">${presetOptions(state.presetName)}</select>
        </label>
        <div class="watch-controls">${toggleSwitchHtml({ id: "duel-audio", label: "Audio", title: "Play sound effects and stage music", checked: audioEnabledStored() })}</div>
        <div class="watch-controls">${toggleSwitchHtml({ id: "duel-lethal-swing", label: "Lethal Swing", title: "Local matches: every new human swing kills, with cinematic zoom and slow motion", checked: state.lethalSwing })}</div>
      </div>

      <div class="duel-row" id="duel-p2p-row" ${state.subMode === "p2p" ? "" : "hidden"}>
        <div class="duel-p2p-panel" id="duel-p2p-panel">
          ${p2pPanelHtml()}
        </div>
      </div>

      <div class="duel-keys" id="duel-keys"></div>
      ${disclosureHtml({ label: "How to play", body: `<p>Move with A/D, jump with W, drop with S and strike with F. Press S + F in the air to dive.</p><p>Defeat your rival, collect the Proof Core, then deliver it to the glowing target. Two deliveries win a round; two rounds win the match.</p><p>Local P2 uses K/; to move, O to jump, L to drop and apostrophe to strike. Touch controls appear on touch devices.</p>` })}

      <div class="duel-row">
        ${buttonHtml({ id: "duel-start", variant: "primary", text: "Start match", attrs: { title: "Start a fresh match" } })}
        ${buttonHtml({ id: "duel-reset", text: "Reset match", attrs: { title: "Clear this match and choose a fresh seed when you start again" } })}
      </div>
    </div>`;
}

function p2pPanelHtml() {
  if (!isP2PSupported()) {
    return `<div class="duel-p2p-warning">P2P needs WebRTC + Firebase. Check your config.js.</div>`;
  }
  // Two visual states:
  //  - .is-idle   → host/join controls visible
  //  - .is-active → stop/new + share + takeover visible
  // We render both in the DOM (so handlers stay bound across state
  // flips) and toggle the parent class to hide the irrelevant block via
  // CSS. That avoids 4 hidden, empty rows always taking vertical space.
  return `
    <div class="duel-p2p-warning tight">
      same link: first visitor plays P2, later visitors spectate.
    </div>
    <div class="duel-p2p-idle">
      <div class="duel-p2p-row">
        ${buttonHtml({ id: "duel-p2p-host", text: "host", attrs: { title: "Create a session and share the invite link" } })}
        <span class="duel-p2p-divider">or</span>
        <input type="text" id="duel-p2p-code" placeholder="paste invite link" autocomplete="off" spellcheck="false" />
        ${buttonHtml({ id: "duel-p2p-join", text: "join", attrs: { title: "Join an existing session" } })}
      </div>
    </div>
    <div class="duel-p2p-active">
      <div class="duel-p2p-row duel-p2p-session-row">
        ${buttonHtml({ id: "duel-p2p-stop", text: "stop session", attrs: { title: "Tear down the current P2P session", disabled: true } })}
        ${buttonHtml({ id: "duel-p2p-new", text: "new host", attrs: { title: "Generate a fresh session id (breaks the previous link)" } })}
      </div>
      <div class="duel-p2p-share" id="duel-p2p-share" hidden></div>
    </div>
    <div class="duel-p2p-takeover" id="duel-p2p-takeover" hidden>
      <span class="tight">host has left — take over and host this match?</span>
      ${buttonHtml({ id: "duel-p2p-takeover-btn", variant: "primary", text: "take over", attrs: { title: "Start a fresh host session on this device" } })}
    </div>
    <div class="duel-p2p-status tight" id="duel-p2p-status">ready: host or paste invite link</div>`;
}

function controlCardHtml({ role, owner, keyboard, touch = false, remote = false }) {
  return `
    <span class="duel-key-card${remote ? " is-remote" : ""}">
      <b>${escapeHtml(role)}</b>
      <span>${escapeHtml(owner)}</span>
      <span>${escapeHtml(keyboard)}</span>
      ${touch ? `<span class="duel-touch-hint">touch D-pad + strike</span>` : ""}
    </span>`;
}

function keysHtml() {
  if (state.subMode === "vs-ai") {
    return `
      ${controlCardHtml({ role: "P1", owner: "you", keyboard: "W/A/S/D + F", touch: true })}
      ${controlCardHtml({ role: "P2", owner: "AI opponent", keyboard: "no local controls", remote: true })}`;
  }
  if (state.subMode === "hot-seat") {
    return `
      ${controlCardHtml({ role: "P1", owner: "local player", keyboard: "W/A/S/D + F", touch: true })}
      ${controlCardHtml({ role: "P2", owner: "same device", keyboard: "O/K/L/; + '", remote: true })}`;
  }
  if (state.spectating || state.p2p?.spectator) {
    return `
      ${controlCardHtml({ role: "spectator", owner: "watching this match", keyboard: "no controls", remote: true })}
      ${controlCardHtml({ role: "players", owner: "host + P2", keyboard: "their W/A/S/D + F or touch", remote: true })}`;
  }
  const paired = !!state.p2p;
  const role = state.hostSide === 1 ? "P2" : "P1";
  const owner = paired
    ? "you on this device"
    : "host is P1, joiner is P2";
  const peerRole = paired && state.hostSide === 0 ? "P2" : "host";
  return `
    ${controlCardHtml({ role, owner, keyboard: "W/A/S/D + F", touch: true })}
    ${controlCardHtml({ role: paired ? peerRole : "peer", owner: "their device", keyboard: "their W/A/S/D + F or touch", remote: true })}`;
}

function statsListHtml() {
  return `
    <div class="duel-stats">
      <span class="stat"><span class="stat-label">score</span><span class="stat-value" id="duel-stat-score">0-0</span></span>
      <span class="stat"><span class="stat-label">rounds</span><span class="stat-value" id="duel-stat-rounds">0-0</span></span>
      <span class="stat duel-status"><span class="stat-label">status</span><span class="stat-value" id="duel-status" role="status">${escapeHtml(startPrompt())}</span></span>
    </div>
    ${disclosureHtml({ label: "Match details", body: `<div class="duel-stats">
      <span class="stat"><span class="stat-label">tick</span><span class="stat-value" id="duel-stat-tick">0</span></span>
      <span class="stat"><span class="stat-label">seed</span><span class="stat-value" id="duel-stat-seed">—</span></span>
      <span class="stat"><span class="stat-label">link</span><span class="stat-value" id="duel-stat-link">local</span></span>
    </div>` })}`;
}

function touchControlsHtml() {
  return `
    <div class="duel-touch-controls" id="duel-touch-controls" aria-label="touch controls">
      <div class="duel-touch-pad" aria-label="move">
        <button type="button" class="duel-touch-control is-up" data-touch-action="up" aria-label="jump">UP</button>
        <button type="button" class="duel-touch-control is-left" data-touch-action="left" aria-label="move left">LEFT</button>
        <button type="button" class="duel-touch-control is-down" data-touch-action="down" aria-label="drop">DOWN</button>
        <button type="button" class="duel-touch-control is-right" data-touch-action="right" aria-label="move right">RIGHT</button>
      </div>
      <div class="duel-touch-actions" aria-label="actions">
        <button type="button" class="duel-touch-control is-action" data-touch-action="action" aria-label="strike">STRIKE</button>
      </div>
    </div>
    <button type="button" class="duel-touch-setup" id="duel-touch-setup">setup</button>`;
}

export function duelPageHtml() {
  if (!state) state = freshState();
  return `
    <div class="page duel-page">
      ${pageHeaderHtml({
        title: "Play",
        subtitle: "Play against AI or a friend. Choose an opponent, then start a match. Unranked sandbox.",
      })}
      <div class="duel-workbench">
        ${contextCardHtml({
          className: "duel-context-card",
          body: controlsCardHtml(),
          autoHeight: true,
        })}
        <section class="panel canvas-panel">
          <canvas id="duel-canvas" aria-label="Playable fighter arena. Open Settings for keyboard controls." class="u-canvas-fill" width="${W}" height="${H}" tabindex="0"></canvas>
          ${statsListHtml()}
          ${touchControlsHtml()}
        </section>
      </div>
    </div>`;
}

// --- mode lifecycle ---

export function mount(root, ctx = {}) {
  ctx.setStatus?.("duel");
  state = freshState();
  placeStoredAliasOnOwnedSide();

  root.innerHTML = duelPageHtml();

  state.page = root.querySelector(".duel-page");
  state.canvas = root.querySelector("#duel-canvas");
  const pause = document.createElement("button");
  pause.type = "button"; pause.id = "duel-pause"; pause.textContent = "Pause";
  pause.addEventListener("click", () => {
    if (!state || state.subMode === "p2p" || !state.world) return;
    state.paused = !state.paused; onBlur(); state.playedAtMs = performance.now(); refreshHud();
  });
  state.arenaShell = mountArenaShell(root, {
    title: "Play", canvas: state.canvas, actions: [root.querySelector("#duel-start")], pause, status: root.querySelector("#duel-status"),
    note: "Local matches pause while settings are open. Closing restores your previous play state. Online matches continue; your controls are released.",
    onOpen: onBlur, onClose: () => { onBlur(); if (state) state.playedAtMs = performance.now(); },
  });
  root.querySelector(".duel-stats .duel-status")?.remove(); // Its live value now belongs to the toolbar.
  document.body.classList.add("duel-mounted");
  void attachRenderer(state.canvas);
  refreshKeysHint();
  bindControls();
  applyJoinLinkFromLocation();

  // Tap the canvas to start a fresh match when nothing is running.
  // Mirrors the spacebar shortcut for touch users. Tapping either HUD avatar
  // cycles that fighter. We also opportunistically enter fullscreen here.
  state.canvas.addEventListener("click", (event) => {
    const side = hudAvatarSideAt(state.canvas, event.clientX, event.clientY);
    if (side !== -1 && localOwnsSide(side)) {
      event.stopPropagation();
      event.preventDefault();
      cycleFighterForSide(side);
      refocusCanvas();
      return;
    }
    if (!state.world || state.world.matchWinner !== -1) {
      startMatch();
    }
    if (isLandscapeCoarse()) {
      void tryEnterFullscreen(state.page);
    }
    refocusCanvas();
  });

  state.canvas.addEventListener("mousemove", (event) => {
    const side = hudAvatarSideAt(state.canvas, event.clientX, event.clientY);
    state.canvas.style.cursor = (side !== -1 && localOwnsSide(side)) ? "pointer" : "";
  });

  addEventListener("keydown", onKeyDown);
  addEventListener("keyup", onKeyUp);
  addEventListener("blur", onBlur);
  addEventListener("hashchange", onHashChange);

  state.running = true;
  syncPlayClass();
  loop();
  refreshHud();
}

export function unmount() {
  getAudio().stopMusic();
  removeEventListener("keydown", onKeyDown);
  removeEventListener("keyup", onKeyUp);
  removeEventListener("blur", onBlur);
  removeEventListener("hashchange", onHashChange);
  if (state) {
    state.running = false;
    state.arenaShell?.destroy();
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.renderer?.destroy();
    state.renderer = null;
    clearTouchInput();
    if (state.p2p?.stop) {
      try { state.p2p.stop(); } catch {}
    }
    state.p2p = null;
    // SPA navigate-away: drop the per-tab host session id so coming
    // back to /duel later starts clean. A full page refresh skips this
    // unmount entirely, so the stored id survives there (which is the
    // whole point — it's what powers the resume-host flow).
    storeHostSession("");
  }
  document.body.classList.remove("duel-mounted", "duel-match-active");
  state = null;
}

function onHashChange() {
  applyJoinLinkFromLocation();
}

async function attachRenderer(canvas) {
  state.rendererId++;
  const id = state.rendererId;
  let renderer = null;
  try {
    renderer = await createFrameRenderer(canvas);
  } catch (err) {
    console.error("[duel] renderer init failed", err);
    return;
  }
  if (!state || id !== state.rendererId) {
    renderer.destroy();
    return;
  }
  state.renderer?.destroy();
  state.renderer = renderer;
}

function bindControls() {
  document.querySelectorAll('input[name="duel-submode"]').forEach((inp) => {
    inp.addEventListener("change", () => {
      if (!inp.checked) return;
      switchSubMode(inp.value);
    });
  });
  const stageSel = document.getElementById("duel-stage");
  stageSel?.addEventListener("change", () => {
    if (!STAGE_IDS.includes(stageSel.value)) return;
    // In P2P only the host owns stage selection. Reject the change on
    // non-host clients (revert the select to the previous value) so
    // both peers stay aligned without a fight over who picked.
    if (!localOwnsStage()) {
      stageSel.value = state.stageId;
      setP2PStatus("only the host picks the stage");
      return;
    }
    state.stageId = stageSel.value;
    state.world = null;
    state.spectating = false;
    state.spectatorFrame = null;
    state.statusMsg = "";
    clearRemoteInputs();
    syncPlayClass();
    renderCharacterSelect();
    refreshHud();
    refocusCanvas();
    if (state.subMode === "p2p" && state.p2p?.linked && typeof state.p2p.broadcastStage === "function") {
      state.p2p.broadcastStage(state.stageId);
    }
    if (getAudio().isEnabled()) {
      getAudio().setStage(state.stageId);
    }
  });
  const audioToggle = document.getElementById("duel-audio");
  audioToggle?.addEventListener("change", () => {
    getAudio().setEnabled(audioToggle.checked);
    if (audioToggle.checked) {
      getAudio().setStage(state.stageId ?? "datacenter");
    }
  });
  const presetSel = document.getElementById("duel-preset");
  const lethalToggle = document.getElementById('duel-lethal-swing');
  lethalToggle?.addEventListener('change', () => {
    state.lethalSwing = lethalToggle.checked;
    state.executionImpact = null;
    state.executionWorld = null;
    try { localStorage.setItem(EXECUTION_STORAGE_KEY, state.lethalSwing ? 'on' : 'off'); } catch {}
    refocusCanvas();
  });
  presetSel?.addEventListener("change", () => {
    state.presetName = presetSel.value;
    state.world = null;
    state.spectating = false;
    state.spectatorFrame = null;
    state.statusMsg = "";
    clearRemoteInputs();
    syncPlayClass();
    renderCharacterSelect();
    refreshHud();
    refocusCanvas();
  });
  document.getElementById("duel-start")?.addEventListener("click", () => {
    if (!getAudio().isEnabled() && localStorage.getItem("m3t4:audio:on") !== "off") {
      getAudio().setEnabled(true);
      const toggle = document.getElementById("duel-audio");
      if (toggle) toggle.checked = true;
    }
    startMatch();
    refocusCanvas();
  });
  document.getElementById("duel-reset")?.addEventListener("click", () => {
    state.world = null;
    state.spectating = false;
    state.spectatorFrame = null;
    state.statusMsg = "";
    clearRemoteInputs();
    syncPlayClass();
    renderCharacterSelect();
    refreshHud();
    refocusCanvas();
  });
  document.getElementById("duel-touch-setup")?.addEventListener("click", () => {
    state.world = null;
    state.spectating = false;
    state.spectatorFrame = null;
    state.statusMsg = "";
    clearRemoteInputs();
    clearTouchInput();
    syncPlayClass();
    renderCharacterSelect();
    refreshHud();
  });

  bindCharacterSelect();
  bindAliasInputs();
  bindP2PControls();
  bindTouchControls();
}

function bindAliasInputs() {
  const el = document.getElementById("duel-character-select");
  if (!el) return;
  // Event delegation: the alias inputs are re-rendered whenever the
  // character panel refreshes, but #duel-character-select stays put, so
  // a single listener on the parent survives across re-renders. Using
  // 'input' fires per keystroke; we update state + broadcast immediately
  // since the payload is tiny and JSON-serialized over the same channel
  // as cosmetic changes.
  el.addEventListener("input", (event) => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    if (!input || !input.classList.contains("duel-alias-input")) return;
    const side = Number(input.dataset.side);
    if (!Number.isInteger(side) || side < 0 || side > 1) return;
    if (!aliasEditable(side)) return;
    const value = sanitizeAlias(input.value);
    state.aliases[side] = value;
    if (side === ownAliasSide()) storeAlias(value);
    refreshHud();
    if (state.subMode === "p2p" && state.p2p?.linked && typeof state.p2p.broadcastAlias === "function") {
      state.p2p.broadcastAlias(side, value);
    }
  });
  el.addEventListener("blur", (event) => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    if (!input || !input.classList.contains("duel-alias-input")) return;
    const side = Number(input.dataset.side);
    if (!Number.isInteger(side) || side < 0 || side > 1) return;
    // Re-canonicalize on blur (collapses whitespace, trims) so the
    // rendered value matches what gets stored / broadcast.
    const value = sanitizeAlias(input.value);
    if (input.value !== value) input.value = value;
  }, true);
}

function bindTouchControls() {
  const el = document.getElementById("duel-touch-controls");
  if (!el) return;

  const releasePointer = (event) => {
    if (!state) return;
    state.touchPointers.delete(event.pointerId);
    updateTouchInput();
  };

  el.addEventListener("pointerdown", (event) => {
    const button = event.target instanceof Element ? event.target.closest(".duel-touch-control") : null;
    const action = button?.dataset.touchAction;
    if (!action) return;
    event.preventDefault();
    try { button.setPointerCapture?.(event.pointerId); } catch {}
    state.touchPointers.set(event.pointerId, action);
    updateTouchInput();
  });
  el.addEventListener("pointerup", releasePointer);
  el.addEventListener("pointercancel", releasePointer);
  el.addEventListener("lostpointercapture", releasePointer);
  el.addEventListener("contextmenu", (event) => event.preventDefault());
}

function bindCharacterSelect() {
  const el = document.getElementById("duel-character-select");
  el?.addEventListener("click", (event) => {
    const bodyButton = event.target instanceof Element ? event.target.closest(".duel-body-option") : null;
    const weaponButton = event.target instanceof Element ? event.target.closest(".duel-weapon-option") : null;
    const button = bodyButton ?? weaponButton;
    if (!button) return;
    const side = Number(button.dataset.side);
    if (!Number.isInteger(side) || side < 0 || side > 1) return;
    // P2P ownership: only the owner of this side can change its
    // character/weapon. The other side is read-only on this client.
    if (!localOwnsSide(side)) return;

    if (bodyButton) {
      const body = BODY_IDS.includes(bodyButton.dataset.body) ? bodyButton.dataset.body : defaultCosmetics(side).body;
      state.cosmetics[side] = normalizeCosmetics({ body, weapon: availableWeaponIds(body)[0] }, side);
    } else if (weaponButton) {
      const current = normalizeCosmetics(state.cosmetics[side], side);
      const weapons = availableWeaponIds(current.body);
      const weapon = weapons.includes(weaponButton.dataset.weapon) ? weaponButton.dataset.weapon : current.weapon;
      state.cosmetics[side] = normalizeCosmetics({ ...current, weapon }, side);
    }

    state.world = null;
    state.spectating = false;
    state.spectatorFrame = null;
    state.statusMsg = "";
    clearRemoteInputs();
    syncPlayClass();
    renderCharacterSelect();
    refreshHud();
    refocusCanvas();
    // Mirror to peer + spectators so their UI reflects the change.
    if (state.subMode === "p2p" && state.p2p?.linked && typeof state.p2p.broadcastCosmetic === "function") {
      state.p2p.broadcastCosmetic(side, state.cosmetics[side]);
    }
  });
}

function renderCharacterSelect() {
  const el = document.getElementById("duel-character-select");
  if (el) el.innerHTML = characterSelectHtml();
  const summaryEl = document.getElementById("duel-cosmetics-summary-label");
  if (summaryEl && state?.cosmetics) {
    summaryEl.textContent = `${bodyLabel(state.cosmetics[0].body)} vs ${bodyLabel(state.cosmetics[1].body)}`;
  }
  syncStageOwnership();
}

function syncStageOwnership() {
  const sel = document.getElementById("duel-stage");
  if (!sel) return;
  const owned = localOwnsStage();
  sel.disabled = !owned;
  sel.title = owned ? "" : "host picks the stage";
}

function joinCodeFromParts(search, hash) {
  const fromSearch = new URLSearchParams(search || "").get("join");
  if (fromSearch) return fromSearch.trim();

  const rawHash = String(hash || "").replace(/^#/, "").trim();
  if (!rawHash) return "";
  const hashParams = new URLSearchParams(rawHash.startsWith("?") ? rawHash.slice(1) : rawHash);
  const fromHash = hashParams.get("join");
  if (fromHash) return fromHash.trim();
  if (!rawHash.includes("=") && rawHash.length > 8) return rawHash;
  return "";
}

function normalizeJoinCode(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text, window.location.origin);
    const code = joinCodeFromParts(url.search, url.hash);
    if (code) return code;
  } catch {}
  if (text.startsWith("#") || text.startsWith("?")) {
    const code = joinCodeFromParts(text.startsWith("?") ? text : "", text.startsWith("#") ? text : "");
    if (code) return code;
  }
  return text;
}

function joinCodeFromLocation() {
  return normalizeJoinCode(`${window.location.search}${window.location.hash}`);
}

function duelShareUrl(sessionId) {
  const url = new URL("/duel", window.location.origin);
  url.hash = `join=${encodeURIComponent(sessionId)}`;
  return url.toString();
}

function applyJoinLinkFromLocation() {
  if (!state) return;
  const code = joinCodeFromLocation();
  if (!code) return;
  if (state.subMode !== "p2p") switchSubMode("p2p");
  const codeInp = document.getElementById("duel-p2p-code");
  if (codeInp) codeInp.value = code;
  // Skip auto-join if a session is already in progress (the user
  // either pasted a link mid-pair or hashchange fired during a live
  // session). The duplicate-join would tear the channel down.
  if (state.p2p) {
    state.statusMsg = "session active — stop first to join a different link";
    setP2PStatus("session active");
    refreshHud();
    return;
  }
  // If the URL hash is *our own* prior host session id (i.e. the user
  // refreshed the host tab), don't auto-join our own link — re-open it
  // as host instead, reusing the same sessionId via the signaling
  // "reuse" op so the friend's pasted link still works.
  const ownHost = loadStoredHostSession();
  if (ownHost && ownHost === code) {
    state.statusMsg = "resuming host…";
    setP2PStatus("resuming host…");
    refreshHud();
    void beginP2P("host", { reuseSessionId: code });
    return;
  }
  state.statusMsg = "joining…";
  setP2PStatus("joining…");
  refreshHud();
  // Auto-join: ensureSignalAuth in p2p-duel.js handles the sign-in
  // (transparent anonymous if needed). If Anonymous Auth is disabled
  // on the project, beginP2P surfaces a clear "enable Anonymous Auth
  // or sign in first" hint via setP2PStatus.
  void beginP2P("join", { sessionId: code });
}

function bindP2PControls() {
  const hostBtn = document.getElementById("duel-p2p-host");
  const joinBtn = document.getElementById("duel-p2p-join");
  const codeInp = document.getElementById("duel-p2p-code");
  const stopBtn = document.getElementById("duel-p2p-stop");
  const newBtn = document.getElementById("duel-p2p-new");
  const takeoverBtn = document.getElementById("duel-p2p-takeover-btn");
  hostBtn?.addEventListener("click", () => beginP2P("host"));
  joinBtn?.addEventListener("click", () => {
    const code = normalizeJoinCode(codeInp?.value || "");
    if (!code) {
      setP2PStatus("paste a link first");
      return;
    }
    beginP2P("join", { sessionId: code });
  });
  stopBtn?.addEventListener("click", () => stopP2PSession({ reason: "stopped" }));
  newBtn?.addEventListener("click", () => {
    // Tear down current host/join (if any) and start a brand-new host
    // session. The previous invite link becomes orphaned — that's the
    // explicit point of "new host" vs "stop session".
    if (state.p2p?.stop) {
      try { state.p2p.stop(); } catch {}
    }
    state.p2p = null;
    storeHostSession("");
    hideTakeoverPrompt();
    void beginP2P("host");
  });
  takeoverBtn?.addEventListener("click", () => {
    hideTakeoverPrompt();
    // The peer we tried to join is gone. Take over by hosting fresh —
    // creates a new sessionId, updates the URL, drops the old code from
    // the input so the user doesn't accidentally re-join their own
    // dead-end link. We do NOT clear the stored host id here: the new
    // host's "code:" status will overwrite it once the session is
    // created. Clearing early would leave a refresh-during-take-over
    // window with no resume target.
    if (codeInp) codeInp.value = "";
    void beginP2P("host");
  });
}

function showTakeoverPrompt(message) {
  const el = document.getElementById("duel-p2p-takeover");
  if (!el) return;
  const msg = el.querySelector(".tight");
  if (msg && message) msg.textContent = message;
  el.hidden = false;
}

function hideTakeoverPrompt() {
  const el = document.getElementById("duel-p2p-takeover");
  if (!el) return;
  el.hidden = true;
}

function syncP2PSessionControls() {
  const stopBtn = document.getElementById("duel-p2p-stop");
  const hostBtn = document.getElementById("duel-p2p-host");
  const joinBtn = document.getElementById("duel-p2p-join");
  const codeInp = document.getElementById("duel-p2p-code");
  const panel = document.getElementById("duel-p2p-panel");
  const hasSession = !!state?.p2p;
  // Stop is only meaningful while we hold a live (or in-flight) session.
  // Host + join must lock once we hold one — clicking either while
  // already paired would orphan the live channel mid-session. The
  // "new host" / "stop" buttons are the explicit way out.
  if (stopBtn) stopBtn.disabled = !hasSession;
  if (hostBtn) hostBtn.disabled = hasSession;
  if (joinBtn) joinBtn.disabled = hasSession;
  if (codeInp) codeInp.disabled = hasSession;
  if (panel) panel.classList.toggle("is-active", hasSession);
}

function stopP2PSession({ reason = "" } = {}) {
  if (!state) return;
  if (state.p2p?.stop) {
    try { state.p2p.stop(); } catch {}
  }
  state.p2p = null;
  state.spectating = false;
  state.spectatorFrame = null;
  state.lastSpectatorFrameTick = -1;
  state.peerLatencyMs = null;
  state.peerLatencyAt = 0;
  state.streamAgeMs = null;
  state.streamAgeAt = 0;
  state.world = null;
  state.brainP2 = null;
  clearRemoteInputs();
  storeHostSession("");
  clearP2PShare();
  hideTakeoverPrompt();
  // Drop any join/host code from the address bar so a future refresh
  // doesn't auto-rejoin the now-dead session.
  if (typeof window !== "undefined" && window.history?.replaceState) {
    try {
      const url = new URL(window.location.href);
      url.hash = "";
      url.searchParams.delete("join");
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {}
  }
  const codeInp = document.getElementById("duel-p2p-code");
  if (codeInp) codeInp.value = "";
  setP2PStatus(reason || "ready: host or paste invite link");
  syncP2PSessionControls();
  syncPlayClass();
  refreshKeysHint();
  renderCharacterSelect();
  refreshHud();
}

async function beginP2P(role, opts) {
  if (!isP2PSupported()) {
    setP2PStatus("P2P unavailable in this build");
    return;
  }
  const sessionId = typeof opts === "string" ? opts : (opts?.sessionId ?? "");
  const reuseSessionId = (opts && typeof opts === "object" ? opts.reuseSessionId : "") || "";
  // Force the sub-mode to p2p so labels, character panel, control
  // hints, and the actionFor branch all switch off vs-AI / hot-seat
  // copy. Without this, an in-flight vs-AI render state can persist
  // through a paired channel because every UI gating selector reads
  // state.subMode, not state.p2p.
  if (state.subMode !== "p2p") switchSubMode("p2p");
  if (state.p2p?.stop) {
    try { state.p2p.stop(); } catch {}
  }
  state.p2p = null;
  state.spectating = false;
  state.spectatorFrame = null;
  state.lastSpectatorFrameTick = -1;
  state.peerLatencyMs = null;
  state.peerLatencyAt = 0;
  state.streamAgeMs = null;
  state.streamAgeAt = 0;
  state.world = null;
  state.brainP2 = null;
  clearRemoteInputs();
  state.hostSide = role === "host" ? 0 : 1;
  placeStoredAliasOnOwnedSide();
  clearP2PShare();
  hideTakeoverPrompt();
  refreshKeysHint();
  renderCharacterSelect();
  syncP2PSessionControls();
  setP2PStatus(role === "host"
    ? (reuseSessionId ? "resuming session…" : "creating session…")
    : "connecting…");
  try {
    const ownerState = state;
    const { startP2PDuel } = await import("../lib/p2p-duel.js");
    if (state !== ownerState || !state?.running || state.subMode !== "p2p") return;
    const handle = await startP2PDuel({
      role,
      sessionId,
      reuseSessionId,
      onStatus: (msg) => handleP2PStatus(msg),
      onLink: (link = {}) => {
        if (link.spectator) {
          state.spectating = true;
          state.hostSide = 0;
          setP2PStatus("spectating");
          state.statusMsg = "spectating";
          refreshKeysHint();
          syncPlayClass();
          refreshHud(state.spectatorFrame ?? emptyFrame());
          return;
        }
        setP2PStatus(role === "host" ? "P2 joined" : "joined host");
        state.statusMsg = role === "host" ? "P2 joined · press fight" : "joined host · waiting for fight";
        // Defensive UI refresh: keysHtml + character panel are only
        // re-rendered via explicit calls (the render loop reads labels
        // every frame, but the surrounding control DOM doesn't). After
        // pairing we want both sides to visibly drop any vs-AI / hot-
        // seat copy.
        refreshKeysHint();
        renderCharacterSelect();
        syncLocalP2PSetupToPeer({ includeStage: role === "host" });
        refreshHud();
      },
      onMatch: ({ seed, stageId, cosmetics, aliases, weaponMotionVersion }) => {
        if (role === "host") return;
        // Guest mirrors host's match parameters so both worlds start
        // from the same seed *and* the same stage.
        clearRemoteInputs();
        state.matchWeaponMotionVersion=weaponMotionVersion===2?2:weaponMotionVersion===1?1:0;
        if (stageId && STAGE_IDS.includes(stageId)) {
          state.stageId = stageId;
          const stageSel = document.getElementById("duel-stage");
          if (stageSel) stageSel.value = stageId;
        }
        state.cosmetics = normalizeCosmeticsPair(cosmetics);
        // Keep our own owned-side alias; mirror whatever the host sent
        // for the other side. Empty-host-alias is a valid value (means
        // "no alias set, fall back to placeholder") and must be applied
        // verbatim — guarding the assignment behind `if (next || …)`
        // would silently keep stale aliases from a prior match.
        if (Array.isArray(aliases)) {
          const owned = ownAliasSide();
          for (const side of [0, 1]) {
            if (side === owned) continue;
            state.aliases[side] = sanitizeAlias(aliases[side] ?? "");
          }
        }
        renderCharacterSelect();
        if (state.spectating || state.p2p?.spectator) {
          state.seed = seed;
          state.world = null;
          state.statusMsg = "spectating";
          syncPlayClass();
          refreshHud(state.spectatorFrame ?? emptyFrame());
          return;
        }
        const stage = SIM_STAGES[state.stageId] ?? SIM_STAGES.datacenter;
        state.seed = seed;
        state.world = createStepperWorld({ stage, seed, chars: selectedCharacters() });
        state.brainP2 = null;
        state.playedAtMs = performance.now();
        state.accumMs = 0;
        state.statusMsg = "fight";
        syncPlayClass();
        renderCharacterSelect();
        refreshHud();
      },
      onRemoteInput: (tick, input) => {
        bufferRemoteInput(tick, input);
      },
      onLatency: (ms) => {
        state.peerLatencyMs = ms;
        state.peerLatencyAt = Date.now();
        refreshHud();
      },
      onStreamAge: (ms) => {
        state.streamAgeMs = ms;
        state.streamAgeAt = Date.now();
        refreshHud(state.spectatorFrame ?? emptyFrame());
      },
      onCosmetic: (side, cosmetic) => {
        // Remote owner of `side` updated their character/weapon. Apply
        // locally without re-broadcasting (which would loop). The
        // non-owned side is read-only on this client by design, so the
        // user can't accidentally fight the remote selection.
        if (side !== 0 && side !== 1) return;
        if (state.subMode !== "p2p") return;
        if (localOwnsSide(side)) return;
        state.cosmetics[side] = normalizeCosmetics(cosmetic, side);
        renderCharacterSelect();
        refreshHud();
      },
      onAlias: (side, alias) => {
        // Remote owner of `side` set their alias. Mirror it locally so
        // their nameplate reads "Bob" instead of "host"/"P2", and so
        // that this client re-broadcasts it correctly to spectators on
        // the next match start.
        if (side !== 0 && side !== 1) return;
        if (state.subMode !== "p2p") return;
        if (localOwnsSide(side)) return;
        state.aliases[side] = sanitizeAlias(alias);
        renderCharacterSelect();
        refreshHud();
      },
      onStage: (stageId) => {
        // Host changed the stage; non-host clients (joiner + late
        // spectators) mirror it. Host-side ignores its own echo.
        if (state.subMode !== "p2p") return;
        if (localOwnsStage()) return;
        if (!STAGE_IDS.includes(stageId)) return;
        if (state.world && state.world.matchWinner === -1) return;
        state.stageId = stageId;
        const stageSelEl = document.getElementById("duel-stage");
        if (stageSelEl) stageSelEl.value = stageId;
        refreshHud();
      },
      onFrame: (frame) => {
        state.spectating = true;
        state.spectatorFrame = frame;
        state.statusMsg = "spectating";
        syncPlayClass();
        refreshHud(frame);
      },
      onSpectatorLink: () => {
        if (!state.world || !state.p2p?.linked) return;
        state.p2p.broadcastMatch?.({
          seed: state.seed,
          stageId: state.stageId,
          cosmetics: selectedCosmetics(),
          aliases: [...state.aliases],
        });
        state.p2p.postSpectatorFrame?.(worldToFrame(state.world));
      },
      onClose: () => setP2PStatus("disconnected"),
    });
    state.p2p = handle;
    if (role === "host" && handle.sessionId) {
      // Persist the host id so a refresh of this tab can re-pair the
      // same invite link via the signaling "reuse" op instead of the
      // page treating its own URL hash as a foreign join code.
      storeHostSession(handle.sessionId);
    }
    if (handle.spectator) {
      state.spectating = true;
      state.hostSide = 0;
      state.statusMsg = "spectating";
      setP2PStatus("spectating");
    } else if (handle.linked) {
      syncLocalP2PSetupToPeer({ includeStage: role === "host" });
    }
    syncP2PSessionControls();
    refreshKeysHint();
    renderCharacterSelect();
    syncPlayClass();
    refreshHud(state.spectatorFrame ?? undefined);
  } catch (e) {
    const message = String(e?.message ?? e);
    const code = String(e?.code ?? "");
    state.p2p = null;
    if (code === "host-gone") {
      // Joiner hit a session whose host is no longer reachable. Offer
      // an explicit take-over rather than leaving them to figure out
      // why "join" timed out.
      setP2PStatus(message);
      showTakeoverPrompt(role === "host"
        ? "session is gone — start a fresh host?"
        : "host has left — take over and host this match?");
    } else if (/sign in (first|required)/i.test(message)) {
      setP2PStatus(message);
    } else if (code === "pair-timeout") {
      setP2PStatus("pairing timed out — try again or take over");
      showTakeoverPrompt("nobody joined in time — start a fresh host?");
    } else {
      setP2PStatus(`P2P error: ${message}`);
    }
    syncP2PSessionControls();
  }
}

function setP2PStatus(text) {
  const el = document.getElementById("duel-p2p-status");
  if (el) el.textContent = text;
}

function handleP2PStatus(text) {
  const match = /^code:\s*(.+)$/i.exec(String(text || ""));
  if (match) {
    const sessionId = match[1].trim();
    // Save as soon as the session id is known so a refresh that happens
    // before the data channel ever opens still has the id available for
    // the reuse path. (We also save again in beginP2P after the handle
    // resolves; the redundancy is intentional.)
    storeHostSession(sessionId);
    updateBrowserInviteUrl(sessionId);
    renderP2PShare(sessionId);
    setP2PStatus("magic link ready");
    syncP2PSessionControls();
    return;
  }
  setP2PStatus(text);
}

function updateBrowserInviteUrl(sessionId) {
  if (!sessionId || !window.history?.replaceState) return;
  const url = duelShareUrl(sessionId);
  window.history.replaceState(window.history.state, "", url);
}

function renderP2PShare(sessionId) {
  const el = document.getElementById("duel-p2p-share");
  if (!el || !sessionId) return;
  const url = duelShareUrl(sessionId);
  el.hidden = false;
  el.innerHTML = `
    <label class="duel-p2p-link-label">invite link
      <input type="text" id="duel-p2p-link" readonly value="${escapeHtml(url)}" />
    </label>
    ${buttonHtml({ id: "duel-p2p-copy-link", text: "copy link", attrs: { title: "Copy the invite link" } })}`;
  document.getElementById("duel-p2p-copy-link")?.addEventListener("click", () => {
    void copyP2PLink(url);
  });
}

function clearP2PShare() {
  const el = document.getElementById("duel-p2p-share");
  if (!el) return;
  el.hidden = true;
  el.innerHTML = "";
}

async function copyP2PLink(url) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      setP2PStatus("link copied");
      return;
    }
  } catch {}
  const input = document.getElementById("duel-p2p-link");
  if (input?.select) {
    input.select();
    try {
      document.execCommand("copy");
      setP2PStatus("link copied");
      return;
    } catch {}
  }
  setP2PStatus("copy failed — select the link");
}

function switchSubMode(value) {
  if (!SUB_MODES.includes(value)) return;
  state.subMode = value;
  const lethalToggle = document.getElementById('duel-lethal-swing');
  if (lethalToggle) {
    lethalToggle.disabled = value === 'p2p';
    lethalToggle.checked = value !== 'p2p' && state.lethalSwing;
  }
  document.querySelectorAll(".duel-mode-row .mode-pill").forEach((p) => {
    p.classList.toggle("is-active", p.dataset.submode === value);
  });
  document.querySelectorAll('input[name="duel-submode"]').forEach((inp) => {
    inp.checked = inp.value === value;
  });
  document.getElementById("duel-preset-row").hidden = value !== "vs-ai";
  document.getElementById("duel-p2p-row").hidden = value !== "p2p";
  if (value !== "p2p") clearP2PShare();
  refreshKeysHint();
  state.world = null;
  state.spectating = false;
  state.spectatorFrame = null;
  state.lastSpectatorFrameTick = -1;
  state.statusMsg = "";
  clearRemoteInputs();
  clearTouchInput();
  // Drop any aliases that came from a peer (or hot-seat side 2) so the
  // new mode starts from a clean slate; the persisted local alias is
  // reapplied to whichever side the user now owns.
  state.aliases = ["", ""];
  placeStoredAliasOnOwnedSide();
  syncPlayClass();
  renderCharacterSelect();
  // Tear down any running p2p session if leaving p2p mode.
  if (value !== "p2p") {
    if (state.p2p?.stop) {
      try { state.p2p.stop(); } catch {}
    }
    state.p2p = null;
    storeHostSession("");
    hideTakeoverPrompt();
    setP2PStatus("ready: host or paste invite link");
  }
  syncP2PSessionControls();
  refreshHud();
  refocusCanvas();
}

function refreshKeysHint() {
  const el = document.getElementById("duel-keys");
  if (el) el.innerHTML = keysHtml();
}

function syncPlayClass() {
  const playing = !!state?.world || !!state?.spectating;
  state?.page?.classList.toggle("is-playing", playing);
  document.body.classList.toggle("duel-match-active", playing);
}

function refocusCanvas() {
  state?.keyset.clear();
  if (state?.arenaShell?.dialog.open) return;
  state?.canvas?.focus();
}
