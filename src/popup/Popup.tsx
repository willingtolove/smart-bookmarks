import { useCallback, useEffect, useState } from 'react';
import { api } from '../ui/api';
import { searchBookmarks } from '../core/search';
import { recommendBookmarks } from '../core/recommend';
import { useDebounce } from '../ui/hooks';
import { DEFAULT_SETTINGS, type Bookmark, type SearchResult, type Settings } from '../types';

export function Popup() {
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 200);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    void api.getSettings().then((r) => r.data && setSettings(r.data));
  }, []);

  const refresh = useCallback(async (query: string) => {
    setLoading(true);
    const list = await api.list();
    const bookmarks: Bookmark[] = (list.data ?? []).filter((b) => b.status !== 'duplicate');
    if (!query.trim()) {
      setResults(
        recommendBookmarks({ bookmarks, limit: 12 }).map((b) => ({ ...b, score: 0, matchType: 'exact' })),
      );
    } else {
      const r = await searchBookmarks({ query, bookmarks, settings, limit: 30 });
      setResults(r);
    }
    setLoading(false);
  }, [settings]);

  useEffect(() => {
    void refresh(dq);
  }, [dq, refresh]);

  const onSave = async () => {
    await api.saveCurrent();
    setToast('已保存到 Smart Bookmarks');
    setTimeout(() => setToast(null), 1500);
    void refresh(q);
  };

  const onDelete = async (id: string) => {
    await api.remove(id);
    void refresh(q);
  };

  return (
    <div className="app">
      <header>
        <input
          autoFocus
          placeholder="搜索书签、标签、摘要或语义…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button onClick={onSave} title="保存当前页 (Ctrl+Shift+S)">＋ 保存</button>
      </header>
      <main>
        {loading && (
          <div className="empty">
            <span className="spinner" />
          </div>
        )}
        {!loading && results.length === 0 && (
          <div className="empty">
            <span className="empty-icon">{q.trim() ? '🔍' : '🔖'}</span>
            <div className="empty-title">
              {q.trim() ? '没有匹配的书签' : '还没有书签'}
            </div>
            <div className="empty-hint">
              {q.trim() ? '试试更短的关键词，或清空搜索看推荐' : '按 Ctrl+Shift+S 保存当前页面'}
            </div>
          </div>
        )}
        {results.map((b) => (
          <div className="item" key={b.id} onClick={() => api.openUrl(b.url)}>
            <img
              className="fav"
              src={b.favicon ?? `https://www.google.com/s2/favicons?domain=${new URL(b.url).hostname}`}
              alt=""
            />
            <div className="meta">
              <div className="title">{b.title}</div>
              <div className="url">{b.url}</div>
              {b.ai?.summary && <div className="summary" title={b.ai.summary}>{b.ai.summary}</div>}
              {(b.ai?.tags?.length || b.status !== 'active') && (
                <div className="badges">
                  {b.ai?.tags?.slice(0, 3).map((t) => <span className="badge" key={t}>#{t}</span>)}
                  {b.status === 'broken' && <span className="badge break">死链</span>}
                  {b.status === 'redirected' && <span className="badge">已重定向</span>}
                </div>
              )}
            </div>
            <div className="actions">
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(b.id); }}
                title="删除"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </main>
      <footer>
        <button onClick={() => api.openOptions()}>⚙ 打开管理面板</button>
        <span>{results.length} 条</span>
      </footer>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
