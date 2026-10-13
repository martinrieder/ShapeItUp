/**
 * Sidecar execution role for the MCP server.
 *
 * The SAME bundled entry (dist/index.js / mcp-server.mjs) is re-executed by
 * the parent MCP server with `--shapeitup-exec` plus Node's permission-model
 * flags. In this role the process does exactly one thing: load OCCT, evaluate
 * a bundled `.shape.ts`, tessellate it, and write the result to stdout as a
 * length-prefixed JSON envelope. It never speaks MCP, never binds the
 * subscriber bus, and — under the permission model — cannot write files,
 * spawn processes, or load native addons.
 *
 * Protocol (both directions): `b'<len>\\n'` followed by `<len>` UTF-8 bytes of
 * JSON. Requests arrive on stdin; exactly one response goes back on stdout.
 * Diagnostics go to stderr (passed through by the parent).
 */
import { initCore } from "@shapeitup/core";
import type { ExecutionResult } from "@shapeitup/core";
import { loadOCCTNode } from "./node-loader.js";
import { loadManifoldNode } from "./manifold-node-loader.js";

export const EXEC_ROLE_FLAG = "--shapeitup-exec";
export const EXEC_ROLE_ENV = "SHAPEITUP_EXEC_ROLE";

/**
 * Wire form of a request (parent → child). Two kinds:
 *  - `execute`: bundle + params → tessellated parts (the render path)
 *  - `export`:  export the child's most recently executed shapes to bytes.
 *    The child owns the live OCCT instance that produced them, so STEP/STL/
 *    3MF serialization happens where the shapes live; the parent only
 *    writes the returned bytes to disk. A child with no prior execute in
 *    this process returns ok:false ("no shape executed") — the parent's
 *    re-execute-before-export flow means this is rare, but it's handled.
 */
export interface ExecRequest {
  id: number;
  kind?: "execute" | "export";
  /** execute: the esbuild-bundled user script — opaque JS text, imports already resolved. */
  js?: string;
  paramOverrides?: Record<string, number | boolean | string>;
  partStats?: "none" | "bbox" | "full";
  /** export: target format. */
  exportFormat?: "step" | "stl" | "3mf";
  /** export: single-part export (exact name match), or all parts when absent. */
  exportPartName?: string;
  /** export: split into one buffer per part (exportLastSplit semantics). */
  exportSplit?: boolean;
}

/** Wire form of the response (child → parent). */
export interface ExecResponse {
  id: number;
  ok: boolean;
  /** Serialized core.execute() result on success (execute requests). */
  result?: SerializedExecutionResult;
  /** Export payload on success (export requests). */
  export?: {
    /** Single combined buffer (exportSplit false). */
    data?: string;
    /** One entry per part (exportSplit true). */
    items?: Array<{ name: string; data: string }>;
  };
  /** Human-readable error on failure — already resolved (no raw WASM pointers). */
  error?: string;
  /** Error stack when available, for the status file's diagnostics. */
  stack?: string;
  /** `resolveError` output when the child recognized a WASM-level signature. */
  operation?: unknown;
}

/**
 * JSON-safe projection of core's ExecutionResult. Typed arrays become base64
 * (btoa over byte-wise chars); everything else is already plain data. The
 * parent reconstructs Float32Array/Uint32Array views.
 */
export interface SerializedExecutionResult {
  params: Array<{ name: string; value: number | boolean | string; declaredValue?: number | boolean | string }>;
  execTimeMs: number;
  tessTimeMs: number;
  timings: Record<string, number>;
  warnings: string[];
  geometryValid: boolean;
  geometryIssues?: Array<{ part: string; severity: "error" | "warning"; reason: string; message: string; probes?: Record<string, number> }>;
  cutAtOutcomes?: boolean[];
  material?: { density: number; name?: string };
  sim?: unknown;
  parts: Array<{
    name: string;
    color: string | null;
    vertices: string;
    normals: string;
    triangles: string;
    edgeVertices: string;
    faceGroups?: string;
    faceInfo?: Array<{ kind: string; center: [number, number, number]; normal?: [number, number, number]; area?: number }>;
    edgeGroups?: string;
    volume?: number;
    surfaceArea?: number;
    centerOfMass?: [number, number, number];
    qty?: number;
    material?: { density: number; name?: string };
    group?: string;
    analyze?: boolean;
    printability?: { manifold: boolean; minFeatureSize_mm: number; issues: string[] };
  }>;
}

function toBase64(view: Uint32Array | Float32Array): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[]);
  }
  return btoa(binary);
}

/** ArrayBuffer (e.g. a STEP/STL/3MF export buffer) → base64 for the wire. */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  return toBase64(new Uint8Array(buf) as unknown as Float32Array);
}

