// Single source of truth for per-workload lifecycle and scheduling policy.
//
// Keep this module the only place where a workload's release state,
// schedulability, or public visibility is authoritatively decided. Three
// surfaces enforce it:
//
//   1. Admin seed endpoints (routes.ts /compute/admin/tasks/*) — refuse to
//      create tasks for workloads that are not seedable.
//   2. Scheduler assignment path (store.ts assignNext / schedulerEligible) —
//      refuse to offer tasks whose workload is not assignable.
//   3. Public-facing surfaces (/compute/use-cases, /compute/public/summary,
//      and the client UI) — hide or group workloads whose policy says they
//      are not public.
//
// use-cases.ts supplies marketing copy (title, notes, boundary, validation).
// This module owns the runtime contract: what is allowed right now.

import { ASSET_TILE_AUDIT_KERNEL_ID } from "./kernels/asset-tile-audit.js";
import { CONTACT_MAP_TILE_KERNEL_ID } from "./kernels/contact-map-tile.js";
import {
  DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID,
  DEVICE_WITNESS_RENDER_KERNEL_ID,
  DEVICE_WITNESS_WEBGPU_KERNEL_ID,
  DEVICE_WITNESS_WEBRTC_KERNEL_ID,
} from "./kernels/device-witness.js";
import { EXPLOIT_SEARCH_KERNEL_ID } from "./kernels/exploit-search.js";
import { GENOME_KMER_KERNEL_ID } from "./kernels/genome-kmer.js";
import { IMAGE_TILE_INFER_KERNEL_ID } from "./kernels/image-tile-infer.js";
import { MICROSCOPY_TILE_SCORE_KERNEL_ID } from "./kernels/microscopy-tile-score.js";
import { PRIME_SEARCH_KERNEL_ID } from "./kernels/prime-search.js";
import { PUBLIC_ARTIFACT_VERIFY_KERNEL_ID } from "./kernels/public-artifact-verify.js";
import { REPLAY_VERIFY_KERNEL_ID } from "./kernels/replay-verify.js";
import { SEED_SWEEP_KERNEL_ID } from "./kernels/seed-sweep.js";
import { TENSOR_TILE_KERNEL_ID } from "./kernels/tensor-tile.js";

export type ReleaseState =
  | "coded"          // kernel exists; not seedable; never public.
  | "admin-preview"  // admin can seed; not shown on public UI.
  | "experimental"   // publicly visible; admin/cron may seed in bounded windows.
  | "released"       // normal seedable lane with public visibility.
  | "retired";       // kept only for receipt verification; never seedable.

export type ScheduleMode =
  | "disabled"        // cannot be seeded or assigned.
  | "manual"          // admin seed only; no cron.
  | "bounded-window"  // cron/seed allowed only while intake window is open.
  | "cron-seeded"     // cron may create tasks; intake still gated globally.
  | "always-on";      // reserved; avoid for public/science lanes.

export type RequiredTier =
  | "observe-only"
  | "cpu-light"
  | "webgpu-light"
  | "witness"
  | "webrtc";

export interface WorkloadPolicy {
  workload: string;
  release: ReleaseState;
  scheduleMode: ScheduleMode;
  requiredTier: RequiredTier;
  publicVisible: boolean;
  defaultEnabled: boolean;
}

