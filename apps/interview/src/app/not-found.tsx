import Link from "next/link";
import { ArrowRight } from "lucide-react";

export default function NotFound() {
  return (
    <main className="page-state">
      <div>
        <p className="overline">404</p>
        <h1>这个页面不存在</h1>
        <p>链接可能已失效，或者页面已被移动。</p>
        <Link className="button" href="/">
          返回首页 <ArrowRight aria-hidden="true" />
        </Link>
      </div>
    </main>
  );
}
