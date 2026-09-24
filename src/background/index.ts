// Service Worker：负责命令、菜单、消息路由、定时任务
/// <reference types="chrome" />
import { db } from '../core/db';
import { newId, normalizeUrl } from '../core/util';
import { checkOne, findDuplicates } from '../core/deadLink';
import { AiClient } from '../core/ai';
import { extractReadableFromString, type Extracted } from '../core/extract';
import type { Bookmark, Settings } from '../types';

const ALARM_DEADLINK = 'smart-bookmarks.deadlink';
const ALARM_DUP = 'smart-bookmarks.dup';
const SW_VERSION = '0.2.0';

console.log('[smart-bookmarks] SW booted', { version: SW_VERSION });

/** ping content script 拿正文，5 秒超时；失败返回 null */
async function pingContentForExtract(tabId: number, id: string): Promise<Extracted | null> {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PING_EXTRACT', id });
    if (res?.ok && res.data) {
      return {
        title: res.data.title,
        description: res.data.description,
        cover: res.data.cover,
        text: res.data.text ?? '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** SW 端降级路径：fetch + 纯正则抽取，8 秒超时 */
async function fetchAndExtract(url: string, timeoutMs = 8000): Promise<Extracted | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { credentials: 'omit', signal: controller.signal });
    if (!res.ok) {
      console.warn('[enrich] fetch non-ok', { url, status: res.status });
      return null;
    }
    const html = await res.text();
    return extractReadableFromString(html, url);
  } catch (e) {
    console.error('[enrich] fetch failed', { url, error: e });
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function getSettings(): Promise<Settings> {
  return db.getSettings();
}

async function saveCurrentTab(tab?: chrome.tabs.Tab | null) {
  if (!tab) tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.url || !tab.title) return;
  const url = tab.url;
  const existing = await db.getBookmarkByUrl(normalizeUrl(url));
  if (existing) {
    await db.putBookmark({ ...existing, visitCount: existing.visitCount + 1, lastVisitedAt: Date.now() });
    return;
  }
  const now = Date.now();
  const bookmark: Bookmark = {
    id: newId(),
    url,
    title: tab.title ?? url,
    favicon: tab.favIconUrl,
    tagIds: [],
    createdAt: now,
    updatedAt: now,
    visitCount: 1,
    lastVisitedAt: now,
    status: 'active',
  };
  await db.putBookmark(bookmark);

  // 异步跑完整 enrich（content 优先，降级 fetch；再跑 AI）
  void enrichBookmark(bookmark.id);
}

async function enrichBookmark(id: string) {
  const b = await db.getBookmark(id);
  if (!b) {
    console.warn('[enrich] bookmark not found', { id });
    return;
  }

  // 1) 优先 ping 当前打开这条 URL 的 content script
  let extracted: Extracted | null = null;
  try {
    const tabs = await chrome.tabs.query({ url: b.url });
    const tabId = tabs[0]?.id;
    if (tabId !== undefined) {
      extracted = await pingContentForExtract(tabId, id);
      if (extracted) {
        console.info('[enrich] content extract ok', { id, url: b.url, len: extracted.text.length });
      }
    }
  } catch (e) {
    console.error('[enrich] tabs.query failed', { id, url: b.url, error: e });
  }

  // 2) 降级：SW fetch + 纯正则抽
  if (!extracted) {
    extracted = await fetchAndExtract(b.url);
    if (extracted) {
      console.info('[enrich] fallback extract ok', { id, url: b.url, len: extracted.text.length });
    }
  }

  // 3) 没正文就退出（AI 没料也没意义）
  if (!extracted) {
    console.error('[enrich] no content available', { id, url: b.url });
    return;
  }

  // 4) 写 content/cover/description
  const updated: Bookmark = {
    ...b,
    content: extracted.text.slice(0, 8000),
    coverImage: extracted.cover ?? b.coverImage,
    description: extracted.description ?? b.description,
    updatedAt: Date.now(),
  };

  // 5) AI 分类
  const settings = await getSettings();
  if (settings.ai.enabled && settings.ai.apiKey) {
    const ai = new AiClient(settings.ai);
    try {
      const meta = await ai.classifyAndSummarize({
        title: b.title,
        url: b.url,
        content: updated.content ?? '',
      });
      updated.ai = { ...(b.ai ?? {}), ...meta, classifiedAt: Date.now(), model: settings.ai.model };
      if (settings.ai.embedModel) {
        try {
          updated.ai!.embedding = await ai.embed(
            `${b.title}\n${meta.summary}\n${(updated.content ?? '').slice(0, 1000)}`,
          );
        } catch (e) {
          console.error('[enrich] embed failed', { id, error: e });
        }
      }
    } catch (e) {
      console.error('[enrich] ai failed', { id, url: b.url, error: e });
    }
  } else {
    console.info('[enrich] ai disabled or no api key, skip classification', { id });
  }

  await db.putBookmark(updated);
  console.info('[enrich] done', { id, hasAi: !!updated.ai });
}

/**
 * 仅重抽正文/封面/描述，跳过 AI 分类。
 * 用于「批量重抽正文」按钮：保留已有 ai 字段不变。
 */
async function reextractBookmark(id: string) {
  const b = await db.getBookmark(id);
  if (!b) {
    console.warn('[reextract] bookmark not found', { id });
    return;
  }
  let extracted: Extracted | null = null;
  try {
    const tabs = await chrome.tabs.query({ url: b.url });
    const tabId = tabs[0]?.id;
    if (tabId !== undefined) {
      extracted = await pingContentForExtract(tabId, id);
      if (extracted) console.info('[reextract] content ok', { id, len: extracted.text.length });
    }
  } catch (e) {
    console.error('[reextract] tabs.query failed', { id, error: e });
  }
  if (!extracted) {
    extracted = await fetchAndExtract(b.url);
    if (extracted) console.info('[reextract] fallback ok', { id, len: extracted.text.length });
  }
  if (!extracted) {
    console.error('[reextract] no content available', { id });
    return;
  }
  await db.putBookmark({
    ...b,
    content: extracted.text.slice(0, 8000),
    coverImage: extracted.cover ?? b.coverImage,
    description: extracted.description ?? b.description,
    updatedAt: Date.now(),
  });
  console.info('[reextract] done', { id });
}

type BatchMode = 'delete' | 'enrich' | 'reextract';

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function reportProgress(
  batchId: string,
  done: number,
  total: number,
  currentId: string,
  status: 'ok' | 'fail',
  error?: string,
) {
  chrome.runtime
    .sendMessage({ type: 'BATCH_PROGRESS', payload: { batchId, done, total, currentId, status, error } })
    .catch(() => {/* UI may have unmounted */});
}

async function runBatch(ids: string[], mode: BatchMode, batchId: string) {
  console.info(`[batch] start`, { batchId, mode, count: ids.length });
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      if (mode === 'delete') {
        await db.deleteBookmark(id);
      } else if (mode === 'enrich') {
        await enrichBookmark(id);
      } else {
        await reextractBookmark(id);
      }
      reportProgress(batchId, i + 1, ids.length, id, 'ok');
    } catch (e) {
      console.error(`[batch] ${mode} failed`, { batchId, id, error: e });
      reportProgress(batchId, i + 1, ids.length, id, 'fail', String(e));
    }
    await sleep(200);
  }
  reportProgress(batchId, ids.length, ids.length, '', 'ok', undefined);
  console.info(`[batch] done`, { batchId, mode });
}

