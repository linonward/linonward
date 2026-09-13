export const CODEX_INSTALL_COMMAND = "npx skills add linonward/skills --skill '*' -g -a codex";

export const CLAUDE_INSTALL_COMMAND = `/plugin marketplace add https://github.com/linonward/skills
/plugin install linonward-skills@linonward`;

export function getSkillInstallCommand(slug: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`Invalid skill slug: ${slug}`);
  }

  return `npx skills add linonward/skills --skill ${slug}`;
}
