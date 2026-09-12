"use client";

import { ArrowRight, BriefcaseBusiness, GitBranch, MessageSquareText } from "lucide-react";
export function Hero() {
  const scrollToForm = () =>
    document.getElementById("submit")?.scrollIntoView({ behavior: "smooth" });
  return (
    <section className="hero">
      <div className="shell hero-grid">
        <div className="hero-copy">
          <h1>明天就要面试？</h1>
          <p className="hero-lead">
            技术岗社招测试计划：提交 JD + 简历，获取针对这场面试的专属作战包。
          </p>
          <p className="hero-note">
            <mark className="marker">不是通用题库</mark>，而是根据「你的简历 × 目标岗位」定向准备。
          </p>
          <button className="button" onClick={scrollToForm}>
            提交资料，获取作战包 <ArrowRight aria-hidden="true" />
          </button>
          <div className="price">
            <span>基础作战包</span>
            <strong>¥49</strong>
            <small>深度包 ¥199 · 含人工校验与薄弱点分析</small>
          </div>
        </div>
        <div className="pack" aria-label="Interview Pack 示例">
          <div className="paper">
            <p className="pack-brand">Interview Pack</p>
            <h2>面试作战包</h2>
            <div className="pack-divider" />
            <div className="pack-row question-row">
              <b className="pack-symbol">
                <BriefcaseBusiness aria-hidden="true" />
              </b>
              <div>
                <strong>JD：AI 应用开发工程师</strong>
                <p>Agent · RAG · 服务端 · 产品落地</p>
                <p>简历：负责知识库问答与工作流编排</p>
              </div>
            </div>
            <div className="pack-divider dotted" />
            <div className="pack-row answer-row">
              <b className="pack-symbol">
                <MessageSquareText aria-hidden="true" />
              </b>
              <div>
                <strong>高概率问题</strong>
                <p>如何评估 Agent 工作流的实际收益？</p>
              </div>
            </div>
            <div className="pack-divider dotted" />
            <div className="pack-row timeline-row">
              <b className="pack-symbol">
                <GitBranch aria-hidden="true" />
              </b>
              <div>
                <strong>追问链</strong>
                <ol className="timeline">
                  <li>为什么这么设计？</li>
                  <li>如何衡量收益？</li>
                  <li>多人团队如何落地？</li>
                  <li>如果重新做一次会改变什么？</li>
                </ol>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
