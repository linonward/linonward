import type { Node as PMNode } from "prosemirror-model";

export type OutlineItem = {
  level: 2 | 3 | 4;
  position: number;
  text: string;
};

/** Returns the headings that are available in the editor's chapter outline. */
export const getOutlineItems = (doc: PMNode): OutlineItem[] => {
  const items: OutlineItem[] = [];
  doc.descendants((node, position) => {
    if (node.type.name !== "heading" || ![2, 3, 4].includes(Number(node.attrs.level))) return;
    const text = node.textContent.trim();
    if (text) items.push({ level: node.attrs.level as OutlineItem["level"], position, text });
  });
  return items;
};
