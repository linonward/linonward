import { z } from "zod";

import { activateSkill, loadSkillResource } from "./skill-runtime.js";
import { defineTool } from "./tool.js";

/**
 * 内部工具：只接受 catalog 中已有的名称，加载完整 `SKILL.md`。
 * 它的 observation 进入下一轮上下文，同时 Harness 会把指令保存成
 * `kind: "skill_instructions"` 的 ContextSource。
 */
export const loadSkillTool = defineTool({
  name: "load_skill",
  description: "Load the complete instructions for one available skill before using it.",
  effect: "read",
  schema: z.object({ name: z.string().min(1) }).strict(),
  async execute({ name }, context) {
    const skill = await activateSkill(name, context.skills, context.maxSkillBytes);
    context.emit({ type: "skill_loaded", name });
    return { name, instructions: skill.instructions };
  },
});

/**
 * 第二个内部工具：只允许读取已激活 Skill 内的相对路径。
 * `scripts/` 被明确拒绝——读取脚本与执行脚本永远不能合并成一个隐式动作。
 */
export const loadSkillResourceTool = defineTool({
  name: "load_skill_resource",
  description: "Load one text reference or asset from an already active skill.",
  effect: "read",
  schema: z.object({ skillName: z.string().min(1), resourcePath: z.string().min(1) }).strict(),
  async execute(input, context) {
    const resource = await loadSkillResource({
      skillName: input.skillName,
      resourcePath: input.resourcePath,
      state: context.skills,
    });
    context.emit({ type: "skill_resource_loaded", ...input });
    return { path: resource.path, content: resource.content, cached: resource.cached };
  },
});
