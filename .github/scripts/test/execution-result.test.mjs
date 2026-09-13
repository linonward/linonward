import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReplyCard,
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

test("renders a standalone GitHub issue URL as an action card", () => {
  assert.deepEqual(buildReplyCard("https://github.com/linonward/linonward/issues/123"), {
    body: {
      elements: [
        { content: "**状态：** 已完成", tag: "markdown" },
        {
          behaviors: [
            {
              default_url: "https://github.com/linonward/linonward/issues/123",
              type: "open_url",
            },
          ],
          tag: "button",
          text: { content: "打开链接", tag: "plain_text" },
          type: "primary",
        },
      ],
    },
    header: {
      template: "blue",
      title: { content: "微信公众号文章已完成", tag: "plain_text" },
    },
    schema: "2.0",
  });
});

test("keeps regular replies in a markdown card", () => {
  assert.deepEqual(buildReplyCard("任务执行失败，请稍后重试。"), {
    body: { elements: [{ content: "任务执行失败，请稍后重试。", tag: "markdown" }] },
    schema: "2.0",
  });
});

test("does not hide text surrounding a GitHub issue URL", () => {
  const text = "创建成功：https://github.com/linonward/linonward/issues/123";
  assert.deepEqual(buildReplyCard(text), {
    body: { elements: [{ content: text, tag: "markdown" }] },
    schema: "2.0",
  });
});
