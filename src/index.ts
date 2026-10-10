#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ChatGPTClient,
  conversationToMarkdown,
  extractTurns,
  groupRounds,
  parseConversationRef,
  sliceRounds,
  type Conversation,
} from "./chatgpt.js";

const client = new ChatGPTClient();
const server = new McpServer({ name: "chatgpt-conversation-reader", version: "0.1.0" });

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (e: unknown) => ({ ...text(e instanceof Error ? e.message : String(e)), isError: true });

// 长会话可能有几 MB，分段读取时避免重复下载
const cache = new Map<string, { at: number; conv: Conversation }>();
async function fetchConversation(id: string, refresh: boolean): Promise<Conversation> {
  const hit = cache.get(id);
  if (!refresh && hit && Date.now() - hit.at < 5 * 60_000) return hit.conv;
  const conv = await client.getConversation(id);
  cache.set(id, { at: Date.now(), conv });
  return conv;
}

server.registerTool(
  "get_conversation",
  {
    description:
      "读取一个 ChatGPT 会话的内容（当前分支）。ref 可以是 [标题](chatgpt-conversation://<id>)、chatgpt-conversation://<id>、https://chatgpt.com/c/<id> 或会话 UUID。" +
      "长会话默认只返回最后 3 轮（一轮 = 一条用户消息及其回复），可用 start/limit 按轮分段读取，或用 save_to 导出全文到文件。",
    inputSchema: {
      ref: z.string().describe("会话引用或 ID"),
      start: z.number().int().default(-3).describe("从第几轮开始（0 起）；负数表示从末尾倒数，默认 -3"),
      limit: z.number().int().min(1).max(200).default(3).describe("最多返回多少轮，默认 3"),
      format: z.enum(["markdown", "json"]).default("markdown"),
      include_tools: z.boolean().default(false).describe("是否包含工具调用、代码执行等非对话消息"),
      save_to: z.string().optional().describe("把完整会话（忽略 start/limit）写入这个文件路径，只返回摘要"),
      refresh: z.boolean().default(false).describe("忽略 5 分钟缓存，重新拉取"),
    },
  },
  async ({ ref, start, limit, format, include_tools, save_to, refresh }) => {
    const id = parseConversationRef(ref);
    if (!id) return fail(`无法从 "${ref}" 中解析出会话 ID`);
    try {
      const conv = await fetchConversation(id, refresh);
      if (save_to) {
        const body =
          format === "json"
            ? JSON.stringify({ id, title: conv.title, turns: extractTurns(conv, include_tools) }, null, 2)
            : conversationToMarkdown(conv, { includeTools: include_tools });
        await writeFile(save_to, body, "utf8");
        const n = groupRounds(extractTurns(conv, include_tools)).length;
        return text(`已保存「${conv.title}」到 ${save_to}（${n} 轮，${body.length} 字符）`);
      }
      if (format === "json") {
        const s = sliceRounds(conv, { includeTools: include_tools, start, limit });
        return text(
          JSON.stringify(
            { id, title: conv.title, total_rounds: s.total, start: s.start, end: s.end, rounds: s.rounds },
            null,
            2,
          ),
        );
      }
      return text(conversationToMarkdown(conv, { includeTools: include_tools, start, limit }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "search_conversations",
  {
    description: "按关键词搜索 ChatGPT 会话（与桌面 App 的 @ 引用搜索使用同一接口），返回标题和可直接引用的链接。",
    inputSchema: { query: z.string().min(1) },
  },
  async ({ query }) => {
    try {
      const r = await client.searchConversations(query);
      const lines = (r.items ?? []).map((i) => `- [${i.title}](chatgpt-conversation://${i.conversation_id})`);
      return text(lines.length ? lines.join("\n") : "没有找到匹配的会话");
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_recent_conversations",
  {
    description: "列出最近更新的 ChatGPT 会话。",
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    },
  },
  async ({ limit, offset }) => {
    try {
      const r = await client.listConversations(limit, offset);
      const lines = (r.items ?? []).map((i) => `- [${i.title}](chatgpt-conversation://${i.id})`);
      return text(lines.length ? lines.join("\n") : "没有会话");
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
