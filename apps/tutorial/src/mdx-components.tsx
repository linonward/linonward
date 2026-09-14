import type { MDXComponents } from "mdx/types";

import { AgentFlow } from "@/components/agent-flow";
import { AgentLoopDiagram } from "@/components/agent-loop-diagram";
import { Callout } from "@/components/callout";
import { CodeBlock } from "@/components/code-block";
import { Checkpoint, LessonOverview, Step } from "@/components/lesson";
import { MdxCodeBlock } from "@/components/mdx-code-block";
import { SectionHeading } from "@/components/section-heading";

const components: MDXComponents = {
  AgentFlow,
  AgentLoopDiagram,
  Callout,
  CodeBlock,
  Checkpoint,
  LessonOverview,
  pre: MdxCodeBlock,
  SectionHeading,
  Step,
};

export function useMDXComponents(): MDXComponents {
  return components;
}
