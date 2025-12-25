# cf-workers-wechat-gpt

利用 Cloudflare Workers 接入微信公众号，实现 AI 自动回复功能（支持 OpenAI 和 Gemini）。

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
| `USE_OPENAI` | `1` 使用 OpenAI，`0` 使用 Gemini | ✅ |
| `OPENAI_API_KEY` | OpenAI API Key | 使用 OpenAI 时 |
| `OPENAI_MODEL` | OpenAI 模型，如 `gpt-4-turbo` | 使用 OpenAI 时 |
| `OPENAI_BASE_URL` | OpenAI 代理地址 | ❌ |
| `OPENAI_SYSTEM_PROMPT` | OpenAI 系统提示词 | ❌ |
| `GEMINI_API_KEY` | Gemini API Key | 使用 Gemini 时 |
| `GEMINI_MODEL` | Gemini 模型，如 `gemini-2.0-flash-lite` | 使用 Gemini 时 |
| `GEMINI_SYSTEM_PROMPT` | Gemini 系统提示词 | ❌ |
| `WELCOME_MESSAGE` | 关注时的欢迎语 | ❌ |
| `CHAT_HISTORY_LIMIT` | 历史记录条数（默认 2） | ❌ |
| `UNSUPPORTED_MESSAGE` | 不支持消息类型的回复 | ❌ |

## 微信公众号配置

1. 登录微信公众平台 → 设置与开发 → 基本配置
2. 服务器配置：
   - **URL**: Worker 的 URL/api/wechat
   - **Token**: 与 `WECHAT_TOKEN` 相同
   - **加密方式**: 明文模式
3. 启用配置

## 会话历史（可选）

需要 KV 存储支持：

1. Workers 控制台 → Storage & Databases → KV → 创建命名空间
2. 复制命名空间的 ID
3. 在 `wrangler.toml` 中配置 KV 绑定：
   ```toml
   kv_namespaces = [
     { binding = "AI_CHAT_HISTORY", id = "你的KV命名空间ID" }
   ]
   ```

> 💡 **提示**：通过 `wrangler.toml` 配置 KV 绑定可实现持久化，避免每次部署后需要手动重新绑定。

## 相关链接

- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [微信公众平台开发者文档](https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html)
- [OpenAI API 文档](https://platform.openai.com/docs/api-reference)
- [Gemini API 文档](https://ai.google.dev/docs)
