import { type ReactElement, useState } from "react";
import type { RunFormValues } from "../lib/api.js";
import { parseAllowedArgvLines } from "../lib/argv.js";

export interface RunFormProps {
  busy: boolean;
  onSubmit(values: RunFormValues): void;
}

interface FormState {
  task: string;
  cwd: string;
  allowedArgvLines: string[];
  maxSteps: string;
  maxToolCalls: string;
  maxCostUsd: string;
  maxWallMs: string;
  approveAllowed: boolean;
  requireSandbox: boolean;
  repeatGuard: boolean;
  plannerModel: string;
}

const INITIAL: FormState = {
  task: "读取 package.json，说明这个仓库有哪些 workspace。",
  cwd: "",
  allowedArgvLines: [""],
  maxSteps: "16",
  maxToolCalls: "32",
  maxCostUsd: "",
  maxWallMs: "",
  approveAllowed: false,
  requireSandbox: false,
  repeatGuard: true,
  plannerModel: "",
};

function positiveInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** 可选正数：留空 = 不限制；写了非法值当没写（服务端也会再校验一次）。 */
function optionalPositiveNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 顶部表单：任务、cwd、`--allow` 白名单、预算、三个开关与规划模型。 */
export function RunForm({ busy, onSubmit }: RunFormProps): ReactElement {
  const [form, setForm] = useState<FormState>(INITIAL);

  const update = (patch: Partial<FormState>): void => {
    setForm((previous) => ({ ...previous, ...patch }));
  };

  const setArgvLine = (index: number, value: string): void => {
    update({
      allowedArgvLines: form.allowedArgvLines.map((line, position) =>
        position === index ? value : line,
      ),
    });
  };

  return (
    <form
      className="run-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          task: form.task.trim(),
          cwd: form.cwd.trim(),
          allowedArgv: parseAllowedArgvLines(form.allowedArgvLines),
          maxSteps: positiveInteger(form.maxSteps, 16),
          maxToolCalls: positiveInteger(form.maxToolCalls, 32),
          maxCostUsd: optionalPositiveNumber(form.maxCostUsd),
          maxWallMs: optionalPositiveNumber(form.maxWallMs),
          approveAllowed: form.approveAllowed,
          requireSandbox: form.requireSandbox,
          repeatGuard: form.repeatGuard,
          plannerModel: form.plannerModel,
        });
      }}
    >
      <label className="field field-wide">
        <span>任务</span>
        <textarea
          name="task"
          rows={3}
          value={form.task}
          onChange={(event) => update({ task: event.target.value })}
          required
        />
      </label>

      <label className="field field-wide">
        <span>cwd（留空 = API 服务启动目录）</span>
        <input
          name="cwd"
          value={form.cwd}
          placeholder="/path/to/workspace"
          onChange={(event) => update({ cwd: event.target.value })}
        />
      </label>

      <div className="field field-wide">
        <span>--allow（一行一条完整命令；引号内保留空格）</span>
        {form.allowedArgvLines.map((line, index) => (
          <div className="argv-row" key={`argv-${index}`}>
            <input
              aria-label={`allowed-argv-${index}`}
              className="mono"
              value={line}
              placeholder="node --version"
              onChange={(event) => setArgvLine(index, event.target.value)}
            />
            <button
              type="button"
              onClick={() =>
                update({
                  allowedArgvLines: form.allowedArgvLines.filter(
                    (_candidate, position) => position !== index,
                  ),
                })
              }
              disabled={form.allowedArgvLines.length <= 1}
            >
              删除
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => update({ allowedArgvLines: [...form.allowedArgvLines, ""] })}
        >
          + 添加命令
        </button>
      </div>

      <label className="field">
        <span>maxSteps</span>
        <input
          name="maxSteps"
          inputMode="numeric"
          value={form.maxSteps}
          onChange={(event) => update({ maxSteps: event.target.value })}
        />
      </label>

      <label className="field">
        <span>maxToolCalls</span>
        <input
          name="maxToolCalls"
          inputMode="numeric"
          value={form.maxToolCalls}
          onChange={(event) => update({ maxToolCalls: event.target.value })}
        />
      </label>

      <label className="field">
        <span>花费上限 USD（留空 = 不限制）</span>
        <input
          name="maxCostUsd"
          inputMode="decimal"
          value={form.maxCostUsd}
          placeholder="0.5"
          onChange={(event) => update({ maxCostUsd: event.target.value })}
        />
      </label>

      <label className="field">
        <span>墙钟上限 ms（留空 = 不限制）</span>
        <input
          name="maxWallMs"
          inputMode="numeric"
          value={form.maxWallMs}
          placeholder="300000"
          onChange={(event) => update({ maxWallMs: event.target.value })}
        />
      </label>

      <label className="field">
        <span>规划模型（留空 = DEEPSEEK_PLANNER_MODEL）</span>
        <input
          name="plannerModel"
          value={form.plannerModel}
          placeholder="deepseek-v4-flash"
          onChange={(event) => update({ plannerModel: event.target.value })}
        />
      </label>

      <div className="field switches">
        <label>
          <input
            type="checkbox"
            checked={form.approveAllowed}
            onChange={(event) => update({ approveAllowed: event.target.checked })}
          />
          approveAllowed（白名单内命令自动批准）
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.requireSandbox}
            onChange={(event) => update({ requireSandbox: event.target.checked })}
          />
          requireSandbox（没有真隔离就拒绝执行）
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.repeatGuard}
            onChange={(event) => update({ repeatGuard: event.target.checked })}
          />
          repeatGuard（拦截重复工具调用）
        </label>
      </div>

      <button className="primary" type="submit" disabled={busy || form.task.trim().length === 0}>
        {busy ? "运行中…" : "开始运行"}
      </button>
    </form>
  );
}
