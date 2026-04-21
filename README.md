# cf-workers-wechat-gpt

利用 Cloudflare Workers 接入微信公众号，实现 AI 自动回复功能（支持 OpenAI、Gemini、Workers AI）。

## 一键部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Zbun/cf-workers-wechat-gpt)

点击按钮后：
1. 授权 Cloudflare 访问 GitHub
2. Fork 仓库并自动部署
3. 在 Worker 设置中配置环境变量

## 环境变量

在 **Cloudflare Workers → 你的 Worker → Settings → Variables and Secrets** 中配置：

| 变量名 | 作用 | 必填 |
| ------ | ----- | ----- |
| `WECHAT_TOKEN` | 公众号 Token | ✅ |
| `AI_PROVIDER` | AI 提供方：`openai` / `gemini` / `workers-ai` | ❌ |
| `AI_TIMEOUT_MS` | AI 请求超时预算，默认 `4500` 毫秒 | ❌ |
| `AI_TIMEOUT_REPLY` | 超时后的兜底回复文案 | ❌ |
| `USE_OPENAI` | `0` 使用 Gemini，默认使用 OpenAI | ❌ |
| `OPENAI_API_KEY` | OpenAI API Key | 使用 OpenAI 时 |
| `OPENAI_MODEL` | OpenAI 模型，如 `gpt-4-turbo` | 使用 OpenAI 时 |
| `OPENAI_BASE_URL` | OpenAI 代理地址（如 OpenRouter） | ❌ |
| `OPENAI_SYSTEM_PROMPT` | OpenAI 系统提示词 | ❌ |
| `GEMINI_API_KEY` | Gemini API Key | 使用 Gemini 时 |
| `GEMINI_MODEL` | Gemini 模型，如 `gemini-2.0-flash-lite` | 使用 Gemini 时 |
| `GEMINI_SYSTEM_PROMPT` | Gemini 系统提示词 | ❌ |
| `CF_AI_MODEL` | Workers AI 模型，默认 `@cf/meta/llama-3.1-8b-instruct-fast` | 使用 Workers AI 时 |
| `CF_AI_MAX_TOKENS` | Workers AI 最大输出 token 数 | ❌ |
| `CF_AI_TEMPERATURE` | Workers AI temperature | ❌ |
| `CF_AI_GATEWAY_ID` | 可选，AI Gateway 名称 | ❌ |
| `CF_AI_GATEWAY_SKIP_CACHE` | `1` 表示跳过 AI Gateway 缓存 | ❌ |
| `CF_AI_GATEWAY_CACHE_TTL` | AI Gateway 缓存秒数 | ❌ |
| `WELCOME_MESSAGE` | 关注时的欢迎语 | ❌ |
| `UNSUPPORTED_MESSAGE` | 不支持消息类型的回复 | ❌ |

## 微信公众号配置

1. 登录微信公众平台 → 设置与开发 → 基本配置
2. 服务器配置：
   - **URL**: Worker 的 URL（如 `https://xxx.workers.dev/api/wechat`）
   - **Token**: 与 `WECHAT_TOKEN` 相同
   - **加密方式**: 明文模式
3. 启用配置

## 会话历史

使用 **KV + 内存混合缓存** 存储会话历史：
- 保留最近 **4 条消息**（2轮对话）
- 内存缓存 **10 分钟**自动过期
- 每 2 条消息写入一次 KV（减少配额消耗）

### KV 配置（可选但推荐）

在 **Cloudflare Workers → 你的 Worker → Settings → Bindings** 中添加 KV 绑定：

| 绑定名称 | 说明 |
|---------|------|
| `AI_CHAT_HISTORY` | 用于持久化会话历史 |

> 💡 **说明**：不配置 KV 时仍可使用，但历史记录仅在内存中保存，Worker 实例重启后丢失。

## Workers AI 配置

如果希望直接走 Cloudflare 原生推理，建议配置：

```toml
[ai]
binding = "AI"
```

然后在 Worker 环境变量中设置：

```env
AI_PROVIDER=workers-ai
CF_AI_MODEL=@cf/meta/llama-3.1-8b-instruct-fast
AI_TIMEOUT_MS=4500
```

如果还要接入 AI Gateway 观察流量、做缓存或路由，再额外设置：

```env
CF_AI_GATEWAY_ID=your-gateway-name
```

说明：
- `Workers AI` 可能比通过 OpenRouter 再转发更快，因为少了一层外部网关跳转。
- `AI Gateway` 主要提供观测、缓存和路由，不保证单次推理更快。
- 当前代码会在超时预算内等 AI 返回；超时后直接回复兜底文案，避免公众号请求卡过 5 秒。

## 相关链接

- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [Cloudflare Workers AI 文档](https://developers.cloudflare.com/workers-ai/)
- [Cloudflare AI Gateway 文档](https://developers.cloudflare.com/ai-gateway/)
- [微信公众平台开发者文档](https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html)
- [OpenAI API 文档](https://platform.openai.com/docs/api-reference)
- [Gemini API 文档](https://ai.google.dev/docs)
