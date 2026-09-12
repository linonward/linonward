import { baseKeymapPlugin } from "./baseKeymap";
import { clipboardPlugin } from "./clipboard";
import { formattingPlugin } from "./formatting";
import { historyPlugin } from "./history";
import { inputRulesPlugin } from "./inputRules";
import { linkPlugin } from "./link";
import { markerPlugin } from "./marker";
import { tablePlugin } from "./table";
import { textAlignPlugin } from "./textAlign";
import { textStylePlugin } from "./textStyle";

export { baseKeymapPlugin } from "./baseKeymap";
export { historyPlugin } from "./history";
export { inputRulesPlugin } from "./inputRules";

export const defaultEditorPlugins = [
  historyPlugin,
  inputRulesPlugin,
  baseKeymapPlugin,
  formattingPlugin,
  textStylePlugin,
  markerPlugin,
  linkPlugin,
  textAlignPlugin,
  tablePlugin,
  clipboardPlugin,
] as const;
