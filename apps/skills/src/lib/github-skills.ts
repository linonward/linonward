import { cache } from "react";
import { SKILL_STAGES, SKILL_STAGE_BY_SLUG, type SkillStage } from "./catalog";

const REPOSITORY_URL = "https://github.com/linonward/skills";
const RAW_BASE_URL = "https://raw.githubusercontent.com/linonward/skills/main";
const TREE_URL = "https://api.github.com/repos/linonward/skills/git/trees/main?recursive=1";
const CACHE_SECONDS = 21_600;

type GitHubTreeItem = {
  path?: string;
  type?: string;
};

type GitHubTreeResponse = {
  tree?: GitHubTreeItem[];
};

export type PublicSkill = SkillStage & {
  name: string;
  description: string;
  markdown: string;
  sourceUrl: string;
};

export function extractSkillSlugs(paths: readonly string[]): string[] {
  const slugs = paths.flatMap((path) => {
    const match = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/.exec(path);
    return match?.[1] ? [match[1]] : [];
  });

  return [...new Set(slugs)].sort();
}

export function getGitHubFileUrl(slug: string, relativePath: string): string {
  const normalizedPath = relativePath.replace(/^\.\//, "");
  return `${REPOSITORY_URL}/blob/main/skills/${slug}/${normalizedPath}`;
}

export function parseSkillContent(slug: string, source: string): PublicSkill {
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!frontmatterMatch?.[1] || frontmatterMatch[2] === undefined) {
    throw new Error(`Skill ${slug} has invalid frontmatter`);
  }

  const fields = new Map<string, string>();
  for (const line of frontmatterMatch[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    fields.set(key, value);
  }

  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !description) {
    throw new Error(`Skill ${slug} is missing required metadata`);
  }
  if (name !== slug) {
    throw new Error(`Skill name ${name} does not match slug ${slug}`);
  }

  const markdown = frontmatterMatch[2].trim();
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  const stage = SKILL_STAGE_BY_SLUG.get(slug);

  return {
    ...(stage ?? {
      order: Number.MAX_SAFE_INTEGER,
      stage: "扩展",
      slug,
      title: heading ?? name,
      summary: description,
    }),
    name,
    title: heading ?? stage?.title ?? name,
    description,
    markdown,
    sourceUrl: `${REPOSITORY_URL}/blob/main/skills/${slug}/SKILL.md`,
  };
}

export function orderCatalogSkills(skills: readonly PublicSkill[]): PublicSkill[] {
  return [...skills]
    .sort((left, right) => left.order - right.order || left.slug.localeCompare(right.slug))
    .map((skill, index) =>
      skill.order === Number.MAX_SAFE_INTEGER ? { ...skill, order: index + 1 } : skill,
    );
}

function createFallbackSkill(stage: SkillStage): PublicSkill {
  return {
    ...stage,
    name: stage.slug,
    description: stage.summary,
    markdown: `# ${stage.title}\n\n${stage.summary}\n\n[在 GitHub 查看完整 SKILL.md](${REPOSITORY_URL}/blob/main/skills/${stage.slug}/SKILL.md)`,
    sourceUrl: `${REPOSITORY_URL}/blob/main/skills/${stage.slug}/SKILL.md`,
  };
}

async function fetchSkill(slug: string): Promise<PublicSkill> {
  const response = await fetch(`${RAW_BASE_URL}/skills/${slug}/SKILL.md`, {
    next: { revalidate: CACHE_SECONDS },
  });
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for ${slug}`);
  }
  return parseSkillContent(slug, await response.text());
}

export async function getAllSkills(): Promise<PublicSkill[]> {
  let discoveredSlugs: string[] = [];

  try {
    const response = await fetch(TREE_URL, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: CACHE_SECONDS },
    });
    if (response.ok) {
      const payload = (await response.json()) as GitHubTreeResponse;
      discoveredSlugs = extractSkillSlugs(
        payload.tree?.flatMap((item) => (item.type === "blob" && item.path ? [item.path] : [])) ??
          [],
      );
    }
  } catch {
    // The curated stages below keep the public site available during a GitHub outage.
  }

  const slugs = discoveredSlugs.length > 0 ? discoveredSlugs : SKILL_STAGES.map(({ slug }) => slug);
  const settled = await Promise.allSettled(slugs.map((slug) => fetchSkill(slug)));
  const skills = settled.flatMap((result, index) => {
    if (result.status === "fulfilled") return [result.value];
    const slug = slugs[index];
    const fallback = slug ? SKILL_STAGE_BY_SLUG.get(slug) : undefined;
    return fallback ? [createFallbackSkill(fallback)] : [];
  });

  return orderCatalogSkills(skills);
}

async function getSkillUncached(slug: string): Promise<PublicSkill | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;

  try {
    const skill = await fetchSkill(slug);
    if (skill.order !== Number.MAX_SAFE_INTEGER) return skill;

    const catalogSkill = (await getAllSkills()).find((item) => item.slug === slug);
    return catalogSkill ?? { ...skill, order: SKILL_STAGES.length + 1 };
  } catch {
    const fallback = SKILL_STAGE_BY_SLUG.get(slug);
    return fallback ? createFallbackSkill(fallback) : null;
  }
}

export const getSkill = cache(getSkillUncached);
