import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { getGitHubFileUrl } from "@/lib/github-skills";

type SkillMarkdownProps = {
  markdown: string;
  slug: string;
};

export function SkillMarkdown({ markdown, slug }: SkillMarkdownProps) {
  return (
    <div className="skill-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => {
          if (/^(?:https?:|mailto:|#)/.test(url)) return defaultUrlTransform(url);
          return getGitHubFileUrl(slug, url);
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
