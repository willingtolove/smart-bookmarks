// 与 Service Worker 通信的薄封装
import type { PingResult } from '../core/ai';
import type { Bookmark, Settings } from '../types';

export const api = {
  saveCurrent: () => send<{ ok: boolean }>('SAVE_CURRENT'),
  /**
   * 拉取全量书签。内部自动分页，避免单次 sendResponse 过大被截断。
   * 支持可选 onProgress 回调，每页触发一次，便于 UI 展示。
   */
  list: async (onProgress?: (loaded: number, total: number) => void): Promise<{ ok: boolean; data: Bookmark[]; total: number }> => {
    const PAGE = 500;
    let offset = 0;
    let all: Bookmark[] = [];
    let total = 0;
    while (true) {
      const r = await send<{ ok: boolean; data?: Bookmark[]; total: number; hasMore: boolean }>(
        'LIST_BOOKMARKS',
        { offset, limit: PAGE },
      );
      const page = r.data ?? [];
      total = r.total ?? total;
      all = all.concat(page);
      onProgress?.(all.length, total);
      if (!r.hasMore) break;
      offset += PAGE;
    }
    return { ok: true, data: all, total };
  },
  get: (id: string) => send<{ ok: boolean; data?: Bookmark }>('GET_BOOKMARK', { id }),
  put: (payload: Bookmark) => send('PUT_BOOKMARK', { payload }),
  remove: (id: string) => send('DELETE_BOOKMARK', { id }),
  openOptions: () => send('OPEN_OPTIONS'),
  openUrl: (url: string) => send('OPEN_URL', { url }),
  checkDeadLinks: () => send('CHECK_DEADLINKS'),
  enrich: (id: string) => send('ENRICH', { id }),
  exportAll: () => send<{ ok: boolean; data: unknown }>('EXPORT_ALL'),
  importAll: (payload: unknown, mode: 'merge' | 'replace') => send('IMPORT_ALL', { payload, mode }),
  getSettings: () => send<{ ok: boolean; data: Settings }>('GET_SETTINGS'),
  saveSettings: (payload: Settings) => send('SAVE_SETTINGS', { payload }),
  pingChat: (ai: Settings['ai']) =>
    send<{ ok: boolean; data?: PingResult; error?: string }>('PING_CHAT', { payload: ai }),
  pingEmbed: (ai: Settings['ai']) =>
    send<{ ok: boolean; data?: PingResult; error?: string }>('PING_EMBED', { payload: ai }),
  batchDelete: (ids: string[], batchId: string) =>
    send<{ ok: boolean }>('BATCH_DELETE', { ids, batchId }),
  batchEnrich: (ids: string[], batchId: string) =>
    send<{ ok: boolean }>('BATCH_ENRICH', { ids, batchId }),
  batchReextract: (ids: string[], batchId: string) =>
    send<{ ok: boolean }>('BATCH_REEXTRACT', { ids, batchId }),
};

export interface BatchProgressPayload {
  batchId: string;
  done: number;
  total: number;
  currentId: string;
  status: 'ok' | 'fail';
  error?: string;
}

function send<T = { ok: boolean }>(type: string, payload?: unknown): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...(payload as object) }, (res) => resolve(res as T));
  });
}
