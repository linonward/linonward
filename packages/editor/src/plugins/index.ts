export { clipboardPlugin } from "./clipboard";
export { defaultEditorPlugins } from "./defaultPlugins";
export {
  insertDivider,
  setCodeBlock,
  setHeading,
  toggleBold,
  toggleCode,
  toggleItalic,
  toggleStrikethrough,
  toggleUnderline,
  wrapBulletList,
  wrapOrderedList,
  wrapQuote,
} from "./formatting";
export { redoEditor, undoEditor } from "./history";
export { applyLink, getLinkAtSelection, normalizeLink, removeLink } from "./link";
export { toggleMarker } from "./marker";
export {
  addEditorTableColumn,
  addEditorTableRow,
  deleteEditorTable,
  deleteEditorTableColumn,
  deleteEditorTableRow,
  insertEditorTable,
} from "./table";
export type { TextAlign } from "./textAlign";
export { currentTextAlign, setTextAlign } from "./textAlign";
export {
  applyFontSize,
  applyInlineFormatting,
  applyTextStyle,
  captureInlineFormatting,
  clearInlineFormatting,
  selectedTextStyleColor,
} from "./textStyle";
export type { EditorPlugin } from "./types";
export { composeProseMirrorPlugins } from "./types";
