import {
  emDash,
  ellipsis,
  inputRules,
  smartQuotes,
  textblockTypeInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";

import { editorSchema } from "../core/schema";

import type { EditorPlugin } from "./types";

const markdownInputRules = [
  textblockTypeInputRule(/^#{1,6}\s$/, editorSchema.nodes.heading, (match) => ({
    level: match[0].trim().length,
  })),
  textblockTypeInputRule(/^```$/, editorSchema.nodes.code_block),
  wrappingInputRule(/^>\s$/, editorSchema.nodes.blockquote),
  wrappingInputRule(/^\s*([-+*])\s$/, editorSchema.nodes.bullet_list),
  wrappingInputRule(/^(\d+)\.\s$/, editorSchema.nodes.ordered_list, (match) => ({
    order: Number(match[1]),
  })),
];

export const inputRulesPlugin: EditorPlugin = {
  id: "input-rules",
  createProseMirrorPlugins: () => [
    inputRules({ rules: [...markdownInputRules, ...smartQuotes, emDash, ellipsis] }),
  ],
};
