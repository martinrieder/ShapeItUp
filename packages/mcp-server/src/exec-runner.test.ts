/**
 * End-to-end tests for the sidecar execution runner.
 *
 * These spawn the REAL bundled MCP server entry (packages/mcp-server/dist/index.js
 * — same file, re-executed with --shapeitup-exec) as a child process, so they
 * cover: the role branch in index.ts, the envelope protocol, OCCT WASM loading
 * under the permission-model flags, execute + tessellation in the child, and
 * round-trip serialization of the mesh arrays.
 *
 * The heavy OCCT boot (~3 s) is paid once per child; the tests share the
 * runner's persistent child where possible.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawn } from "node:child_process";
import { execInChildForTest, encodeRequest } from "./exec-runner.js";
import { EXEC_ROLE_FLAG } from "./exec-child.js";

const DIST_ENTRY = join(__dirname, "..", "dist", "index.js");

/** Minimal valid bundled shape script — as esbuild would emit (ESM -> CJS-ish
 * plain JS with the sentinel globals). We use the real executor contract:
 * the runner feeds `js` straight to core.execute(), which wraps it. */
const SIMPLE_BUNDLE_JS = `
export default function main() {
  return { shape: globalThis.__replicad__?.makeBox ? undefined : undefined, name: "noop" };
}
`;

/** A bundle that exercises real OCCT: replicad is injected as __replicad__
 * inside the executor wrapper — but core.execute's wrapper provides
 * `__replicad__`. The safest real-world-shaped bundle is one whose main()
 * uses the destructured replicad the executor injects. */
/** Real OCCT render, in the shape the engine's esbuild ESM output takes after
 * rewriteImports: replicad imports become `const {...} = __replicad__;`.
 * A 10mm cylinder → 2 caps + side surface, ≥96 triangles, 2 parts-free. */
const CYLINDER_BUNDLE_JS = `const { makeCylinder } = __replicad__;\nfunction main() {\n  const solid = makeCylinder(5, 10);\n  return [{ shape: solid, name: "cyl" }];\n}`;

const INFINITE_LOOP_JS = `function main() {\n  while (true) { /* spin */ }\n}`;

const THROWING_JS = `function main() {\n  throw new Error("user script failure");\n}`;

function distExists(): boolean {
  return existsSync(DIST_ENTRY);
}

