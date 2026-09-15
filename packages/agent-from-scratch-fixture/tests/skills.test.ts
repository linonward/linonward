import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  discoverSkills,
  selectSkillCatalog,
  skillCatalogAsContextSource,
} from "../src/skill-catalog.js";
import { activateSkill, loadSkillResource } from "../src/skill-runtime.js";
import type { SkillState, SkillSummary } from "../src/types.js";
import { makeTempDir, removeTempDir } from "./support.js";

const packageSkills = fileURLToPath(new URL("../skills", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeTempDir(directory)));
});

async function tempDir(): Promise<string> {
  const directory = await makeTempDir("agent-skills-");
  temporaryDirectories.push(directory);
  return directory;
}

async function writeSkill(
  root: string,
  folder: string,
  frontmatterName: string,
  body = "# Skill\n\n1. Read `references/checklist.md`.\n",
): Promise<void> {
  const skillRoot = join(root, folder);
  await mkdir(join(skillRoot, "references"), { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${frontmatterName}\ndescription: A repository audit skill for offline tests.\n---\n\n${body}`,
    "utf8",
  );
}

function stateWith(catalog: SkillSummary[]): SkillState {
  return { catalog, activeSkills: {} };
}

describe("progressive skill loading", () => {
  it("does not expose skill instructions before activation", async () => {
    const catalog = await discoverSkills(packageSkills);
    const source = skillCatalogAsContextSource(catalog);

    expect(source.content).toContain("repository-audit");
    expect(source.content).toContain("Audit a repository");
    expect(source.content).not.toContain("Read `references/checklist.md`");
    expect(source.content).not.toContain("Repository structure");
  });

  it("loads only the selected skill and the requested resource", async () => {
    const catalog = await discoverSkills(packageSkills);
    const state = stateWith(catalog);

    const active = await activateSkill("repository-audit", state, 64_000);
    expect(active.instructions).toContain("references/checklist.md");
    expect(Object.keys(state.activeSkills)).toEqual(["repository-audit"]);

    const resource = await loadSkillResource({
      skillName: "repository-audit",
      resourcePath: "references/checklist.md",
      state,
      maxResourceBytes: 32_000,
    });
    expect(resource.content).toContain("Repository structure");
    expect(resource.cached).toBe(false);

    const again = await loadSkillResource({
      skillName: "repository-audit",
      resourcePath: "references/checklist.md",
      state,
    });
    expect(again.cached).toBe(true);
  });

  it("refuses resources for skills that were never activated", async () => {
    const state = stateWith(await discoverSkills(packageSkills));

    await expect(
      loadSkillResource({
        skillName: "repository-audit",
        resourcePath: "references/checklist.md",
        state,
      }),
    ).rejects.toThrow("skill_not_active");
  });

  it("refuses scripts, binary resources and oversize resources", async () => {
    const root = await tempDir();
    await writeSkill(root, "repository-audit", "repository-audit");
    await mkdir(join(root, "repository-audit", "scripts"), { recursive: true });
    await writeFile(
      join(root, "repository-audit", "scripts", "collect.ts"),
      "export {};\n",
      "utf8",
    );
    await mkdir(join(root, "repository-audit", "assets"), { recursive: true });
    await writeFile(join(root, "repository-audit", "assets", "data.bin"), "binary", "utf8");
    await writeFile(
      join(root, "repository-audit", "references", "huge.md"),
      "x".repeat(4096),
      "utf8",
    );

    const state = stateWith(await discoverSkills(root));
    await activateSkill("repository-audit", state, 8_192);

    await expect(
      loadSkillResource({
        skillName: "repository-audit",
        resourcePath: "scripts/collect.ts",
        state,
      }),
    ).rejects.toThrow("resource_type_not_loadable");
    await expect(
      loadSkillResource({ skillName: "repository-audit", resourcePath: "assets/data.bin", state }),
    ).rejects.toThrow("binary_resource_denied");
    await expect(
      loadSkillResource({
        skillName: "repository-audit",
        resourcePath: "references/huge.md",
        state,
        maxResourceBytes: 16,
      }),
    ).rejects.toThrow("skill_resource_too_large");
  });

  it("refuses resource paths that escape the skill root", async () => {
    const root = await tempDir();
    await writeSkill(root, "repository-audit", "repository-audit");
    const outside = await tempDir();
    await writeFile(join(outside, "secret.md"), "top secret", "utf8");
    await symlink(
      join(outside, "secret.md"),
      join(root, "repository-audit", "references", "link.md"),
    );

    const state = stateWith(await discoverSkills(root));
    await activateSkill("repository-audit", state, 8_192);

    await expect(
      loadSkillResource({
        skillName: "repository-audit",
        resourcePath: "references/link.md",
        state,
      }),
    ).rejects.toThrow("skill path escapes its catalog root");
    await expect(
      loadSkillResource({
        skillName: "repository-audit",
        resourcePath: "../outside.md",
        state,
      }),
    ).rejects.toThrow("resource_type_not_loadable");
  });

  it("rejects skill folders whose name differs from the frontmatter", async () => {
    const root = await tempDir();
    await writeSkill(root, "wrong-folder", "repository-audit");

    await expect(discoverSkills(root)).rejects.toThrow("skill folder and name must match");
  });

  it("rejects a skill whose SKILL.md escapes the catalog root via a symlink", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeSkill(outside, "repository-audit", "repository-audit");
    await symlink(join(outside, "repository-audit"), join(root, "repository-audit"));

    await expect(discoverSkills(root)).rejects.toThrow("skill path escapes its catalog root");
  });

  it("trims the catalog deterministically when summaries exceed the budget", async () => {
    const catalog: SkillSummary[] = ["alpha", "bravo", "charlie"].map((name) => ({
      name,
      description: `${name} description long enough to pass validation`,
      root: `/skills/${name}`,
      entryPath: `/skills/${name}/SKILL.md`,
    }));

    const selected = selectSkillCatalog(catalog, 100);
    expect(selected.map((skill) => skill.name)).toEqual(["alpha"]);
    expect(selectSkillCatalog(catalog, 100).map((skill) => skill.name)).toEqual(["alpha"]);
    expect(selectSkillCatalog(catalog).map((skill) => skill.name)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
  });

  it("rejects a skill larger than the activation limit", async () => {
    const root = await tempDir();
    await writeSkill(root, "repository-audit", "repository-audit", "x".repeat(4096));
    const state = stateWith(await discoverSkills(root));

    await expect(activateSkill("repository-audit", state, 32)).rejects.toThrow("skill_too_large");
    expect(state.activeSkills["repository-audit"]).toBeUndefined();
  });

  it("returns an empty catalog when the skills directory does not exist", async () => {
    const root = await tempDir();
    await expect(discoverSkills(join(root, "missing"))).resolves.toEqual([]);
  });
});
