export default {
  async fetch(request, env) {
    if (isCrawler(request)) {
      return new Response("Forbidden", { status: 403 });
    }

    const { searchParams } = new URL(request.url);

    if (request.method === "GET") {
      const signature = searchParams.get("signature");
      const timestamp = searchParams.get("timestamp");
      const nonce = searchParams.get("nonce");
      const echostr = searchParams.get("echostr");

      if (checkSignature(signature, timestamp, nonce, env.WECHAT_TOKEN)) {
        return new Response(echostr, { status: 200 });
      }
      return new Response("Invalid signature", { status: 403 });
    }

    if (request.method === "POST") {
      const text = await request.text();
      const msg = parseXML(text);
      if (!msg) return new Response("Invalid XML", { status: 400 });

      const useOpenAI = env.USE_OPENAI === "true";
      const userMsg = msg.Content;
      const fromUserName = msg.FromUserName; // 获取用户 FromUserName，用于区分用户

      // 从环境变量获取历史记录限制数，默认为 2
      const historyLimit = parseInt(env.CHAT_HISTORY_LIMIT) || 2;

      // 获取会话历史
      let conversationHistory = await getHistory(fromUserName, env.AI_CHAT_HISTORY);

      // 将用户消息添加到会话历史
      conversationHistory.push({ role: "user", content: userMsg });
      conversationHistory = trimHistory(conversationHistory, historyLimit); // 使用变量替代固定值

      let reply;

      try {
        reply = useOpenAI ? await chatWithOpenAI(userMsg, env, conversationHistory) : await chatWithGemini(userMsg, env, conversationHistory);
      } catch (error) {
        console.error("AI Error:", error);
        reply = `AI 处理失败: ${error.message || "未知错误"}`;
      }

      // 将 AI 回复添加到会话历史
      conversationHistory.push({ role: "assistant", content: reply });
      conversationHistory = trimHistory(conversationHistory, historyLimit); // 使用变量替代固定值

      // 更新会话历史到 KV 存储
      await updateHistory(fromUserName, env.AI_CHAT_HISTORY, conversationHistory);


      const responseXML = formatXMLReply(msg.FromUserName, msg.ToUserName, reply);
      return new Response(responseXML, { headers: { "Content-Type": "application/xml" } });
    }

    return new Response("Invalid Request", { status: 405 });
  }
};

// 🚨 防爬虫方法 (保持不变)
function isCrawler(request) {
  const userAgent = request.headers.get("User-Agent") || "";
  const referer = request.headers.get("Referer") || "";
  const forbiddenAgents = ["curl", "wget", "Python-requests", "Scrapy", "bot", "spider"];
  const forbiddenReferers = ["http://", "https://", "example.com"]; // 可修改为自己的白名单

  // 拦截常见爬虫 UA
  if (forbiddenAgents.some(bot => userAgent.toLowerCase().includes(bot))) {
    console.warn(`Blocked Crawler: ${userAgent}`);
    return true;
  }

  // 限制 Referer 来源
  if (referer && !referer.includes("weixin.qq.com")) {
    console.warn(`Blocked Referer: ${referer}`);
    return true;
  }

  return false;
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

// XML 解析 (保持不变)
function parseXML(xml) {
  const match = xml.match(/<Content><!\[CDATA\[(.*?)\]\]><\/Content>/);
  return match ? { Content: match[1], FromUserName: extractTag(xml, "FromUserName"), ToUserName: extractTag(xml, "ToUserName") } : null;
}

// 提取 XML 标签 (保持不变)
function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]><\\/${tag}>`));
  return match ? match[1] : "";
}

// 与 OpenAI 聊天 (修改后，接收 history 参数)
async function chatWithOpenAI(msg, env, history) {
  const url = `${env.OPENAI_BASE_URL}/chat/completions`;

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

  // Gemini 的上下文处理方式可能与 OpenAI 不同，这里简单将历史记录拼接在消息前 (更严谨的做法需要参考 Gemini API 文档构建 context)
  let historyText = history.map(item => `${item.role === 'user' ? '用户: ' : 'AI: '}${item.content}`).join('\n');
  const prompt = historyText + '\n' + msg; // 将历史记录和当前消息拼接成一个 prompt

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) // 使用拼接了历史记录的 prompt
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

// --------  新增的 KV 历史记录操作函数  --------

// 裁剪会话历史，保持指定长度
function trimHistory(history, limit) {
  // 确保 history 是数组且不为空
  if (!Array.isArray(history)) {
    return [];
  }

  if (history.length > limit) {
    return history.slice(history.length - limit); // 保留最新的 limit 条记录
  }
  return history;
}

// 从 KV 获取会话历史
async function getHistory(userId, kvNamespace) {
  if (!userId || !kvNamespace) {
    console.warn("获取会话历史失败: 缺少必要参数");
    return [];
  }

  try {
    const historyString = await kvNamespace.get(userId);
    if (historyString) {
      const parsed = JSON.parse(historyString);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (error) {
    console.warn("获取会话历史失败:", error);
  }
  return [];
}

// 更新会话历史到 KV
async function updateHistory(userId, kvNamespace, history) {
  if (!userId || !kvNamespace) {
    console.error("更新会话历史失败: 缺少必要参数");
    return;
  }

  // 确保 history 是数组
  const safeHistory = Array.isArray(history) ? history : [];

  try {
    await kvNamespace.put(userId, JSON.stringify(safeHistory));
  } catch (error) {
    console.error("更新会话历史失败:", error);
  }
}
