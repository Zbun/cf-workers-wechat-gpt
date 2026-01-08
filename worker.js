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

  // 校验时间戳有效性（5分钟内）
  if (!isTimestampValid(timestamp, 300)) {
    console.warn(`Invalid timestamp: ${timestamp}`);
    return new Response("Invalid timestamp", { status: 403 });
  }

  // 修复：使用 await 等待签名校验结果
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

  // 处理关注事件
  if (msg.MsgType === "event" && msg.Event.toLowerCase() === "subscribe") {
    reply = env.WELCOME_MESSAGE || "感谢关注！我是基于 AI 的智能助手，可以回答您的各种问题。";
  } else if (msg.MsgType === "text") {
    const useOpenAI = env.USE_OPENAI === "1";
    const userMsg = msg.Content;
    const fromUserName = msg.FromUserName;

    // 从环境变量获取历史记录限制数，默认为 4
    const historyLimit = parseInt(env.CHAT_HISTORY_LIMIT) || 4;

    // 检查是否有 D1 存储可用
    const hasD1Storage = typeof env.AI_CHAT_HISTORY_DB !== 'undefined' && env.AI_CHAT_HISTORY_DB !== null;

    // 初始化数据库表（如果需要）
    if (hasD1Storage) {
      await initDatabase(env.AI_CHAT_HISTORY_DB);
    }

    // 获取会话历史（只查最近 historyLimit 条用于发送给 AI）
    let conversationHistory = [];
    if (hasD1Storage) {
      conversationHistory = await getHistory(fromUserName, env.AI_CHAT_HISTORY_DB, historyLimit);
    }

    try {
      reply = useOpenAI ? await chatWithOpenAI(userMsg, env, conversationHistory) : await chatWithGemini(userMsg, env, conversationHistory);
    } catch (error) {
      console.error("AI Error:", error);
      reply = `AI 处理失败: ${error.message || "未知错误"}`;
    }

    // 保存用户消息和 AI 回复到 D1 (如果可用，异步不阻塞响应)
    if (hasD1Storage) {
      // 不等待保存完成，避免影响响应速度
      saveMessage(fromUserName, "user", userMsg, env.AI_CHAT_HISTORY_DB).catch(e => console.error("保存用户消息失败:", e));
      saveMessage(fromUserName, "assistant", reply, env.AI_CHAT_HISTORY_DB).catch(e => console.error("保存AI回复失败:", e));
    }
  } else {
    reply = env.UNSUPPORTED_MESSAGE || "目前仅支持文字消息哦！";
  }

  const responseXML = formatXMLReply(msg.FromUserName, msg.ToUserName, reply);
  return new Response(responseXML, {
    headers: { "Content-Type": "application/xml" }
  });
}

// 🚨 防爬虫方法（增强版）
function isCrawler(request) {
  const userAgent = request.headers.get("User-Agent") || "";
  const referer = request.headers.get("Referer") || "";

  // 扩充爬虫 UA 黑名单
  const forbiddenAgents = [
    "curl", "wget", "python", "scrapy", "bot", "spider", "crawl",
    "httpclient", "java", "okhttp", "axios", "node-fetch", "postman",
    "insomnia", "httpie", "aiohttp", "go-http-client", "ruby"
  ];

  // 空 User-Agent 直接拦截（正常浏览器/微信必有 UA）
  if (!userAgent || userAgent.length < 10) {
    console.warn("Blocked: Empty or suspicious User-Agent");
    return true;
  }

  // 拦截常见爬虫 UA
  const uaLower = userAgent.toLowerCase();
  if (forbiddenAgents.some(bot => uaLower.includes(bot))) {
    console.warn(`Blocked Crawler UA: ${userAgent.substring(0, 100)}`);
    return true;
  }

  // Referer 检查：如果存在 Referer 且不是微信域名，则拦截
  if (referer && !referer.includes("weixin.qq.com") && !referer.includes("qq.com")) {
    console.warn(`Blocked Referer: ${referer.substring(0, 100)}`);
    return true;
  }

  return false;
}

