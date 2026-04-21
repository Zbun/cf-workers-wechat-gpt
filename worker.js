// 混合缓存：key = userId, value = { history, expireAt, kvSnapshot }
// kvSnapshot 记录上次与 KV 同步的序列化结果，用于判断是否需要写回 KV
const chatCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10分钟过期
const MAX_HISTORY_MESSAGES = 4; // 保留最近 4 条消息（2轮对话）
const DEFAULT_AI_TIMEOUT_MS = 4500;
const DEFAULT_CF_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

export default {
  async fetch(request, env, ctx) {
    if (isCrawler(request)) {
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "GET") {
      return handleGetRequest(request, env);
    }

    if (request.method === "POST") {
      return handlePostRequest(request, env, ctx);
    }

    return new Response("Invalid Request", { status: 405 });
  }
};

async function handleGetRequest(request, env) {
  const { searchParams } = new URL(request.url);
  const signature = searchParams.get("signature");
  const timestamp = searchParams.get("timestamp");
  const nonce = searchParams.get("nonce");
  const echostr = searchParams.get("echostr");

  if (!isTimestampValid(timestamp, 300)) {
    console.warn(`Invalid timestamp: ${timestamp}`);
    return new Response("Invalid timestamp", { status: 403 });
  }

  if (await checkSignature(signature, timestamp, nonce, env.WECHAT_TOKEN)) {
    return new Response(echostr, { status: 200 });
  }
  return new Response("Invalid signature", { status: 403 });
}

async function handlePostRequest(request, env, ctx) {
  const text = await request.text();
  const msg = parseXML(text);
  if (!msg) return new Response("Invalid XML", { status: 400 });

  let reply;

  if (msg.MsgType === "event" && msg.Event.toLowerCase() === "subscribe") {
    reply = env.WELCOME_MESSAGE || "感谢关注！我是基于 AI 的智能助手，可以回答您的各种问题。";
  } else if (msg.MsgType === "text") {
    const userMsg = msg.Content;
    const fromUserName = msg.FromUserName;

    // 混合读取：内存优先，未命中从 KV 加载
    const conversationHistory = await getHistoryHybrid(fromUserName, env.AI_CHAT_HISTORY);
    const provider = resolveAIProvider(env);

    try {
      reply = await withTimeout(
        chatWithProvider(provider, userMsg, env, conversationHistory),
        getAITimeoutMs(env),
        getTimeoutReply(env)
      );
    } catch (error) {
      console.error("AI Error:", error);
      reply = `AI 处理失败: ${error.message || "未知错误"}`;
    }

    // 混合写入：更新内存缓存，条件写入 KV（不阻塞响应）
    updateHistoryHybrid(fromUserName, userMsg, reply, env.AI_CHAT_HISTORY, ctx);
  } else {
    reply = env.UNSUPPORTED_MESSAGE || "目前仅支持文字消息哦！";
  }

  const responseXML = formatXMLReply(msg.FromUserName, msg.ToUserName, reply);
  return new Response(responseXML, {
    headers: { "Content-Type": "application/xml" }
  });
}

// -------- 混合缓存操作 --------

// 混合读取：内存优先，未命中从 KV 加载
async function getHistoryHybrid(userId, kvNamespace) {
  const cached = chatCache.get(userId);

  // 内存命中且未过期
  if (cached && cached.expireAt > Date.now()) {
    return cached.history;
  }

  // 内存未命中或已过期，尝试从 KV 读取
  chatCache.delete(userId);

  if (kvNamespace) {
    try {
      const kvData = await kvNamespace.get(userId);
      if (kvData) {
        const history = JSON.parse(kvData);
        if (Array.isArray(history)) {
          // 加载到内存缓存，记录当前 KV 快照，避免重复写入相同内容
          chatCache.set(userId, {
            history,
            expireAt: Date.now() + CACHE_TTL,
            kvSnapshot: kvData
          });
          return history;
        }
      }
    } catch (error) {
      console.warn("KV 读取失败:", error);
    }
  }

  return [];
}

