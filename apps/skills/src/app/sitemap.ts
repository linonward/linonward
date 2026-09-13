import type { MetadataRoute } from "next";
import { getAllSkills } from "@/lib/github-skills";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const skills = await getAllSkills();
  return [
    { url: "https://skills.linonward.com", changeFrequency: "weekly", priority: 1 },
    ...skills.map((skill) => ({
      url: `https://skills.linonward.com/skills/${skill.slug}`,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  ];
}
