export const sanitizeWechatHtml = (html: string) =>
  html
    .replace(/<\/?(script|style|iframe|form)[^>]*>/gi, "")
    .replace(/\s(on\w+|class)=("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /(?:position\s*:\s*(?:fixed|absolute|sticky)|animation\s*:[^;"']*|transition\s*:[^;"']*|filter\s*:[^;"']*)\s*;?/gi,
      "",
    );
