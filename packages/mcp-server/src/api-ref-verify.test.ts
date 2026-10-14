/** Tests for the verification API-reference category (verify_design et al). */
import { describe, it, expect } from "vitest";
import { getApiReference } from "./tools.js";

describe("verification API reference category", () => {
  it("exists and documents verify_design", () => {
    const text = getApiReference("verification");
    expect(text).toContain("verify_design");
    expect(text).toContain("acceptance gate");
    expect(text).toContain("expectedContacts");
    expect(text).toContain("run_simulation");
  });

  it("documents the full gate toolset and the author-declared concept", () => {
    const text = getApiReference("verification");
    for (const tool of ["check_collisions", "sweep_check", "validate_joints", "describe_geometry"]) {
      expect(text).toContain(tool);
    }
    expect(text).toContain("Author-declared");
  });
});