async function scheduleJobs() {
  const s = await getSettings();
  if (s.deadLinkCheck.enabled) {
    chrome.alarms.create(ALARM_DEADLINK, { periodInMinutes: Math.max(15, s.deadLinkCheck.intervalHours * 60) });
  } else {
    chrome.alarms.clear(ALARM_DEADLINK);
  }
  chrome.alarms.create(ALARM_DUP, { periodInMinutes: 60 * 6 });
}

async function runDeadLinkSweep() {
  const s = await getSettings();
  const all = await db.listBookmarks();
  const queue = all
    .filter((b) => b.status === 'active' || b.status === 'redirected' || b.status === 'broken')
    .sort((a, b) => (a.lastCheckedAt ?? 0) - (b.lastCheckedAt ?? 0))
    .slice(0, s.deadLinkCheck.batchSize);
  for (const b of queue) {
    const r = await checkOne(b.url, s.deadLinkCheck.timeoutMs);
    await db.putBookmark({
      ...b,
      status: r.status,
      httpStatus: r.httpStatus,
      finalUrl: r.finalUrl,
      lastCheckedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
}

async function runDuplicateSweep() {
  const all = await db.listBookmarks();
  const dups = findDuplicates(all);
  let count = 0;
  for (const [, ids] of dups) {
    // 保留访问次数最多的，其余标记为 duplicate
    const sorted = ids
      .map((id) => all.find((x) => x.id === id)!)
      .sort((a, b) => (b.visitCount ?? 0) - (a.visitCount ?? 0));
    for (let i = 1; i < sorted.length; i++) {
      await db.putBookmark({ ...sorted[i], status: 'duplicate', updatedAt: Date.now() });
      count++;
    }
  }
  if (count > 0) console.info(`[dup] marked ${count} duplicates`);
}

chrome.runtime.onInstalled.addListener(async () => {
  await scheduleJobs();
  await migrateBrowserBookmarks();
  setupContextMenu();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleJobs();
  setupContextMenu();
});

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'smart-bookmarks.save',
      title: '保存到 Smart Bookmarks',
      contexts: ['page', 'link'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'smart-bookmarks.save') {
    if (info.linkUrl) {
      const b: Bookmark = {
        id: newId(),
        url: info.linkUrl,
        title: tab?.title ?? info.linkUrl,
        favicon: tab?.favIconUrl,
        tagIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        visitCount: 0,
        status: 'active',
      };
      await db.putBookmark(b);
      void enrichBookmark(b.id);
    } else {
      await saveCurrentTab(tab);
    }
  }
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'save-bookmark') saveCurrentTab();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_DEADLINK) void runDeadLinkSweep();
  if (alarm.name === ALARM_DUP) void runDuplicateSweep();
});

