# Smart Bookmarks 🧠🔖

一款基于 **Manifest V3 + React + TypeScript + Vite** 的智能书签浏览器插件，面向 Chrome / Edge。

## ✨ 特性

- **AI 自动分类 / 摘要 / 打标签**：保存时自动抽取正文 → 调用大模型（OpenAI / DeepSeek / 任意 OpenAI 兼容端点）→ 返回结构化 JSON 并写入书签。
- **语义 / 模糊 / 全文搜索**：默认基于 Fuse.js 的多字段模糊搜索；开启 AI 后追加向量余弦相似度，支持按「意思」找书签。
- **地址栏 Omnibox 搜索**：在 Chrome 地址栏输入 `sb ` 即可搜索书签，实时下拉 8 条匹配，直接 Enter 进 Options 全量搜索，↓ 选条直接打开。
- **书签热度排行**：基于真实访问次数（`chrome.tabs` 监听自动累加），支持总榜 / 本周 / 本月三个时段，Top 3 金银铜高亮。
- **浏览器⭐按钮双向同步**：监听 `chrome.bookmarks.onCreated/onChanged`，用户在浏览器原生书签栏加的书签也会进扩展。
- **死链检测**：周期 + 手动两路触发；HEAD 失败时自动回退到带 `Range` 的 GET，记录 HTTP 状态与最终 URL。
- **重复识别**：按规范化 URL 自动归组，保留访问次数最多者。
- **智能推荐**：基于时间衰减 + 访问频次 + 分类/标签共现，Popup 顶部展示。
- **本地优先 + 可导入导出**：数据存于 IndexedDB；一键导出 JSON。
- **快捷键 / 右键菜单 / Popup / Options 面板** 完整 UI。
- **深浅色自适应**。

## 📁 项目结构

```
smart-bookmarks/
├─ manifest.config.ts        # crxjs 用的 manifest（MV3）
├─ vite.config.ts            # 多入口 + crx 插件
├─ src/
│  ├─ background/index.ts    # Service Worker：命令/菜单/消息/定时任务
│  ├─ content/index.ts       # 内容脚本：抽取正文回传
│  ├─ popup/                 # 弹窗 UI
│  ├─ options/               # 管理面板
│  ├─ core/
│  │  ├─ db.ts               # IndexedDB 封装
│  │  ├─ ai.ts               # OpenAI 兼容客户端 + 分类 prompt
│  │  ├─ search.ts           # Fuse + 向量相似度
│  │  ├─ recommend.ts        # 推荐打分
│  │  ├─ deadLink.ts         # 死链检查 & 重复识别
│  │  ├─ extract.ts          # 简易 Readability
│  │  └─ util.ts
│  └─ types.ts
└─ public/icons/             # 图标（占位）
```

## 🚀 快速开始

```bash
# 1. 安装依赖
pnpm install   # 或 npm i / yarn

# 2. 开发模式（推荐）—— 持续 watch 重建 dist/，到 chrome://extensions/ 点"重新加载"即可
pnpm dev

# 2'. 纯 UI 调试 —— 启动 Vite dev server，浏览器开 http://localhost:5173 看页面
pnpm dev:ui
#   注：dev:ui 不打包到 dist/，仅适用于 Popup / Options 页面预览
#   Service Worker / Content Script 改动仍需在 dist/ 加载后手动"重新加载"扩展

# 3. 在 chrome://extensions/ 打开「开发者模式」→ 「加载已解压的扩展程序」→ 选择 dist/ 目录

# 4. 首次安装会自动从 Chrome 书签树迁移一次；进入 Options 面板配置 AI 即可解锁智能能力
```

构建生产包：

```bash
pnpm build
# 产物在 dist/ 目录，可直接打包 zip 上架
```

## ⚙ 配置 AI

进入 **Options → 设置 → AI**，按需填写：

