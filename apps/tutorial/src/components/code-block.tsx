"use client";

import { useState } from "react";

import { CopyIcon } from "./icons";

interface CodeBlockProps {
  children: string;
  language?: string;
}

export function formatCode(source: string, language: string): string {
  const trimmed = source.trim();

  if (language.toLowerCase() !== "json") {
    return trimmed;
  }

  try {
    const value: unknown = JSON.parse(trimmed);
    return JSON.stringify(value, null, 2) ?? trimmed;
  } catch {
    return trimmed;
  }
}

export function CodeBlock({ children, language = "typescript" }: CodeBlockProps) {
  const [feedback, setFeedback] = useState<"idle" | "copied" | "failed">("idle");
  const code = formatCode(children, language);

  async function copyCode() {
    const textarea = document.createElement("textarea");
    textarea.value = code;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    let succeeded = document.execCommand("copy");
    textarea.remove();

    if (!succeeded) {
      try {
        await navigator.clipboard.writeText(code);
        succeeded = true;
      } catch {
        succeeded = false;
      }
    }

    setFeedback(succeeded ? "copied" : "failed");
    window.setTimeout(() => setFeedback("idle"), 1600);
  }

  return (
    <div className="code-block">
      <div className="code-block__header">
        <span>{language}</span>
        <button onClick={copyCode} type="button">
          <CopyIcon />
          {feedback === "copied" ? "已复制" : feedback === "failed" ? "复制失败" : "复制"}
        </button>
      </div>
      <pre>
        <code>
          {code.split("\n").map((line, index) => (
            <span className="code-block__line" key={`${index}-${line}`}>
              {line}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
