/**
 * Parent-side manager for the sidecar execution child.
 *
 * Spawns THIS SERVER'S OWN entry (process.argv[1]) with `--shapeitup-exec`
 * plus Node's permission-model flags. The child runs the bundled user script
 * and returns tessellated parts over a length-prefixed JSON envelope. The
 * parent keeps: bundling (esbuild), bundle/mesh caches, status files, export
 * writes, and every tool that needs LIVE OCCT handles (those still execute
 * in-process via getCore()).
 *
 * Lifecycle: one persistent child, reused across renders (an OCCT WASM boot
 * costs ~3 s), respawned after a crash, killed after a timeout, memory-capped.
 * The permission flags are added only when the running Node supports them —
 * an unsupported flag would make the child die at spawn, so we probe first
 * and degrade to an unprivileged-but-plain child (still crash-isolated).
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

declare const require: NodeJS.Require;
import { dirname, join } from "node:path";
import type { ExecRequest, ExecResponse, SerializedExecutionResult } from "./exec-child.js";
import { EXEC_ROLE_ENV, EXEC_ROLE_FLAG, deserializeResult, type RenderRequest, type ExportRequest } from "./exec-child.js";

/** Render timeout — user scripts can loop forever; tessellation of sane
 * assemblies completes in seconds. Generous enough for 60-part models. */
const RENDER_TIMEOUT_MS = 120_000;
/** Hard heap cap for the child. WASM + a big assembly fits comfortably. */
const CHILD_MAX_OLD_SPACE_MB = 2048;

export type ExecRunnerErrorKind =
  | "timeout"
  | "crash"
  | "spawn"
  | "protocol"
  | "script";

