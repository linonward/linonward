import { ArrowLeft, ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { SkillMarkdown } from "@/components/skill-markdown";
import { getSkill } from "@/lib/github-skills";
import { getSkillInstallCommand } from "@/lib/install-commands";

type SkillPageProps = {
  params: Promise<{ slug: string }>;
};

export const revalidate = 21_600;

export async function generateMetadata({ params }: SkillPageProps): Promise<Metadata> {
  const { slug } = await params;
  const skill = await getSkill(slug);
  if (!skill) return {};

  return {
    title: skill.title,
    description: skill.description,
    alternates: { canonical: `/skills/${skill.slug}` },
  };
}

export default async function SkillPage({ params }: SkillPageProps) {
  const { slug } = await params;
  const skill = await getSkill(slug);
  if (!skill) notFound();
  const installCommand = getSkillInstallCommand(skill.slug);

  return (
    <>
      <SiteHeader />
      <main className="skill-page shell">
        <Link className="back-link" href="/#skills">
          <ArrowLeft aria-hidden="true" /> 返回全部 Skills
        </Link>
        <header className="skill-page__header">
          <div>
            <span className="skill-page__stage">
              {String(skill.order).padStart(2, "0")} / {skill.stage}
            </span>
            <h1>{skill.title}</h1>
            <code>{skill.slug}</code>
          </div>
          <p>{skill.description}</p>
        </header>
        <dl className="skill-source-facts" aria-label="Skill 来源信息">
          <div>
            <dt>仓库</dt>
            <dd>linonward/skills</dd>
          </div>
          <div>
            <dt>源文件</dt>
            <dd>skills/{skill.slug}/SKILL.md</dd>
          </div>
          <div>
            <dt>许可</dt>
            <dd>MIT</dd>
          </div>
        </dl>
        <div className="skill-page__layout">
          <aside className="skill-page__rail">
            <p className="code-comment">{"// Source of truth"}</p>
            <a href={skill.sourceUrl} target="_blank" rel="noreferrer">
              在 GitHub 查看 SKILL.md <ExternalLink aria-hidden="true" />
            </a>
          </aside>
          <article>
            <section className="skill-install" aria-labelledby="skill-install-title">
              <p className="code-comment">{"// Install one skill"}</p>
              <h2 id="skill-install-title">安装这个 Skill</h2>
              <p>先阅读下面的源文件；确认它适合当前工作方式后，再运行安装命令。</p>
              <div className="installer__code skill-install__code">
                <pre>
                  <code>{installCommand}</code>
                </pre>
                <CopyButton value={installCommand} />
              </div>
            </section>
            <div className="skill-source-heading">
              <p className="code-comment">{"// Read-only source preview"}</p>
              <h2>阅读源文件</h2>
            </div>
            <SkillMarkdown markdown={skill.markdown} slug={skill.slug} />
          </article>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
