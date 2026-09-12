import assert from "node:assert/strict";
import test from "node:test";

import {
  extractResultText,
  formatExecutionReply,
  formatInterruptedReply,
  parseMessages,
} from "../execution-result.mjs";

test("uses the final result from JSON or JSONL output", () => {
  assert.equal(
    extractResultText(parseMessages('[{"type":"result","result":"最终回复"}]')),
    "最终回复",
  );
  assert.equal(
    extractResultText(
      parseMessages('{"type":"result","result":"第一条"}\n{"type":"result","result":"最后一条"}'),
    ),
    "最后一条",
  );
});

test("falls back to the latest assistant text", () => {
  const messages = parseMessages(
    JSON.stringify([{ type: "assistant", content: [{ type: "text", text: "阶段结论" }] }]),
  );
  assert.equal(extractResultText(messages), "阶段结论");
});

test("explains failures while retaining recent progress", () => {
  const messages = [
    { type: "assistant", content: [{ type: "text", text: "正在运行测试" }] },
    { is_error: true, subtype: "error_max_turns", type: "result" },
  ];
  assert.match(formatExecutionReply(messages, "https://example.test/run"), /已达到.*轮数上限/);
  assert.match(formatExecutionReply(messages, "https://example.test/run"), /正在运行测试/);
  assert.match(formatInterruptedReply(messages, "https://example.test/run"), /已被取消/);
});
