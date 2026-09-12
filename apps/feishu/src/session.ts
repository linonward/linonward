import { createHash } from "node:crypto";

// 固定命名空间让同一飞书话题始终映射到同一个 Claude 会话 UUID。
const topicSessionNamespace = "2cde12f5-c436-4a17-809f-dd53ed9b28e7";

export function sessionIdForTopic(topicKey: string): string {
  const namespace = Buffer.from(topicSessionNamespace.replaceAll("-", ""), "hex");
  const digest = createHash("sha1").update(namespace).update(topicKey, "utf8").digest();
  const uuid = Buffer.from(digest.subarray(0, 16));

  uuid[6] = ((uuid[6] as number) & 0x0f) | 0x50;
  uuid[8] = ((uuid[8] as number) & 0x3f) | 0x80;

  const hex = uuid.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
