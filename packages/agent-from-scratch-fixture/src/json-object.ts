/**
 * 从模型返回的文本里提取 JSON。
 *
 * 真实模型几乎不会"只输出一个 JSON 对象"：常见形态是 Markdown 围栏（```json ... ```）、
 * 围栏外再加一句解释、或者 JSON 前后带自然语言。早期实现直接 `JSON.parse(raw)`，
 * 这些形态一律失败，规划器的 evaluate 因此被 Loop 判成 `invalid_model_output`。
 *
 * 这里按三级退让解析，任何一级成功就返回：
 * 1. 直接 `JSON.parse`（离线替身与守规矩的模型走这条）；
 * 2. 剥掉第一个 ``` 围栏的内容再解析；
 * 3. 扫描出**第一个大括号平衡**的 `{...}` 片段再解析（忽略字符串里的 `{` / `}`）。
 * 三级都失败才抛错，调用方负责把它转成带标签的可读错误。
 */

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** 只负责"能不能解析出 JSON"；形状校验（是否为对象、字段是否合法）留给调用方。 */
export function extractJsonObject(raw: string): unknown {
  const direct = tryParse(raw.trim());
  if (direct.ok) return direct.value;

  const fenced = firstFenceBody(raw);
  if (fenced !== undefined) {
    const parsed = tryParse(fenced);
    if (parsed.ok) return parsed.value;
    const balancedInFence = firstBalancedObject(fenced);
    if (balancedInFence !== undefined) {
      const fromFence = tryParse(balancedInFence);
      if (fromFence.ok) return fromFence.value;
    }
  }

  const balanced = firstBalancedObject(raw);
  if (balanced !== undefined) {
    const parsed = tryParse(balanced);
    if (parsed.ok) return parsed.value;
  }

  throw new Error("响应里找不到可解析的 JSON");
}

/** 第一个 ``` 围栏的内容（允许没有闭合围栏）；去掉开头可能出现的 `json` 语言标记。 */
function firstFenceBody(text: string): string | undefined {
  const start = text.indexOf("```");
  if (start < 0) return undefined;

  const afterTicks = start + 3;
  const end = text.indexOf("```", afterTicks);
  const body = end < 0 ? text.slice(afterTicks) : text.slice(afterTicks, end);
  const withoutLanguage = body.replace(/^[ \t]*(?:json|JSON|javascript|js)[ \t]*\r?\n?/, "");
  return withoutLanguage.trim();
}

/** 从第一个 `{` 开始逐个尝试，返回第一个能配平的片段。 */
function firstBalancedObject(text: string): string | undefined {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const end = matchingBraceIndex(text, start);
    if (end !== undefined) return text.slice(start, end + 1);
  }
  return undefined;
}

/**
 * 返回与 `text[start]`（必须是 `{`）配平的 `}` 下标。
 *
 * 必须跟踪字符串状态：观测里经常出现 JSON 字符串内含 `}` 的情况，
 * 天真地数括号会把片段截断在字符串中间。
 */
function matchingBraceIndex(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }

  return undefined;
}
