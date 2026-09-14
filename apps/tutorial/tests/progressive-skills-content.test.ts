import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../src/content/progressive-skills.mdx", import.meta.url)),
  "utf8",
);

describe("progressive skills lesson", () => {
  it("loads skill metadata, instructions, and resources in separate stages", () => {
    expect(source).toContain('id="define-skill-levels"');
    expect(source).toContain('id="scan-skill-metadata"');
    expect(source).toContain('id="select-and-load-skill"');
    expect(source).toContain('id="load-skill-resource"');
    expect(source).toContain('id="connect-skills-to-loop"');
    expect(source).toContain('id="test-progressive-loading"');
    expect(source).toContain("SkillSummary");
    expect(source).toContain("load_skill");
    expect(source).toContain("load_skill_resource");
    expect(source).toContain("activeSkills");
    expect(source).toContain("skill_resource_loaded");
    expect(source).toContain("realpath");
  });
});