| 字段 | 说明 |
| --- | --- |
| 启用 AI | 总开关 |
| 服务商 | OpenAI / DeepSeek / 自定义 |
| Base URL | 例如 `https://api.deepseek.com/v1` |
| API Key | 对应服务商的 Key |
| 模型 (Chat) | 默认 `deepseek-chat` / `gpt-4o-mini` |
| Embedding 模型 | 选填，启用语义搜索时必填 |

> 💡 DeepSeek 默认不提供 Embedding，可保持空 → 仅使用模糊 + 全文搜索；如需语义搜索，可改用 OpenAI 或支持 Embedding 的兼容端点。

## 🧪 关键能力说明

### 自动分类 Prompt（`core/ai.ts`）

模型被要求仅输出 JSON：

```json
{
  "summary": "中文一句话摘要",
  "category": "编程/设计/新闻/...",
  "tags": ["最多5个短标签"],
  "language": "zh"
}
```

后台在抽取正文后异步调用并把结果写回书签 `ai` 字段；Embedding 与摘要可选。

### 搜索排序

1. Fuse.js 命中：标题 > 摘要 > URL > 正文
2. AI Embedding 余弦相似度：仅在 `ai.embedding` 存在时参与
3. 最终按 `score` 倒序

### 地址栏 Omnibox 搜索

manifest 注册 `omnibox: { keyword: 'sb' }`，地址栏输入 `sb ` 触发扩展搜索模式：

- **直接 Enter** — 打开「Options → 书签」页，自动搜索关键词，看全量匹配
- **↓ 选条 + Enter** — 打开该书签
- **Alt+Enter** — 在新前台标签打开
- **空关键词 + Enter** — 打开「Options → 书签」页

Omnibox 搜索复用 `searchBookmarks()`（Fuse + 语义合并），与 Popup / Options 共享同一份搜索实现。
SW 端 `chrome.omnibox.onInputChanged` 实时推 8 条 suggestion，`onInputEntered` 根据 `text` 是不是 http url 区分「打开书签」还是「打开 Options 全量搜索」。

### 书签热度排行

SW 端通过 `chrome.tabs.onActivated` + `onUpdated` 监听真实访问，`lastCountedTabUrl` Map 防止同 tab 同 URL 重复计数。访问时 `db.putBookmark({ ...b, visitCount: +1, lastVisitedAt: now })`（URL 写入前统一 `normalizeUrl`，避免归一化不一致 bug）。

Options 页「🔥 热度」tab 支持三时段（总榜 / 本周 / 本月）+ Top N 选择，Top 3 金银铜高亮。

### 死链检查

通过 `chrome.alarms` 周期触发；Service Worker 限制：每次只检查 `batchSize` 条（默认 50），按 `lastCheckedAt` 升序，规避一次性大量请求。

## 🔐 隐私

- 全部数据默认 **仅存于本地 IndexedDB**。
- 启用 AI 时，仅向用户配置的第三方 API 发送：标题、URL、正文片段（最多 4k 字符）。你可以随时在设置中关闭。
- 插件不内置任何远端后端。

## 🗺 Roadmap

**已做完（v0.3+）**：
- ✅ Chrome 原生书签双向同步（`chrome.bookmarks.onCreated/Changed`）
- ✅ enrich 状态追踪（⏳/⚠/✗ 徽标 + 待处理筛选）
- ✅ 书签热度排行（真实访问追踪 + 总榜/本周/本月）
- ✅ 地址栏 Omnibox 搜索（`sb` keyword）
- ✅ 帮助页 + 整体 UI 精致功能风改版

**计划中**：
- 阅读状态（unread / reading / read）+ 待读清单
- 键盘导航（Popup: j/k；Options: vim 风）
- Saved Searches / 智能合集
- 高亮 / 批注（content script + `highlights[]`）
- AI 对话（基于书签的 RAG）
- 端到端加密的云同步（自建可选后端）
- Firefox 兼容（WebExtensions 差异适配）

## 📜 License

MIT
