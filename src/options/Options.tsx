import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type BatchProgressPayload } from '../ui/api';
import { searchBookmarks } from '../core/search';
import { useDebounce } from '../ui/hooks';
import { DEFAULT_SETTINGS, type Bookmark, type SearchResult, type Settings } from '../types';
import { downloadJSON, newId } from '../core/util';

type Tab = 'bookmarks' | 'tags' | 'categories' | 'hotness' | 'cleanup' | 'help' | 'settings';

export type Filter = { kind: 'tag' | 'category'; value: string };

export function Options() {
  // 支持从 URL 初始化 tab + 搜索词（omnibox 跳转用：?tab=bookmarks&q=nest）
  const initial = useMemo(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const tabParam = sp.get('tab') as Tab | null;
      const qParam = sp.get('q') ?? '';
      const validTabs: Tab[] = ['bookmarks', 'tags', 'categories', 'hotness', 'cleanup', 'help', 'settings'];
      return {
        tab: tabParam && validTabs.includes(tabParam) ? tabParam : 'bookmarks' as Tab,
        q: qParam,
      };
    } catch {
      return { tab: 'bookmarks' as Tab, q: '' };
    }
  }, []);

  const [tab, setTab] = useState<Tab>(initial.tab);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter | null>(null);
  // omnibox 跳转时预填的搜索词
  const initialQ = initial.q;

  const reload = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    const r = await api.list((loaded, total) => {
      console.info(`[reload] loading ${loaded}/${total}`);
    });
    console.info('[reload] total loaded', r.data.length, 'of', r.total);
    setBookmarks(r.data);
    const s = await api.getSettings();
    if (s.data) setSettings(s.data);
    if (showLoading) setLoading(false);
  };
  useEffect(() => {
    void reload(true);
  }, []);

  // 监听 SW 广播的书签变更 —— Options 页打开期间，从 popup / 快捷键 / 右键菜单新增的书签会自动刷新
  // 防抖：避免批量操作时短时间内反复 reload
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = (msg: { type?: string; payload?: { reason?: string } }) => {
      if (msg?.type === 'BOOKMARKS_CHANGED') {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          console.info('[BOOKMARKS_CHANGED]', msg.payload?.reason);
          void reloadRef.current();
        }, 300);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => {
      chrome.runtime.onMessage.removeListener(handler);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const openFiltered = (kind: Filter['kind'], value: string) => {
    setFilter({ kind, value });
    setTab('bookmarks');
  };

  return (
    <div className="layout">
      <aside>
        <div className="brand">
          <span className="brand-logo">🧠</span>
          <span className="brand-name">Smart Bookmarks</span>
          <span className="brand-ver">v{__APP_VERSION__}</span>
        </div>
        <nav>
          {(['bookmarks', 'tags', 'categories', 'hotness', 'cleanup', 'help', 'settings'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {iconOf(t)}
              <span>{labelOf(t)}</span>
            </button>
          ))}
        </nav>
      </aside>
      <section className="content">
        {loading && <div style={{ color: 'var(--muted)' }}>加载中…</div>}
        {tab === 'bookmarks' && (
          <BookmarksView
            bookmarks={bookmarks}
            settings={settings}
            onChange={reload}
            filter={filter}
            onClearFilter={() => setFilter(null)}
            initialQ={initialQ}
          />
        )}
        {tab === 'tags' && <TagsView bookmarks={bookmarks} onOpenFilter={openFiltered} />}
        {tab === 'categories' && <CategoriesView bookmarks={bookmarks} onOpenFilter={openFiltered} />}
        {tab === 'hotness' && <HotnessView bookmarks={bookmarks} />}
        {tab === 'cleanup' && <CleanupView bookmarks={bookmarks} onChange={reload} />}
        {tab === 'help' && <HelpView />}
        {tab === 'settings' && (
          <SettingsView
            settings={settings}
            onSaved={async (s) => {
              await api.saveSettings(s);
              setSettings(s);
            }}
          />
        )}
      </section>
    </div>
  );
}

function labelOf(t: Tab) {
  return { bookmarks: '书签', tags: '标签', categories: '分类', hotness: '热度', cleanup: '清理', help: '帮助', settings: '设置' }[t];
}

