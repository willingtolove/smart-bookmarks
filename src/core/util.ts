// 通用工具
import { nanoid } from 'nanoid';

export const newId = () => nanoid(12);

export function normalizeUrl(url: string) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

export function debounce<T extends (...args: any[]) => void>(fn: T, ms = 200) {
  let h: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (h) clearTimeout(h);
    h = setTimeout(() => fn(...args), ms);
  };
}

export function classNames(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

export function downloadJSON(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function parseBrowserBookmarksHtml(html: string): Array<{
  title: string;
  url: string;
  addDate?: number;
}> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: { title: string; url: string; addDate?: number }[] = [];
  doc.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href');
    if (!href) return;
    out.push({
      title: a.textContent?.trim() || href,
      url: href,
      addDate: a.getAttribute('add_date') ? Number(a.getAttribute('add_date')) * 1000 : undefined,
    });
  });
  return out;
}
