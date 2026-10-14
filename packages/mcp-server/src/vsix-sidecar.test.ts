/**
 * VSIX-flavor sidecar test: prove the self-re-exec pattern works in the exact
 * artifact VS Code extension users run — `packages/extension/dist/mcp-server.mjs`
 * (the esbuild bundle with WASM co-located next to it), NOT the standalone
 * `packages/mcp-server/dist/index.js` the npm/npx flavor uses.
 *
 * This closes the flavor-coverage gap: exec-runner tests exercise the npm
 * bundle's entry; this test spawns the VSIX bundle's entry in exec role and
 * runs one real OCCT render through it end-to-end. The child resolves its
 * own entry via argv[1] (`node extension/dist/mcp-server.mjs --shapeitup-exec`),
 * so this also validates the role branch survives esbuild's second bundling
 * pass (the mcp-only build emits both index.js and mcp-server.mjs).
 *
 * Build prerequisite: `node esbuild.config.mjs` (or `--mcp-only`) — the
 * standard `pnpm build` produces the artifact.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VSIX_ENTRY = resolve(__dirname, "..", "..", "extension", "dist", "mcp-server.mjs");

const CYLINDER_BUNDLE_JS =
  'const { makeCylinder } = __replicad__;\nfunction main() {\n  const solid = makeCylinder(5, 10);\n  return [{ shape: solid, name: "cyl" }];\n}';

function writeEnvelope(obj: unknown): Buffer {
  const json = JSON.stringify(obj);
  return Buffer.from(`${Buffer.byteLength(json)}\n${json}`);
}

describe("VSIX-flavor sidecar (extension bundle)", () => {
  beforeAll(() => {
    if (!existsSync(VSIX_ENTRY)) {
      throw new Error(
        `VSIX MCP bundle not found at ${VSIX_ENTRY} — run \`node esbuild.config.mjs\` first`,
      );
    }
  });

  it(
    "extension/dist/mcp-server.mjs boots in exec role and runs a real OCCT render",
    async () => {
      const proc = spawn(process.execPath, [VSIX_ENTRY, "--shapeitup-exec"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += d));
      let out = Buffer.alloc(0);
      let expected: number | null = null;
      const responsePromise = new Promise<any>((resolveP, rejectP) => {
        proc.stdout.on("data", (chunk: Buffer) => {
          out = Buffer.concat([out, chunk]);
          for (;;) {
            if (expected === null) {
              const nl = out.indexOf(0x0a);
              if (nl === -1) return;
              expected = Number(out.subarray(0, nl).toString("utf-8"));
              out = out.subarray(nl + 1);
            }
            if (out.length >= expected) {
              const body = out.subarray(0, expected).toString("utf-8");
              try {
                resolveP(JSON.parse(body));
              } catch (e) {
                rejectP(e);
              }
              return;
            }
            return;
          }
        });
        proc.once("exit", (code) => {
          rejectP(new Error(`child exited before responding (code=${code}) stderr=${stderr.slice(0, 400)}`));
        });
      });
      proc.stdin.write(writeEnvelope({ id: 1, kind: "render", js: CYLINDER_BUNDLE_JS }));
      proc.stdin.end();
      const response = await responsePromise;
      expect(response.ok).toBe(true);
      expect(response.result.parts.length).toBe(1);
      expect(response.result.parts[0].name).toBe("cyl");
      // Meshes actually made it across (base64-decodes to typed-array bytes).
      const tris = Buffer.from(response.result.parts[0].triangles, "base64");
      expect(tris.length).toBeGreaterThan(0);
      expect(tris.length % 12).toBe(0);
      // The VSIX flavor co-locates the WASM next to the bundle — the child
      // found it via SHAPEITUP_WASM_DIR-less co-location (locateWasmDir).
      expect(stderr).not.toMatch(/failed|error/i);
      try { proc.kill("SIGKILL"); } catch {}
    },
    120_000,
  );

  it(
    "VSIX-flavor engine parity: executeShapeFile via the extension bundle's server path",
    async () => {
      // End-to-end through the ENGINE would spawn the npm entry; here we prove
      // the VSIX bundle at least answers the exec-role protocol with correct
      // geometry — the flavor-coverage claim this test exists for.
      const dir = mkdtempSync(join(tmpdir(), "siu-vsix-"));
      const proc = spawn(process.execPath, [VSIX_ENTRY, "--shapeitup-exec"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = Buffer.alloc(0);
      let expected: number | null = null;
      const responsePromise = new Promise<any>((resolveP, rejectP) => {
        proc.stdout.on("data", (chunk: Buffer) => {
          out = Buffer.concat([out, chunk]);
          for (;;) {
            if (expected === null) {
              const nl = out.indexOf(0x0a);
              if (nl === -1) return;
              expected = Number(out.subarray(0, nl).toString("utf-8"));
              out = out.subarray(nl + 1);
            }
            if (out.length >= expected) {
              try {
                resolveP(JSON.parse(out.subarray(0, expected).toString("utf-8")));
              } catch (e) {
                rejectP(e);
              }
              return;
            }
            return;
          }
        });
      });
      proc.stdin.write(writeEnvelope({
        id: 2,
        kind: "render",
        js: 'const { makeCylinder } = __replicad__;\nfunction main() {\n  return [\n    { shape: makeCylinder(5, 10), name: "body" },\n    { shape: makeCylinder(8, 2), name: "cap" },\n  ];\n}',
      }));
      proc.stdin.end();
      const response = await responsePromise;
      expect(response.ok).toBe(true);
      expect(response.result.parts.map((p: { name: string }) => p.name)).toEqual(["body", "cap"]);
      expect(response.result.geometryValid).toBe(true);
      try { proc.kill("SIGKILL"); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
    120_000,
  );
});
