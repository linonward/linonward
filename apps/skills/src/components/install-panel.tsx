"use client";

import { useState } from "react";
import { CLAUDE_INSTALL_COMMAND, CODEX_INSTALL_COMMAND } from "@/lib/install-commands";
import { CopyButton } from "./copy-button";

const installers = {
  codex: {
    label: "OpenAI Codex",
    command: CODEX_INSTALL_COMMAND,
    note: "使用 skills CLI 将全部 skills 安装到 Codex 的用户级目录。新开 Codex 会话后生效。",
  },
  claude: {
    label: "Claude Code",
    command: CLAUDE_INSTALL_COMMAND,
    note: "在 Claude Code 中依次运行这两条插件命令。",
  },
} as const;

type Installer = keyof typeof installers;

export function InstallPanel() {
  const [active, setActive] = useState<Installer>("codex");
  const installer = installers[active];

  return (
    <div className="installer">
      <div className="installer__tabs" role="tablist" aria-label="选择 AI 工具">
        {(Object.keys(installers) as Installer[]).map((key) => (
          <button
            aria-controls="install-command"
            aria-selected={active === key}
            className="installer__tab"
            id={`install-tab-${key}`}
            key={key}
            onClick={() => setActive(key)}
            role="tab"
            type="button"
          >
            {installers[key].label}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`install-tab-${active}`}
        className="installer__code"
        id="install-command"
        role="tabpanel"
      >
        <pre>
          <code>{installer.command}</code>
        </pre>
        <CopyButton value={installer.command} />
      </div>
      <p className="installer__note">{installer.note}</p>
    </div>
  );
}
