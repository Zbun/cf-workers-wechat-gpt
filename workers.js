export default {
  async fetch(request, env) {
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

      const useOpenAI = env.USE_OPENAI === "true"; // 从环境变量读取开关
      const userMsg = msg.Content;
      let reply;

      try {
        reply = useOpenAI ? await chatWithOpenAI(userMsg, env) : await chatWithGemini(userMsg, env);
      } catch (error) {
        console.error("AI Error:", error);
        reply = `AI 处理失败: ${error.message || "未知错误"}`;
      }

      const responseXML = formatXMLReply(msg.FromUserName, msg.ToUserName, reply);
      return new Response(responseXML, { headers: { "Content-Type": "application/xml" } });
    }

    return new Response("Invalid Request", { status: 405 });
  }
};

function checkSignature(signature, timestamp, nonce, token) {
  const tempStr = [token, timestamp, nonce].sort().join("");
  const hash = new Uint8Array(new TextEncoder().encode(tempStr));
  return crypto.subtle.digest("SHA-1", hash).then(bufferToHex).then(hash => hash === signature);
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function parseXML(xml) {
  const match = xml.match(/<Content><!\[CDATA\[(.*?)\]\]><\/Content>/);
  return match ? { Content: match[1], FromUserName: extractTag(xml, "FromUserName"), ToUserName: extractTag(xml, "ToUserName") } : null;
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]><\\/${tag}>`));
  return match ? match[1] : "";
}

async function chatWithOpenAI(msg, env) {
  const url = `${env.OPENAI_BASE_URL}/chat/completions`;
  
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        messages: [{ role: "system", content: env.OPENAI_SYSTEM_PROMPT }, { role: "user", content: msg }]
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

async function chatWithGemini(msg, env) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: msg }] }] })
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
