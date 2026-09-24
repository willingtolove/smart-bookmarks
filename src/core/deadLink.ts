// 死链检测：HEAD/GET 请求 + 重定向追踪 + 重复识别
import type { Bookmark } from '../types';

export interface CheckResult {
  id: string;
  status: Bookmark['status'];
  httpStatus?: number;
  finalUrl?: string;
}

export async function checkOne(url: string, timeoutMs = 8000): Promise<{
  status: Bookmark['status'];
  httpStatus?: number;
  finalUrl?: string;
}> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 先尝试 HEAD
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    if (res.status === 405 || res.status === 403 || res.status === 400) {
      // 部分站点禁用 HEAD，回退到带 Range 的 GET
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { Range: 'bytes=0-0' },
      });
    }
    clearTimeout(t);
    if (res.status >= 200 && res.status < 400) {
      return {
        status: res.redirected ? 'redirected' : 'active',
        httpStatus: res.status,
        finalUrl: res.url,
      };
    }
    return { status: 'broken', httpStatus: res.status, finalUrl: res.url };
  } catch (e) {
    clearTimeout(t);
    return { status: 'broken' };
  }
}

export function findDuplicates(bookmarks: Bookmark[]): Map<string, string[]> {
  // 规范化 URL：去尾斜杠、协议统一为 https
  const groups = new Map<string, string[]>();
  for (const b of bookmarks) {
    try {
      const u = new URL(b.url);
      u.hash = '';
      const key = u.toString().replace(/\/$/, '').replace(/^http:/, 'https:');
      const arr = groups.get(key) ?? [];
      arr.push(b.id);
      groups.set(key, arr);
    } catch {
      /* invalid url, skip */
    }
  }
  return new Map([...groups].filter(([, ids]) => ids.length > 1));
}
