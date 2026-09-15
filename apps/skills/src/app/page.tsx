import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { GitHubIcon } from "@/components/github-icon";
import { InstallPanel } from "@/components/install-panel";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getAllSkills } from "@/lib/github-skills";

export const revalidate = 21_600;

export default async function Home() {
  const skills = await getAllSkills();
  const workflowSkills = skills.filter((skill) => skill.stage !== "扩展");

  return (
    <>
      <SiteHeader />
      <main>
        <section className="hero shell" aria-labelledby="hero-title">
          <div className="hero__copy">
            <h1 id="hero-title">
              把工程判断，
              <span>放进每一次行动。</span>
            </h1>
            <p>
              LinOnward Skills
              是一套面向独立开发者与小团队的开源工程决策技能集。用清晰的步骤、可执行的检查点和工程化的思维，帮助你在不确定中做出更好的判断。
            </p>
            <div className="hero__actions">
              <a className="button button--primary" href="#skills">
                浏览 Skills <ArrowRight aria-hidden="true" />
              </a>
              <a className="button button--secondary" href="#install">
                安装
              </a>
            </div>
          </div>
          <aside className="hero__aside" aria-label="项目理念">
            <p className="code-comment">{"// Better judgment"}</p>
            <p className="code-comment">{"// Builds better software."}</p>
            <strong>从模糊需求到安全交付，一步一步，更踏实。</strong>
          </aside>
          <div className="route-line" aria-hidden="true">
            <span />
          </div>
        </section>

        <section className="workflow" id="workflow" aria-labelledby="workflow-title">
          <div className="shell">
            <div className="section-heading">
              <div>
                <h2 id="workflow-title">从模糊需求到安全交付</h2>
                <p>不是固定流水线。只加载当前任务真正需要的那个技能。</p>
              </div>
              <p className="code-comment">{"// Eight skills, one clearer path."}</p>
            </div>
            <ol className="workflow__list">
              {workflowSkills.map((skill) => (
                <li key={skill.slug}>
                  <span className="workflow__number">{skill.order}</span>
                  <div>
                    <strong>{skill.stage}</strong>
                    <code>{skill.slug}</code>
                  </div>
                  <p>{skill.summary}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="catalog shell" id="skills" aria-labelledby="skills-title">
          <div className="section-heading">
            <div>
              <h2 id="skills-title">{skills.length} 个开放技能</h2>
              <p>覆盖真实项目中的关键决策时刻，每一个都自包含、无运行时依赖。</p>
            </div>
            <p className="code-comment">{"// Read only what changes the decision."}</p>
          </div>
          <div className="catalog__list">
            {skills.map((skill) => (
              <Link className="skill-row" href={`/skills/${skill.slug}`} key={skill.slug}>
                <span className="skill-row__number">{String(skill.order).padStart(2, "0")}</span>
                <strong>{skill.stage}</strong>
                <code>{skill.slug}</code>
                <p>{skill.summary}</p>
                <span className="skill-row__action">
                  查看详情 <ArrowRight aria-hidden="true" />
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section className="install" id="install" aria-labelledby="install-title">
          <div className="shell install__grid">
            <div>
              <h2 id="install-title">安装</h2>
              <p>在你常用的开发助手中安装 LinOnward Skills，即可在对话中自动匹配或显式调用。</p>
            </div>
            <InstallPanel />
          </div>
        </section>

        <section className="open-source shell" aria-labelledby="open-source-title">
          <div>
            <h2 id="open-source-title">开源，与更多开发者一起实践</h2>
            <p>查看完整实现、参考材料和更新记录，也欢迎提出建议与改进。</p>
            <a
              className="button button--primary"
              href="https://github.com/linonward/skills"
              target="_blank"
              rel="noreferrer"
            >
              <GitHubIcon /> 在 GitHub 查看源码
            </a>
          </div>
          <aside>
            <p className="code-comment">{"// Open source"}</p>
            <p className="code-comment">{"// Better judgment, together."}</p>
            <strong>好的工程判断，值得被更多人使用和改进。</strong>
          </aside>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
