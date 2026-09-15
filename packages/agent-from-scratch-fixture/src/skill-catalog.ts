import { open, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

import type { ContextSource } from "./context.js";
import type { SkillState, SkillSummary } from "./types.js";

export const FRONTMATTER_PROBE_BYTES = 16_384;
/** catalog 摘要的总预算，避免能力变多后把上下文挤满。 */
export const SKILL_CATALOG_MAX_CHARACTERS = 4_000;

export const skillMetadataSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(12).max(500),
});

export interface SkillDocument {
  metadata: { name: string; description: string };
  body: string;
}

/** 只读取头部窗口，不读正文、references 或 scripts。 */
export async function readFrontmatter(entryPath: string): Promise<string> {
  const handle = await open(entryPath, "r");
  try {
    const buffer = Buffer.alloc(FRONTMATTER_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.toString("utf8", 0, bytesRead);
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(prefix);
    if (!match?.[1]) throw new Error(`invalid skill frontmatter: ${entryPath}`);
    return match[1];
  } finally {
    await handle.close();
  }
}

export function assertInsideSkillRoot(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error("skill path escapes its catalog root");
  }
}

export function parseSkillDocument(source: string): SkillDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match?.[1]) throw new Error("invalid skill frontmatter");
  const metadata = skillMetadataSchema.parse(parse(match[1]));
  return { metadata, body: source.slice(match[0].length) };
}

/**
 * 只扫描元数据。坏 Skill 不会被静默忽略：frontmatter 无效、
 * 名称与目录名不一致、SKILL.md 指向目录之外都会直接抛错。
 */
export async function discoverSkills(skillsDirectory: string): Promise<SkillSummary[]> {
  let catalogRoot: string;
  try {
    catalogRoot = await realpath(skillsDirectory);
  } catch {
    return [];
  }

  const entries = await readdir(catalogRoot, { withFileTypes: true });
  const catalog: SkillSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const root = await realpath(join(catalogRoot, entry.name));
    assertInsideSkillRoot(catalogRoot, root);

    let entryPath: string;
    try {
      entryPath = await realpath(join(root, "SKILL.md"));
    } catch {
      continue;
    }
    assertInsideSkillRoot(root, entryPath);

    const metadata = skillMetadataSchema.parse(parse(await readFrontmatter(entryPath)));
    if (metadata.name !== entry.name) throw new Error("skill folder and name must match");

    catalog.push({ ...metadata, root, entryPath });
  }

  return catalog.toSorted((left, right) => left.name.localeCompare(right.name));
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** 超出 catalog 预算时按名称顺序确定性裁剪。 */
export function selectSkillCatalog(
  catalog: SkillSummary[],
  maxCharacters = SKILL_CATALOG_MAX_CHARACTERS,
): SkillSummary[] {
  const selected: SkillSummary[] = [];
  let used = 0;

  for (const skill of catalog.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const size = skill.name.length + skill.description.length + 32;
    if (used + size > maxCharacters) continue;
    selected.push(skill);
    used += size;
  }

  return selected;
}

export function skillCatalogAsContextSource(
  catalog: SkillSummary[],
  maxCharacters = SKILL_CATALOG_MAX_CHARACTERS,
): ContextSource {
  const content = selectSkillCatalog(catalog, maxCharacters)
    .map(
      ({ name, description }) =>
        `<skill name="${escapeXml(name)}">${escapeXml(description)}</skill>`,
    )
    .join("\n");

  return {
    id: "available-skills",
    kind: "skill_catalog",
    label: "Available skills",
    content,
    priority: 90,
  };
}

/** 已激活 Skill 的完整指令与按需资源，每轮由 Context Builder 重新带上。 */
export function activeSkillContextSources(skills: SkillState): ContextSource[] {
  const instructions = Object.values(skills.activeSkills).map(
    (skill): ContextSource => ({
      id: `skill:${skill.name}`,
      kind: "skill_instructions",
      label: skill.name,
      content: skill.instructions,
      priority: 96,
    }),
  );
  const resources = Object.values(skills.activeSkills).flatMap((skill) =>
    Object.entries(skill.loadedResources).map(
      ([path, content]): ContextSource => ({
        id: `skill-resource:${skill.name}:${path}`,
        kind: "skill_resource",
        label: `${skill.name}/${path}`,
        content,
        priority: 94,
      }),
    ),
  );

  return [...instructions, ...resources];
}
