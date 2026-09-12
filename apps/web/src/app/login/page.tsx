import { CircleUserRound } from "lucide-react";
import { redirect } from "next/navigation";

import { auth, signIn } from "@/auth";

export default async function LoginPage() {
  if ((await auth())?.user) redirect("/admin");
  return (
    <main className="grid min-h-screen place-items-center bg-[#0c2030] px-5 text-[#f8f6f1]">
      <section className="w-full max-w-md border border-white/20 p-8 sm:p-11">
        <p className="text-sm font-bold tracking-[0.2em] text-[#ff8838]">LINONWARD NOTES</p>
        <h1 className="mt-5 text-4xl font-extrabold tracking-[-0.05em]">内容管理</h1>
        <p className="mt-4 leading-7 text-white/70">仅允许已配置的管理员 GitHub 账号登录。</p>
        <form
          className="mt-9"
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/admin" });
          }}
        >
          <button
            className="flex min-h-12 w-full cursor-pointer items-center justify-center gap-3 bg-[#ff8838] px-5 font-bold text-[#0c2030] hover:bg-[#ff9a58]"
            type="submit"
          >
            <CircleUserRound className="size-5" aria-hidden="true" />
            使用 GitHub 登录
          </button>
        </form>
      </section>
    </main>
  );
}
