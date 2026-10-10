import { test } from "node:test";
import assert from "node:assert/strict";
import {
  conversationToMarkdown,
  extractTurns,
  groupRounds,
  loadAuth,
  parseAuth,
  parseConversationRef,
  resolveProxy,
  type Conversation,
} from "./chatgpt.js";

const ID = "12345678-90ab-cdef-1234-567890abcdef";

test("parseConversationRef 支持各种引用形式", () => {
  for (const ref of [
    `[示例会话](chatgpt-conversation://${ID})`,
    `chatgpt-conversation://${ID}`,
    `https://chatgpt.com/c/${ID}`,
    `https://chatgpt.com/g/g-abc-my-gpt/c/${ID}?model=x`,
    ID.toUpperCase(),
  ]) {
    assert.equal(parseConversationRef(ref), ID, ref);
  }
  assert.equal(parseConversationRef("hello"), null);
});

test("resolveProxy 优先级：CHATGPT_PROXY > config.json > HTTPS_PROXY", () => {
  const cfg = { proxy: "http://cfg:1" };
  assert.equal(resolveProxy({ CHATGPT_PROXY: "http://env:1", HTTPS_PROXY: "http://h:1" }, cfg), "http://env:1");
  assert.equal(resolveProxy({ HTTPS_PROXY: "http://h:1" }, cfg), "http://cfg:1");
  assert.equal(resolveProxy({ HTTPS_PROXY: "http://h:1" }, {}), "http://h:1");
  assert.equal(resolveProxy({}, {}), undefined);
});

test("parseAuth / loadAuth 支持裸 token、Bearer、session JSON 和 Codex auth.json", () => {
  assert.deepEqual(parseAuth("Bearer abc"), { token: "abc" });
  assert.deepEqual(parseAuth('{"accessToken":"abc","account":{"id":"acc1"}}'), { token: "abc", accountId: "acc1" });
  assert.deepEqual(parseAuth('{"auth_mode":"chatgpt","tokens":{"access_token":"abc","account_id":"acc2"}}'), {
    token: "abc",
    accountId: "acc2",
  });
  assert.deepEqual(loadAuth({ CHATGPT_ACCESS_TOKEN: "abc", CHATGPT_ACCOUNT_ID: "x" }), { token: "abc", accountId: "x" });
  assert.throws(() => loadAuth({ CHATGPT_TOKEN_FILE: "Z:/not-exist.json" }));
});

// 含一个被重新生成的分支：current_node 指向 a2，a1 不应出现
const conv: Conversation = {
  conversation_id: ID,
  title: "示例会话",
  current_node: "a2",
  mapping: {
    root: { id: "root", parent: null, children: ["sys"] },
    sys: {
      id: "sys",
      parent: "root",
      children: ["u1"],
      message: { id: "sys", author: { role: "system" }, content: { content_type: "text", parts: [""] } },
    },
    u1: {
      id: "u1",
      parent: "sys",
      children: ["a1", "t1"],
      message: { id: "u1", author: { role: "user" }, content: { content_type: "text", parts: ["你好"] } },
    },
    a1: {
      id: "a1",
      parent: "u1",
      children: [],
      message: { id: "a1", author: { role: "assistant" }, content: { content_type: "text", parts: ["旧回答"] } },
    },
    t1: {
      id: "t1",
      parent: "u1",
      children: ["a2"],
      message: {
        id: "t1",
        author: { role: "assistant" },
        recipient: "python",
        content: { content_type: "code", language: "python", text: "print(1)" },
      },
    },
    a2: {
      id: "a2",
      parent: "t1",
      children: [],
      message: { id: "a2", author: { role: "assistant" }, content: { content_type: "text", parts: ["新回答"] } },
    },
  },
};

test("extractTurns 只取当前分支，默认跳过 system 和工具消息", () => {
  assert.deepEqual(
    extractTurns(conv).map((t) => t.text),
    ["你好", "新回答"],
  );
  assert.deepEqual(
    extractTurns(conv, true).map((t) => t.text),
    ["你好", "```python\nprint(1)\n```", "新回答"],
  );
});

test("conversationToMarkdown 输出标题、链接和对话", () => {
  const md = conversationToMarkdown(conv);
  assert.match(md, /^# 示例会话/);
  assert.match(md, new RegExp(`https://chatgpt.com/c/${ID}`));
  assert.match(md, /## User\n\n你好/);
  assert.match(md, /## ChatGPT\n\n新回答/);
  assert.doesNotMatch(md, /旧回答/);
});

test("按轮分组与分段：一轮 = 用户消息 + 其后回复", () => {
  const turns = (rs: string[]) => rs.map((r, i) => ({ role: r, contentType: "text", text: `${r}${i}` }));
  const rounds = groupRounds(turns(["user", "assistant", "user", "assistant", "assistant", "user"]));
  assert.deepEqual(
    rounds.map((r) => r.map((t) => t.text)),
    [["user0", "assistant1"], ["user2", "assistant3", "assistant4"], ["user5"]],
  );

  const last = conversationToMarkdown(conv, { start: -3, limit: 3 });
  assert.doesNotMatch(last, /轮次:/); // 只有 1 轮，全部返回
  assert.match(last, /你好[\s\S]*新回答/);
});
