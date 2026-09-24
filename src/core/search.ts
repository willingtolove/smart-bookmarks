// 搜索：Fuse.js（模糊 / 精确）+ 余弦相似度（语义）
import Fuse from 'fuse.js';
import type { Bookmark, SearchResult, Settings } from '../types';
import { AiClient } from './ai';

export interface SearchOptions {
  query: string;
  bookmarks: Bookmark[];
  settings: Settings;
  limit?: number;
}

function cosine(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

export async function searchBookmarks(opts: SearchOptions): Promise<SearchResult[]> {
  const { query, bookmarks, settings, limit = 50 } = opts;
  const q = query.trim();
  if (!q) {
    return bookmarks
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((b) => ({ ...b, score: 0, matchType: 'exact' }));
  }

  const fuse = new Fuse(bookmarks, {
    includeScore: true,
    ignoreLocation: true,
    threshold: 0.4,
    keys: [
      { name: 'title', weight: 0.5 },
      { name: 'description', weight: 0.2 },
      { name: 'url', weight: 0.15 },
      { name: 'content', weight: 0.1 },
      { name: 'ai.summary', weight: 0.2 },
      { name: 'ai.tags', weight: 0.15 },
    ],
  });
  const hits = fuse.search(q).map<SearchResult>((h) => ({
    ...h.item,
    score: 1 - (h.score ?? 0),
    matchType: 'fuzzy',
  }));

  if (settings.ai.enabled && settings.ai.apiKey) {
    try {
      const ai = new AiClient(settings.ai);
      const qEmbed = await ai.embed(q);
      const semantic: SearchResult[] = [];
      for (const b of bookmarks) {
        if (b.ai?.embedding?.length) {
          const s = cosine(qEmbed, b.ai.embedding);
          if (s > 0.5) semantic.push({ ...b, score: s, matchType: 'semantic' });
        }
      }
      const merged = new Map<string, SearchResult>();
      for (const h of hits) merged.set(h.id, h);
      for (const s of semantic) {
        const existing = merged.get(s.id);
        if (!existing || s.score > existing.score) merged.set(s.id, s);
      }
      return Array.from(merged.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (e) {
      console.warn('[search] semantic fallback:', e);
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
