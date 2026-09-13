import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SiteHeader } from "@/components/site-header";

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="not-found shell">
        <p className="code-comment">{"// 404"}</p>
        <h1>这个 Skill 还不在路上。</h1>
        <p>返回集合，看看当前公开的工程决策技能。</p>
        <Link className="button button--primary" href="/#skills">
          <ArrowLeft aria-hidden="true" /> 返回全部 Skills
        </Link>
      </main>
    </>
  );
}
