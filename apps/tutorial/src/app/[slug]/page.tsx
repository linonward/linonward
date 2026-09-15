import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TutorialShell } from "@/components/tutorial-shell";
import { type AnyChapter, chapters, getChapter } from "@/lib/chapters";
import { extensionChapters, getExtensionChapter } from "@/lib/extensions";

interface ChapterPageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return [...chapters, ...extensionChapters].map((chapter) => ({ slug: chapter.slug }));
}

function findChapter(slug: string): AnyChapter | undefined {
  return getChapter(slug) ?? getExtensionChapter(slug);
}

export async function generateMetadata({ params }: ChapterPageProps): Promise<Metadata> {
  const { slug } = await params;
  const chapter = findChapter(slug);

  if (!chapter) {
    return {};
  }

  return {
    title: `${chapter.number} ${chapter.title}`,
    description: chapter.description,
  };
}

export default async function ChapterPage({ params }: ChapterPageProps) {
  const { slug } = await params;
  const chapter = findChapter(slug);

  if (!chapter) {
    notFound();
  }

  const { default: Content } = await chapter.load();

  return (
    <TutorialShell chapter={chapter}>
      <Content />
    </TutorialShell>
  );
}
