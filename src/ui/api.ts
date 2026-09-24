// 与 Service Worker 通信的薄封装
import type { PingResult } from '../core/ai';
import type { Bookmark, Settings } from '../types';

export const api = {
  saveCurrent: () => send<{ ok: boolean }>('SAVE_CURRENT'),
  list: () => send<{ ok: boolean; data: Bookmark[] }>('LIST_BOOKMARKS'),
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
