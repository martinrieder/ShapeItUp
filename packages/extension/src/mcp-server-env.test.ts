/**
 * Unit tests for mcpServerEnv — the pure mapping from the user's
 * shapeitup.mcpExecSidecar setting to the spawned MCP server's environment.
 * Kept vscode-free so it runs without an extension host.
 */
import { describe, it, expect } from "vitest";
import { mcpServerEnv, MCP_EXEC_SIDECAR_ENV } from "./mcp-server-env.js";

function configWith(value: boolean | undefined) {
  return (section: string) => {
    if (section !== "shapeitup") return undefined;
    return {
      get: <T>(_key: string, defaultValue?: T): T =>
        (value === undefined ? defaultValue : value) as T,
    };
  };
}

describe("mcpServerEnv", () => {
  it("returns an empty env map when the setting is off (default install)", () => {
    expect(mcpServerEnv(configWith(false))).toEqual({});
  });

  it("returns an empty env map when the setting is absent", () => {
    expect(mcpServerEnv(configWith(undefined))).toEqual({});
  });

  it("enables the sidecar when the setting is on", () => {
    expect(mcpServerEnv(configWith(true))).toEqual({
      [MCP_EXEC_SIDECAR_ENV]: "1",
    });
  });

  it("tolerates a missing shapeitup configuration section", () => {
    expect(mcpServerEnv(() => undefined)).toEqual({});
  });

  it("emits exactly one env var — nothing else leaks into the server env", () => {
    const env = mcpServerEnv(configWith(true));
    expect(Object.keys(env)).toEqual([MCP_EXEC_SIDECAR_ENV]);
  });
});
