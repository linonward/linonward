"use client";

import {
  ChevronDown,
  Columns3,
  Paintbrush,
  Redo2,
  RemoveFormatting,
  Rows3,
  Trash2,
  Undo2,
} from "lucide-react";
import type { EditorView } from "prosemirror-view";
import type { ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";

export type ToolbarTool = {
  id: string;
  icon: ReactNode;
  label: string;
  run: (view: EditorView) => boolean;
};

export type ToolbarGroup = "block" | "inline" | "insert" | "align";

const toolbarGroups: readonly ToolbarGroup[] = ["block", "inline", "insert", "align"];

type ToolbarTooltip = { label: string; left: number; top: number };
type ToolbarMenuPosition = { left: number; top: number };
type ToolbarShortcut = { mac: string; other: string };

const shortcuts: Partial<Record<ToolbarTool["id"], ToolbarShortcut>> = {
  bold: { mac: "⌘B", other: "Ctrl+B" },
  italic: { mac: "⌘I", other: "Ctrl+I" },
  underline: { mac: "⌘U", other: "Ctrl+U" },
  strikethrough: { mac: "⌘⇧X", other: "Ctrl+Shift+X" },
};
const fontSizes = [12, 14, 15, 16, 17, 18, 20, 24] as const;

const subscribeToNothing = () => () => {};
const getIsMac = () => /Mac/.test(navigator.userAgent);

export function ColorPopover({
  label,
  initial,
  onApply,
  background = false,
}: {
  label: string;
  initial: string;
  onApply: (color: string) => void;
  background?: boolean;
}) {
  const [color, setColor] = useState(initial);
  return (
    <label
      className="native-color-picker"
      title={label}
      onClick={(event) => event.stopPropagation()}
    >
      <span
        className={`color-tool ${background ? "color-tool-background" : "color-tool-text"}`}
        style={
          background
            ? {
                borderBottomColor: color,
                background: `linear-gradient(transparent 55%,${color} 55%)`,
              }
            : { color, borderBottomColor: color }
        }
      >
        A
      </span>
      <input
        aria-label={label}
        type="color"
        value={color}
        onChange={(event) => {
          setColor(event.target.value);
          onApply(event.target.value);
        }}
      />
    </label>
  );
}

export default function EditorToolbar({
  tools,
  groups,
  toolbar,
  command,
  onApplyFontSize,
  formatBrush,
  onUseFormatBrush,
  undo,
  redo,
  clearFormatting,
  addRow,
  addColumn,
  deleteRow,
  deleteColumn,
  deleteTable,
}: {
  tools: ToolbarTool[];
  groups: Record<ToolbarGroup, readonly string[]>;
  toolbar: Record<string, boolean>;
  command: (fn: ToolbarTool["run"]) => () => void;
  onApplyFontSize: (size: string) => void;
  formatBrush: boolean;
  onUseFormatBrush: () => void;
  undo: ToolbarTool["run"];
  redo: ToolbarTool["run"];
  clearFormatting: ToolbarTool["run"];
  addRow: ToolbarTool["run"];
  addColumn: ToolbarTool["run"];
  deleteRow: ToolbarTool["run"];
  deleteColumn: ToolbarTool["run"];
  deleteTable: ToolbarTool["run"];
}) {
  const [tooltip, setTooltip] = useState<ToolbarTooltip | null>(null);
  const [alignmentMenu, setAlignmentMenu] = useState<ToolbarMenuPosition | null>(null);
  const [headingMenu, setHeadingMenu] = useState<ToolbarMenuPosition | null>(null);
  const [fontSizeMenu, setFontSizeMenu] = useState<ToolbarMenuPosition | null>(null);
  const isMac = useSyncExternalStore(subscribeToNothing, getIsMac, () => false);

  useEffect(() => {
    if (!alignmentMenu && !headingMenu && !fontSizeMenu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-toolbar-menu]")) {
        setAlignmentMenu(null);
        setHeadingMenu(null);
        setFontSizeMenu(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAlignmentMenu(null);
        setHeadingMenu(null);
        setFontSizeMenu(null);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [alignmentMenu, headingMenu, fontSizeMenu]);

  const tooltipProps = (label: string, shortcut?: string, addAriaLabel = true) => {
    const tooltipLabel = shortcut ? `${label}（${shortcut}）` : label;
    const show = (
      event: React.MouseEvent<HTMLButtonElement> | React.FocusEvent<HTMLButtonElement>,
    ) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      setTooltip({
        label: tooltipLabel,
        left: bounds.left + bounds.width / 2,
        top: bounds.bottom + 8,
      });
    };
    return {
      ...(addAriaLabel ? { "aria-label": tooltipLabel } : {}),
      onMouseEnter: show,
      onMouseLeave: () => setTooltip(null),
      onFocus: show,
      onBlur: () => setTooltip(null),
    };
  };
  const shortcutFor = (id: string) => {
    const shortcut = shortcuts[id];
    return shortcut && (isMac ? shortcut.mac : shortcut.other);
  };
  const iconButton = (label: string, action: ToolbarTool["run"], icon: ReactNode, extra = "") => (
    <button
      onMouseDown={(event) => event.preventDefault()}
      onClick={command(action)}
      className={`tool ${extra}`}
      {...tooltipProps(label)}
    >
      {icon}
    </button>
  );
  const alignTools = groups.align
    .map((id) => tools.find((tool) => tool.id === id))
    .filter((tool): tool is ToolbarTool => Boolean(tool));
  const activeAlignment = alignTools.find((tool) => toolbar[tool.id]) ?? alignTools[0];
  const headingTools = groups.block
    .map((id) => tools.find((tool) => tool.id === id))
    .filter((tool): tool is ToolbarTool => Boolean(tool));
  const activeHeading = headingTools.find((tool) => toolbar[tool.id]) ?? headingTools[0];

  return (
    <>
      <section className="editor-toolbar">
        <div className="toolbar-content">
          {toolbarGroups.map((groupName) => {
            const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
            const group = groups[groupName]
              .map((id) => toolsById.get(id))
              .filter((tool): tool is ToolbarTool => Boolean(tool));
            if (groupName === "block" && activeHeading) {
              return (
                <div className="toolbar-group" key={groupName}>
                  <button
                    type="button"
                    data-toolbar-menu
                    className={`tool heading-menu-trigger ${headingMenu ? "tool-active" : ""}`}
                    aria-label="标题级别"
                    aria-expanded={Boolean(headingMenu)}
                    aria-haspopup="menu"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      const bounds = event.currentTarget.getBoundingClientRect();
                      setHeadingMenu((menu) =>
                        menu ? null : { left: bounds.left, top: bounds.bottom + 8 },
                      );
                      setAlignmentMenu(null);
                      setFontSizeMenu(null);
                    }}
                    {...tooltipProps("标题级别")}
                  >
                    {activeHeading.icon}
                    <ChevronDown size={13} className="align-menu-chevron" />
                  </button>
                </div>
              );
            }
            if (groupName === "align" && activeAlignment) {
              return (
                <div className="toolbar-group" key={groupName}>
                  <button
                    type="button"
                    data-toolbar-menu
                    className={`tool align-menu-trigger ${alignmentMenu ? "tool-active" : ""}`}
                    aria-label="对齐"
                    aria-expanded={Boolean(alignmentMenu)}
                    aria-haspopup="menu"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      const bounds = event.currentTarget.getBoundingClientRect();
                      setAlignmentMenu((menu) =>
                        menu ? null : { left: bounds.left, top: bounds.bottom + 8 },
                      );
                      setHeadingMenu(null);
                      setFontSizeMenu(null);
                    }}
                    {...tooltipProps("对齐")}
                  >
                    {activeAlignment.icon}
                    <ChevronDown size={13} className="align-menu-chevron" />
                  </button>
                </div>
              );
            }
            return (
              <div className="toolbar-group" key={groupName}>
                {group.map((tool) =>
                  tool.id === "fontSize" ? (
                    <button
                      key={tool.id}
                      type="button"
                      data-toolbar-menu
                      className={`tool font-size-menu-trigger ${fontSizeMenu ? "tool-active" : ""}`}
                      aria-label="字号"
                      aria-expanded={Boolean(fontSizeMenu)}
                      aria-haspopup="menu"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        const bounds = event.currentTarget.getBoundingClientRect();
                        command(tool.run)();
                        setFontSizeMenu((menu) =>
                          menu ? null : { left: bounds.left, top: bounds.bottom + 8 },
                        );
                        setAlignmentMenu(null);
                        setHeadingMenu(null);
                      }}
                      {...tooltipProps("字号")}
                    >
                      {tool.icon}
                      <ChevronDown size={13} className="align-menu-chevron" />
                    </button>
                  ) : (
                    <button
                      key={tool.label}
                      aria-pressed={toolbar[tool.id] || false}
                      {...tooltipProps(
                        tool.label,
                        shortcutFor(tool.id),
                        !["fontSize", "textColor", "backgroundColor"].includes(tool.id),
                      )}
                      onMouseDown={(event) => {
                        if (!["fontSize", "textColor", "backgroundColor"].includes(tool.id))
                          event.preventDefault();
                      }}
                      onClick={command(tool.run)}
                      className={`tool ${toolbar[tool.id] ? "tool-active" : ""}`}
                    >
                      {tool.icon}
                    </button>
                  ),
                )}
              </div>
            );
          })}
          <div className="toolbar-group">
            {iconButton("撤销", undo, <Undo2 size={18} />)}
            {iconButton("重做", redo, <Redo2 size={18} />)}
          </div>
          <div className="toolbar-group">
            <button
              onMouseDown={(event) => event.preventDefault()}
              onClick={onUseFormatBrush}
              className={`tool ${formatBrush ? "tool-active" : ""}`}
              {...tooltipProps(formatBrush ? "格式刷已启用，可重复应用；再次点击取消" : "格式刷")}
              aria-pressed={formatBrush}
            >
              <Paintbrush size={18} />
            </button>
            {iconButton("清除格式", clearFormatting, <RemoveFormatting size={18} />)}
          </div>
          {toolbar.table && (
            <div className="table-tools" aria-label="表格操作">
              <span className="table-tools-label">表格</span>
              {iconButton("在下方添加行", addRow, <Rows3 size={18} />)}
              {iconButton("在右侧添加列", addColumn, <Columns3 size={18} />)}
              {iconButton(
                "删除当前行",
                deleteRow,
                <Rows3 size={18} className="table-delete-icon" />,
              )}
              {iconButton(
                "删除当前列",
                deleteColumn,
                <Columns3 size={18} className="table-delete-icon" />,
              )}
              {iconButton("删除表格", deleteTable, <Trash2 size={17} />, "table-delete")}
            </div>
          )}
        </div>
      </section>
      {tooltip && (
        <div
          className="toolbar-tooltip"
          role="tooltip"
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          {tooltip.label}
        </div>
      )}
      {alignmentMenu && (
        <div
          className="alignment-menu align-menu"
          data-toolbar-menu
          role="menu"
          aria-label="对齐"
          style={{ left: alignmentMenu.left, top: alignmentMenu.top }}
        >
          {alignTools.map((tool) => (
            <button
              key={tool.id}
              type="button"
              role="menuitemradio"
              aria-label={tool.label}
              aria-checked={Boolean(toolbar[tool.id])}
              onClick={() => {
                command(tool.run)();
                setAlignmentMenu(null);
              }}
            >
              {tool.icon}
            </button>
          ))}
        </div>
      )}
      {headingMenu && (
        <div
          className="alignment-menu heading-menu"
          data-toolbar-menu
          role="menu"
          aria-label="标题级别"
          style={{ left: headingMenu.left, top: headingMenu.top }}
        >
          {headingTools.map((tool) => (
            <button
              key={tool.id}
              type="button"
              role="menuitemradio"
              aria-checked={Boolean(toolbar[tool.id])}
              onClick={() => {
                command(tool.run)();
                setHeadingMenu(null);
              }}
            >
              <span className={`heading-option-preview heading-option-${tool.id}`}>
                {tool.icon}
              </span>
            </button>
          ))}
        </div>
      )}
      {fontSizeMenu && (
        <div
          className="alignment-menu font-size-menu"
          data-toolbar-menu
          role="menu"
          aria-label="字号"
          style={{ left: fontSizeMenu.left, top: fontSizeMenu.top }}
        >
          {fontSizes.map((size) => (
            <button
              key={size}
              type="button"
              role="menuitemradio"
              aria-label={`${size}px`}
              aria-checked={false}
              onClick={() => {
                onApplyFontSize(`${size}px`);
                setFontSizeMenu(null);
              }}
            >
              <span className="font-size-option-preview" style={{ fontSize: `${size}px` }}>
                {size}px
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
