import Link from "next/link";
import { GitHubIcon } from "./github-icon";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="shell site-header__inner">
        <Link className="wordmark" href="/" aria-label="LinOnward Skills 首页">
          <span>LinOnward</span> <span className="wordmark__accent">Skills</span>
        </Link>
        <nav className="site-nav" aria-label="主导航">
          <Link href="/#workflow">工作流</Link>
          <Link href="/#skills">Skills</Link>
          <Link href="/#install">安装</Link>
        </nav>
        <a
          className="github-link"
          href="https://github.com/linonward/skills"
          target="_blank"
          rel="noreferrer"
        >
          <GitHubIcon />
          <span>GitHub</span>
        </a>
      </div>
    </header>
  );
}
