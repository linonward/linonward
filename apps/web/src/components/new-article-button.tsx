"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewArticleButton() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  return (
    <button
      className="inline-flex min-h-11 cursor-pointer items-center gap-2 border-0 bg-[#ff8838] px-5 font-bold text-[#0c2030] disabled:cursor-wait disabled:opacity-60"
      disabled={creating}
      type="button"
      onClick={async () => {
        setCreating(true);
        try {
          const response = await fetch("/api/admin/articles", { method: "POST" });
          const payload = (await response.json()) as { article?: { id: string }; error?: string };
          if (!response.ok || !payload.article) throw new Error(payload.error || "创建失败");
          router.push(`/admin/editor/${payload.article.id}`);
        } finally {
          setCreating(false);
        }
      }}
    >
      <Plus className="size-4" aria-hidden="true" />
      {creating ? "正在创建" : "新建文章"}
    </button>
  );
}