function fromBase64(b64: string, ctor: "float32" | "uint32"): Float32Array | Uint32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return ctor === "float32" ? new Float32Array(bytes.buffer) : new Uint32Array(bytes.buffer);
}

function serializeResult(result: ExecutionResult): SerializedExecutionResult {
  return {
    params: result.params.map((p) => ({
      name: p.name,
      value: p.value,
      declaredValue: (p as { declaredValue?: number | boolean | string }).declaredValue,
    })),
    execTimeMs: result.execTimeMs,
    tessTimeMs: result.tessTimeMs,
    timings: result.timings,
    warnings: result.warnings,
    geometryValid: result.geometryValid,
    geometryIssues: result.geometryIssues,
    cutAtOutcomes: result.cutAtOutcomes,
    material: result.material,
    sim: result.sim,
    parts: result.parts.map((p) => ({
      name: p.name,
      color: p.color,
      vertices: toBase64(p.vertices),
      normals: toBase64(p.normals),
      triangles: toBase64(p.triangles),
      edgeVertices: toBase64(p.edgeVertices),
      faceGroups: p.faceGroups ? toBase64(p.faceGroups) : undefined,
      faceInfo: p.faceInfo,
      edgeGroups: p.edgeGroups ? toBase64(p.edgeGroups) : undefined,
      volume: p.volume,
      surfaceArea: p.surfaceArea,
      centerOfMass: p.centerOfMass,
      qty: p.qty,
      material: p.material,
      group: (p as { group?: string }).group,
      analyze: (p as { analyze?: boolean }).analyze,
      printability: (p as { printability?: { manifold: boolean; minFeatureSize_mm: number; issues: string[] } }).printability,
    })),
  };
}

/** Parent-side: turn the wire form back into the typed result tools.ts expects. */
export function deserializeResult(s: SerializedExecutionResult) {
  return {
    params: s.params.map((p) => {
      const def: { name: string; value: number | boolean | string; declaredValue?: number | boolean | string } = {
        name: p.name,
        value: p.value,
      };
      if (p.declaredValue !== undefined) def.declaredValue = p.declaredValue;
      return def;
    }),
    execTimeMs: s.execTimeMs,
    tessTimeMs: s.tessTimeMs,
    timings: s.timings,
    warnings: s.warnings,
    geometryValid: s.geometryValid,
    geometryIssues: s.geometryIssues,
    cutAtOutcomes: s.cutAtOutcomes,
    material: s.material,
    sim: s.sim,
    parts: s.parts.map((p) => ({
      name: p.name,
      color: p.color,
      vertices: fromBase64(p.vertices, "float32") as Float32Array,
      normals: fromBase64(p.normals, "float32") as Float32Array,
      triangles: fromBase64(p.triangles, "uint32") as Uint32Array,
      edgeVertices: fromBase64(p.edgeVertices, "float32") as Float32Array,
      faceGroups: p.faceGroups ? (fromBase64(p.faceGroups, "uint32") as Uint32Array) : undefined,
      faceInfo: p.faceInfo,
      edgeGroups: p.edgeGroups ? (fromBase64(p.edgeGroups, "uint32") as Uint32Array) : undefined,
      volume: p.volume,
      surfaceArea: p.surfaceArea,
      centerOfMass: p.centerOfMass,
      qty: p.qty,
      material: p.material,
      group: (p as { group?: string }).group,
      analyze: (p as { analyze?: boolean }).analyze,
      printability: (p as { printability?: { manifold: boolean; minFeatureSize_mm: number; issues: string[] } }).printability,
    })),
  };
}

function writeEnvelope(obj: unknown): void {
  const json = JSON.stringify(obj);
  process.stdout.write(Buffer.from(`${Buffer.byteLength(json)}\n${json}`));
}

async function readRequest(): Promise<ExecRequest | null> {
  // Byte-exact framing parser. The length prefix declares the body size, and
  // the body may contain \n (JSON with escaped newlines) or arrive split
  // across many chunk boundaries — readline is wrong here because it would
  // wait for a trailing \n that never comes and hang a persistent child.
  return await new Promise<ExecRequest | null>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let expected: number | null = null;
    let bodyStart = 0;
    let done = false;
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      if (done) return;
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (expected === null) {
          const nl = buffer.indexOf(0x0a);
          if (nl === -1) return;
          const len = Number(buffer.subarray(0, nl).toString("utf-8"));
          if (!Number.isFinite(len) || len <= 0 || len > 512 * 1024 * 1024) {
            done = true;
            cleanup();
            reject(new Error(`bad envelope length: ${buffer.subarray(0, nl).toString("utf-8")}`));
            return;
          }
          expected = len;
          bodyStart = nl + 1;
        }
        if (buffer.length - bodyStart >= expected) {
          const body = buffer.subarray(bodyStart, bodyStart + expected).toString("utf-8");
          done = true;
          cleanup();
          try {
            resolve(JSON.parse(body) as ExecRequest);
          } catch (e: any) {
            reject(new Error(`unparseable request body: ${e?.message ?? e}`));
          }
          return;
        }
        return;
      }
    };
    const onEnd = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(null);
    };
    const onError = (e: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(e);
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
  });
}

