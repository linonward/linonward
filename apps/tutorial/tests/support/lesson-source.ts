import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { chapters, type TutorialChapter } from "../../src/lib/chapters";
import { extensionChapters } from "../../src/lib/extensions";

const contentDirectory = fileURLToPath(new URL("../../src/content", import.meta.url));
const extensionDirectory = `${contentDirectory}/extensions`;

export function lessonSource(name: string): string {
  return readFileSync(`${contentDirectory}/${name}.mdx`, "utf8");
}

export function extensionSource(name: string): string {
  return readFileSync(`${extensionDirectory}/${name}.mdx`, "utf8");
}

export function lessonFiles(directory = contentDirectory): string[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".mdx"))
    .toSorted();
}

export function extensionFiles(): string[] {
  return lessonFiles(extensionDirectory);
}

export function registryChapter(slug: string): TutorialChapter | undefined {
  return (
    chapters.find((chapter) => chapter.slug === slug) ??
    extensionChapters.find((chapter) => chapter.slug === slug)
  );
}

/** 去掉 ``` 代码块，避免示例代码里的 HTML/属性干扰结构断言。 */
export function stripCodeFences(source: string): string {
  return source.replace(/```[\s\S]*?```/g, "");
}

export function codeBlocks(source: string, language?: string): string[] {
  const blocks: string[] = [];

  for (const match of source.matchAll(/```([\w-]*)\r?\n([\s\S]*?)```/g)) {
    const [, fenceLanguage = "", body = ""] = match;
    if (language === undefined || fenceLanguage === language) {
      blocks.push(body);
    }
  }

  return blocks;
}

export function codeText(source: string): string {
  return codeBlocks(source).join("\n");
}

export function componentProp(source: string, component: string, prop: string): string | undefined {
  const componentMatch = new RegExp(`<${component}\\b([\\s\\S]*?)/>`).exec(source);
  if (!componentMatch?.[1]) return undefined;

  return new RegExp(`\\b${prop}="([^"]+)"`).exec(componentMatch[1])?.[1];
}

export interface LessonStep {
  id: string;
  number: number;
  title: string;
}

export function steps(source: string): LessonStep[] {
  const found: LessonStep[] = [];

  for (const match of stripCodeFences(source).matchAll(/<Step\b([^>]*)>/g)) {
    const attributes = match[1] ?? "";
    const id = /\bid="([^"]+)"/.exec(attributes)?.[1];
    const number = /\bnumber=\{(\d+)\}/.exec(attributes)?.[1];
    const title = /\btitle="([^"]+)"/.exec(attributes)?.[1];

    if (id && number !== undefined && title) {
      found.push({ id, number: Number(number), title });
    }
  }

  return found;
}

export function stepIds(source: string): string[] {
  return steps(source).map((step) => step.id);
}

export function stepNumbers(source: string): number[] {
  return steps(source).map((step) => step.number);
}

export interface LessonStepBody extends LessonStep {
  body: string;
}

export function stepBodies(source: string): LessonStepBody[] {
  const found: LessonStepBody[] = [];
  const pattern = /<Step\b([^>]*)>([\s\S]*?)<\/Step>/g;

  for (const match of source.matchAll(pattern)) {
    const attributes = match[1] ?? "";
    const id = /\bid="([^"]+)"/.exec(attributes)?.[1];
    const number = /\bnumber=\{(\d+)\}/.exec(attributes)?.[1];
    const title = /\btitle="([^"]+)"/.exec(attributes)?.[1];

    if (id && number !== undefined && title) {
      found.push({ id, number: Number(number), title, body: match[2] ?? "" });
    }
  }

  return found;
}

/** 所有可用作目录锚点的 id，按出现顺序返回；覆盖 Step、LessonPart 与 SectionHeading。 */
export function anchors(source: string): string[] {
  return [...stripCodeFences(source).matchAll(/\bid="([^"]+)"/g)].map((match) => match[1] ?? "");
}

export function hasCheckpointAfterLastStep(source: string): boolean {
  const checkpoint = source.indexOf("<Checkpoint");
  const lastStep = source.lastIndexOf("</Step>");
  return checkpoint > -1 && lastStep > -1 && checkpoint > lastStep;
}

/** 正文里是否使用了某个教学组件；只看组件标签，不看代码块内容。 */
export function hasComponent(source: string, name: string): boolean {
  return new RegExp(`<${name}\\b`).test(stripCodeFences(source));
}

export function componentCount(source: string, name: string): number {
  return [...stripCodeFences(source).matchAll(new RegExp(`<${name}\\b`, "g"))].length;
}

export interface LessonCheckpoint {
  command: string;
  body: string;
}

export function checkpoint(source: string): LessonCheckpoint | undefined {
  const match = /<Checkpoint\b([^>]*)>([\s\S]*?)<\/Checkpoint>/.exec(stripCodeFences(source));
  if (!match) return undefined;

  return {
    command: /command=(['"])(.*?)\1/.exec(match[1] ?? "")?.[2] ?? "",
    body: match[2] ?? "",
  };
}

/**
 * 读取 `<LessonOverview files={[...]} />` 这类数组属性。
 * 它是机器可读的"本章涉及文件"契约，比正文散文稳定。
 */
export function listProp(source: string, component: string, prop: string): string[] {
  const match = new RegExp(`<${component}\\b[\\s\\S]*?\\b${prop}=\\{\\[([\\s\\S]*?)\\]\\}`).exec(
    source,
  );
  if (!match?.[1]) return [];

  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1] ?? "");
}
