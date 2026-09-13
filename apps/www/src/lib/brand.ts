export const brand = {
  siteUrl: "https://www.linonward.com",
  englishName: "linonward",
  chineseName: "林昂在路上",
  slogan: "BETTER ME · ON THE WAY",
  title: "林昂在路上｜向前，自有风景。",
  description: "记录成长、日常与探索。和 linonward 林昂在路上一起，把每一步走成自己的风景。",
  xHandle: "@LinOnward",
  wechatQrCode: "/brand/wechat_qrcode.jpg" as string | null,
  socialLinks: [
    {
      label: "小红书",
      cta: "访问小红书主页",
      href: "https://www.xiaohongshu.com/user/profile/679388c1000000000d0088d3",
    },
    {
      label: "X",
      cta: "访问 X 主页",
      href: "https://x.com/LinOnward",
    },
  ],
  navItems: [
    { label: "关于", href: "#about" },
    { label: "内容", href: "#content" },
    { label: "文章", href: "https://notes.linonward.com" },
    { label: "Skills", href: "https://skills.linonward.com" },
    { label: "产品", href: "#products" },
    { label: "关注", href: "#follow" },
  ],
  product: {
    name: "Interview Pack",
    href: "https://interview.linonward.com",
    tagline: "针对这一场面试，做更有针对性的准备。",
    description:
      "根据你的 JD、简历和面试轮次，为一场具体的技术面试整理可练习、可复盘的专属作战包。",
    audience: "技术岗社招测试计划",
    inputs: "JD × 简历 × 面试轮次",
    features: ["高概率问题与回答要点", "连续追问路径与薄弱点", "面试前 2 小时冲刺计划"],
  },
  assets: {
    horizontalLogo: "/brand/03_logo_horizontal_transparent.png",
    darkLogo: "/brand/04_logo_dark.png",
    wechatAvatar: "/brand/06_wechat_avatar.png",
    poster: "/brand/08_brand_poster.png",
    hero: "/brand/11_website_hero.png",
    merch: "/brand/13_merch_mockup.png",
  },
} as const;

export const contentDirections = [
  {
    number: "01",
    title: "成长与行动",
    description: "把目标拆成具体的小步，在行动中持续调整。",
  },
  {
    number: "02",
    title: "日常与记录",
    description: "记录观察、阅读和生活片段，积累自己的理解。",
  },
  {
    number: "03",
    title: "探索与发现",
    description: "保持好奇，走进新的环境，也重新认识自己。",
  },
] as const;

export const aboutPrinciples = [
  { title: "向前", description: "把想法变成行动，在实践里寻找答案。" },
  { title: "记录", description: "留住真实的过程，让经验成为下一步的参考。" },
  { title: "发现", description: "在熟悉的日常里，看见新的可能。" },
] as const;
