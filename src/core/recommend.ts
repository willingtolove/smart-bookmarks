// 智能推荐：基于时间衰减、访问频次、分类共现
import type { Bookmark } from '../types';

const HALF_LIFE_DAYS = 30; // 30 天半衰期

function timeDecay(ts: number, now = Date.now()) {
  const days = (now - ts) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

export interface RecommendOptions {
  bookmarks: Bookmark[];
  /** 当前书签（如 Popup 打开时），会基于它的分类/标签推荐相似项 */
  context?: Bookmark;
  limit?: number;
}

export function recommendBookmarks(opts: RecommendOptions): Bookmark[] {
  const { bookmarks, context, limit = 10 } = opts;
  if (!bookmarks.length) return [];
  const now = Date.now();

  // 候选打分
  const scored = bookmarks.map((b) => {
    let score = 0;
    score += (b.visitCount ?? 0) * 1.0;
    if (b.lastVisitedAt) score += 2 * timeDecay(b.lastVisitedAt, now);
    if (b.createdAt) score += 0.5 * timeDecay(b.createdAt, now);
    if (b.status !== 'active') score -= 5;

    if (context) {
      if (context.categoryId && b.categoryId === context.categoryId) score += 3;
      const shared = (context.tagIds ?? []).filter((t) => (b.tagIds ?? []).includes(t)).length;
      score += shared * 1.5;
      if (b.ai?.category && context.ai?.category && b.ai.category === context.ai.category) {
        score += 1.5;
      }
    }
    return { b, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.b);
}