/**
 * Run the exec role loop. Exits 0 on a clean EOF (parent closed stdin) or a
 * completed request; non-zero on protocol/execution errors, with a stable
 * exit-code vocabulary the parent can translate into user-facing messages.
 */
export async function runExecRole(): Promise<void> {
  process.stderr.write("[shapeitup-exec] exec role starting\n");
  const wasmDir = process.env.SHAPEITUP_WASM_DIR || undefined;
  // Boot OCCT once, then serve requests until the parent closes stdin (EOF
  // => exit 0). A persistent child amortizes the ~3s WASM compile across
  // renders — the whole point of pooling on the parent side. core.execute
  // reuses the same OCCT instance per call, same as the in-process engine.
  let core: Awaited<ReturnType<typeof initCore>> | undefined;
  try {
    core = await initCore(
      () => loadOCCTNode(wasmDir),
      () => loadManifoldNode(wasmDir).catch((e: unknown) => {
        process.stderr.write(
          `[shapeitup-exec] Manifold loader failed — threads helpers unavailable: ${e instanceof Error ? e.message : String(e)}\n`,
        );
        return null;
      }),
    );
  } catch (e: any) {
    process.stderr.write(`[shapeitup-exec] OCCT init failed: ${e?.message ?? e}\n`);
    process.exit(5);
  }
  for (;;) {
    let request: ExecRequest | null = null;
    try {
      request = await readRequest();
    } catch (e: any) {
      process.stderr.write(`[shapeitup-exec] protocol error: ${e?.message ?? e}\n`);
      process.exit(3);
    }
    // EOF: parent closed stdin — clean teardown (smoke tests rely on rc=0).
    if (!request) process.exit(0);
    // --- export requests ------------------------------------------------
    // core.exportLast* serializes the shapes from the most recent execute
    // in THIS process. When the parent executed through the sidecar, those
    // shapes live here — so the export must run here too, and the parent
    // receives bytes it merely writes to disk.
    if (request.kind === "export") {
      const format = request.exportFormat ?? "stl";
      try {
        if (request.exportSplit) {
          const items = await core.exportLastSplit(format);
          writeEnvelope({
            id: request.id,
            ok: true,
            export: {
              items: items.map((it) => ({ name: it.name, data: arrayBufferToBase64(it.data) })),
            },
          });
        } else {
          const data = await core.exportLast(format, request.exportPartName);
          writeEnvelope({ id: request.id, ok: true, export: { data: arrayBufferToBase64(data) } });
        }
      } catch (e: any) {
        let message = e?.message ?? String(e);
        try { message = core.resolveError(e); } catch { /* plain message */ }
        writeEnvelope({ id: request.id, ok: false, error: message, stack: e?.stack });
      }
      continue;
    }
    try {
      const streaming = request.partStats ? { partStats: request.partStats } : undefined;
      const result = await core.execute(request.js!, request.paramOverrides, streaming);
      writeEnvelope({ id: request.id, ok: true, result: serializeResult(result) });
    } catch (e: any) {
      // Resolve through core so raw WASM pointers become readable text.
      let message = e?.message ?? String(e);
      try {
        message = core.resolveError(e);
      } catch { /* fall back to the plain message */ }
      writeEnvelope({ id: request.id, ok: false, error: message, stack: e?.stack });
      // A WASM-level failure may have poisoned the OCCT heap (Bug #1 in the
      // engine): every subsequent execute on this instance would corrupt.
      // Exit 5 so the parent respawns a fresh child instead of reusing a
      // poisoned one. The response has already been written, so the parent
      // sees the error message first; the respawn is silent.
      const wasmSignaturePattern = /OCCT exception|memory access out of bounds|table index is out of bounds|unreachable executed/i;
      const isRawPointerThrow = typeof e === "number" || typeof e === "bigint";
      if (
        isRawPointerThrow ||
        (typeof message === "string" && wasmSignaturePattern.test(message))
      ) {
        process.stderr.write("[shapeitup-exec] WASM-level failure — exiting so the parent respawns a fresh OCCT instance\n");
        process.exit(5);
      }
      // Plain user-script error: heap is fine, keep serving.
    }
  }
}
