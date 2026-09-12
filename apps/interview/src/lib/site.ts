export const siteConfig = {
  name: "Interview Pack",
  title: "技术岗面试作战包｜针对一场面试的限时准备",
  description:
    "面向技术岗社招测试计划，结合 JD、简历、技术方向与面试轮次，人工交付可练习、可复盘的专属面试作战包。",
  url: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://interview.linonward.com"),
} as const;
