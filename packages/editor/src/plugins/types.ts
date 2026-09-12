import type { Schema } from "prosemirror-model";
import type { Plugin } from "prosemirror-state";

export type EditorPlugin = {
  id: string;
  createProseMirrorPlugins?: (schema: Schema) => Plugin[];
};

export const composeProseMirrorPlugins = (schema: Schema, plugins: readonly EditorPlugin[]) =>
  plugins.flatMap((plugin) => plugin.createProseMirrorPlugins?.(schema) ?? []);
