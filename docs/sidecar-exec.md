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
stdin/stdout; stderr passes through for diagnostics. Meshes serialize as
base64 typed arrays; the parent restores `Float32Array`/`Uint32Array` views.

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

Currently opted in: `modify_shape`'s plain-render path (never dereferences
live OCCT shapes). Tools that need live handles — `export_shape`,
`check_collisions`, `preview_finder` with a finder, `sweep_check` — stay
in-process by design: they call `core.execute` directly via `getCore()`.

## Implementation map

| File | Role |
|---|---|
| `packages/mcp-server/src/exec-child.ts` | Child role: envelope framing, OCCT boot, request loop, mesh serialization, exit codes |
| `packages/mcp-server/src/exec-runner.ts` | Parent side: child pool (spawn/respawn/kill), timeout, memory cap, permission probe, `ExecRunnerError` vocabulary |
| `packages/mcp-server/src/engine.ts` | `executeShapeFile({ sidecar: true })` branch; shared success assembly in `finishExecuteOutcome` |
| `packages/mcp-server/src/index.ts` | Role branch (`--shapeitup-exec` / `SHAPEITUP_EXEC_ROLE=1`) before MCP/bus init; pre-warms the sidecar child after startup when the sidecar is enabled |
| `packages/mcp-server/src/exec-runner.test.ts` | 9 end-to-end tests: protocol, real OCCT render through the child, mesh round-trip, error vocabulary, infinite-loop kill with parent survival, in-process/sidecar parity, child persistence, background pre-warm |

## Verification results

- 9 end-to-end tests pass (real OCCT geometry through the child, ~3 s boot
  amortized across renders — second render < 2 s against the pooled child;
  pre-warmed child serves the first render with the boot cost already spent)
- Full suite: 1232+ tests pass; `pnpm lint`, `pnpm build` clean
- WASM-poisoning path manually verified: raw-pointer throw writes the error
  response, then the child exits 5 so the parent respawns a fresh OCCT

## Future work

- Extend the opt-in to `render_preview`/`open_shape` (same shape as
  `modify_shape`'s render: status-only, no live handles)
- Serialize `exportLast` as child-side bytes (currently parent-side via
  `getCore()`) so exports can ride the sidecar too
- Windows: validate `--allow-fs-read` path handling (drive letters, spaces)
- OS-level resource limits (RLIMIT/cgroups) as Tier 3
