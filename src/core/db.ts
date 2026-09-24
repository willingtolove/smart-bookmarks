// 基于 idb 的本地数据库封装
import { openDB, type IDBPDatabase } from 'idb';
import type { Bookmark, Category, Settings, Tag } from '../types';
import { DEFAULT_SETTINGS } from '../types';

const DB_NAME = 'smart-bookmarks';
const DB_VERSION = 1;

interface Schema {
  bookmarks: Bookmark;
  tags: Tag;
  categories: Category;
  settings: { key: string; value: unknown };
  meta: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('bookmarks')) {
          const s = db.createObjectStore('bookmarks', { keyPath: 'id' });
          s.createIndex('url', 'url', { unique: false });
          s.createIndex('createdAt', 'createdAt');
          s.createIndex('status', 'status');
        }
        if (!db.objectStoreNames.contains('tags')) {
          db.createObjectStore('tags', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('categories')) {
          const c = db.createObjectStore('categories', { keyPath: 'id' });
          c.createIndex('parentId', 'parentId');
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta');
        }
      },
    });
  }
  return dbPromise;
}

export const db = {
  async listBookmarks(): Promise<Bookmark[]> {
    const d = await getDB();
    return d.getAll('bookmarks');
  },
  async getBookmark(id: string): Promise<Bookmark | undefined> {
    const d = await getDB();
    return d.get('bookmarks', id);
  },
  async getBookmarkByUrl(url: string): Promise<Bookmark | undefined> {
    const d = await getDB();
    return d.getFromIndex('bookmarks', 'url', url);
  },
  async putBookmark(b: Bookmark): Promise<void> {
    const d = await getDB();
    await d.put('bookmarks', b);
  },
  async bulkPutBookmarks(items: Bookmark[]): Promise<void> {
    const d = await getDB();
    const tx = d.transaction('bookmarks', 'readwrite');
    await Promise.all(items.map((i) => tx.store.put(i)));
    await tx.done;
  },
  async deleteBookmark(id: string): Promise<void> {
    const d = await getDB();
    await d.delete('bookmarks', id);
  },
  async listTags(): Promise<Tag[]> {
    const d = await getDB();
    return d.getAll('tags');
  },
  async putTag(t: Tag) {
    const d = await getDB();
    await d.put('tags', t);
  },
  async deleteTag(id: string) {
    const d = await getDB();
    await d.delete('tags', id);
  },
  async listCategories(): Promise<Category[]> {
    const d = await getDB();
    return d.getAll('categories');
  },
  async putCategory(c: Category) {
    const d = await getDB();
    await d.put('categories', c);
  },
  async deleteCategory(id: string) {
    const d = await getDB();
    await d.delete('categories', id);
  },
  async getSettings(): Promise<Settings> {
    const d = await getDB();
    const stored = (await d.get('settings', 'main')) as Settings | undefined;
    return { ...DEFAULT_SETTINGS, ...(stored ?? {}) } as Settings;
  },
  async saveSettings(s: Settings) {
    const d = await getDB();
    await d.put('settings', s, 'main');
  },
  async exportAll() {
    const d = await getDB();
    const [bookmarks, tags, categories, settings] = await Promise.all([
      d.getAll('bookmarks'),
      d.getAll('tags'),
      d.getAll('categories'),
      d.get('settings', 'main'),
    ]);
    return { version: 1, exportedAt: Date.now(), bookmarks, tags, categories, settings };
  },
  async importAll(payload: Awaited<ReturnType<typeof this.exportAll>>, mode: 'merge' | 'replace' = 'merge') {
    const d = await getDB();
    const tx = d.transaction(['bookmarks', 'tags', 'categories', 'settings'], 'readwrite');
    if (mode === 'replace') {
      await tx.objectStore('bookmarks').clear();
      await tx.objectStore('tags').clear();
      await tx.objectStore('categories').clear();
    }
    for (const b of payload.bookmarks ?? []) await tx.objectStore('bookmarks').put(b);
    for (const t of payload.tags ?? []) await tx.objectStore('tags').put(t);
    for (const c of payload.categories ?? []) await tx.objectStore('categories').put(c);
    if (payload.settings) await tx.objectStore('settings').put(payload.settings, 'main');
    await tx.done;
  },
};

export type DB = typeof db;
export type { Schema };
