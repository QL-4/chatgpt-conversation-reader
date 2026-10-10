import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetch, ProxyAgent, type Dispatcher, type Response } from "undici";

/** 项目根目录下的 config.json，例如 { "proxy": "http://127.0.0.1:7890" } */
const CONFIG_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "config.json");

export interface Config {
  proxy?: string;
}

export function loadConfig(file = CONFIG_FILE): Config {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Config;
  } catch {
    return {};
  }
}

/** 代理优先级：CHATGPT_PROXY 环境变量 > config.json 的 proxy > HTTPS_PROXY 环境变量；都没有则直连。 */
export function resolveProxy(env: NodeJS.ProcessEnv = process.env, config: Config = loadConfig()): string | undefined {
  return env.CHATGPT_PROXY || config.proxy || env.HTTPS_PROXY || env.https_proxy || undefined;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * 从各种引用形式中提取会话 ID：
 * - [标题](chatgpt-conversation://<id>)
 * - chatgpt-conversation://<id>
 * - https://chatgpt.com/c/<id>、https://chatgpt.com/g/<gpt>/c/<id>
 * - 纯 UUID
 */
export function parseConversationRef(ref: string): string | null {
  const s = ref.trim();
  const scheme = /chatgpt-conversation:\/\/([^\s)\]]+)/i.exec(s);
  if (scheme) return matchUuid(decodeURIComponent(scheme[1]));
  const web = /chatgpt\.com(?:\/g\/[^/\s]+)?\/c\/([^/?#\s)\]]+)/i.exec(s);
  if (web) return matchUuid(web[1]);
  return matchUuid(s);
}

function matchUuid(s: string): string | null {
  const m = UUID.exec(s);
  return m ? m[0].toLowerCase() : null;
}

export interface Auth {
  token: string;
  accountId?: string;
}

/** 读取认证信息，每次请求都重新读，token 更新后无需重启。优先级：
 *  1. CHATGPT_ACCESS_TOKEN
 *  2. CHATGPT_TOKEN_FILE
 *  3. 默认 ~/.codex/auth.json（Codex 登录后自动维护）
 *  文件内容可以是裸 token、/api/auth/session 的 JSON，或 Codex 的 auth.json。 */
export function loadAuth(env: NodeJS.ProcessEnv = process.env): Auth {
  let raw = env.CHATGPT_ACCESS_TOKEN ?? "";
  if (!raw) {
    const file = env.CHATGPT_TOKEN_FILE ?? join(homedir(), ".codex", "auth.json");
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      raw = "";
    }
  }
  const auth = parseAuth(raw);
  if (!auth.token) {
    throw new Error(
      "缺少 accessToken：请先登录 Codex（生成 ~/.codex/auth.json），或设置 CHATGPT_TOKEN_FILE / CHATGPT_ACCESS_TOKEN",
    );
  }
  return { token: auth.token, accountId: env.CHATGPT_ACCOUNT_ID || auth.accountId };
}

export function parseAuth(raw: string): Auth {
  const s = raw.trim();
  if (!s.startsWith("{")) return { token: s.replace(/^Bearer\s+/i, "") };
  const j = JSON.parse(s);
  // Codex auth.json: { tokens: { access_token, account_id } }；session JSON: { accessToken, account: { id } }
  return {
    token: String(j.tokens?.access_token ?? j.accessToken ?? ""),
    accountId: j.tokens?.account_id ?? j.account?.id ?? undefined,
  };
}

/** 网络层错误（连接重置、超时等）重试，HTTP 错误码不重试。 */
async function fetchWithRetry(
  url: URL,
  headers: Record<string, string>,
  dispatcher: Dispatcher | undefined,
  retries = 2,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, { headers, dispatcher });
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

export class ChatGPTClient {
  private readonly dispatcher: Dispatcher | undefined;

  constructor(
    private readonly getAuth: () => Auth = () => loadAuth(),
    private readonly baseUrl = process.env.CHATGPT_BASE_URL ?? "https://chatgpt.com/backend-api",
    proxy: string | undefined = resolveProxy(),
  ) {
    this.dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  }

  private async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const auth = this.getAuth();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.token}`,
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
    };
    if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
    const res = await fetchWithRetry(url, headers, this.dispatcher);
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      const hint =
        res.status === 401
          ? "（token 无效或已过期：打开一次 Codex 让它刷新 auth.json，或重新获取 token）"
          : res.status === 403
            ? "（可能被 Cloudflare 拦截，或会话属于其他账号/工作区，可设置 CHATGPT_ACCOUNT_ID）"
            : res.status === 404
              ? "（会话不存在或无权访问）"
              : "";
      throw new Error(`GET ${url.pathname} 失败: ${res.status}${hint} ${body}`);
    }
    return (await res.json()) as T;
  }

  getConversation(id: string) {
    return this.get<Conversation>(`/conversation/${encodeURIComponent(id)}`);
  }

  searchConversations(query: string, cursor?: string) {
    return this.get<{ items: { conversation_id: string; title: string }[]; cursor?: string | null }>(
      "/conversations/search",
      { query, cursor },
    );
  }

  listConversations(limit = 20, offset = 0) {
    return this.get<{ items: { id: string; title: string; update_time?: string | number }[]; total?: number }>(
      "/conversations",
      { limit, offset, order: "updated" },
    );
  }
}

// ---------- 会话结构与转换 ----------

export interface Conversation {
  conversation_id?: string;
  id?: string;
  title?: string;
  create_time?: number;
  update_time?: number;
  current_node?: string;
  mapping: Record<string, MappingNode>;
}

interface MappingNode {
  id: string;
  parent?: string | null;
  children?: string[];
  message?: Message | null;
}

interface Message {
  id: string;
  author: { role: string; name?: string | null };
  create_time?: number | null;
  content: { content_type: string; parts?: unknown[]; text?: string; language?: string };
  metadata?: Record<string, unknown>;
  recipient?: string;
}

export interface TurnOut {
  role: string;
  name?: string;
  contentType: string;
  text: string;
  createTime?: number;
}

/** 沿 current_node 回溯到根，得到当前显示的这条分支（与网页上看到的一致）。 */
export function currentBranch(conv: Conversation): Message[] {
  let nodeId = conv.current_node ?? findLeaf(conv.mapping);
  const out: Message[] = [];
  const seen = new Set<string>();
  while (nodeId && !seen.has(nodeId)) {
    seen.add(nodeId);
    const node = conv.mapping[nodeId];
    if (!node) break;
    if (node.message) out.push(node.message);
    nodeId = node.parent ?? undefined;
  }
  return out.reverse();
}

function findLeaf(mapping: Record<string, MappingNode>): string | undefined {
  const root = Object.values(mapping).find((n) => !n.parent);
  let cur = root;
  while (cur?.children?.length) cur = mapping[cur.children[cur.children.length - 1]];
  return cur?.id;
}

const VISIBLE_TYPES = new Set(["text", "multimodal_text"]);

export function extractTurns(conv: Conversation, includeTools = false): TurnOut[] {
  const turns: TurnOut[] = [];
  for (const m of currentBranch(conv)) {
    const role = m.author.role;
    const meta = m.metadata ?? {};
    if (role === "system" || meta.is_visually_hidden_from_conversation) continue;
    const type = m.content.content_type;
    const isTool = role === "tool" || !VISIBLE_TYPES.has(type) || (m.recipient && m.recipient !== "all");
    if (isTool && !includeTools) continue;
    const text = contentToText(m.content).trim();
    if (!text) continue;
    turns.push({
      role,
      name: m.author.name ?? undefined,
      contentType: type,
      text,
      createTime: m.create_time ?? undefined,
    });
  }
  return turns;
}

function contentToText(c: Message["content"]): string {
  if (typeof c.text === "string") return c.language ? fence(c.text, c.language) : c.text;
  if (!Array.isArray(c.parts)) return "";
  return c.parts
    .map((p) => {
      if (typeof p === "string") return p;
      if (p && typeof p === "object") {
        const o = p as Record<string, unknown>;
        if (typeof o.text === "string") return o.text;
        if (typeof o.content === "string") return o.content;
        if (typeof o.asset_pointer === "string") return `[附件: ${o.asset_pointer}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function fence(text: string, lang: string): string {
  return "```" + (lang === "unknown" ? "" : lang) + "\n" + text + "\n```";
}

/** 把消息按“轮”分组：每轮从一条用户消息开始，包含其后的所有回复。 */
export function groupRounds(turns: TurnOut[]): TurnOut[][] {
  const rounds: TurnOut[][] = [];
  for (const t of turns) {
    if (t.role === "user" || rounds.length === 0) rounds.push([t]);
    else rounds[rounds.length - 1].push(t);
  }
  return rounds;
}

export interface RoundSlice {
  total: number;
  start: number;
  end: number;
  rounds: TurnOut[][];
}

/** start 为轮次下标（0 起），负数表示从末尾倒数；limit 为最多返回的轮数。 */
export function sliceRounds(conv: Conversation, opts: RoundOptions = {}): RoundSlice {
  const all = groupRounds(extractTurns(conv, opts.includeTools));
  const total = all.length;
  let start = opts.start ?? 0;
  if (start < 0) start = Math.max(0, total + start);
  start = Math.min(start, total);
  const end = opts.limit === undefined ? total : Math.min(total, start + opts.limit);
  return { total, start, end, rounds: all.slice(start, end) };
}

export interface RoundOptions {
  includeTools?: boolean;
  /** 从第几轮开始（0 起），负数表示从末尾倒数 */
  start?: number;
  /** 最多返回多少轮 */
  limit?: number;
}

export function conversationToMarkdown(conv: Conversation, opts: RoundOptions = {}): string {
  const id = conv.conversation_id ?? conv.id ?? "";
  const { total, start, end, rounds } = sliceRounds(conv, opts);

  const lines = [`# ${conv.title ?? "Untitled"}`, ""];
  if (id) lines.push(`- 会话: https://chatgpt.com/c/${id}`);
  if (conv.update_time) lines.push(`- 更新时间: ${formatTime(conv.update_time)}`);
  if (start > 0 || end < total) lines.push(`- 轮次: 第 ${start}–${end - 1} 轮，共 ${total} 轮`);
  lines.push("");
  if (start > 0) lines.push(`…… 前面还有 ${start} 轮，可用 start=${Math.max(0, start - (opts.limit ?? start))} 往前读取`, "");
  for (const round of rounds) {
    for (const t of round) {
      const who = t.role === "user" ? "User" : t.role === "assistant" ? "ChatGPT" : t.name ? `${t.role}:${t.name}` : t.role;
      lines.push(`## ${who}`, "", t.text, "");
    }
  }
  if (end < total) lines.push(`…… 后面还有 ${total - end} 轮，可用 start=${end} 继续读取`);
  return lines.join("\n");
}

function formatTime(t: number | string): string {
  const d = typeof t === "number" ? new Date(t * 1000) : new Date(t);
  return isNaN(d.getTime()) ? String(t) : d.toISOString();
}