const POLICIES: WorkloadPolicy[] = [
  // m3t4 core verification lanes — released, normal cron/admin seeding.
  { workload: REPLAY_VERIFY_KERNEL_ID,           release: "released",     scheduleMode: "cron-seeded",   requiredTier: "cpu-light",     publicVisible: true,  defaultEnabled: true  },
  { workload: PUBLIC_ARTIFACT_VERIFY_KERNEL_ID,  release: "released",     scheduleMode: "cron-seeded",   requiredTier: "cpu-light",     publicVisible: true,  defaultEnabled: true  },
  // Seed sweeps: admin-only; not shown in the public workloads list.
  // Kept reachable via the store + scheduler so receipt-verification tests,
  // WebRTC proof fixtures, and manual admin seeding still work end to end.
  { workload: SEED_SWEEP_KERNEL_ID,              release: "admin-preview", scheduleMode: "manual",       requiredTier: "cpu-light",     publicVisible: false, defaultEnabled: false },
  { workload: EXPLOIT_SEARCH_KERNEL_ID,          release: "released",     scheduleMode: "manual",        requiredTier: "cpu-light",     publicVisible: true,  defaultEnabled: true  },
  { workload: ASSET_TILE_AUDIT_KERNEL_ID,        release: "released",     scheduleMode: "manual",        requiredTier: "cpu-light",     publicVisible: true,  defaultEnabled: true  },

  // Science lanes.
  { workload: GENOME_KMER_KERNEL_ID,             release: "released",     scheduleMode: "bounded-window", requiredTier: "cpu-light",     publicVisible: true,  defaultEnabled: true  },
  { workload: MICROSCOPY_TILE_SCORE_KERNEL_ID,   release: "released",     scheduleMode: "bounded-window", requiredTier: "cpu-light",     publicVisible: true,  defaultEnabled: true  },
  // Contact map stays experimental until we have production receipts + previews.
  { workload: CONTACT_MAP_TILE_KERNEL_ID,        release: "experimental", scheduleMode: "bounded-window", requiredTier: "webgpu-light",  publicVisible: true,  defaultEnabled: true  },

  // ML.
  { workload: IMAGE_TILE_INFER_KERNEL_ID,        release: "released",     scheduleMode: "bounded-window", requiredTier: "cpu-light",     publicVisible: true,  defaultEnabled: true  },

  // Plasma / infra.
  { workload: TENSOR_TILE_KERNEL_ID,             release: "released",     scheduleMode: "manual",        requiredTier: "webgpu-light",  publicVisible: true,  defaultEnabled: true  },
  { workload: PRIME_SEARCH_KERNEL_ID,            release: "admin-preview", scheduleMode: "manual",       requiredTier: "cpu-light",     publicVisible: false, defaultEnabled: false },

  // Device witness — infrastructure workloads. Public-visible for
  // transparency but grouped separately in the UI (witness tier) so they
  // don't clutter the main science/compute lanes.
  { workload: DEVICE_WITNESS_WEBGPU_KERNEL_ID,         release: "released", scheduleMode: "manual", requiredTier: "witness",   publicVisible: true, defaultEnabled: true },
  { workload: DEVICE_WITNESS_WEBRTC_KERNEL_ID,         release: "released", scheduleMode: "manual", requiredTier: "witness",   publicVisible: true, defaultEnabled: true },
  { workload: DEVICE_WITNESS_RENDER_KERNEL_ID,         release: "released", scheduleMode: "manual", requiredTier: "witness",   publicVisible: true, defaultEnabled: true },
  { workload: DEVICE_WITNESS_DERIVED_BUFFER_KERNEL_ID, release: "released", scheduleMode: "manual", requiredTier: "witness",   publicVisible: true, defaultEnabled: true },
];

const POLICY_BY_WORKLOAD = new Map<string, WorkloadPolicy>(POLICIES.map((p) => [p.workload, p]));

export function getWorkloadPolicy(workload: string): WorkloadPolicy | null {
  return POLICY_BY_WORKLOAD.get(workload) ?? null;
}

export function listWorkloadPolicies(): WorkloadPolicy[] {
  return POLICIES.slice();
}

// An admin seed endpoint should succeed only when the workload's policy makes
// task creation legal. Retired/coded/disabled lanes are rejected unconditionally;
// manual/bounded-window/cron-seeded lanes may all be seeded by admin — the
// scheduler enforces whether assignment is currently allowed.
export function canSeed(workload: string): { ok: boolean; reason?: string } {
  const policy = getWorkloadPolicy(workload);
  if (!policy) return { ok: false, reason: `no policy for workload ${workload}` };
  if (policy.release === "coded") return { ok: false, reason: "workload is not yet admin-seedable" };
  if (policy.release === "retired") return { ok: false, reason: "workload is retired" };
  if (policy.scheduleMode === "disabled") return { ok: false, reason: "workload scheduleMode is disabled" };
  return { ok: true };
}

// Scheduler check. `intakeOpen` is the global acceptAssignments flag and
// serves as the current bounded window for the `bounded-window` mode.
export function canAssign(
  workload: string,
  context: { intakeOpen: boolean },
): { ok: boolean; reason?: string } {
  const policy = getWorkloadPolicy(workload);
  if (!policy) return { ok: false, reason: `no policy for workload ${workload}` };
  if (policy.release === "coded") return { ok: false, reason: "workload not yet assignable" };
  if (policy.release === "retired") return { ok: false, reason: "workload retired" };
  if (policy.scheduleMode === "disabled") return { ok: false, reason: "workload disabled" };
  if (policy.scheduleMode === "bounded-window" && !context.intakeOpen) {
    return { ok: false, reason: "bounded intake window closed" };
  }
  return { ok: true };
}

export function isPublicVisible(workload: string): boolean {
  return getWorkloadPolicy(workload)?.publicVisible === true;
}
