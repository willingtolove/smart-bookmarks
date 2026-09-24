import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type BatchProgressPayload } from '../ui/api';
import { searchBookmarks } from '../core/search';
import { useDebounce } from '../ui/hooks';
import { DEFAULT_SETTINGS, type Bookmark, type SearchResult, type Settings } from '../types';
import { downloadJSON, newId } from '../core/util';

type Tab = 'bookmarks' | 'tags' | 'categories' | 'settings' | 'cleanup';

export function Options() {
  const [tab, setTab] = useState<Tab>('bookmarks');
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(false);

  const reload = async () => {
    setLoading(true);
    const r = await api.list();
    setBookmarks(r.data ?? []);
    const s = await api.getSettings();
    if (s.data) setSettings(s.data);
    setLoading(false);
  };
  useEffect(() => {
    void reload();
  }, []);

  return (
    <div className="layout">
      <aside>
        <div className="brand">🧠 Smart Bookmarks</div>
        <nav>
          {(['bookmarks', 'tags', 'categories', 'cleanup', 'settings'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {labelOf(t)}
            </button>
          ))}
        </nav>
      </aside>
      <section className="content">
        {loading && <div style={{ color: 'var(--muted)' }}>加载中…</div>}
        {tab === 'bookmarks' && <BookmarksView bookmarks={bookmarks} settings={settings} onChange={reload} />}
        {tab === 'tags' && <TagsView bookmarks={bookmarks} onChange={reload} />}
        {tab === 'categories' && <CategoriesView bookmarks={bookmarks} onChange={reload} />}
        {tab === 'cleanup' && <CleanupView bookmarks={bookmarks} onChange={reload} />}
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
  return { bookmarks: '🔖 书签', tags: '🏷 标签', categories: '📂 分类', cleanup: '🧹 清理', settings: '⚙ 设置' }[t];
}

function BookmarksView({
  bookmarks,
  settings,
  onChange,
}: {
  bookmarks: Bookmark[];
  settings: Settings;
  onChange: () => Promise<void> | void;
}) {
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 200);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [statusFilter, setStatusFilter] = useState<'all' | Bookmark['status']>('all');
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [enriching, setEnriching] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchProgress, setBatchProgress] = useState<BatchProgressPayload | null>(null);
  const [batchTitle, setBatchTitle] = useState<string>('');
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      const r = await searchBookmarks({ query: dq, bookmarks, settings, limit: 500 });
      setResults(statusFilter === 'all' ? r : r.filter((b) => b.status === statusFilter));
    })();
  }, [dq, bookmarks, settings, statusFilter]);

  // Bug 3: 搜索/筛选变化时清空 selected，避免用户看不到的 id 被误操作
  useEffect(() => {
    setSelected(new Set());
  }, [dq, statusFilter]);

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
  const runBatch = async (mode: 'delete' | 'enrich' | 'reextract') => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const batchId = newId();
    const titleMap: Record<typeof mode, string> = {
      delete: '批量删除',
      enrich: '批量重分类',
      reextract: '批量重抽正文',
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
    if (mode === 'delete') {
      await api.batchDelete(ids, batchId);
    } else if (mode === 'enrich') {
      await api.batchEnrich(ids, batchId);
    } else {
      await api.batchReextract(ids, batchId);
    }
  };

  return (
    <div>
      <h1>书签</h1>
      <div className="toolbar">
        <input placeholder="搜索标题、URL、标签、正文…支持语义" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}>
          <option value="all">全部状态</option>
          <option value="active">正常</option>
          <option value="redirected">已重定向</option>
          <option value="broken">死链</option>
          <option value="duplicate">重复</option>
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
            <button className="btn ghost" onClick={() => runBatch('enrich')}>重分类</button>
            <button className="btn ghost" onClick={() => runBatch('reextract')}>重抽正文</button>
            <button className="btn ghost" style={{ color: 'var(--danger)' }} onClick={() => runBatch('delete')}>删除</button>
            <button className="btn ghost" onClick={clearSelection} title="取消选择" style={{ padding: '4px 8px' }}>✕</button>
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
            <tr key={b.id}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(b.id)}
                  autoComplete="off"
                  onChange={() => toggleOne(b.id)}
                />
              </td>
              <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.title}</td>
              <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.url}</td>
              <td>{b.ai?.category ?? '—'}</td>
              <td>{(b.ai?.tags ?? []).map((t) => `#${t}`).join(' ') || '—'}</td>
              <td><span className={`status-pill status-${b.status}`}>{labelStatus(b.status)}</span></td>
              <td>{b.visitCount}</td>
              <td className="actions-col">
                <button className="btn ghost" onClick={() => setEditing(b)}>编辑</button>
                <button className="btn ghost" disabled={enriching.has(b.id)} onClick={() => onEnrich(b.id)}>
                  {enriching.has(b.id) ? '⏳ 分析中…' : '重分类'}
                </button>
                <button className="btn danger" onClick={async () => { await api.remove(b.id); onChange(); }}>删</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <EditModal bookmark={editing} onClose={() => setEditing(null)} onSaved={onChange} />}

      {batchProgress && (
        <BatchProgressToast
          title={batchTitle}
          progress={batchProgress}
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
  onClose,
}: {
  title: string;
  progress: BatchProgressPayload;
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

  const pct = Math.round((progress.done / Math.max(progress.total, 1)) * 100);
  const okCount = progress.done - errors.length;
  const done = progress.done >= progress.total;

  return (
    <div className="batch-toast" role="status">
      <button className="close" onClick={onClose} aria-label="关闭">✕</button>
      <h4>{title} {done ? '✓ 完成' : ''}</h4>
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
          {errors.map((e, i) => (
            <div key={i}>
              <code>{e.id.slice(0, 8)}</code>: {e.error}
            </div>
          ))}
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
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'grid', placeItems: 'center', zIndex: 50 }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--bg)', padding: 20, borderRadius: 12, width: 520, maxWidth: '90vw' }}
      >
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
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
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

function TagsView({ bookmarks, onChange }: { bookmarks: Bookmark[]; onChange: () => Promise<void> | void }) {
  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of bookmarks) for (const t of b.ai?.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [bookmarks]);
  return (
    <div>
      <h1>标签</h1>
      <p style={{ color: 'var(--muted)' }}>标签由 AI 在保存时自动生成（可手动在书签编辑中修改）。</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {allTags.map(([t, n]) => (
          <span key={t} className="status-pill">#{t} <strong>· {n}</strong></span>
        ))}
        {allTags.length === 0 && <p style={{ color: 'var(--muted)' }}>暂无标签 — 开启 AI 自动分类后再保存书签即可。</p>}
      </div>
      <p style={{ color: 'var(--muted)', marginTop: 24 }}>刷新数据：</p>
      <button className="btn" onClick={() => onChange()}>刷新</button>
    </div>
  );
}

function CategoriesView({ bookmarks }: { bookmarks: Bookmark[]; onChange: () => Promise<void> | void }) {
  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of bookmarks) {
      const c = b.ai?.category ?? '未分类';
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [bookmarks]);
  return (
    <div>
      <h1>分类</h1>
      <table>
        <thead><tr><th>分类</th><th>数量</th></tr></thead>
        <tbody>
          {groups.map(([c, n]) => (
            <tr key={c}><td>{c}</td><td>{n}</td></tr>
          ))}
        </tbody>
      </table>
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
