# cf-workers-wechat-gpt
简单的利用cloudflare workers接入微信公众号GPT自动回答

### 1. 使用 Cloudflare Worker 变量
你需要在 **Cloudflare Workers 的 Environment Variables（环境变量）** 中配置：

| 变量名 | 作用     |
| ------|-----------|
| `WECHAT_TOKEN` | 公众号 Token，用于校验请求合法性 |
| `WELCOME_MESSAGE`| 订阅时自动回复欢迎语 |
| `USE_OPENAI` | `true` 使用 OpenAI，`false` 使用 Gemini|
| `OPENAI_API_KEY` | OpenAI API Key |
| `OPENAI_BASE_URL` | OpenAI API Base URL（支持代理）|
| `OPENAI_MODEL` | OpenAI 选择的模型，例如 gpt-4-turbo |
| `OPENAI_SYSTEM_PROMPT` | 预置角色 Prompt |
| `GEMINI_API_KEY` | Gemini API Key |
| `GEMINI_MODEL` | Gemini 选择的模型，例如 gemini-2.0-flash-lite |
| `AI_CHAT_HISTORY` | 使用chat时，需要配置 cf KV存储 |

**如何设置？**
1. 进入 Cloudflare Workers -> 选择你的 Worker -> Settings（设置）。
2. 进入 Environment Variables（环境变量）。
3. 添加以上变量，然后点击保存。










