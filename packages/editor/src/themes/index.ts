import type { Theme } from "./types";

const editorTokens = {
  "--richtext-body": "rgba(0, 0, 0, 0.9)",
  "--richtext-heading-h1": "#1f1f1f",
  "--richtext-heading-h2": "#252525",
  "--richtext-heading-h3": "#303030",
  "--richtext-quote-border": "3px solid #b7b7b7",
  "--richtext-quote-text": "#666666",
  "--richtext-code-background": "#f3f3f6",
  "--richtext-code-border": "1px solid #e3e3e9",
  "--richtext-code-text": "#303241",
  "--richtext-inline-code-background": "#f0eff8",
  "--richtext-inline-code-text": "#7334a3",
  "--richtext-link": "#576b95",
  "--richtext-divider": "1px solid #d9dbe3",
  "--richtext-list-bullet": "#4438e8",
  "--richtext-list-bullet-ring": "#efeeff",
  "--richtext-list-unordered": "#6d7280",
  "--richtext-list-number": "#6d7280",
  "--richtext-table-border": "#dfe1e8",
  "--richtext-table-cell-border": "#e2e4eb",
  "--richtext-table-heading-background": "#f1f0ff",
  "--richtext-table-heading-text": "#342aa7",
  "--richtext-table-selection": "rgba(68, 56, 232, 0.1)",
  "--richtext-table-resize": "#4438e8",
} as const;

const base = {
  editorTokens,
  article: {
    color: editorTokens["--richtext-body"],
    fontSize: "16px",
    lineHeight: "1.6",
    fontFamily:
      "PingFang SC, system-ui, -apple-system, BlinkMacSystemFont, Helvetica Neue, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Arial, sans-serif",
  },
  paragraph: { margin: "8px 0 24px" },
  headings: {
    h1: {
      fontSize: "26px",
      fontWeight: "700",
      lineHeight: "1.45",
      margin: "8px 0 28px",
      color: editorTokens["--richtext-heading-h1"],
      fontFamily:
        "PingFang SC, system-ui, -apple-system, BlinkMacSystemFont, Helvetica Neue, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Arial, sans-serif",
    },
    h2: {
      fontSize: "18px",
      fontWeight: "700",
      lineHeight: "1.6",
      margin: "8px 0 24px",
      color: editorTokens["--richtext-heading-h2"],
      fontFamily:
        "PingFang SC, system-ui, -apple-system, BlinkMacSystemFont, Helvetica Neue, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Arial, sans-serif",
    },
    h3: {
      fontSize: "18px",
      fontWeight: "700",
      lineHeight: "1.6",
      margin: "8px 0 24px",
      color: editorTokens["--richtext-heading-h3"],
      fontFamily:
        "PingFang SC, system-ui, -apple-system, BlinkMacSystemFont, Helvetica Neue, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Arial, sans-serif",
    },
  },
  blockquote: {
    borderLeft: editorTokens["--richtext-quote-border"],
    color: editorTokens["--richtext-quote-text"],
    margin: "28px 0",
    padding: "2px 0 2px 16px",
  },
  codeBlock: {
    backgroundColor: editorTokens["--richtext-code-background"],
    border: editorTokens["--richtext-code-border"],
    borderRadius: "6px",
    color: editorTokens["--richtext-code-text"],
    fontSize: "13px",
    lineHeight: "1.65",
    margin: "20px 0",
    padding: "16px",
    whiteSpace: "pre-wrap",
  },
  inlineCode: {
    backgroundColor: editorTokens["--richtext-inline-code-background"],
    borderRadius: "3px",
    color: editorTokens["--richtext-inline-code-text"],
    fontSize: ".88em",
    padding: "2px 4px",
  },
  image: { display: "block", height: "auto", margin: "22px auto", maxWidth: "100%", width: "auto" },
  orderedList: { margin: "0 0 18px", paddingLeft: "26px" },
  bulletList: { margin: "0 0 18px", paddingLeft: "26px" },
  link: { color: editorTokens["--richtext-link"], textDecoration: "none" },
  horizontalRule: { border: "0", borderTop: editorTokens["--richtext-divider"], margin: "35px 0" },
};

