/**
 * 把一行命令拆成 argv。
 *
 * 支持单引号 / 双引号分组，其余按空白切分；**不做**任何 shell 展开（没有变量替换、
 * 通配符、管道、重定向）——命令白名单要求的是逐项相等的 argv，因此这里只做最朴素的
 * 分词，宁可让用户写清楚，也不猜他想表达什么。
 */
export function splitArgv(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;

  for (const char of line) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (started) tokens.push(current);
  return tokens;
}

/** 表单里的一行 = 一条完整命令；空行被丢弃。 */
export function parseAllowedArgvLines(lines: readonly string[]): string[][] {
  return lines.map(splitArgv).filter((argv) => argv.length > 0);
}
