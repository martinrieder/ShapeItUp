# Sidecar execution (`--shapeitup-exec`)

**Status:** implemented for MCP-only mode. Opt-in via `SHAPEITUP_MCP_EXEC_SIDECAR=1`.

## Why

`.shape.ts` files are user/agent-authored code. Until now, every MCP render
executed that code **in-process** inside the MCP server — the same process that
owns the JSON-RPC channel, the subscriber-bus WebSocket, and all engine state.
Two consequences:

1. **Security:** a shape file runs with the full Node privileges of the MCP
   server process (fs, network, child processes, native addons).
2. **Robustness:** an OCCT WASM crash (segfault, heap poisoning, OOM) or an
   infinite loop in a script killed or wedged the whole server. This is a real
   bug class for OCCT WASM — the engine already carries Bug #1 mitigations
   (`resetCore`) for in-process heap poisoning.

The sidecar fixes (2) completely and meaningfully constrains (1).

## Design — self-re-exec pattern

The parent MCP server spawns **its own already-resolved entry** in an exec
role. No new package, no second artifact to keep in version sync — the
tarball, the VS Code extension bundle, and `npx` all re-exec the same file.

```
MCP server (parent, trusted)                 exec child (unprivileged, disposable)
┌────────────────────────────────┐           ┌────────────────────────────────┐
│ MCP JSON-RPC on stdio           │           │ same dist/index.js, exec role │
│ esbuild-wasm bundling + caches  │  bundle → │ node --no-addons               │
│ path probing, tools/list        │  stdin    │   --max-old-space-size=2048   │
│ export writes, status files     │           │   [--experimental-permission   │
│ resvg PNG render (parent-side)  │ ← meshes/ │    + scoped --allow-fs-read]   │
│ heartbeat, subscriber bus       │  stdout   │ loadOCCTNode + core.execute   │
└────────────────────────────────┘           └────────────────────────────────┘
```

**Division of labor** (everything risky-to-lose stays in the parent):

- Parent keeps: bundling, bundle/mesh caches, status files, export writes,
  PNG rendering, MCP protocol, subscriber bus.
- Child does exactly one thing: load OCCT once, evaluate bundled scripts,
  tessellate, return serialized parts. It never writes a file, never spawns,
  never touches the protocol.
- Exports stay parent-side: the child returns serialized parts (meshes, no
  live OCCT handles); the parent owns every `writeFileSync`. The child's
  read scope is allowlist-only.

**Protocol:** length-prefixed JSON envelopes (`b'<len>\n<body>'`) on
stdin/stdout; stderr passes through for diagnostics. Requests are a
discriminated union on a REQUIRED `kind` (the child rejects kind-less
requests as protocol errors, exit 3): `render` (bundle + params → serialized
parts; the PRODUCER half of the child-side shape cache) and `export` (format
+ optional part name / split flag → base64 STEP/STL/3MF bytes; the CONSUMER
half). `render` matches the tool vocabulary the agent already sees. Both
peers ship in the same file, so protocol evolution is atomic — no
version-skew window, no compatibility shim. Meshes serialize as
base64 typed arrays; the parent restores `Float32Array`/`Uint32Array` views.

