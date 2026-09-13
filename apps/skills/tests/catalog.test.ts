import { describe, expect, it } from "vitest";
import {
  extractSkillSlugs,
  getGitHubFileUrl,
  orderCatalogSkills,
  parseSkillContent,
} from "../src/lib/github-skills";
import {
  CLAUDE_INSTALL_COMMAND,
  CODEX_INSTALL_COMMAND,
  getSkillInstallCommand,
} from "../src/lib/install-commands";

describe("skill catalog", () => {
  it("parses public frontmatter and keeps the markdown body", () => {
    const skill = parseSkillContent(
      "shape-work",
      `---\nname: shape-work\ndescription: Turn fuzzy work into a testable brief.\n---\n\n# Shape Work\n\nBody.`,
    );

    expect(skill).toMatchObject({
      slug: "shape-work",
      name: "shape-work",
      title: "Shape Work",
      description: "Turn fuzzy work into a testable brief.",
    });
    expect(skill.markdown).toContain("# Shape Work");
  });

  it("rejects a skill whose slug and frontmatter name disagree", () => {
    expect(() =>
      parseSkillContent(
        "shape-work",
        `---\nname: another-skill\ndescription: A useful description.\n---\n\n# Shape Work`,
      ),
    ).toThrow("does not match");
  });

  it("discovers only direct public SKILL.md files", () => {
    expect(
      extractSkillSlugs([
        "skills/shape-work/SKILL.md",
        "skills/challenge-plan/SKILL.md",
        "skills/challenge-plan/references/review-lenses.md",
        "README.md",
      ]),
    ).toEqual(["challenge-plan", "shape-work"]);
  });

  it("keeps unknown public skills available as extensions", () => {
    const skill = parseSkillContent(
      "write-wechat",
      `---\nname: write-wechat\ndescription: Write a WeChat article.\n---\n\n# Write WeChat`,
    );

    expect(skill).toMatchObject({
      slug: "write-wechat",
      stage: "扩展",
      title: "Write WeChat",
    });
  });

  it("gives newly discovered extension skills a display order", () => {
    const core = parseSkillContent(
      "shape-work",
      `---\nname: shape-work\ndescription: Shape a request.\n---\n\n# Shape Work`,
    );
    const extension = parseSkillContent(
      "write-wechat",
      `---\nname: write-wechat\ndescription: Write an article.\n---\n\n# Write WeChat`,
    );

    expect(orderCatalogSkills([extension, core]).map(({ slug, order }) => [slug, order])).toEqual([
      ["shape-work", 1],
      ["write-wechat", 2],
    ]);
  });

  it("rewrites relative reference links to the source repository", () => {
    expect(getGitHubFileUrl("challenge-plan", "references/review-lenses.md")).toBe(
      "https://github.com/linonward/skills/blob/main/skills/challenge-plan/references/review-lenses.md",
    );
  });
});

describe("installation commands", () => {
  it("installs every public skill for Codex with the skills CLI", () => {
    expect(CODEX_INSTALL_COMMAND).toBe("npx skills add linonward/skills --skill '*' -g -a codex");
  });

  it("uses the published Claude Code marketplace identifier", () => {
    expect(CLAUDE_INSTALL_COMMAND).toBe(
      "/plugin marketplace add https://github.com/linonward/skills\n/plugin install linonward-skills@linonward",
    );
  });

  it("builds a direct command for one skill", () => {
    expect(getSkillInstallCommand("shape-work")).toBe(
      "npx skills add linonward/skills --skill shape-work",
    );
  });

  it("rejects an unsafe skill slug in an install command", () => {
    expect(() => getSkillInstallCommand("shape-work; echo unsafe")).toThrow("Invalid skill slug");
  });
});
