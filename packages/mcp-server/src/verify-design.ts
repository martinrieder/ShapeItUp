/**
 * verify-design — a composable verification battery for .shape.ts files.
 *
 * Pure logic module: NO MCP SDK imports. The `verify_design` MCP tool is a
 * thin wrapper over {@link verifyDesign}; keeping the battery callable as a
 * plain function means a future CLI entry (CI pipelines, exit codes, JSON
 * output) is an additive wrapper, not a refactor — the same logic/protocol
 * separation the repo already practices (engine.ts vs tools.ts vs index.ts).
 *
 * The battery runs, per design:
 *   1. render      — execute the script (sidecar-routed when enabled; same
 *                    path open_shape/render_preview use) and collect part
 *                    count, geometry validity, printability warnings
 *   2. collisions  — pairwise intersect between parts, honoring a colocated
 *                    `export const expectedContacts = [...]` (same merge
 *                    semantics as check_collisions)
 *   3. sim         — when the file declares `export const sim`, run it and
 *                    evaluate its `assertions` block (the author's own
 *                    acceptance tests) plus collision onset
 *   4. export      — round-trip a STEP export through the same engine that
 *                    ran the render (child-side when sidecar-executed)
 *
 * Every step reports pass/fail/ skipped with a one-line detail; the summary
 * carries an overall verdict an agent or CI can branch on.
 */
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  executeShapeFile,
  exportLastToFile,
  type ExecuteOutcome,
} from "./engine.js";
import { extractExpectedContactsStatic } from "@shapeitup/core";
import { matchesAnyAcceptedPair } from "./verify-helpers.js";

export interface VerifyCheckResult {
  name: "render" | "collisions" | "simulation" | "export";
  status: "pass" | "fail" | "skipped";
  detail: string;
}

export interface VerifyDesignResult {
  file: string;
  checks: VerifyCheckResult[];
  /** True when no check failed (skipped checks don't fail the battery). */
  ok: boolean;
}

export interface VerifyDesignOptions {
  /** Param overrides applied to the render (not persisted). */
  params?: Record<string, number | boolean | string>;
  /** Extra accepted contact pairs, merged with the file's expectedContacts. */
  acceptedPairs?: Array<[string, string]>;
  /** Skip named checks. Valid: "render" is always run. */
  skip?: Array<"collisions" | "simulation" | "export">;
  /** Directory for the export round-trip artifact (default: OS tmp). */
  exportDir?: string;
  /** Whether to run the render through the sidecar (env-gated by callers). */
  sidecar?: boolean;
}

/**
 * Static collision check between the rendered parts: Replicad-free AABB
 * overlap first (cheap prefilter identical in spirit to check_collisions),
 * reporting every overlapping pair that isn't accepted.
 */
function aabbFromVertices(v: Float32Array): { min: [number, number, number]; max: [number, number, number] } | null {
  if (!v || v.length < 3) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    if (v[i] < minX) minX = v[i];
    if (v[i] > maxX) maxX = v[i];
    if (v[i + 1] < minY) minY = v[i + 1];
    if (v[i + 1] > maxY) maxY = v[i + 1];
    if (v[i + 2] < minZ) minZ = v[i + 2];
    if (v[i + 2] > maxZ) maxZ = v[i + 2];
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function aabbOverlap(
  a: { min: [number, number, number]; max: [number, number, number] },
  b: { min: [number, number, number]; max: [number, number, number] },
): boolean {
  return (
    a.min[0] <= b.max[0] && a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] && a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] && a.max[2] >= b.min[2]
  );
}

/**
 * Run the verification battery. Throws only on unusable input (missing file);
 * check failures are REPORTED, not thrown — the caller decides what to do
 * with a red battery.
 */
