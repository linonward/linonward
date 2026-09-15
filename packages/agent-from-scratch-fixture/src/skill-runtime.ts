import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { assertInsideSkillRoot, parseSkillDocument } from "./skill-catalog.js";
import type { ActiveSkill, SkillState } from "./types.js";

export const ALLOWED_RESOURCE_ROOTS: ReadonlySet<string> = new Set(["references", "assets"]);
export const DEFAULT_MAX_RESOURCE_BYTES = 32_000;

/**
 * 加载完整 `SKILL.md`。指令不按字符截断——截断可能丢掉关键约束；
 * 超出独立上限时明确失败并要求拆分 Skill。
 */
export async function activateSkill(
  name: string,
  state: SkillState,
  maxSkillBytes: number,
): Promise<ActiveSkill> {
  const cached = state.activeSkills[name];
  if (cached) return cached;

  const summary = state.catalog.find((skill) => skill.name === name);
  if (!summary) throw new Error(`unknown skill: ${name}`);

  const source = await readFile(summary.entryPath, "utf8");
  if (Buffer.byteLength(source) > maxSkillBytes) throw new Error("skill_too_large");

  const { metadata, body } = parseSkillDocument(source);
  if (metadata.name !== summary.name) throw new Error("skill metadata changed after discovery");

  const active: ActiveSkill = { name, instructions: body.trim(), loadedResources: {} };
  state.activeSkills[name] = active;
  return active;
}

/** 只允许读取已激活 Skill 内 `references/` 或 `assets/` 中的文本资源。 */
export async function loadSkillResource(input: {
  skillName: string;
  resourcePath: string;
  state: SkillState;
  maxResourceBytes?: number | undefined;
}): Promise<{ path: string; content: string; cached: boolean }> {
  const active = input.state.activeSkills[input.skillName];
  if (!active) throw new Error("skill_not_active");

  const summary = input.state.catalog.find((skill) => skill.name === input.skillName);
  if (!summary) throw new Error("unknown_skill");

  const firstSegment = input.resourcePath.split(/[\\/]/)[0];
  if (!firstSegment || !ALLOWED_RESOURCE_ROOTS.has(firstSegment)) {
    throw new Error("resource_type_not_loadable");
  }

  let target: string;
  try {
    target = await realpath(join(summary.root, input.resourcePath));
  } catch {
    throw new Error("resource_not_found");
  }

  assertInsideSkillRoot(summary.root, target);
  if (!/\.(md|txt|json|ya?ml)$/i.test(target)) throw new Error("binary_resource_denied");

  const info = await stat(target);
  const maxResourceBytes = input.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES;
  if (info.size > maxResourceBytes) throw new Error("skill_resource_too_large");

  const cached = active.loadedResources[input.resourcePath];
  if (cached !== undefined) return { path: input.resourcePath, content: cached, cached: true };

  const content = await readFile(target, "utf8");
  active.loadedResources[input.resourcePath] = content;
  return { path: input.resourcePath, content, cached: false };
}
