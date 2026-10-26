import { getAudio } from "./audio.js";

// Translate rendered combat frames into the same cues in Watch, Tune and Play.
const WEAPON_CLASS = {
  worldcoin_orb_flail: "flail", backpack_maul: "maul", gpu_server_blade: "blade", heat_sink_greatsword: "greatsword",
  rolled_constitution_bat: "bat", alignment_baton: "club", red_team_pike: "pike", guardrail_greatsword: "greatsword",
  nobel_medal_flail: "flail", folded_chess_axe: "axe", go_board_maul: "maul", alphafold_blade: "blade",
  sunscreen_bottle_club: "club", controller_nunchucks: "nunchucks", shareholder_sauce_club: "club", quest_flail: "flail",
  compute_bat: "bat", heatsink_hammer: "maul", silicon_cleaver: "blade", rack_greatsword: "greatsword",
  coil_bat: "bat", orbit_lance: "pike", satellite_axe: "axe", angular_greatsword: "greatsword",
};

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

export function createArenaAudioTracker({ getCosmetics = () => [], audioSource = getAudio, clock = () => performance.now() } = {}) {
  let previous = null;
  let lastGruntMs = [-Infinity, -Infinity];
  let lastFootstepMs = [-Infinity, -Infinity];
  let footstepStep = [0, 0];

  function fireGrunt(audio, side, char, kind) {
    if (!char) return;
    const now = clock();
    if (kind !== "ko" && now - lastGruntMs[side] < 400) return;
    lastGruntMs[side] = now;
    const cue = `grunt_${char}_${kind}`;
    if (!audio.play(cue)) {
      audio.play(side === 0 ? `grunt_sama_${kind}` : `grunt_darrius_${kind}`);
    }
  }

  function update(frame) {
    const audio = audioSource();
    if (!audio.isEnabled() || !audio.ready) { previous = frame; return; }
    if (!previous) { previous = frame; return; }

    const cosmetics = getCosmetics();
    const chars = [frame.p0?.body ?? cosmetics[0]?.body ?? "sama", frame.p1?.body ?? cosmetics[1]?.body ?? "darrius"];
    const weapons = [frame.p0?.weapon ?? cosmetics[0]?.weapon ?? "gpu_server_blade", frame.p1?.weapon ?? cosmetics[1]?.weapon ?? "alignment_baton"];
    const now = clock();

    for (let i = 0; i < 2; i++) {
      const key = i === 0 ? "p0" : "p1";
      const prev = previous[key];
      const curr = frame[key];
      if (!prev || !curr) continue;

      // 1. Weapon swings: initial swing or mid-swing cancellation / restart
      const startedSwipe = ((prev.swipeT ?? 0) <= 0 && (curr.swipeT ?? 0) > 0) ||
        ((curr.swipeT ?? 0) > (prev.swipeT ?? 0) + 0.04);
      if (startedSwipe) {
        const weapon = weapons[i];
        const cls = WEAPON_CLASS[weapon] ?? "blade";
        audio.play(`swipe_${cls}`);
        fireGrunt(audio, i, chars[i], "effort");
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
      const moved = Math.abs((curr.x ?? 0) - (prev.x ?? 0)) > 0.1;
      const isRunning = moved && curr.onGround && (curr.stun ?? 0) <= 0 && Math.abs(curr.vx ?? 0) > 60 && (curr.swipeT ?? 0) <= 0 && (curr.diveT ?? 0) <= 0 && !curr.dead;
      if (isRunning && now - lastFootstepMs[i] > 180) {
        lastFootstepMs[i] = now;
        const stepCue = (footstepStep[i]++ % 2 === 0) ? "footstep_a" : "footstep_b";
        audio.play(stepCue, { volume: 0.5 });
      }

      // 6. Stun / Non-lethal weapon hit
      if ((prev.stun ?? 0) <= 0 && (curr.stun ?? 0) > 0 && !curr.dead) {
        const attacker = 1 - i;
        playHitSound(audio, chars[attacker], weapons[attacker]);
        fireGrunt(audio, i, chars[i], "hurt");
      }

      // 7. Death from weapon hit
      if (!prev.dead && curr.dead) {
        const attacker = 1 - i;
        playHitSound(audio, chars[attacker], weapons[attacker]);
        audio.play("ko_flatline");
        fireGrunt(audio, i, chars[i], "ko");
      }
    }

    // 8. Weapon clash
    const clashTick0 = frame.p0?.lastClashTick ?? -9999;
    const prevClash0 = previous.p0?.lastClashTick ?? -9999;
    const clashTick1 = frame.p1?.lastClashTick ?? -9999;
    const prevClash1 = previous.p1?.lastClashTick ?? -9999;
    if (clashTick0 > prevClash0 || clashTick1 > prevClash1) {
      audio.play("hit_sama_gpu_server_blade", { impact: true, playbackRate: 1.5 });
    }

    if (previous.token && frame.token) {
      if (!previous.token.exists && frame.token.exists) {
        audio.play("proof_spawn");
      }
      if (previous.token.carrier === -1 && frame.token.carrier !== -1) {
        audio.play("proof_acquired");
      }
    }
    if (previous.scoreboard && frame.scoreboard) {
      if (frame.scoreboard[0] > previous.scoreboard[0] || frame.scoreboard[1] > previous.scoreboard[1]) {
        audio.play("proof_delivered");
      }
    }
    if (previous.rounds && frame.rounds) {
      if (frame.rounds[0] > previous.rounds[0] || frame.rounds[1] > previous.rounds[1]) {
        audio.play("round_taken");
      }
    }

    previous = frame;
  }

  return { update, reset() {
    previous = null;
    lastGruntMs = [-Infinity, -Infinity];
    lastFootstepMs = [-Infinity, -Infinity];
    footstepStep = [0, 0];
  } };
}