/** 内联 SVG 图标 — 16x16，stroke-only，继承 currentColor */
function iconOf(t: Tab) {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const wrap = (children: React.ReactNode) => (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">{children}</svg>
  );
  switch (t) {
    case 'bookmarks':
      return wrap(<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" {...stroke} />);
    case 'tags':
      return wrap(<>
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" {...stroke} />
        <circle cx="7" cy="7" r="1.5" fill="currentColor" />
      </>);
    case 'categories':
      return wrap(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" {...stroke} />);
    case 'hotness':
      return wrap(<>
        <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" {...stroke} />
      </>);
    case 'cleanup':
      return wrap(<>
        <path d="M3 6h18" {...stroke} />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" {...stroke} />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" {...stroke} />
        <path d="M10 11v6M14 11v6" {...stroke} />
      </>);
    case 'settings':
      return wrap(<>
        <circle cx="12" cy="12" r="3" {...stroke} />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" {...stroke} />
      </>);
    case 'help':
      return wrap(<>
        <circle cx="12" cy="12" r="10" {...stroke} />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" {...stroke} />
        <circle cx="12" cy="17" r="0.5" fill="currentColor" />
      </>);
  }
}

function BookmarksView({
  bookmarks,
  settings,
  onChange,
  filter,
  onClearFilter,
  initialQ,
}: {
  bookmarks: Bookmark[];
  settings: Settings;
  onChange: () => Promise<void> | void;
  filter: Filter | null;
  onClearFilter: () => void;
  initialQ?: string;
}) {
  const [q, setQ] = useState(initialQ ?? '');
  const dq = useDebounce(q, 200);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [statusFilter, setStatusFilter] = useState<'all' | Bookmark['status'] | 'needs-attention'>('all');
  const [sortBy, setSortBy] = useState<'time' | 'title' | 'visit'>('time');
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [enriching, setEnriching] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchProgress, setBatchProgress] = useState<BatchProgressPayload | null>(null);
  const [batchTitle, setBatchTitle] = useState<string>('');
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 统计：让用户直接看到"我的新书签到底在不在数据库"
  const stats = useMemo(() => {
    const now = Date.now();
    const sevenDays = now - 7 * 24 * 60 * 60 * 1000;
    const thirtyDays = now - 30 * 24 * 60 * 60 * 1000;
    const byStatus: Record<Bookmark['status'], number> = { active: 0, redirected: 0, broken: 0, duplicate: 0 };
    const byEnrich: Record<'pending' | 'ok' | 'partial' | 'failed' | 'unknown', number> = {
      pending: 0, ok: 0, partial: 0, failed: 0, unknown: 0,
    };
    let recent7 = 0;
    let recent30 = 0;
    let withAi = 0;
    let lastAdded = 0;
    for (const b of bookmarks) {
      byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
      const es = b.enrichStatus ?? 'unknown';
      byEnrich[es] = (byEnrich[es] ?? 0) + 1;
      if (b.createdAt >= sevenDays) recent7++;
      if (b.createdAt >= thirtyDays) recent30++;
      if (b.ai?.classifiedAt) withAi++;
      if (b.createdAt > lastAdded) lastAdded = b.createdAt;
    }
    return { byStatus, byEnrich, recent7, recent30, withAi, lastAdded };
  }, [bookmarks]);

  const onEnrich = async (id: string) => {
    if (enriching.has(id)) return;
    setEnriching((s) => new Set(s).add(id));
    const before = (await api.get(id))?.data?.ai?.classifiedAt ?? 0;
    await api.enrich(id);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const after = (await api.get(id))?.data?.ai?.classifiedAt ?? 0;
      if (after > before) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    setEnriching((s) => {
      const ns = new Set(s);
      ns.delete(id);
      return ns;
    });
    await onChange();
  };

  useEffect(() => {
    void (async () => {
      // 1. 先按 tag/category 过滤（如果有）
      let base = bookmarks;
      if (filter) {
        base = bookmarks.filter((b) =>
          filter.kind === 'tag'
            ? (b.ai?.tags ?? []).includes(filter.value)
            : (b.ai?.category ?? '未分类') === filter.value,
        );
      }

      // 2. 在过滤子集上执行搜索（或按时间排序）
      let r: SearchResult[];
      if (dq.trim()) {
        r = await searchBookmarks({ query: dq, bookmarks: base, settings });
      } else {
        r = base
          .slice()
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((b) => ({ ...b, score: 0, matchType: 'exact' as const }));
      }

      // 3. 用户显式选的排序覆盖默认（search 默认按 score；用户想强制按时间/名称/访问）
      if (sortBy === 'time') {
        r = r.slice().sort((a, b) => b.createdAt - a.createdAt);
      } else if (sortBy === 'title') {
        r = r.slice().sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
      } else if (sortBy === 'visit') {
        r = r.slice().sort((a, b) => (b.visitCount ?? 0) - (a.visitCount ?? 0));
      }

      // 4. 最后按状态筛选
      if (statusFilter === 'all') {
        setResults(r);
      } else if (statusFilter === 'needs-attention') {
        // pending / partial / failed / 未设置 全部算"需要关注"
        setResults(r.filter((b) => b.enrichStatus !== 'ok'));
      } else {
        setResults(r.filter((b) => b.status === statusFilter));
      }
    })();
  }, [filter, dq, bookmarks, settings, statusFilter, sortBy]);

  // Bug 3: 搜索/筛选变化时清空 selected，避免用户看不到的 id 被误操作
  useEffect(() => {
    setSelected(new Set());
  }, [filter, dq, statusFilter]);

  // Bug 5: onChange 用 ref 持有，避免 SW 监听 useEffect 反复重订阅 + 闭包过期
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // 订阅 SW 进度（一次性挂载）
  useEffect(() => {
    const handler = (msg: { type?: string; payload?: BatchProgressPayload }) => {
      if (msg?.type === 'BATCH_PROGRESS' && msg.payload) {
        setBatchProgress(msg.payload);
        if (msg.payload.done >= msg.payload.total) {
          if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
          closeTimerRef.current = setTimeout(() => {
            setBatchProgress(null);
            setBatchTitle('');
            // Bug 6: 完成后统一清空 selected
            setSelected(new Set());
            onChangeRef.current?.();
          }, 2000);
        }
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  // 选择操作
  const toggleOne = (id: string) => {
    setSelected((s) => {
      const ns = new Set(s);
      if (ns.has(id)) ns.delete(id);
      else ns.add(id);
      return ns;
    });
  };
  const selectAllVisible = () => setSelected(new Set(results.map((r) => r.id)));
  const clearSelection = () => setSelected(new Set());
  const allChecked = results.length > 0 && results.every((b) => selected.has(b.id));
  const someChecked = !allChecked && results.some((b) => selected.has(b.id));

  // Bug 8: 表头 indeterminate 用 useEffect 设置，避免 dev mode 警告
  const headerRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerRef.current) headerRef.current.indeterminate = someChecked;
    if (selectAllRef.current) selectAllRef.current.indeterminate = someChecked;
  }, [someChecked]);

  // 批量操作
  type BatchKind =
    | 'delete' | 'enrich' | 'reextract'
    | 'reanalyze';

  const runBatch = async (mode: BatchKind) => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const batchId = newId();
    const titleMap: Record<BatchKind, string> = {
      delete: '批量删除',
      enrich: '批量重分类',
      reextract: '批量重抽正文',
      reanalyze: '批量重新分析',
    };
    setBatchTitle(titleMap[mode]);
    setBatchProgress({ batchId, done: 0, total: ids.length, currentId: '', status: 'ok' });
    if (mode === 'delete') {
      if (!confirm(`确定删除 ${ids.length} 条书签？此操作不可撤销。`)) {
        setBatchProgress(null);
        setBatchTitle('');
        return;
      }
    }
    // Bug 6: 任务发起后立即清空 selected（剩下的由 onChange → reload 接管，
    // 2 秒后 Toast 关闭时再兜底清一次）
    setSelected(new Set());
    switch (mode) {
      case 'delete': await api.batchDelete(ids, batchId); break;
      case 'enrich': await api.batchEnrich(ids, batchId); break;
      case 'reextract': await api.batchReextract(ids, batchId); break;
      case 'reanalyze': await api.batchReanalyze(ids, batchId); break;
    }
  };

  return (
    <div>
      <h1>书签</h1>

      {/* 统计行：让用户直接看到"新书签在不在数据库" */}
      <div className="stats-line">
        <span className="stats-item">
          共 <strong>{bookmarks.length}</strong> 条
        </span>
        <span className="stats-sep">·</span>
        <span className="stats-item">
          7 天新增 <strong className={stats.recent7 > 0 ? 'stats-new' : ''}>{stats.recent7}</strong>
        </span>
        <span className="stats-sep">·</span>
        <span className="stats-item">
          30 天新增 <strong>{stats.recent30}</strong>
        </span>
        <span className="stats-sep">·</span>
        <span className="stats-item">
          AI 分类 <strong>{stats.withAi}</strong>
        </span>
        {/* enrich 状态细分：让用户知道"为什么有些没标签/没摘要"。点击直接套上筛选 */}
        {(stats.byEnrich.pending > 0 || stats.byEnrich.partial > 0 || stats.byEnrich.failed > 0) && (
          <>
            {stats.byEnrich.pending > 0 && (
              <>
                <span className="stats-sep">·</span>
                <button
                  className={`stats-item stats-button ${statusFilter === 'needs-attention' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('needs-attention')}
                  title="筛选：所有待处理的书签（pending + partial + failed）"
                >
                  处理中 <strong>{stats.byEnrich.pending}</strong>
                </button>
              </>
            )}
            {stats.byEnrich.partial > 0 && (
              <>
                <span className="stats-sep">·</span>
                <button
                  className={`stats-item stats-button ${statusFilter === 'needs-attention' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('needs-attention')}
                  title="筛选：所有待处理的书签（pending + partial + failed）"
                >
                  ⚠ AI 失败 <strong className="stats-warn">{stats.byEnrich.partial}</strong>
                </button>
              </>
            )}
            {stats.byEnrich.failed > 0 && (
              <>
                <span className="stats-sep">·</span>
                <button
                  className={`stats-item stats-button ${statusFilter === 'needs-attention' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('needs-attention')}
                  title="筛选：所有待处理的书签（pending + partial + failed）"
                >
                  ✗ 抽正文失败 <strong className="stats-warn">{stats.byEnrich.failed}</strong>
                </button>
              </>
            )}
          </>
        )}
        {(stats.byStatus.broken > 0 || stats.byStatus.duplicate > 0) && (
          <>
            {stats.byStatus.broken > 0 && (
              <>
                <span className="stats-sep">·</span>
                <span className="stats-item">
                  死链 <strong className="stats-warn">{stats.byStatus.broken}</strong>
                </span>
              </>
            )}
            {stats.byStatus.duplicate > 0 && (
              <>
                <span className="stats-sep">·</span>
                <span className="stats-item">
                  重复 <strong className="stats-warn">{stats.byStatus.duplicate}</strong>
                </span>
              </>
            )}
          </>
        )}
        {stats.lastAdded > 0 && (
          <span className="stats-meta">
            最后添加：{new Date(stats.lastAdded).toLocaleString('zh-CN')}
          </span>
        )}
      </div>

      {filter && (
        <div className="filter-pill" role="status">
          <span>
            {filter.kind === 'tag' ? '🏷 # ' : '📂 '}
            {filter.value}
          </span>
          <button onClick={onClearFilter} title="清除过滤" aria-label="清除过滤">✕</button>
        </div>
      )}
      <div className="toolbar">
        <input placeholder="搜索标题、URL、标签、正文…支持语义" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} title="排序方式">
          <option value="time">按时间</option>
          <option value="title">按名称</option>
          <option value="visit">按访问</option>
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}>
          <option value="all">全部状态</option>
          <option value="active">正常</option>
          <option value="redirected">已重定向</option>
          <option value="broken">死链</option>
          <option value="duplicate">重复</option>
          <optgroup label="─── AI 处理 ───">
            <option value="needs-attention">⚠ 待处理（AI 失败 / 抽正文失败 / 未解析）</option>
          </optgroup>
        </select>
        <button className="btn ghost" onClick={() => onChange()}>刷新</button>
        <button
          className="btn"
          onClick={async () => {
            const data = await api.exportAll();
            downloadJSON(`smart-bookmarks-${Date.now()}.json`, data.data);
          }}
        >
          导出
        </button>
        <label className="btn ghost" style={{ cursor: 'pointer' }}>
          导入
          <input
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const text = await f.text();
              const payload = JSON.parse(text);
              if (confirm('合并到现有数据？\n确定 = 合并；取消 = 覆盖')) {
                await api.importAll(payload, 'merge');
              } else {
                await api.importAll(payload, 'replace');
              }
              onChange();
            }}
          />
        </label>
      </div>

      {/* 结果计数 — 让用户感知当前规模 */}
      {results.length > 0 && (
        <div
          style={{
            marginTop: -8,
            marginBottom: 12,
            color: 'var(--muted)',
            fontSize: 'var(--text-sm)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {(() => {
            const parts: string[] = [];
            if (filter) parts.push(`${filter.kind === 'tag' ? '#' : '📂 '}${filter.value}`);
            if (dq.trim()) parts.push(`搜索「${dq.trim()}」`);
            if (parts.length > 0) return `${parts.join(' + ')} · 共 ${results.length} 条`;
            return `共 ${results.length} 条${bookmarks.length > results.length ? `（已从 ${bookmarks.length} 条中匹配）` : ''}`;
          })()}
        </div>
      )}

      {/* 第二行：全选 + 多选操作 */}
      <div className="toolbar" style={{ marginTop: 8, gap: 6 }}>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            cursor: results.length === 0 ? 'not-allowed' : 'pointer',
            color: results.length === 0 ? 'var(--muted)' : 'var(--fg)',
            userSelect: 'none',
          }}
          title="全选/取消全选当前过滤后的书签"
        >
          <input
            type="checkbox"
            ref={selectAllRef}
            checked={!!allChecked}
            autoComplete="off"
            disabled={results.length === 0}
            onChange={(e) => {
              if (e.target.checked) selectAllVisible();
              else clearSelection();
            }}
          />
          全选当前 ({results.length})
        </label>
        {selected.size > 0 && (
          <>
            <span style={{ color: 'var(--accent)', fontSize: 13, fontWeight: 600 }}>
              已选 {selected.size} 项
            </span>
            <BatchActionsMenu onAction={runBatch} onClear={clearSelection} />
          </>
        )}
      </div>

      <table>
        <thead>
          <tr>
            <th style={{ width: 36 }}>
              <input
                type="checkbox"
                ref={headerRef}
                checked={!!allChecked}
                autoComplete="off"
                onChange={(e) => {
                  if (e.target.checked) selectAllVisible();
                  else clearSelection();
                }}
              />
            </th>
            <th>标题</th>
            <th>URL</th>
            <th>分类</th>
            <th>标签</th>
            <th>状态</th>
            <th>访问</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {results.map((b) => (
            <tr key={b.id} className={selected.has(b.id) ? 'selected' : ''}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(b.id)}
                  autoComplete="off"
                  onChange={() => toggleOne(b.id)}
                />
              </td>
              <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <a
                  href={b.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bookmark-title-link"
                  title="新标签打开"
                >
                  {b.title}
                </a>
              </td>
              <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <a
                  href={b.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bookmark-url-link"
                  title="新标签打开"
                >
                  {b.url}
                </a>
              </td>
              <td>{b.ai?.category ?? '—'}</td>
              <td>{(b.ai?.tags ?? []).map((t) => `#${t}`).join(' ') || '—'}</td>
              <td>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span className={`status-pill status-${b.status}`}>{labelStatus(b.status)}</span>
                  {b.enrichStatus === 'pending' && (
                    <span className="enrich-badge enrich-pending" title="enrich 处理中…">⏳</span>
                  )}
                  {b.enrichStatus === 'failed' && (
                    <span
                      className="enrich-badge enrich-failed"
                      title={b.enrichError ?? '正文抽取失败'}
                    >
                      ✗
                    </span>
                  )}
                  {b.enrichStatus === 'partial' && (
                    <span
                      className="enrich-badge enrich-partial"
                      title={b.enrichError ?? 'AI 分类部分失败'}
                    >
                      ⚠
                    </span>
                  )}
                </span>
              </td>
              <td>{b.visitCount}</td>
              <td className="actions-col">
                <button className="btn ghost" onClick={() => setEditing(b)}>编辑</button>
                <button className="btn ghost" disabled={enriching.has(b.id)} onClick={() => onEnrich(b.id)}>
                  {enriching.has(b.id)
                    ? '⏳ 分析中…'
                    : b.enrichStatus === 'failed'
                      ? '重新抽正文'
                      : '重新分析'}
                </button>
                <button className="btn danger" onClick={async () => { await api.remove(b.id); onChange(); }}>删</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* 空结果状态 */}
      {results.length === 0 && (
        <div className="empty" style={{ marginTop: 32 }}>
          <span className="empty-icon">🔍</span>
          <div className="empty-title">
            {dq.trim() ? '没有匹配的书签' : filter ? '这个过滤条件下没有书签' : '还没有书签'}
          </div>
          <div className="empty-hint">
            {dq.trim() ? (
              <>
                当前在 <strong>{bookmarks.length}</strong> 条书签中搜索「{dq.trim()}」
                {filter && <>（叠加了 {filter.kind === 'tag' ? `#${filter.value}` : `📂 ${filter.value}`} 过滤）</>}
                。试试更短的关键词、清空搜索框、或点击右上角「清除过滤」。
              </>
            ) : filter ? (
              <>
                数据库里有 <strong>{bookmarks.length}</strong> 条书签，但当前过滤条件下没有匹配项。
                <div style={{ marginTop: 12 }}>
                  <button className="btn ghost" onClick={onClearFilter}>
                    ✕ 清除过滤查看全部
                  </button>
                </div>
              </>
            ) : (
              <>按 <code>Ctrl+Shift+S</code> 保存当前页面。</>
            )}
          </div>
        </div>
      )}
      {editing && <EditModal bookmark={editing} onClose={() => setEditing(null)} onSaved={onChange} />}

      {batchProgress && (
        <BatchProgressToast
          title={batchTitle}
          progress={batchProgress}
          bookmarks={bookmarks}
          onClose={() => {
            if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
            setBatchProgress(null);
            setBatchTitle('');
            onChange();
          }}
        />
      )}
    </div>
  );
}

/** 批量操作 Toast：显示进度、✓/✗ 计数、可展开失败列表 */
function BatchProgressToast({
  title,
  progress,
  bookmarks,
  onClose,
}: {
  title: string;
  progress: BatchProgressPayload;
  bookmarks: Bookmark[];
  onClose: () => void;
}) {
  const [errors, setErrors] = useState<Array<{ id: string; error: string }>>([]);
  const lastDoneRef = useRef(0);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (progress.status === 'fail' && progress.error && progress.done > lastDoneRef.current) {
      lastDoneRef.current = progress.done;
      setErrors((arr) => [...arr, { id: progress.currentId, error: progress.error! }]);
    }
  }, [progress]);

  // 当前正在处理的书签（id → title）
  const currentTitle = progress.currentId
    ? bookmarks.find((b) => b.id === progress.currentId)?.title
    : undefined;
  const currentUrl = progress.currentId
    ? bookmarks.find((b) => b.id === progress.currentId)?.url
    : undefined;

  const pct = Math.round((progress.done / Math.max(progress.total, 1)) * 100);
  const okCount = progress.done - errors.length;
  const done = progress.done >= progress.total;

  return (
    <div className="batch-toast" role="status">
      <button className="close" onClick={onClose} aria-label="关闭">✕</button>
      <h4>{title} {done ? '✓ 完成' : ''}</h4>
      {/* 当前处理的书签（去掉 url 显示） */}
      {!done && currentTitle && (
        <div className="current-item" title={currentUrl}>
          正在处理：<strong>{currentTitle}</strong>
        </div>
      )}
      <div style={{ color: 'var(--muted)', fontSize: 12 }}>
        {progress.done} / {progress.total} · {pct}%
      </div>
      <div className="bar"><div style={{ width: `${pct}%` }} /></div>
      <div className="stats">
        <span className="ok">✓ {okCount}</span>
        <span className="fail">✗ {errors.length}</span>
        {errors.length > 0 && (
          <button
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12 }}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? '收起错误' : '查看错误'}
          </button>
        )}
      </div>
      {expanded && errors.length > 0 && (
        <div className="errors">
          {errors.map((e, i) => {
            const eb = bookmarks.find((b) => b.id === e.id);
            return (
              <div key={i}>
                <code>{e.id.slice(0, 8)}</code> {eb ? `「${eb.title}」` : ''}: {e.error}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function labelStatus(s: Bookmark['status']) {
  return { active: '正常', redirected: '已重定向', broken: '死链', duplicate: '重复' }[s];
}

function EditModal({
  bookmark,
  onClose,
  onSaved,
}: {
  bookmark: Bookmark;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [b, setB] = useState(bookmark);
  useEffect(() => setB(bookmark), [bookmark]);
  return (
    <div className="edit-modal-backdrop" onClick={onClose}>
      <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
        <h2>编辑书签</h2>
        <div className="row"><label>标题</label><input value={b.title} onChange={(e) => setB({ ...b, title: e.target.value })} /></div>
        <div className="row"><label>URL</label><input value={b.url} onChange={(e) => setB({ ...b, url: e.target.value })} /></div>
        <div className="row"><label>描述</label><input value={b.description ?? ''} onChange={(e) => setB({ ...b, description: e.target.value })} /></div>
        <div className="row"><label>AI 标签</label>
          <input
            value={(b.ai?.tags ?? []).join(', ')}
            onChange={(e) => setB({ ...b, ai: { ...(b.ai ?? {}), tags: e.target.value.split(/[,，]\s*/).filter(Boolean) } })}
          />
        </div>
        <div className="row"><label>AI 摘要</label>
          <input value={b.ai?.summary ?? ''} onChange={(e) => setB({ ...b, ai: { ...(b.ai ?? {}), summary: e.target.value } })} />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button
            className="btn"
            onClick={async () => {
              await api.put({ ...b, updatedAt: Date.now() });
              onSaved();
              onClose();
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function TagsView({ bookmarks, onOpenFilter }: { bookmarks: Bookmark[]; onOpenFilter: (kind: 'tag', value: string) => void }) {
  const [q, setQ] = useState('');
  const [sortBy, setSortBy] = useState<'count' | 'name' | 'recent'>('count');

  const allTags = useMemo(() => {
    const m = new Map<string, { count: number; lastUsed: number }>();
    for (const b of bookmarks) {
      const lastUsed = b.updatedAt ?? b.createdAt;
      for (const t of b.ai?.tags ?? []) {
        const cur = m.get(t) ?? { count: 0, lastUsed: 0 };
        cur.count += 1;
        cur.lastUsed = Math.max(cur.lastUsed, lastUsed);
        m.set(t, cur);
      }
    }
    const qLower = q.trim().toLowerCase();
    return Array.from(m.entries())
      .map(([t, info]) => ({ t, ...info }))
      .filter(({ t }) => !qLower || t.toLowerCase().includes(qLower))
      .sort((a, b) => {
        if (sortBy === 'count') return b.count - a.count || a.t.localeCompare(b.t, 'zh-CN');
        if (sortBy === 'recent') return b.lastUsed - a.lastUsed;
        return a.t.localeCompare(b.t, 'zh-CN');
      });
  }, [bookmarks, q, sortBy]);

  const maxCount = useMemo(() => Math.max(1, ...allTags.map((t) => t.count)), [allTags]);

  return (
    <div>
      <h1>标签</h1>
      <p style={{ color: 'var(--muted)', margin: '0 0 16px' }}>
        AI 在保存时自动生成，也可手动在书签编辑中修改。点击标签可跳转到对应书签。
      </p>

      <div className="toolbar">
        <input
          placeholder="搜索标签…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
        />
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
          <option value="count">按数量</option>
          <option value="name">按名称</option>
          <option value="recent">按最近使用</option>
        </select>
      </div>

      <div className="tag-cloud">
        {allTags.map(({ t, count, lastUsed }) => {
          const scale = 0.85 + (count / maxCount) * 0.45;
          const tip = `${count} 条书签 · 最近使用 ${new Date(lastUsed).toLocaleDateString()}`;
          return (
            <button
              key={t}
              className="tag-chip"
              onClick={() => onOpenFilter('tag', t)}
              title={tip}
              style={{ fontSize: `${scale}em` }}
            >
              <span>#{t}</span>
              <span className="tag-count">· {count}</span>
            </button>
          );
        })}
      </div>

      {allTags.length === 0 && (
        <div className="empty">
          <span className="empty-icon">🏷</span>
          <div className="empty-title">{q.trim() ? '没有匹配的标签' : '还没有标签'}</div>
          <div className="empty-hint">
            {q.trim() ? '试试更短的关键字' : '开启 AI 自动分类后再保存书签即可'}
          </div>
        </div>
      )}
    </div>
  );
}

function CategoriesView({ bookmarks, onOpenFilter }: { bookmarks: Bookmark[]; onOpenFilter: (kind: 'category', value: string) => void }) {
  const [sortBy, setSortBy] = useState<'count' | 'name'>('count');

  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of bookmarks) {
      const c = b.ai?.category ?? '未分类';
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    const total = Math.max(1, bookmarks.length);
    return Array.from(m.entries())
      .map(([c, n]) => ({ c, n, pct: (n / total) * 100 }))
      .sort((a, b) =>
        sortBy === 'name' ? a.c.localeCompare(b.c, 'zh-CN') : b.n - a.n || a.c.localeCompare(b.c, 'zh-CN'),
      );
  }, [bookmarks, sortBy]);

  return (
    <div>
      <h1>分类</h1>
      <p style={{ color: 'var(--muted)', margin: '0 0 16px' }}>
        AI 在保存时自动归类。点击分类可跳转到对应书签。
      </p>

      <div className="toolbar">
        <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>
          {groups.length} 个分类 · {bookmarks.length} 条书签
        </span>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
          <option value="count">按数量</option>
          <option value="name">按名称</option>
        </select>
      </div>

      {groups.length === 0 ? (
        <div className="empty">
          <span className="empty-icon">📂</span>
          <div className="empty-title">还没有分类</div>
          <div className="empty-hint">开启 AI 自动分类后再保存书签</div>
        </div>
      ) : (
        <table className="categories-table">
          <thead>
            <tr>
              <th>分类</th>
              <th style={{ width: 80 }}>数量</th>
              <th>占比</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(({ c, n, pct }) => (
              <tr key={c} className="clickable" onClick={() => onOpenFilter('category', c)}>
                <td>
                  <span className="category-dot" />
                  {c}
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{n}</td>
                <td>
                  <span className="category-bar">
                    <span className="category-bar-fill" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="category-pct">{pct.toFixed(1)}%</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * 热度排行：根据 visitCount 排序，附三个时间窗（总榜 / 本周 / 本月）。
 * 数据源：SW 端 chrome.tabs.onActivated / onUpdated 实时累加 visitCount + lastVisitedAt。
 */
function HotnessView({ bookmarks }: { bookmarks: Bookmark[] }) {
  const [period, setPeriod] = useState<'all' | '7d' | '30d'>('all');
  const [topN, setTopN] = useState(50);

  const ranked = useMemo(() => {
    const now = Date.now();
    let filtered = bookmarks.filter((b) => (b.visitCount ?? 0) > 0);
    if (period === '7d') {
      filtered = filtered.filter((b) => (b.lastVisitedAt ?? 0) >= now - 7 * 86400000);
    } else if (period === '30d') {
      filtered = filtered.filter((b) => (b.lastVisitedAt ?? 0) >= now - 30 * 86400000);
    }
    return filtered
      .slice()
      .sort(
        (a, b) =>
          (b.visitCount ?? 0) - (a.visitCount ?? 0) ||
          (b.lastVisitedAt ?? 0) - (a.lastVisitedAt ?? 0),
      )
      .slice(0, topN);
  }, [bookmarks, period, topN]);

  const totalVisits = useMemo(
    () => bookmarks.reduce((s, b) => s + (b.visitCount ?? 0), 0),
    [bookmarks],
  );

  return (
    <div>
      <h1>🔥 热度排行</h1>
      <p style={{ color: 'var(--muted)', margin: '0 0 16px' }}>
        基于真实访问次数（浏览器打开标签页自动累加，不依赖手动保存）。
        切换窗口查看不同时间维度的热门书签。
      </p>

      {/* 统计行 */}
      <div className="stats-line" style={{ marginBottom: 16 }}>
        <span className="stats-item">
          有访问的书签 <strong>{ranked.length === topN ? `${topN}+` : ranked.length}</strong> / 总 <strong>{bookmarks.length}</strong>
        </span>
        <span className="stats-sep">·</span>
        <span className="stats-item">
          累计访问 <strong>{totalVisits}</strong> 次
        </span>
        {ranked[0] && (
          <>
            <span className="stats-sep">·</span>
            <span className="stats-meta">
              🏆 当前榜首：{ranked[0].title.slice(0, 30)}{ranked[0].title.length > 30 ? '…' : ''}（{ranked[0].visitCount} 次）
            </span>
          </>
        )}
      </div>

      <div className="toolbar">
        <select value={period} onChange={(e) => setPeriod(e.target.value as typeof period)} title="时间窗口">
          <option value="all">总榜（全部时间）</option>
          <option value="7d">本周热门</option>
          <option value="30d">本月热门</option>
        </select>
        <select value={topN} onChange={(e) => setTopN(Number(e.target.value))} title="显示数量">
          <option value={20}>前 20</option>
          <option value={50}>前 50</option>
          <option value={100}>前 100</option>
          <option value={500}>前 500</option>
        </select>
      </div>

      {ranked.length === 0 ? (
        <div className="empty">
          <span className="empty-icon">📊</span>
          <div className="empty-title">
            {period === 'all' ? '还没有访问记录' : '该时间窗口内没有访问'}
          </div>
          <div className="empty-hint">
            {period === 'all'
              ? '在浏览器里打开你已保存的书签页面，本页会自动统计访问次数。'
              : '试试切换到「总榜」查看全部时间。'}
          </div>
        </div>
      ) : (
        <div className="rank-list">
          {ranked.map((b, i) => {
            const rank = i + 1;
            return (
              <div key={b.id} className={`rank-item ${rank <= 3 ? `rank-top-${rank}` : ''}`}>
                <div className="rank-number">{rank}</div>
                <div className="rank-body">
                  <a
                    href={b.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rank-title"
                    title="新标签打开"
                  >
                    {b.title}
                  </a>
                  <div className="rank-meta">
                    <span className="rank-visits">访问 <strong>{b.visitCount}</strong> 次</span>
                    <span className="stats-sep">·</span>
                    <span>最后访问 {relativeTime(b.lastVisitedAt)}</span>
                    {b.ai?.category && (
                      <>
                        <span className="stats-sep">·</span>
                        <span>{b.ai.category}</span>
                      </>
                    )}
                    {(b.ai?.tags ?? []).slice(0, 3).map((t) => (
                      <span key={t} className="rank-tag">#{t}</span>
                    ))}
                  </div>
                </div>
                <div className="rank-actions">
                  <button className="btn ghost" onClick={() => api.openUrl(b.url)} title="打开">
                    ↗
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 相对时间显示（X 分钟前 / X 小时前 / X 天前 / YYYY-MM-DD） */
function relativeTime(ts?: number): string {
  if (!ts) return '从未';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/* ===========================================================
 * BatchActionsMenu：批量操作下拉菜单（智能 / 危险 两分组）
 *
 * 设计取舍：删掉了「编辑」组（添加/移除标签、移动到分类）。
 * 理由：有 AI 时代，用户不需要手动维护标签/分类 —— 让 AI 处理就好。
 * =========================================================== */

type BatchActionKind =
  | 'reanalyze' | 'enrich' | 'reextract'
  | 'delete';

function BatchActionsMenu({
  onAction,
  onClear,
}: {
  onAction: (kind: BatchActionKind) => Promise<void> | void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 关闭逻辑：点击外面 / Esc
  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const fire = (kind: BatchActionKind) => {
    void onAction(kind);
    setOpen(false);
  };

  return (
    <div className="batch-menu" ref={ref}>
      <button className="btn ghost" onClick={() => setOpen((o) => !o)}>
        ⚙ 操作 ▾
      </button>
      <button
        className="btn ghost"
        onClick={onClear}
        title="取消选择"
        style={{ padding: '4px 8px' }}
      >
        ✕
      </button>
      {open && (
        <div className="batch-menu-dropdown" role="menu">
          <div className="menu-group-title">智能</div>
          <button className="menu-item" onClick={() => fire('reanalyze')}>
            🔄 重新分析（重抽 + 重分类）
          </button>
          <button className="menu-item" onClick={() => fire('enrich')}>
            🏷 仅重分类
          </button>
          <button className="menu-item" onClick={() => fire('reextract')}>
            📝 仅重抽正文
          </button>

          <div className="menu-divider" />
          <div className="menu-group-title menu-group-danger">危险</div>
          <button
            className="menu-item menu-item-danger"
            onClick={() => fire('delete')}
          >
            🗑 删除
          </button>
        </div>
      )}
    </div>
  );
}

function CleanupView({
  bookmarks,
  onChange,
}: {
  bookmarks: Bookmark[];
  onChange: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const broken = bookmarks.filter((b) => b.status === 'broken');
  const dups = useMemo(() => {
    const m = new Map<string, Bookmark[]>();
    for (const b of bookmarks) {
      try {
        const u = new URL(b.url);
        u.hash = '';
        const k = u.toString().replace(/\/$/, '').replace(/^http:/, 'https:');
        const arr = m.get(k) ?? [];
        arr.push(b);
        m.set(k, arr);
      } catch { /* */ }
    }
    return Array.from(m.values()).filter((arr) => arr.length > 1);
  }, [bookmarks]);

  return (
    <div>
      <h1>清理</h1>
      <h2>死链检测</h2>
      <p style={{ color: 'var(--muted)' }}>
        按设置中的 <code>intervalHours</code> 周期自动检查，也可以在此手动触发。
      </p>
      <div className="row" style={{ marginBottom: 12 }}>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await api.checkDeadLinks();
            await onChange();
            setBusy(false);
          }}
        >
          {busy ? '检测中…' : '立即检查'}
        </button>
        <span style={{ color: 'var(--muted)' }}>已发现 {broken.length} 条死链</span>
      </div>
      {broken.length > 0 && (
        <table>
          <thead><tr><th>标题</th><th>URL</th><th>状态码</th><th>操作</th></tr></thead>
          <tbody>
            {broken.map((b) => (
              <tr key={b.id}>
                <td>{b.title}</td>
                <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.url}</td>
                <td>{b.httpStatus ?? '—'}</td>
                <td>
                  <button className="btn ghost" onClick={() => api.openUrl(b.url)}>打开</button>
                  <button className="btn danger" onClick={async () => { await api.remove(b.id); onChange(); }}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>重复书签</h2>
      {dups.length === 0 && <p style={{ color: 'var(--muted)' }}>没有发现重复 ✓</p>}
      {dups.map((arr) => (
        <div key={arr[0].url} style={{ marginBottom: 12 }}>
          <div style={{ color: 'var(--muted)' }}>{arr[0].url}</div>
          <ul>
            {arr.map((b) => (
              <li key={b.id}>
                {b.title} · 访问 {b.visitCount} 次
                <button className="btn ghost" style={{ marginLeft: 8 }} onClick={() => api.openUrl(b.url)}>打开</button>
                <button className="btn danger" style={{ marginLeft: 8 }} onClick={async () => { await api.remove(b.id); onChange(); }}>删除</button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * 帮助页：使用说明 + FAQ + 快捷键 + 数据存储位置。
 * 设计原则：把 80% 用户最常见的疑问用结构化文档一次性答完。
 */
function HelpView() {
  return (
    <div className="help">
      <h1>使用说明</h1>
      <p className="help-intro">
        Smart Bookmarks 是带 AI 自动分类、语义搜索、死链检测、浏览器原生书签双向同步的智能书签管理器。
      </p>

      {/* ============ 快速开始 ============ */}
      <section className="help-section">
        <h2>🚀 快速开始</h2>
        <ol className="help-steps">
          <li>
            <strong>保存第一个书签</strong> — 用浏览器右上角的⭐按钮（或 <kbd>Ctrl+Shift+S</kbd>）。
            本扩展会自动把它同步进来，并异步抓取正文 + 调用 AI 自动分类。
          </li>
          <li>
            <strong>等待几秒</strong> — AI 分类通常 2-5 秒完成，期间状态栏显示「正常」，分类后会出现标签。
          </li>
          <li>
            <strong>试试搜索</strong> — 打开 popup（点击工具栏图标）或在「书签」页搜索框输入关键词。
            支持模糊匹配 + 语义相似度（需要先在「设置」里配置 AI Key）。
          </li>
        </ol>
      </section>

      {/* ============ 三种保存方式 ============ */}
      <section className="help-section">
        <h2>💾 三种保存方式</h2>
        <div className="help-cards">
          <div className="help-card">
            <div className="help-card-title">① 浏览器⭐按钮 <span className="help-recommend">推荐</span></div>
            <p>Chrome / Edge 工具栏的星号按钮，保存后扩展自动同步进来。无需切窗口。</p>
          </div>
          <div className="help-card">
            <div className="help-card-title">② 快捷键 <kbd>Ctrl+Shift+S</kbd></div>
            <p>在任何网页按一下就保存。Mac 用户是 <kbd>⌘+Shift+S</kbd>。可在 <code>chrome://extensions/shortcuts</code> 改键。</p>
          </div>
          <div className="help-card">
            <div className="help-card-title">③ 右键菜单</div>
            <p>右键页面 →「保存到 Smart Bookmarks」。也可以右键链接直接保存链接目标。</p>
          </div>
        </div>
      </section>

      {/* ============ 地址栏搜索（Omnibox） ============ */}
      <section className="help-section">
        <h2>⌨️ 地址栏搜索（Omnibox）</h2>
        <p>
          不用打开 popup，直接在 Chrome 地址栏搜：输入 <kbd>sb</kbd> + <kbd>空格</kbd> 切换到 Smart Bookmarks 搜索模式。
        </p>
        <ul className="help-list">
          <li>
            <strong>敲关键词 + 直接 Enter</strong> — 打开「管理面板 → 书签」页，自动搜索关键词，看全部匹配
          </li>
          <li>
            <strong>↓ 选某条 + Enter</strong> — 直接打开那个书签
          </li>
          <li>
            <strong>Alt+Enter</strong> — 在新前台标签打开书签
          </li>
          <li>
            <strong>空关键词 + Enter</strong> — 打开「管理面板 → 书签」页（无搜索词）
          </li>
        </ul>
        <div className="help-tip">
          <strong>💡 设计取舍：</strong>chrome 的 omnibox 占位符（灰色提示）无法绑定快捷动作。
          我们用 onInputEntered 收到的 query 字符串（不是 url）来识别「直接 Enter = 打开 Options 搜索」——简单可靠。
        </div>
      </section>

      {/* ============ 搜索技巧 ============ */}
      <section className="help-section">
        <h2>🔍 搜索技巧</h2>
        <ul className="help-list">
          <li>
            <strong>模糊搜索</strong> — 输入关键词，会匹配标题 / URL / 标签 / 摘要 / 正文。
            例如搜「react」能命中正文里有 react 字样的文章。
          </li>
          <li>
            <strong>语义搜索</strong> — 开启 AI 后，搜「AI 相关的内容」会返回主题相近但没用这些词的书签。
            底层用向量余弦相似度（threshold 0.5）。
          </li>
          <li>
            <strong>叠加过滤</strong> — 在「标签」或「分类」页点击，会跳转到书签页并预过滤。
            搜索框 + 过滤是<strong>交集</strong>，不是互斥。
          </li>
          <li>
            <strong>排序</strong> — 工具栏的下拉可切「按时间」/「按名称」/「按访问次数」。
            无关键词默认按时间倒序；有搜索结果时默认按相关度。
          </li>
          <li>
            <strong>状态筛选</strong> — 工具栏另一个下拉：「全部状态」/「正常」/「死链」/「重复」，
            加上分组里的「⚠ 待处理」（只看 enrich 失败的条目）。
          </li>
        </ul>
      </section>

      {/* ============ AI 自动分类 ============ */}
      <section className="help-section">
        <h2>🧠 AI 自动分类</h2>
        <p>保存时自动跑（如果启用了 AI）：</p>
        <ul className="help-list">
          <li>抓取网页正文（最长 8000 字）</li>
          <li>调用 LLM 生成中文摘要、分类、3-5 个标签</li>
          <li>如配置了 embedding 模型，会生成向量用于语义搜索</li>
        </ul>
        <p className="help-tip">
          <strong>没启用 AI 也能用</strong> — 基础搜索（标题 / URL）不依赖 AI。
          只是不会有摘要、标签、分类、语义搜索。AI Key 在「设置」页填，支持 OpenAI / DeepSeek / 任意 OpenAI 兼容服务。
        </p>
      </section>

      {/* ============ 清理 ============ */}
      <section className="help-section">
        <h2>🧹 清理</h2>
        <ul className="help-list">
          <li>
            <strong>死链检测</strong> — 按设置里的周期自动检查，把失效书签标为「死链」。
            也可在「清理」页手动触发。
          </li>
          <li>
            <strong>重复合并</strong> — 每 6 小时跑一次，按 URL 规范化后去重，保留访问次数最多的。
            重复项标为「重复」状态（不自动删除，可在「清理」页查看）。
          </li>
        </ul>
      </section>

      {/* ============ 数据 ============ */}
      <section className="help-section">
        <h2>📦 数据存储</h2>
        <ul className="help-list">
          <li>
            所有书签 + AI 分类 + 设置存在浏览器的 <strong>IndexedDB</strong> 里，
            数据库名 <code>smart-bookmarks</code>，结构见 <code>src/core/db.ts</code>。
          </li>
          <li>
            <strong>导出 / 导入</strong>：在「书签」页用「导出 / 导入」按钮。
            导入支持「合并」和「覆盖」两种模式。
          </li>
          <li>
            <strong>浏览器原生书签双向同步</strong>（v0.3.0 起）：
            <ul>
              <li>⭐按钮加书签 → 实时同步进扩展（带 browserId 反向关联）</li>
              <li>浏览器里改标题/URL → 同步更新扩展</li>
              <li>每小时全量 resync 兜底事件丢失</li>
              <li><strong>单向</strong>：扩展里删除的书签<strong>不会</strong>反向删除浏览器书签（避免误操作）</li>
            </ul>
          </li>
          <li>
            <strong>卸载扩展会清空所有数据</strong>。建议定期导出备份。
          </li>
        </ul>
      </section>

      {/* ============ 批量操作 ============ */}
      <section className="help-section">
        <h2>⚙️ 批量操作</h2>
        <p>
          在「书签」页勾选若干条（可点表头或工具栏的「全选当前 (N)」全选当前过滤结果），右上角会出现「⚙ 操作 ▾」下拉菜单：
        </p>
        <ul className="help-list">
          <li>
            <strong>🔄 重新分析（重抽 + 重分类）</strong> — 适用于换 AI 模型 / API key 后重跑全部书签
          </li>
          <li>
            <strong>🏷 仅重分类</strong> — 保留 content，只重跑 AI 分类（速度比「重新分析」快）
          </li>
          <li>
            <strong>📝 仅重抽正文</strong> — content 缺失或乱码时用，重抓 + 重分析
          </li>
          <li>
            <strong>🗑 删除</strong> — 危险区，需 confirm 确认
          </li>
        </ul>
        <div className="help-tip">
          <strong>💡 设计取舍：</strong>我们<strong>不</strong>提供手动添加/移除标签、移动到分类这类操作。理由：AI 时代让用户远离手动维护——AI 自动打标签、自动归类，你只需要在「重新分析」一键触发。
        </div>
        <p>
          进度通过底部 Toast 显示「X / Y」，完成时自动消失。所有批量操作共用同一条 <code>runBatch</code> 通道，SW 端串行执行避免 API 限流。
        </p>
      </section>

      {/* ============ FAQ ============ */}
      <section className="help-section">
        <h2>❓ 常见问题</h2>

        <details className="help-faq" open>
          <summary>为什么保存的书签搜不到？</summary>
          <ol>
            <li>看「书签」页顶部的<strong>统计行</strong>：如果「共 X 条」没增加，说明保存路径没触发（点⭐按钮 / 快捷键 / 右键）。v0.3.0 起三种入口都生效。</li>
            <li>如果「共 X 条」增加了但搜索没结果，看统计行有没有「⚠ AI 失败」/「✗ 抽正文失败」— 这种书签的标签/摘要为空，关键词搜不到。点击数字会自动套上「待处理」筛选。</li>
            <li>可能是过滤条件限制。在「标签」/「分类」页点过过滤会缩小范围，试试清空搜索框或点过滤胶囊的 ✕。</li>
            <li>语义搜索要求已配 AI Key + 已 enrich 过（看 enrich 徽标 ⏳ → ✓ 后才能搜）。</li>
          </ol>
        </details>

        <details className="help-faq">
          <summary>状态列上的 ⏳ / ⚠ / ✗ 徽标是什么意思？</summary>
          <p>这是 <strong>enrich 流水线状态</strong>，每个书签保存后会自动跑（抽正文 + AI 分类）：</p>
          <ul>
            <li><strong>⏳ pending</strong> — 刚保存还在跑（通常 2-5 秒）。</li>
            <li><strong>⚠ partial</strong> — 正文抽到了但 AI 分类失败（或 AI 未启用 / embedding 失败）。hover 徽标看具体原因。</li>
            <li><strong>✗ failed</strong> — 正文抽取就失败了（content script 无响应 + fetch 也失败）。通常是网络问题或页面反爬。</li>
            <li><strong>无徽标</strong> — 全部成功。</li>
          </ul>
          <p>点击行操作里的「重新分析」/「重新抽正文」按钮可重试（按钮文案会按状态智能变化）。</p>
        </details>

        <details className="help-faq">
          <summary>状态筛选下拉里的「⚠ 待处理」是什么？</summary>
          <p>等价于"所有 enrich 没有成功的书签"（pending + partial + failed + 旧数据）。
            选中后会只显示这些需要关注的条目，方便批量点「重新分析」重跑。
            也可以直接点统计行里的「⚠ AI 失败 X」/「✗ 抽正文失败 X」数字，自动套上这个筛选。</p>
        </details>

        <details className="help-faq">
          <summary>AI Key 安全吗？</summary>
          <p>存在浏览器本地 IndexedDB，不会上传到任何第三方。
            仅在调用 AI 接口时直接发到你配置的 baseUrl（默认 OpenAI）。
            如果你使用自托管或代理服务，请确认 baseUrl 可信。
          </p>
        </details>

        <details className="help-faq">
          <summary>语义搜索和关键词搜索有什么区别？</summary>
          <p>关键词搜索精确但不会「猜」你的意思；语义搜索能匹配主题相近但字面不同的内容。
            例如搜「深度学习」相关文章，关键词会漏掉标题是「Neural Network Basics」的内容，语义能命中。
            两者在结果里会按 score 合并排序，取较高分。</p>
        </details>

        <details className="help-faq">
          <summary>如何批量重分类 / 重抽正文？</summary>
          <p>在「书签」页勾选要处理的书签（可点表头全选当前页），下方会出现「重分类」/「重抽正文」按钮。
            后台异步跑，进度显示在右下角 Toast 里。</p>
        </details>

        <details className="help-faq">
          <summary>卸载后数据还在吗？</summary>
          <p>IndexedDB 数据随扩展一起删除。再次安装后是空白状态。
            想迁移设备：在旧设备「导出」→ 在新设备「导入」。</p>
        </details>

        <details className="help-faq">
          <summary>支持哪些浏览器？</summary>
          <p>所有 Manifest V3 的 Chromium 内核浏览器（Chrome、Edge、Brave、Arc 等）。
            Firefox 需要单独打包，本扩展当前未提供 Firefox 版本。</p>
        </details>
      </section>

      {/* ============ 版本 ============ */}
      <section className="help-section help-footer">
        <h2>📝 版本</h2>
        <ul className="help-list">
          <li>
            <strong>v0.3.0</strong> —
            <ul>
              <li>chrome.bookmarks 双向同步（⭐按钮实时进扩展 + 浏览器改标题/URL 同步）</li>
              <li>enrich 状态追踪（pending / ok / partial / failed 徽标 + 错误原因 hover 提示）</li>
              <li>「⚠ 待处理」筛选（pending + partial + failed），统计行数字可点击</li>
              <li>书签页统计行（总数 / 7天新增 / 30天新增 / AI 分类 / 死链 / 重复 / 最后添加时间）</li>
              <li>排序下拉（按时间 / 按名称 / 按访问次数）</li>
              <li>大数据集兼容（LIST_BOOKMARKS 分页 + search 全量返回）</li>
              <li>filter + search 交集（之前是互斥）</li>
              <li>帮助页（你正在看的这个）</li>
            </ul>
          </li>
          <li><strong>v0.2.0</strong> — 整体 UI 精致功能风改版 / 标签可视化 / 分类可视化</li>
          <li><strong>v0.1.0</strong> — 初始版本 / AI 自动分类 / 语义搜索 / 死链检测</li>
        </ul>
      </section>
    </div>
  );
}

function SettingsView({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => Promise<void> }) {
  const [s, setS] = useState(settings);
  const [showApiKey, setShowApiKey] = useState(false);
  useEffect(() => setS(settings), [settings]);
  return (
    <div>
      <h1>设置</h1>

      <h2>AI</h2>
      <div className="row">
        <label>启用 AI</label>
        <input type="checkbox" checked={s.ai.enabled} onChange={(e) => setS({ ...s, ai: { ...s.ai, enabled: e.target.checked } })} />
      </div>
      <div className="row">
        <label>服务商</label>
        <select value={s.ai.provider} onChange={(e) => {
          const provider = e.target.value as Settings['ai']['provider'];
          const presets: Record<string, Partial<Settings['ai']>> = {
            openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', embedModel: 'text-embedding-3-small' },
            deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', embedModel: '' },
          };
          setS({ ...s, ai: { ...s.ai, provider, ...(presets[provider] ?? {}) } });
        }}>
          <option value="openai">OpenAI</option>
          <option value="deepseek">DeepSeek (OpenAI 兼容)</option>
          <option value="custom">自定义 (OpenAI 兼容)</option>
        </select>
      </div>
      <div className="row"><label>Base URL</label><input value={s.ai.baseUrl} onChange={(e) => setS({ ...s, ai: { ...s.ai, baseUrl: e.target.value } })} /></div>
      <div className="row">
        <label>API Key</label>
        <input
          type={showApiKey ? 'text' : 'password'}
          value={s.ai.apiKey}
          onChange={(e) => setS({ ...s, ai: { ...s.ai, apiKey: e.target.value } })}
        />
        <button
          type="button"
          className="btn ghost"
          onClick={() => setShowApiKey((v) => !v)}
          title={showApiKey ? '隐藏 API Key' : '显示 API Key'}
          aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
          style={{ flex: '0 0 auto', padding: '6px 10px' }}
        >
          {showApiKey ? EyeOffIcon : EyeIcon}
        </button>
      </div>
      <div className="row">
        <label>模型 (Chat)</label>
        <input value={s.ai.model} onChange={(e) => setS({ ...s, ai: { ...s.ai, model: e.target.value } })} />
        <PingButton kind="chat" ai={s.ai} />
      </div>
      <div className="row">
        <label>Embedding 模型 (可选)</label>
        <input value={s.ai.embedModel ?? ''} onChange={(e) => setS({ ...s, ai: { ...s.ai, embedModel: e.target.value } })} />
        <PingButton kind="embed" ai={s.ai} />
      </div>
      <div className="row">
        <label>保存时自动分类</label>
        <input type="checkbox" checked={s.ai.autoClassifyOnSave} onChange={(e) => setS({ ...s, ai: { ...s.ai, autoClassifyOnSave: e.target.checked } })} />
      </div>
      <div className="row">
        <label>自动生成摘要</label>
        <input type="checkbox" checked={s.ai.autoSummarize} onChange={(e) => setS({ ...s, ai: { ...s.ai, autoSummarize: e.target.checked } })} />
      </div>

      <h2>死链检测</h2>
      <div className="row">
        <label>启用</label>
        <input type="checkbox" checked={s.deadLinkCheck.enabled} onChange={(e) => setS({ ...s, deadLinkCheck: { ...s.deadLinkCheck, enabled: e.target.checked } })} />
      </div>
      <div className="row"><label>检测周期 (小时)</label><input className="small" type="number" value={s.deadLinkCheck.intervalHours} onChange={(e) => setS({ ...s, deadLinkCheck: { ...s.deadLinkCheck, intervalHours: Number(e.target.value) } })} /></div>
      <div className="row"><label>每批数量</label><input className="small" type="number" value={s.deadLinkCheck.batchSize} onChange={(e) => setS({ ...s, deadLinkCheck: { ...s.deadLinkCheck, batchSize: Number(e.target.value) } })} /></div>
      <div className="row"><label>请求超时 (ms)</label><input className="small" type="number" value={s.deadLinkCheck.timeoutMs} onChange={(e) => setS({ ...s, deadLinkCheck: { ...s.deadLinkCheck, timeoutMs: Number(e.target.value) } })} /></div>

      <h2>其他</h2>
      <div className="row">
        <label>主题</label>
        <select value={s.theme} onChange={(e) => setS({ ...s, theme: e.target.value as Settings['theme'] })}>
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </div>

      <h2>快捷键</h2>
      <p>在 <code>chrome://extensions/shortcuts</code> 中可修改：<span className="kbd">Ctrl+Shift+S</span> 保存当前页</p>

      <div className="row" style={{ marginTop: 24, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={async () => { await onSaved(s); alert('已保存'); }}>保存设置</button>
      </div>
    </div>
  );
}

/** 模型可用性检测按钮 + 行内状态徽标 */
function PingButton({ kind, ai }: { kind: 'chat' | 'embed'; ai: Settings['ai'] }) {
  const [state, setState] = useState<PingState>({ kind: 'idle' });
  const disabled = !ai.apiKey || state.kind === 'loading';

  const onClick = async () => {
    setState({ kind: 'loading' });
    const res = kind === 'chat' ? await api.pingChat(ai) : await api.pingEmbed(ai);
    const data = res.data;
    if (!data) {
      setState({ kind: 'fail', error: res.error ?? '未知错误' });
      return;
    }
    if (data.ok) setState({ kind: 'ok' });
    else setState({ kind: 'fail', error: data.error, httpStatus: data.httpStatus });
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        className="btn ghost"
        disabled={disabled}
        onClick={onClick}
        style={{ flex: '0 0 auto', padding: '6px 10px' }}
      >
        {state.kind === 'loading' ? '检测中…' : '检测'}
      </button>
      <PingBadge state={state} />
    </span>
  );
}

interface PingState {
  kind: 'idle' | 'loading' | 'ok' | 'fail';
  error?: string;
  httpStatus?: number;
}

function PingBadge({ state }: { state: PingState }) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'loading') {
    return <span className="status-pill status-loading">⏳</span>;
  }
  if (state.kind === 'ok') {
    return <span className="status-pill status-active" title="可用">✓ 可用</span>;
  }
  // fail
  const tip = state.httpStatus
    ? `HTTP ${state.httpStatus}${state.error ? `\n${state.error}` : ''}`
    : state.error ?? '';
  return (
    <span className="status-pill status-broken" title={tip}>
      ✗ {state.httpStatus ? `HTTP ${state.httpStatus}` : '失败'}
    </span>
  );
}

// 内联 SVG 图标，避免引入额外依赖
const EyeIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOffIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17.94 17.94A10.06 10.06 0 0 1 12 19c-6.5 0-10-7-10-7a17.62 17.62 0 0 1 4.06-5.06" />
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.16 3.19" />
    <path d="M14.12 14.12a3 3 0 0 1-4.24-4.24" />
    <line x1="2" y1="2" x2="22" y2="22" />
  </svg>
);
