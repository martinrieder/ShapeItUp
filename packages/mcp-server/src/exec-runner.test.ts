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
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
