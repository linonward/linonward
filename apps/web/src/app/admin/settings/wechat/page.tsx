import { CheckCircle2, CircleAlert } from "lucide-react";

import { AdminHeader } from "@/components/admin-header";

export default function WechatSettingsPage() {
  const configured = Boolean(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET);
  return (
    <>
      <AdminHeader />
      <main className="mx-auto w-[min(760px,calc(100%_-_40px))] py-16">
        <p className="text-xs font-bold tracking-[0.22em] text-[#d95f12]">CHANNEL</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-[-0.05em]">微信公众号</h1>
        <p className="mt-5 max-w-2xl leading-7 text-[#526873]">
          个人订阅号仅同步至草稿箱，最终发表在微信公众平台内人工完成。
        </p>
        <section className="mt-10 border border-[#0c2030]/20 bg-white p-7">
          <div className="flex items-start gap-4">
            {configured ? (
              <CheckCircle2 className="mt-0.5 size-5 text-emerald-600" aria-hidden="true" />
            ) : (
              <CircleAlert className="mt-0.5 size-5 text-amber-600" aria-hidden="true" />
            )}
            <div>
              <h2 className="font-bold">{configured ? "凭据已配置" : "等待配置凭据"}</h2>
              <p className="mt-2 text-sm leading-6 text-[#62727b]">
                {configured
                  ? "AppID 与 AppSecret 已从服务端环境变量读取。"
                  : "请在部署环境设置 WECHAT_APP_ID 和 WECHAT_APP_SECRET。"}
              </p>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
