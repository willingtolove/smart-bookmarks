// 共享类型定义：书签、AI 元数据、配置等
export type ID = string;

export interface Tag {
  id: ID;
  name: string;
  color?: string;
}

export interface Category {
  id: ID;
  name: string;
  parentId?: ID;
}

export interface AiMeta {
  summary?: string;        // 摘要
  category?: string;       // 推测分类名
  tags?: string[];         // 推测的标签
  language?: string;       // 主语言
  embedding?: number[];    // 向量（用于语义搜索）
  classifiedAt?: number;   // 分类时间
  model?: string;          // 使用的模型名
}

export interface Bookmark {
  id: ID;
  url: string;
  title: string;
  description?: string;
  favicon?: string;
  coverImage?: string;     // 抓取的 og:image
  content?: string;        // 抽取的正文（用于全文/向量搜索）
  folderId?: ID;           // 自定义文件夹
  categoryId?: ID;
  tagIds: ID[];
  ai?: AiMeta;
  createdAt: number;
  updatedAt: number;
  lastVisitedAt?: number;
  visitCount: number;
  status: 'active' | 'broken' | 'redirected' | 'duplicate';
  lastCheckedAt?: number;
  httpStatus?: number;
  finalUrl?: string;
}

export interface Settings {
  ai: {
    enabled: boolean;
    provider: 'openai' | 'deepseek' | 'custom';
    baseUrl: string;
    apiKey: string;
    model: string;
    embedModel?: string;
    autoClassifyOnSave: boolean;
    autoSummarize: boolean;
  };
  deadLinkCheck: {
    enabled: boolean;
    intervalHours: number;     // 周期
    batchSize: number;         // 每次检查数量
    timeoutMs: number;
  };
  storage: {
    keepBrowserBookmarksInSync: boolean;
  };
  theme: 'light' | 'dark' | 'system';
}

export const DEFAULT_SETTINGS: Settings = {
  ai: {
    enabled: false,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    embedModel: '',
    autoClassifyOnSave: true,
    autoSummarize: true,
  },
  deadLinkCheck: {
    enabled: true,
    intervalHours: 24,
    batchSize: 50,
    timeoutMs: 8000,
  },
  storage: {
    keepBrowserBookmarksInSync: true,
  },
  theme: 'system',
};

export interface SearchResult extends Bookmark {
  score: number;
  matchType: 'exact' | 'fuzzy' | 'semantic';
}
