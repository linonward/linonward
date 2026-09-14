import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TutorialShell } from "@/components/tutorial-shell";
import { chapters, getChapter } from "@/lib/chapters";

interface ChapterPageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return chapters.map((chapter) => ({ slug: chapter.slug }));
}

export async function generateMetadata({ params }: ChapterPageProps): Promise<Metadata> {
  const { slug } = await params;
  const chapter = getChapter(slug);

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
  const chapter = getChapter(slug);

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