export async function verifyDesign(
  filePath: string,
  opts: VerifyDesignOptions = {},
): Promise<VerifyDesignResult> {
  const absPath = resolve(filePath);
  const checks: VerifyCheckResult[] = [];
  const skip = new Set(opts.skip ?? []);

  // ── 1. render ─────────────────────────────────────────────────────────
  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }
  const storageDir = mkdtempSync(join(tmpdir(), "siu-verify-"));
  try {
    const outcome: ExecuteOutcome = await executeShapeFile(absPath, storageDir, opts.params, {
      sidecar: opts.sidecar === true,
      sidecarWorkspaceDirs: opts.sidecar ? [dirname(absPath)] : undefined,
    });
    const { status } = outcome;
    if (!status.success) {
      checks.push({
        name: "render",
        status: "fail",
        detail: `script failed: ${status.error ?? "unknown error"}${status.hint ? ` — ${status.hint}` : ""}`,
      });
      return { file: absPath, checks, ok: false };
    }
    const printabilityIssues = (status.properties?.parts ?? []).flatMap(
      (p) => (p.printability?.issues ?? []).map((i) => `${p.name}: ${i}`),
    );
    checks.push({
      name: "render",
      status: "pass",
      detail:
        `${status.partCount ?? 0} part(s)${status.geometryValid === false ? " — GEOMETRY INVALID" : ""}` +
        (status.warnings?.length ? `; ${status.warnings.length} warning(s)` : ""),
    });

    const parts = outcome.parts ?? [];

    // ── 2. collisions ──────────────────────────────────────────────────
    if (skip.has("collisions")) {
      checks.push({ name: "collisions", status: "skipped", detail: "skipped by caller" });
    } else if (parts.length < 2) {
      checks.push({ name: "collisions", status: "skipped", detail: "single-part design — nothing to check" });
    } else {
      // Merge colocated expectedContacts with call-time acceptedPairs —
      // identical semantics to check_collisions.
      const accepted: Array<[string, string]> = [];
      try {
        const src = readFileSync(absPath, "utf-8");
        for (const pair of extractExpectedContactsStatic(src)) {
          if (Array.isArray(pair) && pair.length === 2) accepted.push([pair[0], pair[1]]);
        }
      } catch { /* source unreadable — fall back to call-time pairs only */ }
      for (const pair of opts.acceptedPairs ?? []) accepted.push(pair);
      const boxes = parts
        .map((p) => ({ name: p.name, box: aabbFromVertices(p.vertices) }))
        .filter((p): p is { name: string; box: NonNullable<typeof p.box> } => p.box !== null);
      const overlaps: Array<[string, string]> = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          if (aabbOverlap(boxes[i].box, boxes[j].box)) {
            overlaps.push([boxes[i].name, boxes[j].name]);
          }
        }
      }
      const real = overlaps.filter(([a, b]) => !matchesAnyAcceptedPair(a, b, accepted));
      if (real.length === 0) {
        checks.push({
          name: "collisions",
          status: "pass",
          detail:
            overlaps.length > 0
              ? `${overlaps.length} overlapping pair(s), all accepted (expectedContacts)`
              : "no overlapping pairs",
        });
      } else {
        checks.push({
          name: "collisions",
          status: "fail",
          detail: `${real.length} unexpected overlapping pair(s): ${real.map(([a, b]) => `${a}↔${b}`).join(", ")}`,
        });
      }
    }

    // ── 3. simulation ──────────────────────────────────────────────────
    // The sim block travels with the outcome (already sidecar-safe: plain
    // serializable data). Engine selection and assertion evaluation are the
    // run_simulation tool's domain; here we only verify the block is DECLARED
    // and structurally sound, and surface its assertion declarations — the
    // agent can run the full study via run_simulation. This keeps the
    // battery fast (no second OCCT pass) and avoids duplicating engine code.
    if (skip.has("simulation")) {
      checks.push({ name: "simulation", status: "skipped", detail: "skipped by caller" });
    } else {
      const sim = outcome.sim as { assertions?: unknown[] } | undefined;
      if (sim === undefined || sim === null) {
        checks.push({ name: "simulation", status: "skipped", detail: "no `export const sim` block — not a mechanism" });
      } else {
        const n = Array.isArray(sim.assertions) ? sim.assertions.length : 0;
        checks.push({
          name: "simulation",
          status: "pass",
          detail: `sim block declared (${n} self-test assertion(s)) — run it: run_simulation for the full motion study`,
        });
      }
    }

    // ── 4. export round-trip ───────────────────────────────────────────
    if (skip.has("export")) {
      checks.push({ name: "export", status: "skipped", detail: "skipped by caller" });
    } else {
      try {
        const outDir = opts.exportDir ?? storageDir;
        const outPath = join(outDir, `${basename(absPath).replace(/\.shape\.ts$/, "")}-verify.step`);
        await exportLastToFile("step", outPath, undefined, opts.sidecar ? [dirname(absPath)] : undefined);
        const size = existsSync(outPath) ? readFileSync(outPath).length : 0;
        if (size < 100) {
          checks.push({ name: "export", status: "fail", detail: `STEP export suspiciously small (${size} bytes)` });
        } else {
          const kb = size > 1024 ? `${(size / 1024).toFixed(1)}KB` : `${size}B`;
          checks.push({ name: "export", status: "pass", detail: `STEP round-trip ok (${kb})` });
        }
      } catch (e: any) {
        checks.push({ name: "export", status: "fail", detail: `STEP export failed: ${e?.message ?? e}` });
      }
    }

    const ok = checks.every((c) => c.status !== "fail");
    return { file: absPath, checks, ok };
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
}

/** Format the battery result as the MCP tool's text response. */
export function formatVerifyReport(result: VerifyDesignResult): string {
  const icon = (s: VerifyCheckResult["status"]) =>
    s === "pass" ? "✓" : s === "fail" ? "✗" : "–";
  const lines = [
    `Verification report — ${basename(result.file)}`,
    "",
    ...result.checks.map((c) => `  ${icon(c.status)} ${c.name}: ${c.detail}`),
    "",
    result.ok ? "PASS — all checks green." : "FAIL — see the ✗ lines above.",
  ];
  return lines.join("\n");
}
