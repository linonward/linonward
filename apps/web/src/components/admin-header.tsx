import { LogOut } from "lucide-react";
import Link from "next/link";

import { signOut } from "@/auth";

export function AdminHeader() {
  return (
    <header className="border-b border-[#0c2030]/15 bg-white">
      <div className="mx-auto flex h-18 w-[min(1120px,calc(100%_-_40px))] items-center gap-8">
        <Link className="text-lg font-extrabold tracking-[-0.04em] no-underline" href="/admin">
          linonward notes
        </Link>
        <nav className="flex gap-6 text-sm font-semibold">
          <Link className="no-underline" href="/admin">
            文章
          </Link>
          <Link className="no-underline" href="/admin/settings/wechat">
            公众号
          </Link>
        </nav>
        <form
          className="ml-auto"
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button
            className="flex cursor-pointer items-center gap-2 border-0 bg-transparent text-sm text-[#526873]"
            type="submit"
          >
            <LogOut className="size-4" aria-hidden="true" />
            退出
          </button>
        </form>
      </div>
    </header>
  );
}
