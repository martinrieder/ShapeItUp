/**
 * Environment for the MCP server spawned by the VS Code extension.
 *
 * The extension launches the bundled MCP server (`dist/mcp-server.mjs`) via
 * VS Code's McpStdioServerDefinition; the server reads
 * `SHAPEITUP_MCP_EXEC_SIDECAR` to decide whether shape execution runs in the
 * crash-isolated sidecar child (see docs/sidecar-exec.md). This module is
 * the single place that maps the user's `shapeitup.mcpExecSidecar` setting
 * onto that env var — kept pure (no vscode import) so it is unit-testable
 * without an extension host.
 */

export const MCP_EXEC_SIDECAR_ENV = "SHAPEITUP_MCP_EXEC_SIDECAR";

/** The vscode settings reader shape this module needs — a subset, so tests
 * can pass a plain object without importing vscode. */
export interface SettingsReader {
  get(section: string): { get<T>(key: string, defaultValue?: T): T } | undefined;
}

/**
 * Build the env var map for the spawned MCP server. Returns an empty object
 * when the sidecar is off (the default) so the server's environment stays
 * untouched in the default install. `SHAPEITUP_MCP_EXEC_SIDECAR=1` enables
 * sidecar-routed execution for the render/export/sim tool paths.
 *
 * Accepts a workspace-configuration factory like `vscode.workspace.getConfiguration`
 * so callers can inject the real one at the call site and tests a stub.
 */
export function mcpServerEnv(
  getConfiguration: (section: string) => { get<T>(key: string, defaultValue?: T): T } | undefined,
  env: NodeJS.ProcessEnv = {},
): Record<string, string> {
  const shapeitup = getConfiguration("shapeitup");
  const enabled = shapeitup?.get<boolean>("mcpExecSidecar", false) === true;
  if (!enabled) return {};
  return { [MCP_EXEC_SIDECAR_ENV]: "1" };
}