const createColorTheme = (
  id: string,
  name: string,
  overrides: Partial<Record<keyof typeof editorTokens, string>>,
) => {
  const tokens = { ...base.editorTokens, ...overrides };
  return {
    ...base,
    id,
    name,
    editorTokens: tokens,
    article: { ...base.article, color: tokens["--richtext-body"] },
    headings: {
      ...base.headings,
      h1: { ...base.headings.h1, color: tokens["--richtext-heading-h1"] },
      h2: { ...base.headings.h2, color: tokens["--richtext-heading-h2"] },
      h3: { ...base.headings.h3, color: tokens["--richtext-heading-h3"] },
    },
    blockquote: {
      ...base.blockquote,
      borderLeft: tokens["--richtext-quote-border"],
      color: tokens["--richtext-quote-text"],
    },
    codeBlock: {
      ...base.codeBlock,
      backgroundColor: tokens["--richtext-code-background"],
      border: tokens["--richtext-code-border"],
      color: tokens["--richtext-code-text"],
    },
    inlineCode: {
      ...base.inlineCode,
      backgroundColor: tokens["--richtext-inline-code-background"],
      color: tokens["--richtext-inline-code-text"],
    },
    link: { ...base.link, color: tokens["--richtext-link"] },
    horizontalRule: { ...base.horizontalRule, borderTop: tokens["--richtext-divider"] },
  };
};

const defaultTheme = createColorTheme("default", "公众号默认", {});
const minimalTheme = createColorTheme("minimal", "极简技术", {
  "--richtext-body": "#1e2026",
  "--richtext-heading-h1": "#222222",
  "--richtext-heading-h2": "#222222",
  "--richtext-heading-h3": "#222222",
  "--richtext-quote-border": "2px solid #222222",
});

export const themes: Theme[] = [
  defaultTheme,
  {
    ...minimalTheme,
    article: { ...minimalTheme.article, lineHeight: "1.95" },
    headings: {
      ...minimalTheme.headings,
      h2: {
        ...minimalTheme.headings.h2,
        borderBottom: "2px solid #222222",
        paddingBottom: "8px",
      },
    },
  },
  createColorTheme("ocean", "海岸蓝", {
    "--richtext-body": "#26364a",
    "--richtext-heading-h1": "#163f68",
    "--richtext-heading-h2": "#1d5687",
    "--richtext-heading-h3": "#2870a6",
    "--richtext-quote-border": "3px solid #5b9bc8",
    "--richtext-quote-text": "#5a7086",
    "--richtext-code-background": "#f1f7fb",
    "--richtext-code-border": "1px solid #cfe0ed",
    "--richtext-code-text": "#31536f",
    "--richtext-inline-code-background": "#e7f1f9",
    "--richtext-inline-code-text": "#1d689d",
    "--richtext-link": "#2376b3",
    "--richtext-divider": "1px solid #c7dce9",
    "--richtext-list-bullet": "#287eb9",
    "--richtext-list-bullet-ring": "#e3f0f8",
    "--richtext-list-unordered": "#5e87a5",
    "--richtext-list-number": "#5e87a5",
    "--richtext-table-border": "#c9deec",
    "--richtext-table-cell-border": "#d8e7f0",
    "--richtext-table-heading-background": "#eaf4fa",
    "--richtext-table-heading-text": "#215f90",
    "--richtext-table-selection": "rgba(40, 126, 185, 0.12)",
    "--richtext-table-resize": "#287eb9",
  }),
  createColorTheme("warm", "暖棕", {
    "--richtext-body": "#3e342e",
    "--richtext-heading-h1": "#5e3828",
    "--richtext-heading-h2": "#76452f",
    "--richtext-heading-h3": "#985d3b",
    "--richtext-quote-border": "3px solid #bd8b66",
    "--richtext-quote-text": "#79685d",
    "--richtext-code-background": "#fbf6f1",
    "--richtext-code-border": "1px solid #ead9cb",
    "--richtext-code-text": "#674b3b",
    "--richtext-inline-code-background": "#f7e9df",
    "--richtext-inline-code-text": "#a25836",
    "--richtext-link": "#a65a34",
    "--richtext-divider": "1px solid #e5cfc0",
    "--richtext-list-bullet": "#ad663f",
    "--richtext-list-bullet-ring": "#f7e8de",
    "--richtext-list-unordered": "#9b765e",
    "--richtext-list-number": "#9b765e",
    "--richtext-table-border": "#e6cdbd",
    "--richtext-table-cell-border": "#f0ded2",
    "--richtext-table-heading-background": "#faeee6",
    "--richtext-table-heading-text": "#8a4a2d",
    "--richtext-table-selection": "rgba(173, 102, 63, 0.12)",
    "--richtext-table-resize": "#ad663f",
  }),
];
export const getTheme = (id: string): Theme => {
  const theme = themes.find((entry) => entry.id === id) ?? themes[0];
  if (!theme) throw new Error("The editor must define at least one theme.");
  return theme;
};
export const getEditorThemeVariables = (id: string) => getTheme(id).editorTokens;