export class ExecRunnerError extends Error {
  kind: ExecRunnerErrorKind;
  constructor(kind: ExecRunnerErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

interface ChildState {
  proc: import("node:child_process").ChildProcess;
  busy: boolean;
  /**
   * Resolves once the child has booted OCCT (i.e. it's serving requests).
   * Pre-warmed children set this so execInChild can await boot completion
   * instead of racing a request against a still-compiling WASM.
   */
  ready?: Promise<void>;
}

let child: ChildState | null = null;
let nextRequestId = 1;

/**
 * Extra read-allowlist entries for the child. Computed lazily from where the
 * OCCT/Manifold WASM binaries actually live (mirrors engine.ts's
 * locateWasmDir + the node_modules fallback in the loaders), because the
 * permission model denies fs reads by default. Without these, the child
 * can't boot OCCT at all.
 */
export function wasmReadDirs(): string[] {
  const dirs: string[] = [];
  try {
    const here = dirname(
      new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    );
    if (existsSync(join(here, "replicad_single.wasm"))) dirs.push(here);
    if (existsSync(join(here, "manifold.wasm"))) dirs.push(here);
  } catch {}
  // Loaders fall back to node_modules resolution when the wasm isn't
  // co-located (standalone npm install / source run). Allow the whole
  // package dirs — the permission model has no file-level granularity.
  try {
    const { createRequire } = require("module") as typeof import("node:module");
    const req = createRequire(import.meta.url);
    try {
      dirs.push(dirname(req.resolve("replicad-opencascadejs/src/replicad_single.js")));
    } catch {}
    try {
      dirs.push(dirname(req.resolve("manifold-3d/manifold.js")));
    } catch {}
  } catch {}
  return [...new Set(dirs)];
}

let permissionFlagsCache: string[] | null | undefined;

/**
 * Detect whether this Node accepts `--experimental-permission` with our
 * allowlist shape, and whether the full runtime can boot under it. Probing
 * is cheap and cached. Returns null when the flag is unsupported OR the
 * sandboxed runtime can't operate under it — the child then runs without
 * permission flags but keeps the process boundary (crash/OOM isolation).
 *
 * The probe boots the exec-role entry itself (stdin closed = immediate
 * clean exit). This catches the real-world failure modes a bare `-e ""`
 * probe misses: Node needing to read package.json files above the
 * allowlisted dirs for ESM resolution, loaders resolving through
 * un-allowlisted node_modules paths, etc. A permission-flagged child that
 * dies at boot is worse than no flags: every render fails.
 *
 * Note: SHAPEITUP_MCP_EXEC_PERMS=1 forces flags on (for debugging the
 * Tier-2 hardening); SHAPEITUP_MCP_EXEC_PERMS=0 forces them off.
 */
function permissionFlags(readDirs: string[]): string[] | null {
  if (permissionFlagsCache !== undefined) return permissionFlagsCache;
  const override = process.env.SHAPEITUP_MCP_EXEC_PERMS;
  if (override === "0") {
    permissionFlagsCache = null;
    return permissionFlagsCache;
  }
  const flags = [
    "--experimental-permission",
    ...readDirs.flatMap((d) => ["--allow-fs-read", d]),
  ];
  const probe = (extra: string[]) => {
    try {
      execFileSync(
        process.execPath,
        [...extra, selfEntry(), EXEC_ROLE_FLAG],
        { stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, [EXEC_ROLE_ENV]: "1" } },
      );
      return true;
    } catch {
      return false;
    }
  };
  const supported = probe(["--experimental-permission", "-e", ""]);
  if (!supported) {
    permissionFlagsCache = null;
    return permissionFlagsCache;
  }
  if (override === "1" || probe(flags)) {
    permissionFlagsCache = flags;
  } else {
    // Node accepts the flags but the real entry can't boot under them
    // (ESM resolution reads outside the allowlist, etc.). Degrade to the
    // process-boundary-only tier rather than breaking every render.
    process.stderr.write(
      "[exec-runner] permission model available but entry failed to boot under it — running child without permission flags (process-boundary isolation only)\n",
    );
    permissionFlagsCache = null;
  }
  return permissionFlagsCache;
}

/**
 * Resolve this program's own entry point for re-exec. In production the MCP
 * server runs as `node dist/index.js` (or the bundled mcp-server.mjs), so
 * argv[1] IS the entry. Under vitest, argv[1] is the test runner — detect
 * that (vitest sets VITEST) and resolve the built bundle instead, which the
 * exec-runner tests build before running (`esbuild.config.mjs --mcp-only`).
 */
export function selfEntry(): string {
  if (!process.env.VITEST) {
    const argv1 = process.argv[1];
    if (argv1 && existsSync(argv1)) return argv1;
  }
  // vitest / ts-source runs: use the built MCP bundle in dist/.
  const here = dirname(
    new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  );
  for (const cand of [
    join(here, "..", "dist", "index.js"),
    join(here, "dist", "index.js"),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return process.argv[1] ?? "node";
}

function readDirsForWorkspace(workspaceDirs: string[]): string[] {
  // The child must be able to read: the workspace(s) holding the shape
  // files, the WASM binaries, AND its own program (the entry script is
  // loaded through fs by Node itself, which the permission model also
  // gates) plus the node_modules tree the loaders resolve through.
  const dirs = [...workspaceDirs, ...wasmReadDirs(), dirname(selfEntry())];
  return [...new Set(dirs)];
}

function spawnChild(workspaceDirs: string[]): ChildState {
  const entry = selfEntry();
  const readDirs = readDirsForWorkspace(workspaceDirs);
  const perm = permissionFlags(readDirs);
  // Node CLI flags MUST precede the script path — anything after it is
  // process.argv for the script. Order: node flags, script path, role flag.
  const args: string[] = [];
  if (perm) args.push(...perm);
  args.push(`--max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`, "--no-addons", entry, EXEC_ROLE_FLAG);
  const env = { ...process.env };
  for (const d of wasmReadDirs()) {
    if (existsSync(join(d, "replicad_single.wasm"))) {
      env.SHAPEITUP_WASM_DIR ??= d;
    }
  }
  const proc = spawn(process.execPath, args, {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const state: ChildState = { proc, busy: false };
  return state;
}

function killChild(): void {
  if (child) {
    try { child.proc.kill("SIGKILL"); } catch {}
    child = null;
  }
}

/**
 * Pre-warm the sidecar child in the background.
 *
 * OCCT's WASM compile costs ~3 s on first boot. The MCP server's first
 * moments are idle — the client is reading tools/list and deciding what to
 * call — so spending those seconds compiling OCCT in a background child
 * makes the first render effectively instant: by the time the first
 * render request arrives, the child is already serving.
 *
 * In-process warm-up can't do this trick (the compile would block the
 * event loop and delay initialize); the process boundary is what makes
 * it free.
 *
 * Non-fatal by design: boot failures just log to stderr and clear the
 * child so the next execInChild spawns fresh. `workspaceDirs` should
 * cover the roots shape files are expected to live under.
 */
export function prewarmExecChild(workspaceDirs: string[]): void {
  if (child) return; // already warm or warming
  try {
    const state = spawnChild(workspaceDirs);
    // The child signals readiness with its startup banner on stderr; the
    // OCCT boot itself is invisible to us (it happens before the banner).
    // We can't observe it directly over this protocol, so "ready" is the
    // child being alive — the request path awaits the response anyway.
    state.ready = Promise.resolve();
    child = state;
    process.stderr.write("[exec-runner] pre-warmed sidecar child (pid=" + state.proc.pid + ")\n");
  } catch (e: any) {
    process.stderr.write(`[exec-runner] pre-warm failed (will spawn lazily): ${e?.message ?? e}\n`);
    child = null;
  }
}

/**
 * Execute a bundled script in the sidecar child. Returns the deserialized
 * ExecutionResult (typed-array views restored) or throws ExecRunnerError
 * with a `kind` the caller can surface ("your script looped forever" vs
 * "the geometry engine crashed — restarted").
 */
export async function execInChild(
  js: string,
  paramOverrides: Record<string, number | boolean | string> | undefined,
  opts: {
    partStats?: "none" | "bbox" | "full";
    workspaceDirs: string[];
    /**
     * Identity the child should RECORD for this render — the WRITE half of
     * the child-side shape cache. Supplied by the engine (which owns file
     * identity); a follow-up export's cacheLookup can then match it.
     */
    producedShapeIdentity?: { file: string; sourceHash: string; paramsKey: string };
  },
): Promise<ReturnType<typeof deserializeResult>> {
  const request: ExecRequest = {
    id: nextRequestId++,
    kind: "render",
    js,
    paramOverrides,
    partStats: opts.partStats,
    producedShapeIdentity: opts.producedShapeIdentity,
  };
  if (!child || child.proc.exitCode !== null || !child.proc.stdin?.writable) {
    killChild();
    child = spawnChild(opts.workspaceDirs);
  }
  const proc = child.proc;
  child.busy = true;
  try {
    // Wire up the response reader BEFORE writing the request so a fast
    // child can't race us (response arriving before readResponse attaches).
    const responsePromise = withTimeout(readResponse(proc), RENDER_TIMEOUT_MS, proc);
    proc.stdin?.write(encodeRequest(request));
    const response = await responsePromise;
    if (!response.ok || !response.result) {
      const err = new ExecRunnerError("script", response.error ?? "unknown script error");
      err.stack = response.stack;
      throw err;
    }
    return deserializeResult(response.result);
  } finally {
    if (child) child.busy = false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, proc: import("node:child_process").ChildProcess): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      reject(new ExecRunnerError("timeout", `render exceeded ${ms / 1000}s — child killed`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function readResponse(proc: import("node:child_process").ChildProcess): Promise<ExecResponse> {
  return new Promise<ExecResponse>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let expected: number | null = null;
    let bodyStart = 0;
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (expected === null) {
          const nl = buffer.indexOf(0x0a);
          if (nl === -1) return;
          const len = Number(buffer.subarray(0, nl).toString("utf-8"));
          if (!Number.isFinite(len) || len <= 0 || len > 512 * 1024 * 1024) {
            cleanup();
            reject(new ExecRunnerError("protocol", `bad envelope length from child: ${buffer.subarray(0, nl).toString("utf-8")}`));
            return;
          }
          expected = len;
          bodyStart = nl + 1;
        }
        if (buffer.length - bodyStart >= expected) {
          const body = buffer.subarray(bodyStart, bodyStart + expected).toString("utf-8");
          buffer = buffer.subarray(bodyStart + expected);
          expected = null;
          bodyStart = 0;
          cleanup();
          try {
            resolve(JSON.parse(body) as ExecResponse);
          } catch (e: any) {
            reject(new ExecRunnerError("protocol", `unparseable child response: ${e?.message ?? e}`));
          }
          return;
        }
        return;
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new ExecRunnerError(
          "crash",
          `execution child exited unexpectedly (code=${code ?? "?"} signal=${signal ?? "?"}) — the geometry engine crashed or ran out of memory`,
        ),
      );
    };
    const onError = (e: Error) => {
      cleanup();
      reject(new ExecRunnerError("spawn", `failed to start execution child: ${e.message}`));
    };
    const cleanup = () => {
      proc.stdout?.off("data", onData);
      proc.off("exit", onExit);
      proc.off("error", onError);
    };
    proc.stdout?.on("data", onData);
    proc.once("exit", onExit);
    proc.once("error", onError);
  });
}

/**
 * Export the child's most recently executed shapes to bytes.
 *
 * core.exportLast* serializes the shapes owned by the process that ran the
 * last execute. When that was the sidecar child (engine routes sidecar
 * executes there), the shapes live in the child — so the export request
 * rides the same envelope protocol and the parent receives bytes it merely
 * writes to disk. The child keeps its read-only posture: it produces bytes,
 * the parent does every writeFileSync.
 *
 * Throws ExecRunnerError with the same vocabulary as execInChild (crash,
 * timeout, protocol, script) plus ok:false export errors surfaced as
 * `kind: "script"`.
 */
export async function exportInChild(
  opts: {
    format: "step" | "stl" | "3mf";
    partName?: string;
    split?: boolean;
    workspaceDirs: string[];
    /**
     * Child-side cache match-spec: when supplied with `fallbackJs`, the child
     * skips its re-execute when its last execute matches this identity —
     * the child-side analog of the parent's liveForceCache, relocated to
     * where the shapes actually live.
     */
    expectedShapeIdentity?: { file: string; sourceHash: string; paramsKey: string };
    /**
     * Bundle for the child to re-execute on identity mismatch. Without it
     * the child exports whatever its last execute left behind (legacy
     * behavior — the engine's re-execute-before-export contract normally
     * guarantees freshness instead).
     */
    fallbackJs?: string;
    /** Params the fallback bundle should run with. */
    fallbackParams?: Record<string, number | boolean | string>;
  },
): Promise<{ data?: Buffer; items?: Array<{ name: string; data: Buffer }> }> {
  const request: ExecRequest = {
    id: nextRequestId++,
    kind: "export",
    exportFormat: opts.format,
    exportPartName: opts.partName,
    exportSplit: opts.split,
    // Cache query + fallback travel as an inseparable pair: the child's
    // re-render arm exists exactly when the query does.
    cacheLookup:
      opts.expectedShapeIdentity && opts.fallbackJs
        ? {
            expectShapesFrom: opts.expectedShapeIdentity,
            fallbackJs: opts.fallbackJs,
            fallbackParams: opts.fallbackParams,
          }
        : undefined,
  };
  if (!child || child.proc.exitCode !== null || !child.proc.stdin?.writable) {
    killChild();
    child = spawnChild(opts.workspaceDirs);
  }
  const proc = child.proc;
  child.busy = true;
  try {
    const responsePromise = withTimeout(readResponse(proc), RENDER_TIMEOUT_MS, proc);
    proc.stdin?.write(encodeRequest(request));
    const response = await responsePromise;
    if (!response.ok) {
      const err = new ExecRunnerError("script", response.error ?? "unknown export error");
      err.stack = response.stack;
      throw err;
    }
    if (!response.export) {
      throw new ExecRunnerError("protocol", "export response carried no payload");
    }
    if (response.export.items) {
      return {
        items: response.export.items.map((it) => ({ name: it.name, data: Buffer.from(it.data, "base64") })),
      };
    }
    if (response.export.data === undefined) {
      throw new ExecRunnerError("protocol", "export response carried neither data nor items");
    }
    return { data: Buffer.from(response.export.data, "base64") };
  } finally {
    if (child) child.busy = false;
  }
}

/** Test hook: reset the singleton child + flags cache. */
export function resetExecRunner(): void {
  killChild();
  permissionFlagsCache = undefined;
}

/** Whether the runner currently holds a live child (test observability). */
export function execRunnerHasChild(): boolean {
  return !!child && child.proc.exitCode === null;
}

/** @internal for tests: write the request envelope the way the child reads it. */
export function encodeRequest(req: ExecRequest): Buffer {
  const json = JSON.stringify(req);
  return Buffer.from(`${Buffer.byteLength(json)}\n${json}`);
}

/** @internal for tests: run one request end-to-end against a fresh child. */
export async function execInChildForTest(
  req: Omit<RenderRequest, "id"> | Omit<ExportRequest, "id">,
  workspaceDirs: string[],
): Promise<ExecResponse> {
  const entry = selfEntry();
  const perm = permissionFlags(readDirsForWorkspace(workspaceDirs));
  const args: string[] = [];
  if (perm) args.push(...perm);
  args.push(`--max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`, "--no-addons", entry, EXEC_ROLE_FLAG);
  const env = { ...process.env };
  for (const d of wasmReadDirs()) {
    if (existsSync(join(d, "replicad_single.wasm"))) env.SHAPEITUP_WASM_DIR ??= d;
  }
  const proc = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "inherit"] });
  const responsePromise = readResponse(proc);
  proc.stdin.write(encodeRequest({ ...req, id: 1 }));
  proc.stdin.end();
  try {
    return await responsePromise;
  } finally {
    try { proc.kill("SIGKILL"); } catch {}
  }
}
