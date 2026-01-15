// 混合缓存：key = userId, value = { history, expireAt, kvVersion }
// kvVersion 记录从 KV 加载时的历史长度，用于决定是否需要写回 KV
const chatCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10分钟过期
const MAX_HISTORY_MESSAGES = 4; // 保留最近 4 条消息（2轮对话）
const KV_WRITE_THRESHOLD = 2; // 历史变化超过 2 条时才写入 KV

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
    const useOpenAI = env.USE_OPENAI !== "0"; // 默认使用 OpenAI，设为 "0" 时使用 Gemini
    const userMsg = msg.Content;
    const fromUserName = msg.FromUserName;

    // 混合读取：内存优先，未命中从 KV 加载
    const conversationHistory = await getHistoryHybrid(fromUserName, env.AI_CHAT_HISTORY);

    try {
      reply = useOpenAI
        ? await chatWithOpenAI(userMsg, env, conversationHistory)
        : await chatWithGemini(userMsg, env, conversationHistory);
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
          // 加载到内存缓存，记录 KV 版本（当前长度）
          chatCache.set(userId, {
            history,
            expireAt: Date.now() + CACHE_TTL,
            kvVersion: history.length
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
  const kvVersion = cached?.kvVersion || 0;

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
    kvVersion
  });

  // 条件写入 KV：历史变化超过阈值时才写入
  const changeCount = history.length - kvVersion;
  if (kvNamespace && changeCount >= KV_WRITE_THRESHOLD) {
    const writePromise = kvNamespace.put(userId, JSON.stringify(history))
      .then(() => {
        // 写入成功后更新 kvVersion
        const current = chatCache.get(userId);
        if (current) {
          current.kvVersion = history.length;
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

async function chatWithOpenAI(msg, env, history) {
  const baseUrl = env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const url = `${baseUrl}/chat/completions`;

  const messages = [
    { role: "system", content: env.OPENAI_SYSTEM_PROMPT || "你是一个有帮助的AI助手" },
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

async function chatWithGemini(msg, env, history) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;

  const contents = [
    { role: "user", parts: [{ text: env.GEMINI_SYSTEM_PROMPT || "你是一个有帮助的AI助手" }] }
  ];

  for (const item of history) {
    contents.push({
      role: item.role === "user" ? "user" : "model",
      parts: [{ text: item.content }]
    });
  }

  contents.push({ role: "user", parts: [{ text: msg }] });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(`Gemini Error ${response.status}: ${data.error?.message || "未知错误"}`);

    return data.candidates?.[0]?.content?.parts?.[0]?.text || "抱歉，我暂时无法回答你的问题。";
  } catch (error) {
    console.error("Gemini Request Failed:", error);
    return `Gemini 错误: ${error.message}`;
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