// 混合写入：立即更新内存，条件写入 KV
function updateHistoryHybrid(userId, userMsg, assistantReply, kvNamespace, ctx) {
  const cached = chatCache.get(userId);
  let history = cached ? [...cached.history] : [];
  const kvSnapshot = cached?.kvSnapshot || null;

  // 添加新对话
  history.push({ role: "user", content: userMsg });
  history.push({ role: "assistant", content: assistantReply });

  // 保留最近 MAX_HISTORY_MESSAGES 条消息
  if (history.length > MAX_HISTORY_MESSAGES) {
    history = history.slice(-MAX_HISTORY_MESSAGES);
  }

  // 更新内存缓存
  chatCache.set(userId, {
    history,
    expireAt: Date.now() + CACHE_TTL,
    kvSnapshot
  });

  // 只在内容实际变化时写回 KV，避免因为固定长度裁剪导致后续不再落盘
  const serializedHistory = JSON.stringify(history);
  if (kvNamespace && serializedHistory !== kvSnapshot) {
    const writePromise = kvNamespace.put(userId, serializedHistory)
      .then(() => {
        // 写入成功后更新最新快照
        const current = chatCache.get(userId);
        if (current) {
          current.kvSnapshot = serializedHistory;
        }
      })
      .catch(err => console.error("KV 写入失败:", err));

    // 异步执行，不阻塞响应
    if (ctx?.waitUntil) {
      ctx.waitUntil(writePromise);
    }
  }

  // 清理过期缓存
  cleanExpiredCache();
}

function cleanExpiredCache() {
  const now = Date.now();
  for (const [userId, cached] of chatCache.entries()) {
    if (cached.expireAt <= now) {
      chatCache.delete(userId);
    }
  }
}

// -------- 辅助函数 --------

function isCrawler(request) {
  const userAgent = request.headers.get("User-Agent") || "";
  const referer = request.headers.get("Referer") || "";

  const forbiddenAgents = [
    "curl", "wget", "python", "scrapy", "bot", "spider", "crawl",
    "httpclient", "java", "okhttp", "axios", "node-fetch", "postman",
    "insomnia", "httpie", "aiohttp", "go-http-client", "ruby"
  ];

  if (!userAgent || userAgent.length < 10) {
    console.warn("Blocked: Empty or suspicious User-Agent");
    return true;
  }

  const uaLower = userAgent.toLowerCase();
  if (forbiddenAgents.some(bot => uaLower.includes(bot))) {
    console.warn(`Blocked Crawler UA: ${userAgent.substring(0, 100)}`);
    return true;
  }

  if (referer && !referer.includes("weixin.qq.com") && !referer.includes("qq.com")) {
    console.warn(`Blocked Referer: ${referer.substring(0, 100)}`);
    return true;
  }

  return false;
}

function isTimestampValid(timestamp, maxAgeSeconds = 300) {
  if (!timestamp) return false;
  const requestTime = parseInt(timestamp, 10);
  if (isNaN(requestTime)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - requestTime) <= maxAgeSeconds;
}

