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
const ALARM_BROWSER_SYNC = 'smart-bookmarks.browser-sync';
const SW_VERSION = '0.3.0';

console.log('[smart-bookmarks] SW booted', { version: SW_VERSION });

/** 真实访问追踪：用户切到/打开已保存的书签页面时 +1 visitCount。
 *  之前 visitCount 只在「再保存一次」时 +1，没法做热度排行。
 *  用 lastCountedTabUrl 防止同 tab 同 URL 重复计数。 */
const lastCountedTabUrl = new Map<number, string>();

async function tryCountVisit(tabId: number, url?: string) {
  try {
    const target = url ?? (await chrome.tabs.get(tabId)).url;
    if (!target || !target.startsWith('http')) return;
    if (lastCountedTabUrl.get(tabId) === target) return; // 同 tab 同 URL 已计过
    // 先查 DB，再决定是否登记到 Map —— 否则未保存的 URL 也会占位，
    // 之后用户在这标签里切换到新书签页时，因 URL 不再匹配可能反而被漏掉。
    const b = await db.getBookmarkByUrl(normalizeUrl(target));
    if (!b) return;
    lastCountedTabUrl.set(tabId, target);
    await db.putBookmark({
      ...b,
      visitCount: (b.visitCount ?? 0) + 1,
      lastVisitedAt: Date.now(),
    });
    // 不广播 BOOKMARKS_CHANGED —— 浏览时频繁触发会扰民。
    // 用户打开热度页时会主动 reload。
  } catch {
    /* tab 可能已关闭，忽略 */
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => void tryCountVisit(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) void tryCountVisit(tabId, changeInfo.url);
});
chrome.tabs.onRemoved.addListener((tabId) => lastCountedTabUrl.delete(tabId));

/** 广播书签库变更（新增 / 删除 / 批量操作 / 导入）—— 让 Options 自动刷新，避免用户手动点刷新按钮 */
function notifyBookmarksChanged(reason: string) {
  chrome.runtime
    .sendMessage({ type: 'BOOKMARKS_CHANGED', payload: { reason, at: Date.now() } })
    .catch(() => {
      /* 没有监听者（popup / options 未打开）—— 忽略 */
    });
}

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

/** 把 Chrome 原生书签库的一条新书签同步进 IndexedDB。已存在则更新，不存在则新建。 */
async function syncBrowserBookmarkToLocal(browserId: string, node: chrome.bookmarks.BookmarkTreeNode) {
  if (!node.url) return; // 跳过文件夹
  const url = normalizeUrl(node.url);
  const existing =
    (await db.getBookmarkByBrowserId(browserId)) ??
    (await db.getBookmarkByUrl(normalizeUrl(url)));
  const now = Date.now();
  const bookmark: Bookmark = {
    id: existing?.id ?? newId(),
    url,
    title: node.title || url,
    favicon: existing?.favicon,
    tagIds: existing?.tagIds ?? [],
    browserId, // 反向关联到 Chrome 原生书签 id，方便后续 onChanged 定位
    createdAt: existing?.createdAt ?? node.dateAdded ?? now,
    updatedAt: now,
    visitCount: existing?.visitCount ?? 0,
    lastVisitedAt: existing?.lastVisitedAt,
    status: existing?.status ?? 'active',
    // 新建的标记 pending，已存在的保留 enrichStatus 字段（不让 sync 抹掉）
    ...(existing ? {} : { enrichStatus: 'pending' as const }),
    description: existing?.description,
    coverImage: existing?.coverImage,
    content: existing?.content,
    categoryId: existing?.categoryId,
    folderId: existing?.folderId,
    ai: existing?.ai,
    enrichStatus: existing ? existing.enrichStatus : 'pending',
    enrichError: existing?.enrichError,
    enrichedAt: existing?.enrichedAt,
  };
  await db.putBookmark(bookmark);
  // 不广播 notifyBookmarksChanged —— 同步是后台行为，避免 Options 频繁重渲染
  console.info('[bookmark-sync] put', { id: bookmark.id, browserId, url });
}

