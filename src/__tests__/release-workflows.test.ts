import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const release = readFileSync(
  resolve(__dirname, "../../.github/workflows/publish-release.yml"),
  "utf8",
);
const standalonePytestPublish = resolve(__dirname, "../../.github/workflows/publish-pytest.yml");
const unitTests = readFileSync(resolve(__dirname, "../../.github/workflows/test-unit.yml"), "utf8");

describe("release workflow sequencing", () => {
  it("publishes pytest only from the Release workflow after npm", () => {
    const pytestJob = release.slice(release.indexOf("  publish-pytest:"));
    expect(pytestJob).toContain("needs: [build, publish]");
    expect(pytestJob).toContain("environment: pypi");
    // Behaviour of this gate — including that it retries npm rather than
    // racing it — lives in npm-publish-verify-workflow.test.ts, which executes
    // the step's own run body. This only pins the sequencing claim.
    expect(pytestJob).toContain('npm view "${PKG}@${VERSION}" version');
    expect(existsSync(standalonePytestPublish)).toBe(false);
  });
});

describe("unit-test CLI coverage", () => {
  it("builds the CLI before running the unit suite", () => {
    expect(unitTests.indexOf("pnpm build")).toBeGreaterThan(-1);
    expect(unitTests.indexOf("pnpm build")).toBeLessThan(unitTests.indexOf("pnpm test"));
  });
});
