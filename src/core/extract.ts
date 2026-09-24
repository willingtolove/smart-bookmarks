// 简易 Readability 抽取
// 提供两个版本：
// - extractReadableFromDom：DOM 解析（content script 使用，精度高）
// - extractReadableFromString：纯正则（Service Worker 使用，无 window 依赖）

export interface Extracted {
  title?: string;
  description?: string;
  cover?: string;
  text: string;
  canonicalUrl?: string;
}

function decodeEntities(s: string) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

// 共用的 meta 抽取（纯字符串）
function pickMeta(html: string): { title?: string; description?: string; cover?: string; canonical?: string } {
  const title = metaContent(html, /property=["']og:title["']\s+content=["']([^"']+)/i)
    ?? tagText(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = metaContent(html, /property=["']og:description["']\s+content=["']([^"']+)/i)
    ?? metaContent(html, /name=["']description["']\s+content=["']([^"']+)/i);
  const cover = metaContent(html, /property=["']og:image["']\s+content=["']([^"']+)/i)
    ?? tagAttr(html, /<link[^>]+rel=["']image_src["'][^>]*>/i, 'href');
  const canonical = tagAttr(html, /<link[^>]+rel=["']canonical["'][^>]*>/i, 'href');
  return { title, description, cover, canonical };
}

function metaContent(html: string, re: RegExp): string | undefined {
  const m = re.exec(html);
  return m?.[1];
}

function tagText(html: string, re: RegExp): string | undefined {
  const m = re.exec(html);
  return m?.[1];
}

function tagAttr(html: string, re: RegExp, attr: string): string | undefined {
  const m = re.exec(html);
  if (!m) return undefined;
  const attrRe = new RegExp(`${attr}=["']([^"']+)`, 'i');
  const a = attrRe.exec(m[0]);
  return a?.[1];
}

function stripTags(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// === DOM 版本（content script） ===
export function extractReadableFromDom(html: string, baseUrl: string): Extracted {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title =
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ??
    doc.querySelector('title')?.textContent ??
    undefined;
  const description =
    doc.querySelector('meta[property="og:description"]')?.getAttribute('content') ??
    doc.querySelector('meta[name="description"]')?.getAttribute('content') ??
    undefined;
  const cover =
    doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ??
    doc.querySelector('link[rel="image_src"]')?.getAttribute('href') ??
    undefined;
  const canonical =
    doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? baseUrl;

  // 移除无关节点
  doc.querySelectorAll('script, style, noscript, nav, header, footer, aside, form, svg').forEach((el) => el.remove());

  // 启发式：挑正文最长的 <article> 或 <main> 或 <body>
  const candidates = [
    ...Array.from(doc.querySelectorAll('article')),
    ...Array.from(doc.querySelectorAll('main')),
    doc.body,
  ].filter(Boolean) as HTMLElement[];

  let best: HTMLElement | null = null;
  let bestScore = 0;
  for (const el of candidates) {
    const text = (el.textContent ?? '').trim();
    const score = text.length;
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }

  const text = (best?.textContent ?? doc.body?.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);

  return {
    title: title ? decodeEntities(title).trim() : undefined,
    description: description ? decodeEntities(description).trim() : undefined,
    cover: cover ? new URL(cover, baseUrl).toString() : undefined,
    canonicalUrl: canonical,
    text,
  };
}

// === 字符串版本（Service Worker / Node 等无 DOM 环境） ===
export function extractReadableFromString(html: string, baseUrl: string): Extracted {
  const { title, description, cover, canonical } = pickMeta(html);

  // 启发式：挑正文最长的 <article> / <main> / <body>
  const articleMatch = /<article\b[\s\S]*?<\/article>/i.exec(html);
  const mainMatch = /<main\b[\s\S]*?<\/main>/i.exec(html);
  const bodyMatch = /<body\b[\s\S]*?<\/body>/i.exec(html);

  let bestHtml = '';
  if (articleMatch) bestHtml = articleMatch[0];
  else if (mainMatch) bestHtml = mainMatch[0];
  else if (bodyMatch) bestHtml = bodyMatch[0];
  else bestHtml = html;

  const text = stripTags(bestHtml).slice(0, 12000);

  return {
    title: title ? decodeEntities(title).trim() : undefined,
    description: description ? decodeEntities(description).trim() : undefined,
    cover: cover ? safeUrl(cover, baseUrl) : undefined,
    canonicalUrl: canonical ?? baseUrl,
    text,
  };
}

function safeUrl(href: string, baseUrl: string): string | undefined {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined;
  }
}

// 向后兼容的旧名（content script 仍用 DOM 版本）
export const extractReadable = extractReadableFromDom;