/** 监听 Chrome 原生书签变更 —— 让"⭐按钮添加"也进入扩展数据库 */
function setupBrowserBookmarkSync() {
  chrome.bookmarks.onCreated.addListener(async (id, node) => {
    try {
      await syncBrowserBookmarkToLocal(id, node);
      notifyBookmarksChanged('browser-sync-created');
      // 异步 enrich（content 抽取 + AI 分类），仅当 URL 存在时
      if (node.url) {
        const local = await db.getBookmarkByBrowserId(id);
        if (local) void enrichBookmark(local.id);
      }
    } catch (e) {
      console.error('[bookmark-sync] onCreated failed', { id, error: e });
    }
  });

  chrome.bookmarks.onChanged.addListener(async (id, changeInfo) => {
    try {
      const local = await db.getBookmarkByBrowserId(id);
      if (!local) return; // 不在扩展库（用户可能直接清空过），跳过
      await db.putBookmark({
        ...local,
        title: changeInfo.title ?? local.title,
        url: changeInfo.url ? normalizeUrl(changeInfo.url) : local.url,
        updatedAt: Date.now(),
      });
      notifyBookmarksChanged('browser-sync-changed');
    } catch (e) {
      console.error('[bookmark-sync] onChanged failed', { id, error: e });
    }
  });
}

async function getSettings(): Promise<Settings> {
  return db.getSettings();
}

async function saveCurrentTab(tab?: chrome.tabs.Tab | null) {
  if (!tab) tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.url || !tab.title) return;
  const url = normalizeUrl(tab.url);
  const existing = await db.getBookmarkByUrl(url);
  if (existing) {
    // 访问次数由 chrome.tabs.onActivated/onUpdated 自动累加，
    // 手动再保存不应该 +1，否则用户每按一次 Ctrl+Shift+S 就刷一次热度数据。
    notifyBookmarksChanged('save-existing');
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
    enrichStatus: 'pending',
  };
  await db.putBookmark(bookmark);
  notifyBookmarksChanged('save');

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

  // 3) 没正文就退出 —— 标记 failed 状态，让用户在 UI 看到
  if (!extracted) {
    console.error('[enrich] no content available', { id, url: b.url });
    await db.putBookmark({
      ...b,
      enrichStatus: 'failed',
      enrichError: '正文抽取失败（content script 无响应 + fetch 也失败）',
      enrichedAt: Date.now(),
      updatedAt: Date.now(),
    });
    notifyBookmarksChanged('enrich-failed');
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
  let classifyFailed = false;
  let classifyError = '';
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
          // embedding 失败不阻塞 —— content 已写，分类已出
          classifyError = 'embedding 失败（语义搜索不可用，分类/标签正常）';
        }
      }
    } catch (e: any) {
      console.error('[enrich] ai failed', { id, url: b.url, error: e });
      classifyFailed = true;
      classifyError = `AI 分类失败：${e?.message ?? String(e)}`;
    }
  } else {
    // 没启用 AI：content 已写但不算"完整 ok"，标记 partial 让用户知道可以补
    classifyFailed = true;
    classifyError = 'AI 未启用（设置 → AI → 启用并填 Key）';
  }

  updated.enrichStatus = classifyFailed ? 'partial' : 'ok';
  updated.enrichError = classifyError || undefined;
  updated.enrichedAt = Date.now();

  await db.putBookmark(updated);
  notifyBookmarksChanged('enrich-' + updated.enrichStatus);
  console.info('[enrich] done', { id, status: updated.enrichStatus, hasAi: !!updated.ai });
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
  notifyBookmarksChanged(`batch-${mode}`);
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
  // 每小时一次把 Chrome 原生书签库的全量同步进 IndexedDB —— 兜底事件丢失
  chrome.alarms.create(ALARM_BROWSER_SYNC, { periodInMinutes: 60 });
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

