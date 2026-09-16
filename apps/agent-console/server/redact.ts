/**
 * 密钥脱敏：任何要写回浏览器或日志的文本都先过一遍这里。
 *
 * 只认环境里确实配置过的密钥值，替换成 `***`——**绝不回显密钥本身**。
 */
export function redactSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return text;
  return text.split(secret).join("***");
}

/**
 * 从环境变量里取所有不该外泄的值。
 *
 * 除了模型密钥，还包括访问令牌本身：它出现在请求头里，任何"把请求原样打出来"的
 * 日志或错误响应都可能带上它。
 */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  return [env["DEEPSEEK_API_KEY"], env["AGENT_CONSOLE_TOKEN"]].flatMap((secret) =>
    secret === undefined || secret.length === 0 ? [] : [secret],
  );
}

export function redactAll(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) result = redactSecret(result, secret);
  return result;
}

/**
 * 递归脱敏：对象 / 数组的形状保持不变，只替换其中的字符串。
 *
 * 任何要写回浏览器的结构化数据（journal 记录、运行列表、快照）都从这里出，
 * 这样"有没有脱敏"就不再依赖每个调用点自己记得处理嵌套字段。
 */
export function redactDeep(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof value === "string") return redactAll(value, secrets);
  if (depth > 8) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, secrets, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const nested: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      nested[key] = redactDeep(item, secrets, depth + 1);
    }
    return nested;
  }
  return value;
}

/** `redactDeep` 的对象版本：传进去什么形状，回来就是什么形状。 */
export function redactRecord(
  record: Record<string, unknown>,
  secrets: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = redactDeep(value, secrets, 0);
  }
  return result;
}
