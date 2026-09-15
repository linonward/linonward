/**
 * 密钥脱敏：任何要写回浏览器或日志的文本都先过一遍这里。
 *
 * 只认环境里确实配置过的密钥值，替换成 `***`——**绝不回显密钥本身**。
 */
export function redactSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return text;
  return text.split(secret).join("***");
}

/** 从环境变量里取所有不该外泄的值（目前只有 DeepSeek 的 key）。 */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  const secret = env["DEEPSEEK_API_KEY"];
  return secret === undefined || secret.length === 0 ? [] : [secret];
}

export function redactAll(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) result = redactSecret(result, secret);
  return result;
}