function checkSignature(signature, timestamp, nonce, token) {
  const tempStr = [token, timestamp, nonce].sort().join("");
  const hash = new Uint8Array(new TextEncoder().encode(tempStr));
  return crypto.subtle.digest("SHA-1", hash).then(bufferToHex).then(h => h === signature);
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function parseXML(xml) {
  const msgType = extractTag(xml, "MsgType");
  const event = extractTag(xml, "Event");
  return {
    MsgType: msgType,
    Event: event,
    Content: msgType === "text" ? extractContentTag(xml) : "",
    FromUserName: extractTag(xml, "FromUserName"),
    ToUserName: extractTag(xml, "ToUserName")
  };
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]></${tag}>`));
  return match ? match[1] : "";
}

function extractContentTag(xml) {
  const match = xml.match(/<Content><!\[CDATA\[(.*?)\]\]><\/Content>/);
  return match ? match[1] : "";
}

// -------- AI 调用 --------

function resolveAIProvider(env) {
  const configured = (env.AI_PROVIDER || "").trim().toLowerCase();
  if (configured === "workers-ai" || configured === "openai") {
    return configured;
  }
  return "openai";
}

function getAITimeoutMs(env) {
  const value = Number.parseInt(env.AI_TIMEOUT_MS || "", 10);
  if (!Number.isFinite(value) || value < 1000) {
    return DEFAULT_AI_TIMEOUT_MS;
  }
  return Math.min(value, 4900);
}

function getTimeoutReply(env) {
  return env.AI_TIMEOUT_REPLY || "消息已收到，处理中稍慢，请稍后再试一次。";
}

function getBaseSystemPrompt(env, provider) {
  return env.OPENAI_SYSTEM_PROMPT || "你是一个有帮助的AI助手";
}

function getWechatFormatPrompt(env) {
  return (env.WECHAT_FORMAT_PROMPT || "").trim();
}

function buildSystemPrompt(env, provider) {
  const promptParts = [getBaseSystemPrompt(env, provider)];
  const wechatFormatPrompt = getWechatFormatPrompt(env);
  if (wechatFormatPrompt) {
    promptParts.push(wechatFormatPrompt);
  }
  return promptParts.join("\n\n");
}

function getOptionalNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function withTimeout(promise, timeoutMs, fallbackValue) {
  let timerId;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => {
        timerId = setTimeout(() => resolve(fallbackValue), timeoutMs);
      })
    ]);
  } finally {
    if (timerId) {
      clearTimeout(timerId);
    }
  }
}

async function chatWithProvider(provider, msg, env, history) {
  if (provider === "workers-ai") {
    return chatWithCloudflareAI(msg, env, history);
  }
  return chatWithOpenAI(msg, env, history);
}

async function chatWithCloudflareAI(msg, env, history) {
  if (!env.AI || typeof env.AI.run !== "function") {
    throw new Error("Workers AI 未绑定，请在 wrangler.toml 配置 [ai] binding = \"AI\"");
  }

  const systemPrompt = buildSystemPrompt(env, "openai");
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: msg }
  ];

  const options = {
    messages,
    max_tokens: getOptionalNumber(env.CF_AI_MAX_TOKENS),
    temperature: getOptionalNumber(env.CF_AI_TEMPERATURE)
  };

  // Workers AI 不接受值为 undefined 的字段
  Object.keys(options).forEach(key => {
    if (options[key] === undefined) {
      delete options[key];
    }
  });

  try {
    const result = await env.AI.run(env.CF_AI_MODEL || DEFAULT_CF_MODEL, options);
    if (typeof result === "string") {
      return result;
    }
    return result?.response || "抱歉，我暂时无法回答你的问题。";
  } catch (error) {
    console.error("Workers AI Request Failed:", error);
    return `Workers AI 错误: ${error.message || "未知错误"}`;
  }
}

async function chatWithOpenAI(msg, env, history) {
  const baseUrl = env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const url = `${baseUrl}/chat/completions`;

  const systemPrompt = buildSystemPrompt(env, "openai");
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: msg }
  ];

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: env.OPENAI_MODEL, messages })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(`OpenAI Error ${response.status}: ${data.error?.message || "未知错误"}`);

    return data.choices?.[0]?.message?.content || "抱歉，我暂时无法回答你的问题。";
  } catch (error) {
    console.error("OpenAI Request Failed:", error);
    return `OpenAI 错误: ${error.message}`;
  }
}

function formatXMLReply(to, from, content) {
  return `<xml>
    <ToUserName><![CDATA[${to}]]></ToUserName>
    <FromUserName><![CDATA[${from}]]></FromUserName>
    <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
    <MsgType><![CDATA[text]]></MsgType>
    <Content><![CDATA[${content}]]></Content>
  </xml>`;
}
