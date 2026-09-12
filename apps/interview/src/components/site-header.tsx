import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="shell nav">
        <Link href="/" className="brand">
          <Image
            src="/brand/interview-pack-logo.png"
            alt="Interview Pack"
            width={36}
            height={36}
            priority
          />
          <span>
            Interview <i>Pack</i>
          </span>
        </Link>
        <Link href="/#submit" className="nav-link">
          提交资料 <ArrowRight aria-hidden="true" />
        </Link>
      </div>
    </header>
  );
}
