import { Plus } from "lucide-react";

export const faqItems = [
  {
    id: "delivery",
    question: "提交后多久会收到结果？",
    answer: "当前为限额人工交付。我们会在确认资料后联系你，说明这场面试的交付安排。",
  },
  {
    id: "chatgpt",
    question: "和直接使用 ChatGPT 有什么区别？",
    answer:
      "ChatGPT 更适合通用问答；Interview Pack 会结合你的 JD、简历和面试时间，整理高频题、回答要点、追问路径与准备建议，让你直接按一场具体面试来练习。",
  },
  {
    id: "privacy",
    question: "我的资料会被用于其他用途吗？",
    answer:
      "不会。提交的信息只用于本次面试准备、沟通与服务改进；只有你在面后回访中明确勾选授权时，才会联系你讨论匿名案例分享。",
  },
  {
    id: "resume",
    question: "可以上传 PDF 简历吗？",
    answer: "当前测试版仅支持直接粘贴文本，暂不支持 PDF 上传与解析。",
  },
];
export function Faq() {
  return (
    <section className="section faq">
      <div className="shell narrow">
        <h2>常见问题</h2>
        {faqItems.map(({ id, question, answer }) => (
          <details key={id}>
            <summary>
              {id === "chatgpt" ? (
                <>
                  和直接使用 <mark className="marker marker-blue">ChatGPT</mark> 有什么区别？
                </>
              ) : (
                question
              )}
              <Plus aria-hidden="true" />
            </summary>
            <p>{answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
