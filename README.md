# chatgpt-conversation-reader

一个 MCP server，用来读取 ChatGPT 会话内容。它能识别 ChatGPT / Codex 桌面 App 里 `@` 引用会话时生成的链接：

```markdown
[示例会话](chatgpt-conversation://00000000-0000-0000-0000-000000000000)
```

把这种链接交给支持 MCP 的客户端（Trae、Claude、Codex 等），就能直接读到对应会话的内容。

> 本项目调用的是 ChatGPT 网页端未公开的内部接口，可能随时变化，也不是官方支持的用法。请只读取你自己账号下的会话。

## 工具

| 工具 | 作用 |
|---|---|
| `get_conversation` | 读取一个会话（当前分支），默认返回最后 3 轮 |
| `search_conversations` | 按关键词搜索会话，返回可直接引用的 `chatgpt-conversation://` 链接 |
| `list_recent_conversations` | 列出最近更新的会话 |

### get_conversation 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `ref` | 必填 | `[标题](chatgpt-conversation://<id>)`、`chatgpt-conversation://<id>`、`https://chatgpt.com/c/<id>` 或会话 UUID |
| `start` | `-3` | 从第几轮开始（0 起）；负数表示从末尾倒数 |
| `limit` | `3` | 最多返回多少轮（1–200） |
| `format` | `markdown` | `markdown` 或 `json` |
| `include_tools` | `false` | 是否包含工具调用、代码执行等非对话消息 |
| `save_to` | — | 把完整会话写入这个文件路径（忽略 `start` / `limit`），只返回摘要 |
| `refresh` | `false` | 忽略 5 分钟缓存，重新拉取 |

一轮 = 一条用户消息加上它后面的所有回复。返回内容只读当前显示的分支，被重新生成替换掉的旧回答不会出现。读取中间一段时，开头和结尾会提示怎么往前、往后翻。

## 安装

需要 Node.js 20.18 以上（依赖 undici 7）。

```bash
npm install
npm run build
```

## 配置

### 1. 认证

默认读取 Codex 的登录文件 `~/.codex/auth.json`，里面的 token 由 Codex 自动刷新。只要在本机登录过 Codex（桌面 App 或 CLI），就不需要额外配置。

也可以用环境变量覆盖，优先级从高到低：

| 环境变量 | 说明 |
|---|---|
| `CHATGPT_ACCESS_TOKEN` | 直接给 token，可带 `Bearer ` 前缀 |
| `CHATGPT_TOKEN_FILE` | token 文件路径，内容可以是裸 token、`https://chatgpt.com/api/auth/session` 返回的 JSON，或 Codex 的 auth.json |
| `CHATGPT_ACCOUNT_ID` | 会话在团队工作区时需要，默认从认证文件里读取 |

token 每次请求都会重新读取，更新后不需要重启 server。

### 2. 代理

如果直连 chatgpt.com 不通，复制模板并填入你的代理地址：

```bash
cp config.example.json config.json
```

```json
{
  "proxy": "http://127.0.0.1:7890"
}
```

`config.json` 已加入 `.gitignore`。代理的取值顺序：环境变量 `CHATGPT_PROXY` > `config.json` 的 `proxy` > 环境变量 `HTTPS_PROXY`，都没有则直连。

### 3. 接入 MCP 客户端

```json
{
  "mcpServers": {
    "chatgpt-conversation-reader": {
      "command": "node",
      "args": ["<项目绝对路径>/dist/index.js"]
    }
  }
}
```

## 常见错误

| 错误 | 原因与处理 |
|---|---|
| `fetch failed` / 连接超时 | 网络不通，检查代理配置 |
| `401` | token 无效或过期，打开一次 Codex 让它刷新 auth.json，或重新获取 token |
| `403` | 可能被 Cloudflare 拦截，或会话属于其他账号或工作区（设置 `CHATGPT_ACCOUNT_ID`） |
| `404` | 会话不存在或无权访问 |
| 缺少 accessToken | 没有登录 Codex，也没有设置 token 环境变量 |

## 开发

```bash
npm test   # 编译并运行单元测试
```

| 文件 | 内容 |
|---|---|
| `src/chatgpt.ts` | 链接解析、认证、代理、接口请求、会话转 Markdown |
| `src/index.ts` | MCP server 和工具定义 |
| `src/chatgpt.test.ts` | 单元测试（不访问网络） |

### 用到的接口

均为 `https://chatgpt.com/backend-api` 下的内部接口，从 ChatGPT / Codex 桌面 App 的前端代码中找到：

| 接口 | 用途 |
|---|---|
| `GET /conversation/{id}` | 读取会话，返回消息树 `mapping` 和当前节点 `current_node` |
| `GET /conversations/search?query=` | 搜索会话（桌面 App 的 `@` 引用使用同一接口） |
| `GET /conversations?limit&offset&order=updated` | 列出最近会话 |

请求头带 `Authorization: Bearer <accessToken>` 和 `ChatGPT-Account-Id`。

## 许可证

[MIT](LICENSE)