// 时间戳有效性校验（防止重放攻击）
function isTimestampValid(timestamp, maxAgeSeconds = 300) {
  if (!timestamp) return false;

  const requestTime = parseInt(timestamp, 10);
  if (isNaN(requestTime)) return false;

  const now = Math.floor(Date.now() / 1000);
  const diff = Math.abs(now - requestTime);

  return diff <= maxAgeSeconds;
}

// 微信签名校验 (保持不变)
function checkSignature(signature, timestamp, nonce, token) {
  const tempStr = [token, timestamp, nonce].sort().join("");
  const hash = new Uint8Array(new TextEncoder().encode(tempStr));
  return crypto.subtle.digest("SHA-1", hash).then(bufferToHex).then(hash => hash === signature);
}

// buffer to hex (保持不变)
function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// 修改 parseXML 函数
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

// 提取 XML 标签 (保持不变)
function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]><\\/${tag}>`));
  return match ? match[1] : "";
}

// 在 extractTag 函数后添加
function extractContentTag(xml) {
  const match = xml.match(/<Content><!\[CDATA\[(.*?)\]\]><\/Content>/);
  return match ? match[1] : "";
}

// 与 OpenAI 聊天 (修改后，接收 history 参数)
async function chatWithOpenAI(msg, env, history) {
  const baseUrl = env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const url = `${baseUrl}/chat/completions`;

  // 构建包含历史记录的消息数组
  const messages = [
    { role: "system", content: env.OPENAI_SYSTEM_PROMPT },
    ...history, // 将会话历史加入 messages
    { role: "user", content: msg } // 当前用户消息
  ];

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        messages: messages // 使用包含历史记录的 messages
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(`OpenAI Error ${response.status}: ${data.error?.message || "未知错误"}`);

    return data.choices?.[0]?.message?.content || "抱歉，我暂时无法回答你的问题。";
  } catch (error) {
    console.error("OpenAI Request Failed:", error);
    return `OpenAI 错误: ${error.message}`;
  }
}

// 与 Gemini 聊天 (修改后，接收 history 参数，Gemini 历史记录处理可能需要调整)
async function chatWithGemini(msg, env, history) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;

  // 转换历史记录为 Gemini 格式的对话
  const contents = [{
    role: "user",
    parts: [{ text: env.GEMINI_SYSTEM_PROMPT || "你是一个有帮助的AI助手" }]
  }];

  // 添加历史对话
  for (const item of history) {
    contents.push({
      role: item.role === "user" ? "user" : "model",
      parts: [{ text: item.content }]
    });
  }

  // 添加当前消息
  contents.push({
    role: "user",
    parts: [{ text: msg }]
  });

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

// XML 回复格式化 (保持不变)
function formatXMLReply(to, from, content) {
  return `<xml>
    <ToUserName><![CDATA[${to}]]></ToUserName>
    <FromUserName><![CDATA[${from}]]></FromUserName>
    <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
    <MsgType><![CDATA[text]]></MsgType>
    <Content><![CDATA[${content}]]></Content>
  </xml>`;
}

// --------  D1 历史记录操作函数  --------

// 初始化数据库表
async function initDatabase(db) {
  try {
    // 分开执行，避免多语句问题
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `).run();

    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_user_id ON chat_history(user_id)
    `).run();

    console.log("数据库初始化成功");
  } catch (error) {
    // 表已存在时忽略错误
    console.log("数据库初始化:", error.message);
  }
}

// 从 D1 获取会话历史
async function getHistory(userId, db, limit) {
  if (!userId || !db) {
    return [];
  }

  try {
    const { results } = await db.prepare(
      `SELECT role, content FROM chat_history 
       WHERE user_id = ? 
       ORDER BY id DESC 
       LIMIT ?`
    ).bind(userId, limit).all();

    // 结果是倒序的，需要反转
    return results.reverse().map(row => ({
      role: row.role,
      content: row.content
    }));
  } catch (error) {
    console.error("从D1获取历史失败:", error);
    return [];
  }
}

// 保存单条消息到 D1
async function saveMessage(userId, role, content, db) {
  if (!userId || !db) {
    return;
  }

  try {
    await db.prepare(
      `INSERT INTO chat_history (user_id, role, content) VALUES (?, ?, ?)`
    ).bind(userId, role, content).run();
  } catch (error) {
    console.error("保存消息失败:", error);
  }
}
