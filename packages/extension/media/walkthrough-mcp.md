# Install ShapeItUp for your AI assistant

ShapeItUp already works inside **VS Code Copilot Agent Mode** — no setup
needed. For other AI clients (Claude Code, Cursor, Claude Desktop, Gemini
CLI, Mistral Vibe), use the command below.

Run `ShapeItUp: Install MCP Server…` from the Command Palette
(`Cmd/Ctrl+Shift+P`) and pick your client. We'll copy the right command to
your clipboard, open a one-click install deep link, or, for Mistral Vibe, show
you exactly what we'd add to `~/.vibe/config.toml` — we never write to your
config without asking.

The simplest path: pick **"Copy AI install prompt URL"**, then paste into any
agentic CLI. The agent will detect your clients and install ShapeItUp for
you, with your approval at each step.

## Optional: crash-isolated execution (sidecar)

Shape scripts are code, and a crashing one shouldn't take the geometry
engine down with it. Enable **`shapeitup.mcpExecSidecar`** in Settings to
run shape execution in a separate, permission-restricted child process:

- a crashing or looping script kills only the child — the server respawns
  it and keeps serving
- the first render is fast: the engine warms up in the background while
  your AI client is still reading the tool list
- exports, screenshots, and simulations all work unchanged

Off by default while it soaks. Details and the trust model:
`docs/sidecar-exec.md` in the repository.
