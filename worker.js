// 内存缓存：key = userId, value = { history: [], expireAt: timestamp }
const chatCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10分钟过期
const MAX_HISTORY = 4; // 保留4轮对话（8条消息）

export default {
  async fetch(request, env) {
    if (isCrawler(request)) {
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "GET") {
      return handleGetRequest(request, env);
    }

    if (request.method === "POST") {
      return handlePostRequest(request, env);
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

async function handlePostRequest(request, env) {
  const text = await request.text();
  const msg = parseXML(text);
  if (!msg) return new Response("Invalid XML", { status: 400 });

  let reply;

  if (msg.MsgType === "event" && msg.Event.toLowerCase() === "subscribe") {
    reply = env.WELCOME_MESSAGE || "感谢关注！我是基于 AI 的智能助手，可以回答您的各种问题。";
  } else if (msg.MsgType === "text") {
    const useOpenAI = env.USE_OPENAI === "1";
    const userMsg = msg.Content;
    const fromUserName = msg.FromUserName;

    // 获取或创建用户缓存
    const conversationHistory = getHistory(fromUserName);

    try {
      reply = useOpenAI
        ? await chatWithOpenAI(userMsg, env, conversationHistory)
        : await chatWithGemini(userMsg, env, conversationHistory);
    } catch (error) {
      console.error("AI Error:", error);
      reply = `AI 处理失败: ${error.message || "未知错误"}`;
    }

    // 更新缓存（不阻塞响应）
    updateHistory(fromUserName, userMsg, reply);
  } else {
    reply = env.UNSUPPORTED_MESSAGE || "目前仅支持文字消息哦！";
  }

  const responseXML = formatXMLReply(msg.FromUserName, msg.ToUserName, reply);
  return new Response(responseXML, {
    headers: { "Content-Type": "application/xml" }
  });
}

// -------- 内存缓存操作 --------

function getHistory(userId) {
  const cached = chatCache.get(userId);
  if (cached && cached.expireAt > Date.now()) {
    return cached.history;
  }
  // 过期或不存在，清理并返回空
  chatCache.delete(userId);
  return [];
}

function updateHistory(userId, userMsg, assistantReply) {
  let history = getHistory(userId);

  // 添加新对话
  history.push({ role: "user", content: userMsg });
  history.push({ role: "assistant", content: assistantReply });

  // 保留最近 MAX_HISTORY 轮（每轮2条）
  if (history.length > MAX_HISTORY * 2) {
    history = history.slice(-MAX_HISTORY * 2);
  }

  // 更新缓存
  chatCache.set(userId, {
    history,
    expireAt: Date.now() + CACHE_TTL
  });

  // 清理过期缓存（异步执行，不阻塞）
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
  const match = xml.match(new RegExp(`<${tag}><![CDATA[(.*?)]]></${tag}>`));
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
