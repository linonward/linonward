import type { ReactNode } from "react";

interface LessonOverviewProps {
  files?: string[];
  outcome: string;
  prerequisites?: string;
}

export function LessonOverview({ files = [], outcome, prerequisites }: LessonOverviewProps) {
  return (
    <section className="lesson-overview">
      <div>
        <span>本章完成后</span>
        <strong>{outcome}</strong>
      </div>
      {prerequisites ? (
        <div>
          <span>开始之前</span>
          <p>{prerequisites}</p>
        </div>
      ) : null}
      {files.length > 0 ? (
        <div>
          <span>本章涉及文件</span>
          <ul>
            {files.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

interface StepProps {
  children: ReactNode;
  id: string;
  number: number;
  title: string;
}

export function Step({ children, id, number, title }: StepProps) {
  return (
    <section className="lesson-step">
      <h2 id={id}>
        <span>Step {number}</span>
        {title}
      </h2>
      <div>{children}</div>
    </section>
  );
}

interface CheckpointProps {
  children: ReactNode;
  command: string;
}

export function Checkpoint({ children, command }: CheckpointProps) {
  return (
    <aside className="checkpoint">
      <div className="checkpoint__heading">
        <span aria-hidden="true">✓</span>
        <strong>检查点</strong>
      </div>
      <p>运行：</p>
      <code className="checkpoint__command">{command}</code>
      <div className="checkpoint__result">{children}</div>
    </aside>
  );
}