**Child-side export:** `core.exportLast*` serializes the shapes owned by the
process that ran the most recent execute. When that was the child, the
engine's `lastExecuteWasSidecar` tracking routes the export request to the
same child over the envelope protocol; the parent receives bytes and does
the only `writeFileSync`. This keeps the child read-only (it produces bytes,
the parent writes them) while making exports ride the sidecar — including
`export_shape`, whose re-execute-then-export flow runs entirely child-side in
sidecar mode. A child with no prior execute returns `ok:false` ("no shape
executed"), which the parent's re-execute-before-export contract makes rare.

**Child-side shape cache (skipping the re-execute):** the child-side analog
of the parent's `liveForceCache`, relocated to where the shapes actually
live. The engine records each sidecar execute's identity —
`(file, sourceHash, paramsKey)` — on both sides. An export request carries
the expected identity plus the bundle as a fallback; when the child's last
execute matches exactly, it serializes the shapes it already holds and
skips the round-trip entirely. Two freshness guarantees keep it honest:

1. **Source re-verification at export time** — the engine re-reads the file
   from disk before offering the match-spec; an edit between render and
   export invalidates it.
2. **Direct-call refresh** — when `exportLast*` is invoked without a
   preceding re-execute (`verify_design` does this) and the file has
   changed, the engine re-bundles the CURRENT source and re-executes via
   the sidecar before exporting. The stale fallback bundle alone would
   re-run the old source — a bundle is a snapshot, so freshness requires
   a fresh bundle.

In the common `export_shape` flow the preceding re-execute already refreshed
both sides, so the export lands as a pure cache hit: one OCCT round-trip
saved per back-to-back modify→export.

**Viewer hand-off (headless proof):** the screenshot pipeline that
`open_shape(capture:true)`, `tune_params`, and `render_preview` feed —
`renderPartsToSvg` → `svgToPng` (resvg WASM) — is a pure mesh consumer: it
reads `vertices`/`triangles`/`color` per part and never dereferences a live
OCCT handle. When the VS Code extension is running, the interactive viewer
is unaffected by the sidecar (the extension's webview worker re-executes the
file itself in the browser); when it isn't, this headless pipeline IS the
viewer hand-off. The behavior is proven by a pixel-parity test: the same
shape executed in-process and via the sidecar produces **byte-identical
rasterized PNGs** through the real pipeline — and the sidecar parts are
asserted handle-free (`p.shape === undefined`) before rendering, pinning
the mesh-only contract the screenshot path depends on.

**Lifecycle:** one persistent child per parent, reused across renders (an
OCCT WASM boot costs ~3 s once, not per render). The child serves requests
until stdin EOF (exit 0). Timeout (120 s, SIGKILL), memory cap (2 GB), and
crash respawn are enforced by the parent.

**Pre-warm (`prewarmExecChild`):** because the child is a separate process,
the parent spawns it in the background the moment the MCP server is up —
while the client is still reading `tools/list` and deciding what to call.
The ~3 s OCCT WASM compile happens in the child during those idle seconds,
so the first sidecar-routed render arrives to a warm engine and completes
without the boot cost. In-process warm-up cannot do this trick: the compile
would block the parent's event loop and delay `initialize`. The process
boundary is what makes the warm-up free. Wired in `index.ts` whenever
`SHAPEITUP_MCP_EXEC_SIDECAR=1` is set; failures are non-fatal (logged to
stderr, next render spawns lazily).

## Exit-code vocabulary

| Code | Meaning | Parent behavior |
|---|---|---|
| 0 | stdin EOF — clean teardown | none (smoke tests rely on this) |
| 2 | exec role crashed at startup | surface as spawn error |
| 3 | protocol error (bad envelope) | surface as protocol error |
| 4 | OCCT init failed in the child | surface as OCCT init failure |
| 5 | WASM-level failure after response written, or script crash | respawn fresh child on next request |
| script error | `ok:false` response (exit stays 0 in the persistent loop) | surface as user-script error, child keeps serving |

## Permission model — probe and degrade

Node's `--experimental-permission` with scoped `--allow-fs-read` allowlists
(workspace roots + WASM locations + the entry's own directory) is applied
**only when the real entry can actually boot under the flag set**. The probe
execs the entry itself (stdin closed = immediate exit 0); a probe failure
means Node needs module-resolution reads outside the allowlist (observed in
practice with pnpm's symlinked `.pnpm` store), and a child that can't boot
is worse than no flags — every render would fail. So the runner degrades to
the process boundary alone and logs that on stderr.

`--no-addons` and the memory cap are unconditional: they don't affect boot.
`SHAPEITUP_MCP_EXEC_PERMS=1` forces permission flags on (Tier-2 debugging);
`=0` forces them off.

**Honest scope:** this is crash/OOM/timeout isolation plus a coarse
permission fence, not a full security boundary. The permission model is
still experimental, and OCCT's WASM memory is not sandboxed by it. A hostile
shape file that runs while permission flags are active cannot write files,
spawn processes, or load native addons, and can read only the allowlisted
paths. Without flags, the child still cannot kill the parent.

## Enabling it

```bash
SHAPEITUP_MCP_EXEC_SIDECAR=1 npx -y @shapeitup/mcp-server
```

VS Code extension users: enable the **`shapeitup.mcpExecSidecar`** setting
(Settings → ShapeItUp) — the extension passes the env var to the spawned
server automatically.

Currently opted in (all env-gated via `SHAPEITUP_MCP_EXEC_SIDECAR=1`):

- `modify_shape`'s plain-render path — status only
- `export_shape` — exports serialize in the child (bytes returned, parent writes)
- `open_shape` — status + screenshot (the SVG/resvg pipeline reads mesh
  vertices/triangles, never live handles)
- `tune_params` — status + screenshot, same shape as `open_shape`
- `render_preview` — **only without a finder**: plain renders are status +
  mesh; a finder pass needs live OCCT shape refs, so `force` and `sidecar`
  are mutually exclusive by construction there
- `run_simulation` — the sim path dereferences only `parts[].vertices`
  (rest AABBs) and the serializable `sim` block; its `force: true` is mesh
  freshness, not live handles, so it composes with the sidecar
- the audit-stack tool — its own comment documents it reads vertex arrays
  only, so it rides the sidecar too
- `get_render_status` executes nothing (reads the status file), so there is
  nothing to opt in
- `verify_design` — the one-call verification battery (render, collisions,
  sim-block detection, STEP export round-trip) routes its render and export
  through the sidecar when enabled
- `preview_shape` — inline snippets render through the sidecar; the
  screenshot path reads the outcome's OWN parts (sidecar executes leave the
  engine's in-process `lastParts` empty — the naive `getLastParts()` read
  would silently skip screenshots)
- `validate_joints` — `extractJoints` reads only tessellated vertex arrays
  (never live OCCT handles), so it rides the sidecar; joint maps travel with
  the serialized parts

Tools that still need parent-side live handles — `check_collisions`,
`preview_finder` with a finder, `sweep_check`, `verify_shape`,
`describe_geometry` — stay in-process by design: they call `core.execute`
directly via `getCore()` (exact `.shape.intersect()` / `.faces` /
`.edges` dereferences that only exist in the executing process).

`executeWithPersistedParams` never records sidecar outcomes into
`liveForceCache` (the live-parts fast path): sidecar parts carry meshes but
no `.shape` handles, and recording them would shadow a real in-process
entry for the same key. The fast path's shape-guard rejects them anyway; not
recording them keeps the cache semantically clean.

## Implementation map

| File | Role |
|---|---|
| `packages/mcp-server/src/exec-child.ts` | Child role: envelope framing, OCCT boot, request loop, mesh serialization, exit codes |
| `packages/mcp-server/src/exec-runner.ts` | Parent side: child pool (spawn/respawn/kill), timeout, memory cap, permission probe, `ExecRunnerError` vocabulary |
| `packages/mcp-server/src/engine.ts` | `executeShapeFile({ sidecar: true })` branch; shared success assembly in `finishExecuteOutcome`; `lastExecuteWasSidecar` routes `exportLast*` to the child |
| `packages/mcp-server/src/index.ts` | Role branch (`--shapeitup-exec` / `SHAPEITUP_EXEC_ROLE=1`) before MCP/bus init; pre-warms the sidecar child after startup when the sidecar is enabled |
| `packages/mcp-server/src/exec-runner.test.ts` | 15 end-to-end tests: protocol, real OCCT render through the child, mesh round-trip, error vocabulary, infinite-loop kill with parent survival, in-process/sidecar parity, child persistence, background pre-warm, child-side STEP export, child-side split STL export, tool-path parity across all opted-in call shapes (plain / param-override / force+full-stats), screenshot pixel-parity from sidecar parts (byte-identical PNGs, handle-free contract) |

## Verification results

- 15 end-to-end tests pass (real OCCT geometry through the child, ~3 s boot
  amortized across renders — second render < 2 s against the pooled child;
  pre-warmed child serves the first render with the boot cost already spent;
  sidecar exports produce valid artifacts — STEP verified by ISO-10303-21
  header, split STL one-file-per-part with per-part sizes; the screenshot
  pipeline fed sidecar parts rasterizes byte-identical to in-process parts)
- Full suite: 1232+ tests pass; `pnpm lint`, `pnpm build` clean
- WASM-poisoning path manually verified: raw-pointer throw writes the error
  response, then the child exits 5 so the parent respawns a fresh OCCT

## Future work

- Windows: validate `--allow-fs-read` path handling (drive letters, spaces)
- OS-level resource limits (RLIMIT/cgroups) as Tier 3

## The `verify_design` tool

One MCP call, one acceptance gate: `verify_design` runs the verification
battery on a shape file — render (script executes, geometry valid,
printability warnings), collisions (unexpected part overlaps, honoring a
colocated `export const expectedContacts`), simulation (whether the file
declares a `sim` block with self-test assertions; `run_simulation` executes
the full study), and a STEP export round-trip. The battery lives in
`verify-design.ts` as a PURE function (`verifyDesign`) with the MCP tool as
a thin wrapper — so a future CLI entry for CI (exit codes, JSON output) is
an additive wrapper over the same function, not a refactor. It rides the
sidecar for render and export when enabled, inheriting crash isolation.
