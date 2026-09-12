import type { CSSProperties, RefObject } from "react";

import { getEditorThemeVariables } from "../themes";

import styles from "./EditorWorkspace.module.css";

export default function EditorWorkspace({
  mount,
  html,
  themeId,
  darkPreview,
  formatBrushActive,
}: {
  mount: RefObject<HTMLDivElement | null>;
  html: string;
  themeId: string;
  darkPreview: boolean;
  formatBrushActive: boolean;
}) {
  return (
    <section
      className={`${styles.workspace} editor-workspace ${formatBrushActive ? styles.formatBrushActive : ""}`}
      data-richtext-theme={themeId}
      style={getEditorThemeVariables(themeId) as CSSProperties}
    >
      <section className={styles.editorPane}>
        <div className={styles.editorFrame}>
          <div ref={mount} />
        </div>
      </section>
      <aside
        className={`${styles.preview} editor-preview ${darkPreview ? `${styles.previewDark} editor-preview-dark` : ""}`}
      >
        <div className={styles.previewFrame}>
          <article dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </aside>
    </section>
  );
}
