import { describe, expect, it } from "vitest";

import { codeText, lessonSource, listProp, stepIds } from "./support/lesson-source";

const source = lessonSource("progressive-skills");
const code = codeText(source);

describe("progressive skills lesson", () => {
  it("keeps the three-layer loading anchors", () => {
    expect(stepIds(source)).toEqual([
      "define-skill-levels",
      "define-skill-contract",
      "scan-skill-metadata",
      "select-and-load-skill",
      "load-skill-resource",
      "connect-skills-to-loop",
      "test-progressive-loading",
    ]);
  });

  it("loads metadata, instructions, and resources in separate stages", () => {
    for (const marker of [
      "SkillSummary",
      "load_skill",
      "load_skill_resource",
      "activeSkills",
      "skill_resource_loaded",
      "realpath",
    ]) {
      expect(code, `skills lesson should keep ${marker}`).toContain(marker);
    }
  });

  it("declares the skill runtime modules and the sample skill", () => {
    const files = listProp(source, "LessonOverview", "files");

    expect(files).toContain("src/skill-catalog.ts");
    expect(files).toContain("src/skill-runtime.ts");
    expect(files).toContain("tests/skills.test.ts");
    expect(files.some((file) => file.startsWith("skills/"))).toBe(true);
  });
});
