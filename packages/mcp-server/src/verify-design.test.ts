/**
 * Tests for the verify_design battery — the pure verifyDesign() function,
 * not the MCP wrapper (which is a thin safeHandler + formatVerifyReport call).
 *
 * Covers: passing design, failing render, unexpected collision detection,
 * expectedContacts acceptance (colocated + call-time), single-part skip,
 * sim-block detection, export round-trip, skip flags, and report formatting.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyDesign, formatVerifyReport, type VerifyDesignResult } from "./verify-design.js";

function withShape(content: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "siu-vfy-"));
  const file = join(dir, "part.shape.ts");
  writeFileSync(file, content);
  return { dir, file };
}

describe("verifyDesign battery", () => {
  it(
    "passing single-part design: render + export pass, collisions/sim skipped honestly",
    async () => {
      const { dir, file } = withShape(
        `import { makeCylinder } from "replicad";\nexport default function main() {\n  return [{ shape: makeCylinder(5, 10), name: "body" }];\n}\n`,
      );
      const result = await verifyDesign(file);
      const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
      expect(byName.render.status).toBe("pass");
      expect(byName.collisions.status).toBe("skipped");
      expect(byName.collisions.detail).toMatch(/single-part/);
      expect(byName.simulation.status).toBe("skipped");
      expect(byName.export.status).toBe("pass");
      expect(byName.export.detail).toMatch(/STEP round-trip ok/);
      expect(result.ok).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    },
    120_000,
  );

  it(
    "failing script: render fails and the battery reports red without running further checks",
    async () => {
      const { dir, file } = withShape(
        `import { makeCylinder } from "replicad";\nexport default function main() {\n  throw new Error("deliberate failure");\n}\n`,
      );
      const result = await verifyDesign(file);
      expect(result.ok).toBe(false);
      expect(result.checks.length).toBe(1);
      expect(result.checks[0].name).toBe("render");
      expect(result.checks[0].status).toBe("fail");
      expect(result.checks[0].detail).toMatch(/deliberate failure/);
      rmSync(dir, { recursive: true, force: true });
    },
    120_000,
  );

  it(
    "unexpected collision fails the battery; colocated expectedContacts accepts it",
    async () => {
      // Two overlapping cylinders — unexpected overlap.
      const overlapSrc = `import { makeCylinder } from "replicad";\nexport default function main() {\n  return [\n    { shape: makeCylinder(5, 10), name: "post" },\n    { shape: makeCylinder(5, 10).translate(3, 0, 0), name: "clip" },\n  ];\n}\n`;
      const bad = withShape(overlapSrc);
      const badResult = await verifyDesign(bad.file);
      const badCol = badResult.checks.find((c) => c.name === "collisions");
      expect(badCol?.status).toBe("fail");
      expect(badCol?.detail).toMatch(/post↔clip/);
      expect(badResult.ok).toBe(false);
      rmSync(bad.dir, { recursive: true, force: true });

      // Same geometry, but the design declares the contact expected — pass.
      const okShape = withShape(
        overlapSrc.replace(
          "export default function",
          "export const expectedContacts = [[\"post\", \"clip\"]];\nexport default function",
        ),
      );
      const okResult = await verifyDesign(okShape.file);
      const okCol = okResult.checks.find((c) => c.name === "collisions");
      expect(okCol?.status).toBe("pass");
      expect(okCol?.detail).toMatch(/accepted/);
      expect(okResult.ok).toBe(true);
      rmSync(okShape.dir, { recursive: true, force: true });
    },
    180_000,
  );

  it(
    "call-time acceptedPairs accept an overlap without touching the file",
    async () => {
      const { dir, file } = withShape(
        `import { makeCylinder } from "replicad";\nexport default function main() {\n  return [\n    { shape: makeCylinder(5, 10), name: "post" },\n    { shape: makeCylinder(5, 10).translate(3, 0, 0), name: "clip" },\n  ];\n}\n`,
      );
      const result = await verifyDesign(file, { acceptedPairs: [["post", "clip"]] });
      const col = result.checks.find((c) => c.name === "collisions");
      expect(col?.status).toBe("pass");
      expect(result.ok).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    },
    120_000,
  );

  it(
    "sim block detection: a file with `export const sim` reports the simulation check",
    async () => {
      const { dir, file } = withShape(
        `import { makeCylinder } from "replicad";\nexport const sim = {\n  bodies: { "carriage-*": "kinematic" },\n  joints: [{ id: "slide", body: "carriage-*", type: "prismatic", anchor: [0,0,0], axis: [1,0,0] }],\n  actuators: [{ id: "drive", joint: "slide", profile: { kind: "velocity", v: 10 } }],\n  assertions: [{ name: "noHit", kind: "noCollision", a: "carriage-*", b: "bed" }],\n};\nexport default function main() {\n  return [\n    { shape: makeCylinder(5, 10), name: "carriage-body" },\n    { shape: makeCylinder(8, 2).translate(0, 0, 10), name: "bed" },\n  ];\n}\n`,
      );
      const result = await verifyDesign(file);
      const sim = result.checks.find((c) => c.name === "simulation");
      expect(sim?.status).toBe("pass");
      expect(sim?.detail).toMatch(/sim block declared/);
      expect(sim?.detail).toMatch(/1 self-test assertion/);
      rmSync(dir, { recursive: true, force: true });
    },
    120_000,
  );

  it(
    "skip flags: collisions/simulation/export can each be skipped",
    async () => {
      const { dir, file } = withShape(
        `import { makeCylinder } from "replicad";\nexport default function main() {\n  return [{ shape: makeCylinder(5, 10), name: "body" }];\n}\n`,
      );
      const result = await verifyDesign(file, { skip: ["collisions", "simulation", "export"] });
      // Skipped checks still APPEAR in the report (status "skipped") so the
      // agent sees what ran and what didn't — only render executes.
      expect(result.checks.map((c) => c.name)).toEqual(["render", "collisions", "simulation", "export"]);
      expect(result.checks.filter((c) => c.status === "skipped").length).toBe(3);
      expect(result.ok).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    },
    120_000,
  );

  it("formatVerifyReport renders pass and fail verdicts correctly", () => {
    const pass: VerifyDesignResult = {
      file: "/x/bracket.shape.ts",
      checks: [
        { name: "render", status: "pass", detail: "2 part(s)" },
        { name: "export", status: "pass", detail: "STEP round-trip ok (1.2KB)" },
      ],
      ok: true,
    };
    const passText = formatVerifyReport(pass);
    expect(passText).toContain("bracket.shape.ts");
    expect(passText).toContain("✓ render");
    expect(passText).toContain("PASS — all checks green.");

    const fail: VerifyDesignResult = {
      file: "/x/bracket.shape.ts",
      checks: [
        { name: "render", status: "pass", detail: "1 part(s)" },
        { name: "collisions", status: "fail", detail: "1 unexpected overlapping pair(s): post↔clip" },
      ],
      ok: false,
    };
    const failText = formatVerifyReport(fail);
    expect(failText).toContain("✗ collisions");
    expect(failText).toContain("FAIL");
  });

  it("missing file throws a clear error (the tool surfaces it as isError)", async () => {
    await expect(verifyDesign("/nonexistent/thing.shape.ts")).rejects.toThrow(/File not found/);
  });
});
