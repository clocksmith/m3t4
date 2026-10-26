import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(__dirname, "..");
const themeDoc = JSON.parse(fs.readFileSync(path.resolve(clientRoot, "../audio/audio-theme.v1.json"), "utf8"));

test("sprite.webm and sprite.manifest.json exist and are well-formed", () => {
  const spritePath = path.resolve(clientRoot, "assets/audio/sfx/sprite.webm");
  const manifestPath = path.resolve(clientRoot, "assets/audio/sfx/sprite.manifest.json");

  assert.ok(fs.existsSync(spritePath), "sprite.webm must exist");
  assert.ok(fs.statSync(spritePath).size > 1000, "sprite.webm must be non-empty");

  assert.ok(fs.existsSync(manifestPath), "sprite.manifest.json must exist");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  // Check expected cues
  assert.ok(manifest.jump_boing, "manifest must contain jump_boing cue");
  assert.ok(manifest.swipe_blade, "manifest must contain swipe_blade cue");
  assert.ok(manifest.dive_lunge, "manifest must contain dive_lunge cue");
  assert.ok(manifest.match_start, "manifest must contain match_start cue");
  assert.ok(manifest.match_end_win, "manifest must contain match_end_win cue");
  assert.ok(manifest.win_applause, "manifest must contain win_applause cue");

  // Every cue listed in spritePack.order in audio-theme.v1.json must be in manifest
  for (const cueId of themeDoc.spritePack.order) {
    assert.ok(manifest[cueId], `manifest must contain ordered cue ${cueId}`);
    const [startMs, endMs] = manifest[cueId];
    assert.ok(typeof startMs === "number" && typeof endMs === "number", `cue ${cueId} must have numeric offsets`);
    assert.ok(endMs > startMs, `cue ${cueId} must have positive duration (${startMs} -> ${endMs})`);
  }
});

test("per-stage music and impact IR assets exist for all stages", () => {
  const stages = ["datacenter/cold_aisle_chapel", "boardroom/fiduciary_basement", "demoday/demo_day_afterparty"];

  for (const s of stages) {
    const musicPath = path.resolve(clientRoot, `assets/audio/stages/${s}/music.webm`);
    const irPath = path.resolve(clientRoot, `assets/audio/stages/${s}/impact_ir.webm`);

    assert.ok(fs.existsSync(musicPath), `music.webm must exist for stage ${s}`);
    assert.ok(fs.statSync(musicPath).size > 5000, `music.webm must be non-empty for stage ${s}`);

    assert.ok(fs.existsSync(irPath), `impact_ir.webm must exist for stage ${s}`);
    assert.ok(fs.statSync(irPath).size > 500, `impact_ir.webm must be non-empty for stage ${s}`);
  }
});
