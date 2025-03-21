# cf-workers-wechat-gpt

利用 Cloudflare Workers 接入微信公众号，实现 AI 自动回复功能（支持 OpenAI 和 Gemini）。

## 功能特点

- 微信公众号消息自动回复
- 支持 OpenAI 和 Gemini AI 模型
- 支持会话历史记录功能
- 防爬虫和请求验证
- 无需服务器，使用 Cloudflare Workers 部署

## 部署步骤

### 1. 准备工作

1. 注册 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)
2. 创建一个新的 Worker
3. 获取微信公众号开发者信息
4. 准备 OpenAI 或 Gemini API 密钥

### 2. 配置 KV 存储

1. 在 Cloudflare Workers 控制台创建一个 KV 命名空间（用于存储聊天历史）
2. 命名为 `AI_CHAT_HISTORY` 或自定义名称
3. 将 KV 命名空间绑定到你的 Worker

### 3. 配置环境变量

你需要在 **Cloudflare Workers 的 Environment Variables（环境变量）** 中配置：

| 变量名 | 作用 | 必填 |
| ------ | ----- | ----- |
| `WECHAT_TOKEN` | 公众号 Token，用于校验请求合法性 | ✅ |
| `WELCOME_MESSAGE` | 订阅时自动回复欢迎语 | ❌ |
| `USE_OPENAI` | `true` 使用 OpenAI，`false` 使用 Gemini | ✅ |
| `OPENAI_API_KEY` | OpenAI API Key | 使用 OpenAI 时必填 |
| `OPENAI_BASE_URL` | OpenAI API Base URL（支持代理） | 使用 OpenAI 时必填 |
| `OPENAI_MODEL` | OpenAI 选择的模型，例如 `gpt-4-turbo` | 使用 OpenAI 时必填 |
| `OPENAI_SYSTEM_PROMPT` | 预置角色 Prompt | ❌ |
| `GEMINI_API_KEY` | Gemini API Key | 使用 Gemini 时必填 |
| `GEMINI_MODEL` | Gemini 选择的模型，例如 `gemini-2.0-flash-lite` | 使用 Gemini 时必填 |
| `GEMINI_SYSTEM_PROMPT` | Gemini 预置角色 Prompt | ❌ |
| `CHAT_HISTORY_LIMIT` | 对话历史记录保存条数，默认为 2 | ❌ |
| `UNSUPPORTED_MESSAGE` | 收到不支持类型消息的回复 | ❌ |
| `AI_CHAT_HISTORY` | 聊天历史记录 KV 存储绑定名称 | ✅ |

**如何设置环境变量？**
1. 进入 Cloudflare Workers -> 选择你的 Worker -> Settings（设置）
2. 进入 Environment Variables（环境变量）
3. 添加以上变量，然后点击保存

### 4. 部署代码

1. 将 `worker.js` 代码复制到 Cloudflare Worker 编辑器中
2. 点击部署
3. 将 Worker 生成的 URL 配置到微信公众号后台开发者设置中

## 微信公众号配置

1. 登录微信公众平台
2. 进入"设置与开发" -> "基本配置"
3. 填写服务器配置：
   - URL: 填写 Worker 的 URL
   - Token: 填写与环境变量中 `WECHAT_TOKEN` 相同的值
   - 消息加密方式: 明文模式
4. 启用配置

## 注意事项

- 确保 KV 存储已正确绑定，否则会话历史功能无法使用
- 对于高流量公众号，请考虑 Cloudflare Workers 的使用限制
- AI 接口可能存在访问限制，请确保 API Key 有效

## 相关链接

- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [微信公众平台开发者文档](https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html)
- [OpenAI API 文档](https://platform.openai.com/docs/api-reference)
- [Gemini API 文档](https://ai.google.dev/docs)










