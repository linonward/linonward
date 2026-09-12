export type Theme = {
  id: string;
  name: string;
  editorTokens: Record<`--richtext-${string}`, string>;
  article: Record<string, string>;
  paragraph: Record<string, string>;
  headings: Record<string, Record<string, string>>;
  blockquote: Record<string, string>;
  codeBlock: Record<string, string>;
  inlineCode: Record<string, string>;
  image: Record<string, string>;
  orderedList: Record<string, string>;
  bulletList: Record<string, string>;
  link: Record<string, string>;
  horizontalRule: Record<string, string>;
};