/** 兜底：把 Chrome 原生书签库里所有 URL 同步进 IndexedDB（按 URL 去重） */
async function runBrowserBookmarkResync() {
  const tree = await chrome.bookmarks.getTree();
  let added = 0;
  let updated = 0;
  const walk = async (nodes: chrome.bookmarks.BookmarkTreeNode[]) => {
    for (const n of nodes) {
      if (n.url) {
        const existing = await db.getBookmarkByBrowserId(n.id);
        if (existing) {
          // 标题/URL 可能已被用户在浏览器里改过
          if (existing.title !== (n.title || n.url) || existing.url !== n.url) {
            await db.putBookmark({ ...existing, title: n.title || n.url, url: n.url, updatedAt: Date.now() });
            updated++;
          }
        } else {
          await syncBrowserBookmarkToLocal(n.id, n);
          added++;
        }
      }
      if (n.children) await walk(n.children);
    }
  };
  await walk(tree);
  if (added > 0 || updated > 0) {
    console.info(`[bookmark-sync] resync done: added ${added}, updated ${updated}`);
    notifyBookmarksChanged('browser-sync-resync');
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await scheduleJobs();
  await migrateBrowserBookmarks();
  setupContextMenu();
  setupBrowserBookmarkSync();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleJobs();
  setupContextMenu();
  setupBrowserBookmarkSync();
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
        enrichStatus: 'pending',
      };
      await db.putBookmark(b);
      notifyBookmarksChanged('context-menu-save');
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
  if (alarm.name === ALARM_BROWSER_SYNC) void runBrowserBookmarkResync();
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
          // 分页返回：避免 1000+ 大书签（含 content + embedding）单次 sendResponse
          // 过大导致 MV3 structured clone 静默失败
          const offset = Number(msg.offset ?? 0);
          const limit = Number(msg.limit ?? 500);
          const all = await db.listBookmarks();
          const slice = all.slice(offset, offset + limit);
          console.info('[LIST_BOOKMARKS]', {
            total: all.length,
            offset,
            returned: slice.length,
            sampleSizeKB: all[0] ? Math.round(JSON.stringify(all[0]).length / 1024) : 0,
          });
          sendResponse({
            ok: true,
            data: slice,
            total: all.length,
            offset,
            hasMore: offset + slice.length < all.length,
          });
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
          notifyBookmarksChanged('delete');
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
          notifyBookmarksChanged('import');
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
 * 初次安装时：把 Chrome 书签树导入到本地数据库。
 * 已存在数据时改为增量同步（按 URL + browserId 去重），
 * 避免用户用浏览器⭐按钮添加的书签被永久忽略。
 */
async function migrateBrowserBookmarks() {
  try {
    const tree = await chrome.bookmarks.getTree();
    const items: Bookmark[] = [];
    const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => {
      for (const n of nodes) {
        if (n.url) {
          items.push({
            id: newId(),
            url: n.url,
            title: n.title || n.url,
            tagIds: [],
            browserId: n.id,
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
    if (!items.length) return;

    const all = await db.listBookmarks();
    const byUrl = new Map(all.map((b) => [b.url, b]));
    let added = 0;
    let merged = 0;
    for (const item of items) {
      const existing = byUrl.get(item.url);
      if (existing) {
        // 已有：补上 browserId 反向关联（如果之前是通过快捷键存的，没存 browserId）
        if (!existing.browserId) {
          await db.putBookmark({ ...existing, browserId: item.browserId, updatedAt: Date.now() });
          merged++;
        }
      } else {
        // 新条目：标记 pending，等批量 enrich
        await db.putBookmark({ ...item, enrichStatus: 'pending' });
        added++;
      }
    }
    console.info(`[migrate] added ${added}, merged browserId ${merged}`);
  } catch (e) {
    console.warn('[migrate] failed', e);
  }
}