describe("sidecar exec runner (MCP-only mode)", () => {
  beforeAll(() => {
    if (!distExists()) {
      throw new Error(
        `bundled entry not found at ${DIST_ENTRY} — run \`node esbuild.config.mjs --mcp-only\` first`,
      );
    }
  });

  it("child exits 0 on EOF without a request (clean parent teardown path)", async () => {
    const proc = spawn(process.execPath, [DIST_ENTRY, EXEC_ROLE_FLAG], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    proc.stdin.end(); // parent closes stdin → child sees EOF → exit 0
    const code = await new Promise<number | null>((resolve) =>
      proc.on("exit", (c) => resolve(c)),
    );
    expect(code).toBe(0);
    expect(stderr).toContain("exec role starting");
  });

  it("child refuses non-envelope garbage with a protocol error", async () => {
    const proc = spawn(process.execPath, [DIST_ENTRY, EXEC_ROLE_FLAG], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    proc.stdin.write("this is not an envelope\n");
    const code = await new Promise<number | null>((resolve) =>
      proc.on("exit", (c) => resolve(c)),
    );
    expect(code).toBe(3);
    expect(stderr).toContain("protocol error");
  }, 30_000);

  it(
    "executes a real OCCT box render end-to-end and round-trips the mesh",
    async () => {
      const response = await execInChildForTest(
        { js: CYLINDER_BUNDLE_JS },
        [tmpdir()],
      );
      expect(response.ok).toBe(true);
      expect(response.result).toBeDefined();
      const parts = response.result!.parts;
      expect(parts.length).toBe(1);
      expect(parts[0].name).toBe("cyl");
      const tris = Buffer.from(parts[0].triangles, "base64");
      expect(tris.length).toBeGreaterThan(0);
      expect(tris.length % 12).toBe(0); // whole triangles of 3 uint32s
      // Serialized vertices present and non-empty.
      const verts = Buffer.from(parts[0].vertices, "base64");
      expect(verts.length).toBeGreaterThan(0);
      expect(response.result!.geometryValid).toBe(true);
    },
    120_000,
  );

  it(
    "returns a user-script error (not a crash) with exit-code vocabulary",
    async () => {
      const response = await execInChildForTest(
        { js: THROWING_JS },
        [tmpdir()],
      );
      expect(response.ok).toBe(false);
      expect(response.error).toContain("user script failure");
    },
    120_000,
  );

  it(
    "crash isolation: an infinite loop in the script kills the child, not the parent",
    async () => {
      // We can't wait 120s for the runner's own timeout here; instead spawn
      // the child directly, send the looping script, and confirm the child
      // is killable and the parent (this test process) survives fine —
      // plus the runner's timeout path via a short-fused direct check.
      const proc = spawn(process.execPath, [DIST_ENTRY, EXEC_ROLE_FLAG], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      proc.stdin.write(encodeRequest({ id: 1, js: INFINITE_LOOP_JS }));
      proc.stdin.end();
      // Give it a moment to boot OCCT and enter main(), then SIGKILL —
      // exactly what execInChild's timeout does at RENDER_TIMEOUT_MS.
      await new Promise((r) => setTimeout(r, 8000));
      expect(proc.exitCode).toBeNull(); // still spinning — loop confirmed
      proc.kill("SIGKILL");
      const code = await new Promise<number | null>((resolve) =>
        proc.on("exit", (c) => resolve(c)),
      );
      expect([null, 137]).toContain(code); // killed by signal (or its exit code), not a graceful return
      // Parent (this process) is alive and well — we're still executing.
    },
    60_000,
  );

  it(
    "serialized result deserializes to correct typed-array views",
    async () => {
      const { deserializeResult } = await import("./exec-child.js");
      const response = await execInChildForTest(
        { js: CYLINDER_BUNDLE_JS },
        [tmpdir()],
      );
      expect(response.ok).toBe(true);
      const result = deserializeResult(response.result!);
      expect(result.parts[0].triangles).toBeInstanceOf(Uint32Array);
      expect(result.parts[0].vertices).toBeInstanceOf(Float32Array);
      expect(result.parts[0].triangles.length).toBeGreaterThan(0);
      expect(result.parts[0].vertices.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    "engine.executeShapeFile sidecar path produces a success status equal to the in-process path",
    async () => {
      const { executeShapeFile } = await import("./engine.js");
      const dir = mkdtempSync(join(tmpdir(), "siu-sidecar-"));
      const shapePath = join(dir, "part.shape.ts");
      writeFileSync(
        shapePath,
        `import { makeCylinder } from "replicad";\nexport default function main() {\n  return [{ shape: makeCylinder(5, 10), name: "cyl" }];\n}\n`,
      );
      const inProc = await executeShapeFile(shapePath, dir);
      expect(inProc.status.success).toBe(true);
      expect(inProc.status.partCount).toBe(1);
      const sidecar = await executeShapeFile(shapePath, dir, undefined, {
        sidecar: true,
        sidecarWorkspaceDirs: [dir],
      });
      expect(sidecar.status.success).toBe(true);
      expect(sidecar.status.partCount).toBe(1);
      expect(sidecar.status.partNames).toEqual(inProc.status.partNames);
      expect(sidecar.status.boundingBox).toEqual(inProc.status.boundingBox);
      rmSync(dir, { recursive: true, force: true });
    },
    180_000,
  );

  it(
    "persistent child: two renders reuse one OCCT boot (crash isolation + no reboot cost)",
    async () => {
      const { execInChild } = await import("./exec-runner.js");
      const dir = mkdtempSync(join(tmpdir(), "siu-persist-"));
      const first = await execInChild(CYLINDER_BUNDLE_JS, undefined, {
        workspaceDirs: [dir],
      });
      expect(first.parts.length).toBe(1);
      const hadChild = (await import("./exec-runner.js")).execRunnerHasChild();
      expect(hadChild).toBe(true);
      // Second render must reuse the SAME child (spawn would produce a new
      // OCCT boot costing ~3s; reuse keeps it well under a second).
      const t0 = Date.now();
      const second = await execInChild(CYLINDER_BUNDLE_JS, undefined, {
        workspaceDirs: [dir],
      });
      const elapsed = Date.now() - t0;
      expect(second.parts.length).toBe(1);
      expect(second.parts[0].name).toBe("cyl");
      expect(elapsed).toBeLessThan(2000);
      (await import("./exec-runner.js")).resetExecRunner();
      rmSync(dir, { recursive: true, force: true });
    },
    120_000,
  );

  it(
    "pre-warm: child spawned in the background before the first render request",
    async () => {
      const { prewarmExecChild, execRunnerHasChild, execInChild, resetExecRunner } =
        await import("./exec-runner.js");
      resetExecRunner();
      const dir = mkdtempSync(join(tmpdir(), "siu-prewarm-"));
      // Pre-warm: spawn immediately, no request yet.
      prewarmExecChild([dir]);
      expect(execRunnerHasChild()).toBe(true);
      // First render rides the already-spawned child. Give it a moment to
      // boot OCCT in the background; then the render should complete
      // without needing a fresh spawn.
      await new Promise((r) => setTimeout(r, 3000));
      const result = await execInChild(CYLINDER_BUNDLE_JS, undefined, {
        workspaceDirs: [dir],
      });
      expect(result.parts.length).toBe(1);
      expect(result.parts[0].name).toBe("cyl");
      resetExecRunner();
      rmSync(dir, { recursive: true, force: true });
    },
    120_000,
  );

  it(
    "child-side export: execute via sidecar then exportLast to STEP bytes",
    async () => {
      const { executeShapeFile, exportLastToFile } = await import("./engine.js");
      const { resetExecRunner } = await import("./exec-runner.js");
      resetExecRunner();
      const dir = mkdtempSync(join(tmpdir(), "siu-export-"));
      const shapePath = join(dir, "part.shape.ts");
      writeFileSync(
        shapePath,
        `import { makeCylinder } from "replicad";\nexport default function main() {\n  return [{ shape: makeCylinder(5, 10), name: "cyl" }];\n}\n`,
      );
      // Execute through the sidecar — the live shapes now live in the child.
      const out = await executeShapeFile(shapePath, dir, undefined, {
        sidecar: true,
        sidecarWorkspaceDirs: [dir],
      });
      expect(out.status.success).toBe(true);
      // exportLastToFile must transparently route to the child and produce
      // the same artifact class as the in-process path.
      const stepPath = join(dir, "part.step");
      await exportLastToFile("step", stepPath, undefined, [dir]);
      const written = readFileSync(stepPath);
      expect(written.length).toBeGreaterThan(100);
      expect(written.subarray(0, 30).toString("utf-8")).toContain("ISO-10303-21");
      resetExecRunner();
      rmSync(dir, { recursive: true, force: true });
    },
    180_000,
  );

  it(
    "child-side split export: one file per part from sidecar-executed shapes",
    async () => {
      const { executeShapeFile, exportLastSplitToDir } = await import("./engine.js");
      const { resetExecRunner } = await import("./exec-runner.js");
      resetExecRunner();
      const dir = mkdtempSync(join(tmpdir(), "siu-split2-"));
      const shapePath = join(dir, "duo.shape.ts");
      writeFileSync(
        shapePath,
        `import { makeCylinder } from "replicad";\nexport default function main() {\n  return [\n    { shape: makeCylinder(5, 10), name: "alpha" },\n    { shape: makeCylinder(3, 8), name: "beta" },\n  ];\n}\n`,
      );
      const out = await executeShapeFile(shapePath, dir, undefined, {
        sidecar: true,
        sidecarWorkspaceDirs: [dir],
      });
      expect(out.status.success).toBe(true);
      expect(out.status.partCount).toBe(2);
      const outDir = join(dir, "split");
      const written = await exportLastSplitToDir("stl", outDir, [dir]);
      expect(written.length).toBe(2);
      const names = written.map((f) => basename(f)).sort();
      expect(names).toEqual(["alpha.stl", "beta.stl"]);
      for (const f of written) {
        expect(statSync(f).size).toBeGreaterThan(80);
      }
      resetExecRunner();
      rmSync(dir, { recursive: true, force: true });
    },
    180_000,
  );

  it(
    "tool-path parity: sidecar executes produce identical status across opted-in tool shapes",
    async () => {
      const { executeShapeFile } = await import("./engine.js");
      const { resetExecRunner } = await import("./exec-runner.js");
      resetExecRunner();
      const dir = mkdtempSync(join(tmpdir(), "siu-parity-"));
      // Same fixture class the opted-in tools use: params + named parts, the
      // shape of file open_shape/tune_params/render_preview/run_simulation
      // all consume (status + mesh vertices only, never live handles).
      const shapePath = join(dir, "parity.shape.ts");
      writeFileSync(
        shapePath,
        `import { makeCylinder } from "replicad";\nexport const params = { radius: 5, height: 10 };\nexport default function main(p) {\n  return [\n    { shape: makeCylinder(p.radius, p.height), name: "body" },\n  ];\n}\n`,
      );
      const cases: Array<{ label: string; params?: Record<string, number>; partStats?: "full" }> = [
        { label: "plain render (open_shape/tune_params/render_preview shape)" },
        { label: "with param overrides (tune_params shape)", params: { radius: 7 } },
        { label: "force+fresh mesh (run_simulation shape)", partStats: "full" },
      ];
      for (const c of cases) {
        const inProc = await executeShapeFile(shapePath, dir, c.params, {
          partStats: c.partStats,
        });
        resetExecRunner();
        const sidecar = await executeShapeFile(shapePath, dir, c.params, {
          partStats: c.partStats,
          sidecar: true,
          sidecarWorkspaceDirs: [dir],
        });
        expect(inProc.status.success, c.label).toBe(true);
        expect(sidecar.status.success, c.label).toBe(true);
        expect(sidecar.status.partNames, c.label).toEqual(inProc.status.partNames);
        expect(sidecar.status.boundingBox, c.label).toEqual(inProc.status.boundingBox);
        expect(sidecar.status.currentParams, c.label).toEqual(inProc.status.currentParams);
        // totalVolume is only reported when the script declares a material —
        // identical on both paths (undefined === undefined), so plain equality
        // covers both the defined and undefined cases.
        expect(sidecar.status.properties?.totalVolume, c.label).toBe(
          inProc.status.properties?.totalVolume,
        );
      }
      resetExecRunner();
      rmSync(dir, { recursive: true, force: true });
    },
    240_000,
  );

  it(
    "screenshot pipeline: sidecar parts render pixel-identical to in-process parts",
    async () => {
      // Viewer hand-off proof, headless: the SVG+resvg screenshot pipeline
      // that open_shape(capture:true) / tune_params / render_preview all use
      // is a pure mesh consumer (renderPartsToSvg reads vertices/triangles/
      // color; svg-to-png rasterizes). This test executes the SAME shape
      // in-process and via the sidecar, runs both parts arrays through the
      // real pipeline, and asserts the rasterized PNGs are byte-identical —
      // proving the sidecar's mesh-only parts (no live OCCT handles) feed
      // the screenshot path exactly like in-process parts. When the VS Code
      // extension isn't running, this headless pipeline IS the viewer
      // hand-off.
      const { executeShapeFile } = await import("./engine.js");
      const { resetExecRunner } = await import("./exec-runner.js");
      const { renderPartsToSvg } = await import("./svg-renderer.js");
      const { svgToPng } = await import("./svg-to-png.js");
      resetExecRunner();
      const dir = mkdtempSync(join(tmpdir(), "siu-shot-"));
      const shapePath = join(dir, "shot.shape.ts");
      writeFileSync(
        shapePath,
        `import { makeCylinder } from "replicad";\nexport default function main() {\n  return [\n    { shape: makeCylinder(5, 10), name: "body" },\n    { shape: makeCylinder(8, 2).translate(0, 0, 10), name: "cap" },\n  ];\n}\n`,
      );
      // In-process render.
      const inProc = await executeShapeFile(shapePath, dir);
      expect(inProc.status.success).toBe(true);
      expect(inProc.parts).toBeDefined();
      // Sidecar render — parts carry meshes but NO live .shape handles.
      resetExecRunner();
      const sidecar = await executeShapeFile(shapePath, dir, undefined, {
        sidecar: true,
        sidecarWorkspaceDirs: [dir],
      });
      expect(sidecar.status.success).toBe(true);
      expect(sidecar.parts).toBeDefined();
      // The sidecar contract: parts must be handle-free.
      for (const p of sidecar.parts!) {
        expect((p as { shape?: unknown }).shape).toBeUndefined();
      }
      // Both parts arrays go through the REAL screenshot pipeline.
      const svgA = renderPartsToSvg(inProc.parts!);
      const svgB = renderPartsToSvg(sidecar.parts!);
      // SVGs identical → same triangles, same shading, same summary stats.
      expect(svgB.svg).toBe(svgA.svg);
      expect(svgB.summary).toBe(svgA.summary);
      // Rasterize both through resvg — byte-identical PNGs.
      const pngA = await svgToPng(svgA.svg, 640);
      const pngB = await svgToPng(svgB.svg, 640);
      expect(pngB.equals(pngA)).toBe(true);
      expect(pngA.length).toBeGreaterThan(1000);
      // PNG magic bytes prove a real raster, not an empty buffer.
      expect(pngA[0]).toBe(0x89);
      expect(pngA.subarray(1, 4).toString("latin1")).toBe("PNG");
      resetExecRunner();
      rmSync(dir, { recursive: true, force: true });
    },
    180_000,
  );
});
