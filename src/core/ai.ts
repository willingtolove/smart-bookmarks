// 轻量 AI 客户端：兼容 OpenAI 风格 Chat Completions 与 Embeddings 接口
// 便于切换 OpenAI / DeepSeek / 自定义 OpenAI 兼容端点
import type { Settings } from '../types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormatJson?: boolean;
}

/** 检测结果统一信封 */
export interface PingResult {
  ok: boolean;
  error?: string;
  httpStatus?: number;
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export class AiClient {
  constructor(private settings: Settings['ai']) {}

  private get endpoint() {
    return this.settings.baseUrl.replace(/\/$/, '');
  }

  private headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.settings.apiKey}`,
    };
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}) {
    if (!this.settings.enabled) throw new Error('AI 未启用');
    if (!this.settings.apiKey) throw new Error('缺少 API Key');

    const body: Record<string, unknown> = {
      model: this.settings.model,
      messages,
      temperature: opts.temperature ?? 0.2,
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.responseFormatJson) body.response_format = { type: 'json_object' };

    const res = await fetch(`${this.endpoint}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI 请求失败 ${res.status}: ${text}`);
    }
    const data = (await res.json()) as {
      choices?: { message: { content: string } }[];
    };
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  }

  async embed(text: string): Promise<number[]> {
    if (!this.settings.enabled) throw new Error('AI 未启用');
    if (!this.settings.apiKey) throw new Error('缺少 API Key');
    const model = this.settings.embedModel || 'text-embedding-3-small';
    const res = await fetch(`${this.endpoint}/embeddings`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model, input: text }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Embedding 请求失败 ${res.status}: ${text}`);
    }
    const data = (await res.json()) as { data?: { embedding: number[] }[] };
    return data.data?.[0]?.embedding ?? [];
  }

  /**
   * 可用性检测：复用同一 endpoint / headers，但 body 最小化
   * 不要求 settings.enabled（用户在配置阶段尚未勾选）
   * 仅校验 apiKey 非空
   */
  async pingChat(): Promise<PingResult> {
    if (!this.settings.apiKey) return { ok: false, error: '缺少 API Key' };
    if (!this.settings.model) return { ok: false, error: 'Chat 模型为空' };
    const url = `${this.endpoint}/chat/completions`;
    const body = JSON.stringify({
      model: this.settings.model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      temperature: 0,
    });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body,
      });
      if (!res.ok) {
        const text = await res.text();
        console.error('[pingChat] failed', {
          url,
          model: this.settings.model,
          status: res.status,
          body: text,
        });
        return { ok: false, httpStatus: res.status, error: truncate(text, 200) };
      }
      return { ok: true };
    } catch (e) {
      console.error('[pingChat] network error', { url, model: this.settings.model, error: errorMessage(e) });
      return { ok: false, error: errorMessage(e) };
    }
  }

  async pingEmbed(): Promise<PingResult> {
    if (!this.settings.apiKey) return { ok: false, error: '缺少 API Key' };
    if (!this.settings.embedModel) return { ok: false, error: 'Embedding 模型为空，已跳过' };
    const url = `${this.endpoint}/embeddings`;
    const body = JSON.stringify({ model: this.settings.embedModel, input: 'a' });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body,
      });
      if (!res.ok) {
        const text = await res.text();
        console.error('[pingEmbed] failed', {
          url,
          model: this.settings.embedModel,
          status: res.status,
          body: text,
        });
        return { ok: false, httpStatus: res.status, error: truncate(text, 200) };
      }
      return { ok: true };
    } catch (e) {
      console.error('[pingEmbed] network error', { url, model: this.settings.embedModel, error: errorMessage(e) });
      return { ok: false, error: errorMessage(e) };
    }
  }

  /**
   * 总结 + 分类 + 标签，返回 JSON
   */
  async classifyAndSummarize(args: {
    title: string;
    url: string;
    content: string;
    languageHint?: string;
  }): Promise<{
    summary: string;
    category: string;
    tags: string[];
    language: string;
  }> {
    const sys: ChatMessage = {
      role: 'system',
      content:
        '你是书签整理助手。根据用户提供的网页标题、URL 与正文片段，输出严格的 JSON 字段：' +
        '{"summary": "中文一句话摘要", "category": "最贴切的分类名（短词，如 编程/设计/新闻/购物/学术/工具/生活/其他）",' +
        ' "tags": ["最多5个短标签"], "language": "主语言代码，如 zh/en"}。只输出 JSON。',
    };
    const user: ChatMessage = {
      role: 'user',
      content: `Title: ${args.title}\nURL: ${args.url}\nLanguage hint: ${args.languageHint ?? 'auto'}\n\nContent (truncated):\n${args.content.slice(0, 4000)}`,
    };
    const text = await this.chat([sys, user], { responseFormatJson: true, temperature: 0.2 });
    try {
      const json = JSON.parse(text);
      return {
        summary: String(json.summary ?? ''),
        category: String(json.category ?? '其他'),
        tags: Array.isArray(json.tags) ? json.tags.map(String).slice(0, 5) : [],
        language: String(json.language ?? 'auto'),
      };
    } catch {
      // 容错：尝试抽取 JSON
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return JSON.parse(m[0]);
        } catch {
          /* ignore */
        }
      }
      return { summary: text.slice(0, 200), category: '其他', tags: [], language: 'auto' };
    }
  }
}
