# cf-workers-wechat-gpt
简单的利用cloudflare workers接入微信公众号GPT自动回答

## 1. 使用 Cloudflare Worker 变量
你需要在 **Cloudflare Workers 的 Environment Variables（环境变量）** 中配置：

| 变量名 | 作用     |
| ------|-----------|
| `WECHAT_TOKEN` | 公众号 Token，用于校验请求合法性 |
