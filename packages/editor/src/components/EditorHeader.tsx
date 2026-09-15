"use client";

import { Check, ChevronDown, Copy, Menu, Moon, Palette, Sun, Upload } from "lucide-react";
import type { ChangeEvent, KeyboardEvent, RefObject } from "react";
import { useEffect, useRef, useState } from "react";

import type { OutlineItem } from "../outline";
import { themes } from "../themes";

export default function EditorHeader({
  title,
  themeId,
  copied,
  fileInput,
  imageFileInput,
  onTitleChange,
  onThemeChange,
  onImport,
  onImageUpload,
  onCopy,
  darkPreview,
  onToggleDarkPreview,
  outlineItems,
  onNavigateOutline,
  homeHref,
  brandName,
  actions,
}: {
  title: string;
  themeId: string;
  copied: boolean;
  fileInput: RefObject<HTMLInputElement | null>;
  imageFileInput: RefObject<HTMLInputElement | null>;
  onTitleChange: (title: string) => void;
  onThemeChange: (themeId: string) => void;
  onImport: (event: ChangeEvent<HTMLInputElement>) => void;
  onImageUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onCopy: () => void;
  darkPreview: boolean;
  onToggleDarkPreview: () => void;
  outlineItems: OutlineItem[];
  onNavigateOutline: (position: number) => void;
  homeHref: string;
  brandName: string;
  actions: ReadonlyArray<{
    id: string;
    label: string;
    disabled: boolean;
    onClick: () => void;
  }>;
}) {
  const titleInput = useRef<HTMLInputElement>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title);
  const [outlineOpen, setOutlineOpen] = useState(false);

  useEffect(() => {
    if (!editingTitle) return;
    titleInput.current?.focus();
    titleInput.current?.select();
  }, [editingTitle]);

  const startTitleEdit = () => {
    setTitleDraft(title);
    setEditingTitle(true);
  };
  const finishTitleEdit = () => {
    const nextTitle = titleDraft.trim();
    if (nextTitle) onTitleChange(nextTitle);
    setEditingTitle(false);
  };
  const cancelTitleEdit = () => {
    setTitleDraft(title);
    setEditingTitle(false);
  };
  const handleTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finishTitleEdit();
    }
    if (event.key === "Escape") cancelTitleEdit();
  };

  return (
    <header className="h-[70px] bg-white border-b border-[#e8e9ee] flex items-center px-6 gap-5">
      <a className="editor-brand" href={homeHref} aria-label="返回内容管理">
        {brandName}
      </a>
      <span className="h-8 border-l border-[#e5e6ec]" />
      <div className="outline-menu">
        <button
          type="button"
          className={`outline-trigger ${outlineOpen ? "outline-trigger-active" : ""}`}
          aria-label="章节目录"
          aria-expanded={outlineOpen}
          aria-controls="chapter-outline"
          onClick={() => setOutlineOpen((open) => !open)}
        >
          <Menu size={20} aria-hidden="true" />
        </button>
        {outlineOpen && (
          <section id="chapter-outline" className="chapter-outline" aria-label="章节目录">
            <div className="chapter-outline-title">章节目录</div>
            {outlineItems.length ? (
              <nav>
                {outlineItems.map((item) => (
                  <button
                    type="button"
                    key={item.position}
                    className={`chapter-outline-item chapter-outline-level-${item.level}`}
                    onClick={() => {
                      onNavigateOutline(item.position);
                      setOutlineOpen(false);
                    }}
                  >
                    {item.text}
                  </button>
                ))}
              </nav>
            ) : (
              <p className="chapter-outline-empty">添加 H2、H3 或 H4 标题后会显示在这里。</p>
            )}
          </section>
        )}
      </div>
      {editingTitle ? (
        <input
          ref={titleInput}
          value={titleDraft}
          aria-label="文章标题"
          onChange={(event) => setTitleDraft(event.target.value)}
          onBlur={finishTitleEdit}
          onKeyDown={handleTitleKeyDown}
          className="document-title-input"
        />
      ) : (
        <button
          type="button"
          className="document-title"
          aria-label="双击编辑标题"
          title="双击编辑标题"
          onDoubleClick={startTitleEdit}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") startTitleEdit();
          }}
        >
          {title}
        </button>
      )}
      <div className="ml-auto flex gap-3 items-center">
        {actions.map((action) => (
          <button
            className="topbtn"
            disabled={action.disabled}
            key={action.id}
            onClick={action.onClick}
            type="button"
          >
            {action.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="topbtn topbtn-icon has-tooltip"
          aria-label="导入 Markdown"
          data-tooltip="导入 Markdown"
        >
          <Upload size={16} />
        </button>
        <input
          ref={fileInput}
          onChange={onImport}
          accept=".md,.markdown,text/markdown"
          type="file"
          hidden
        />
        <input
          ref={imageFileInput}
          onChange={onImageUpload}
          accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
          type="file"
          hidden
          data-testid="image-upload"
        />
        <div className="topbtn theme-select">
          <Palette size={16} />
          <select
            value={themeId}
            onChange={(event) => onThemeChange(event.target.value)}
            aria-label="选择主题"
            className="theme-select-control"
          >
            {themes.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.name}
              </option>
            ))}
          </select>
          <ChevronDown size={16} aria-hidden="true" className="pointer-events-none" />
        </div>
        <button
          type="button"
          onClick={onCopy}
          className={`topbtn topbtn-icon has-tooltip ${copied ? "topbtn-success" : ""}`}
          aria-label={copied ? "已复制到公众号" : "复制到公众号"}
          data-tooltip={copied ? "已复制" : "复制到公众号"}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
        <button
          type="button"
          className="preview-mode-toggle"
          aria-label={darkPreview ? "切换至浅色预览" : "切换至暗色预览"}
          aria-pressed={darkPreview}
          onClick={onToggleDarkPreview}
        >
          {darkPreview ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
    </header>
  );
}