// 消息路由（popup/options/content 共用）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'SAVE_CURRENT': {
          await saveCurrentTab();
          sendResponse({ ok: true });
          break;
        }
        case 'LIST_BOOKMARKS': {
          sendResponse({ ok: true, data: await db.listBookmarks() });
          break;
        }
        case 'GET_BOOKMARK': {
          sendResponse({ ok: true, data: await db.getBookmark(msg.id) });
          break;
        }
        case 'PUT_BOOKMARK': {
          await db.putBookmark(msg.payload);
          sendResponse({ ok: true });
          break;
        }
        case 'DELETE_BOOKMARK': {
          await db.deleteBookmark(msg.id);
          sendResponse({ ok: true });
          break;
        }
        case 'OPEN_OPTIONS': {
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        }
        case 'CHECK_DEADLINKS': {
          await runDeadLinkSweep();
          sendResponse({ ok: true });
          break;
        }
        case 'ENRICH': {
          void enrichBookmark(msg.id);
          sendResponse({ ok: true });
          break;
        }
        case 'BATCH_DELETE': {
          void runBatch(msg.ids ?? [], 'delete', msg.batchId);
          sendResponse({ ok: true });
          break;
        }
        case 'BATCH_ENRICH': {
          void runBatch(msg.ids ?? [], 'enrich', msg.batchId);
          sendResponse({ ok: true });
          break;
        }
        case 'BATCH_REEXTRACT': {
          void runBatch(msg.ids ?? [], 'reextract', msg.batchId);
          sendResponse({ ok: true });
          break;
        }
        case 'EXPORT_ALL': {
          sendResponse({ ok: true, data: await db.exportAll() });
          break;
        }
        case 'IMPORT_ALL': {
          await db.importAll(msg.payload, msg.mode);
          sendResponse({ ok: true });
          break;
        }
        case 'GET_SETTINGS': {
          sendResponse({ ok: true, data: await getSettings() });
          break;
        }
        case 'SAVE_SETTINGS': {
          await db.saveSettings(msg.payload);
          await scheduleJobs();
          sendResponse({ ok: true });
          break;
        }
        case 'PING_CHAT': {
          // 使用消息里携带的草稿 ai 配置，不读已保存 settings（检测阶段用户可能未保存）
          const ai = (msg.payload ?? {}) as Settings['ai'];
          const client = new AiClient(ai);
          sendResponse({ ok: true, data: await client.pingChat() });
          break;
        }
        case 'PING_EMBED': {
          const ai = (msg.payload ?? {}) as Settings['ai'];
          const client = new AiClient(ai);
          sendResponse({ ok: true, data: await client.pingEmbed() });
          break;
        }
        case 'OPEN_URL': {
          chrome.tabs.create({ url: msg.url });
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown type' });
      }
    } catch (e: any) {
      sendResponse({ ok: false, error: e?.message ?? String(e) });
    }
  })();
  return true;
});

/**
 * 一次性迁移：把 Chrome 书签树导入到本地数据库
 * （如果设置 keepBrowserBookmarksInSync 开启，则每次启动还会同步）
 */
async function migrateBrowserBookmarks() {
  try {
    const tree = await chrome.bookmarks.getTree();
    const all = await db.listBookmarks();
    if (all.length > 0) return;
    const items: Bookmark[] = [];
    const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => {
      for (const n of nodes) {
        if (n.url) {
          items.push({
            id: newId(),
            url: n.url,
            title: n.title || n.url,
            tagIds: [],
            createdAt: n.dateAdded ?? Date.now(),
            updatedAt: Date.now(),
            visitCount: 0,
            status: 'active',
          });
        }
        if (n.children) walk(n.children);
      }
    };
    walk(tree);
    if (items.length) await db.bulkPutBookmarks(items);
  } catch (e) {
    console.warn('[migrate] failed', e);
  }
}
