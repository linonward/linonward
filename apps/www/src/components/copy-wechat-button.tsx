"use client";

import { Check, Copy } from "lucide-react";
import { useRef, useState } from "react";
import { brand } from "@/lib/brand";

type Status = "idle" | "success" | "error";

export function CopyWechatButton() {
  const [status, setStatus] = useState<Status>("idle");
  const fallbackRef = useRef<HTMLSpanElement>(null);

  async function copyName() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(brand.chineseName);
      setStatus("success");
    } catch {
      setStatus("error");
      requestAnimationFrame(() => {
        const selection = window.getSelection();
        const range = document.createRange();
        if (fallbackRef.current && selection) {
          range.selectNodeContents(fallbackRef.current);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      });
    }
  }

  return (
    <div>
      <button
        type="button"
        className="inline-flex min-h-12.5 w-auto cursor-pointer items-center justify-center gap-2.5 rounded-xs border border-transparent bg-brand-orange px-5.5 py-3 font-[750] leading-[1.2] text-brand-navy transition-[transform,background-color,color] duration-180 hover:-translate-y-0.5 hover:bg-[#ff9a58] motion-reduce:hover:translate-y-0 [&_svg]:size-4.5 [&_svg]:stroke-2"
        onClick={copyName}
      >
        {status === "success" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {status === "success" ? "已复制" : "复制公众号名称"}
      </button>
      <p className="mt-3 mb-0 min-h-7 text-sm text-on-panel-soft" aria-live="polite">
        {status === "success" && "已复制公众号名称"}
        {status === "error" && (
          <>
            复制失败，请手动复制：
            <span className="font-extrabold text-on-panel select-all" ref={fallbackRef}>
              {brand.chineseName}
            </span>
          </>
        )}
      </p>
    </div>
  );
}
