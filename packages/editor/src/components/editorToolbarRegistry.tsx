import {
  ALargeSmall,
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Code2,
  FileCode2,
  Highlighter,
  ImageIcon,
  Italic,
  Link,
  List,
  ListOrdered,
  Minus,
  Quote,
  Strikethrough,
  Table2,
  Underline,
} from "lucide-react";
import type { EditorView } from "prosemirror-view";
import type { ReactNode } from "react";

import {
  applyTextStyle,
  insertDivider,
  insertEditorTable,
  setCodeBlock,
  setHeading,
  setTextAlign,
  toggleBold,
  toggleCode,
  toggleItalic,
  toggleMarker,
  toggleStrikethrough,
  toggleUnderline,
  wrapBulletList,
  wrapOrderedList,
  wrapQuote,
} from "../plugins";

import { ColorPopover, type ToolbarGroup, type ToolbarTool } from "./EditorToolbar";

export const editorToolbarGroups: Record<ToolbarGroup, readonly string[]> = {
  block: ["h2", "h3", "h4"],
  inline: [
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "code",
    "fontSize",
    "textColor",
    "backgroundColor",
    "marker",
  ],
  insert: ["quote", "bullet", "ordered", "link", "image", "codeBlock", "divider", "table"],
  align: ["alignLeft", "alignCenter", "alignRight", "alignJustify"],
};

type RegistryContext = {
  textColor: string;
  backgroundColor: string;
  uploadingImage: boolean;
  captureFontSizeSelection: () => void;
  withEditor: (operation: (editor: EditorView) => void) => void;
  openLinkEditor: () => void;
  chooseImage: () => void;
};

type CommandDefinition = {
  id: string;
  icon: ReactNode | ((context: RegistryContext) => ReactNode);
  label: string | ((context: RegistryContext) => string);
  run: (context: RegistryContext, view: EditorView) => boolean;
};

const editorCommandRegistry: readonly CommandDefinition[] = [
  { id: "h2", icon: "H2", label: "二级标题", run: (_, view) => setHeading(view, 2) },
  { id: "h3", icon: "H3", label: "三级标题", run: (_, view) => setHeading(view, 3) },
  { id: "h4", icon: "H4", label: "四级标题", run: (_, view) => setHeading(view, 4) },
  { id: "bold", icon: <Bold size={17} />, label: "粗体", run: (_, view) => toggleBold(view) },
  { id: "italic", icon: <Italic size={17} />, label: "斜体", run: (_, view) => toggleItalic(view) },
  {
    id: "underline",
    icon: <Underline size={17} />,
    label: "下划线",
    run: (_, view) => toggleUnderline(view),
  },
  {
    id: "strikethrough",
    icon: <Strikethrough size={17} />,
    label: "删除线",
    run: (_, view) => toggleStrikethrough(view),
  },
  { id: "code", icon: <Code2 size={17} />, label: "行内代码", run: (_, view) => toggleCode(view) },
  {
    id: "fontSize",
    icon: <ALargeSmall size={18} />,
    label: "字号",
    run: (context) => {
      context.captureFontSizeSelection();
      return true;
    },
  },
  {
    id: "textColor",
    label: "前景色",
    run: () => true,
    icon: (context) => (
      <ColorPopover
        key={context.textColor}
        label="前景"
        initial={context.textColor}
        onApply={(color) =>
          context.withEditor((editor) => applyTextStyle(editor, "text_color", color))
        }
      />
    ),
  },
  {
    id: "backgroundColor",
    label: "背景色",
    run: () => true,
    icon: (context) => (
      <ColorPopover
        key={context.backgroundColor}
        label="背景"
        initial={context.backgroundColor}
        background
        onApply={(color) =>
          context.withEditor((editor) => applyTextStyle(editor, "background_color", color))
        }
      />
    ),
  },
  {
    id: "marker",
    icon: <Highlighter size={18} />,
    label: "马克笔",
    run: (_, view) => toggleMarker(view),
  },
  { id: "quote", icon: <Quote size={18} />, label: "引用", run: (_, view) => wrapQuote(view) },
  {
    id: "bullet",
    icon: <List size={18} />,
    label: "无序列表",
    run: (_, view) => wrapBulletList(view),
  },
  {
    id: "ordered",
    icon: <ListOrdered size={18} />,
    label: "有序列表",
    run: (_, view) => wrapOrderedList(view),
  },
  {
    id: "link",
    icon: <Link size={17} />,
    label: "链接",
    run: (context) => {
      context.openLinkEditor();
      return true;
    },
  },
  {
    id: "image",
    icon: <ImageIcon size={18} />,
    label: (context) => (context.uploadingImage ? "正在上传图片" : "图片"),
    run: (context) => {
      context.chooseImage();
      return true;
    },
  },
  {
    id: "codeBlock",
    icon: <FileCode2 size={18} />,
    label: "代码块",
    run: (_, view) => setCodeBlock(view),
  },
  {
    id: "divider",
    icon: <Minus size={20} />,
    label: "分割线",
    run: (_, view) => insertDivider(view),
  },
  {
    id: "table",
    icon: <Table2 size={18} />,
    label: "插入 3 × 3 表格",
    run: (_, view) => insertEditorTable(view),
  },
  {
    id: "alignLeft",
    icon: <AlignLeft size={18} />,
    label: "左对齐",
    run: (_, view) => setTextAlign("left")(view.state, view.dispatch),
  },
  {
    id: "alignCenter",
    icon: <AlignCenter size={18} />,
    label: "居中对齐",
    run: (_, view) => setTextAlign("center")(view.state, view.dispatch),
  },
  {
    id: "alignRight",
    icon: <AlignRight size={18} />,
    label: "右对齐",
    run: (_, view) => setTextAlign("right")(view.state, view.dispatch),
  },
  {
    id: "alignJustify",
    icon: <AlignJustify size={18} />,
    label: "两端对齐",
    run: (_, view) => setTextAlign("justify")(view.state, view.dispatch),
  },
];

export const editorCommandIds = editorCommandRegistry.map((command) => command.id);

export const useEditorToolbarTools = (context: RegistryContext): ToolbarTool[] =>
  editorCommandRegistry.map((command) => ({
    id: command.id,
    icon: typeof command.icon === "function" ? command.icon(context) : command.icon,
    label: typeof command.label === "function" ? command.label(context) : command.label,
    run: (view) => command.run(context, view),
  }));
