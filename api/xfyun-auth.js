// api/xfyun-auth.js
// 生成讯飞语音听写 WebSocket 鉴权 URL
// 在服务端计算 HMAC-SHA256，保护 APISecret 不暴露到前端

const crypto = require("crypto");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).end();
  }

  const APPID      = process.env.XFYUN_APPID;
  const API_KEY    = process.env.XFYUN_API_KEY;
  const API_SECRET = process.env.XFYUN_API_SECRET;

  if (!APPID || !API_KEY || !API_SECRET) {
    return res.status(500).json({ error: "讯飞配置缺失，请在 Vercel 填入 XFYUN_APPID / XFYUN_API_KEY / XFYUN_API_SECRET" });
  }

  // 讯飞鉴权规范：rfc1123 格式时间 + HMAC-SHA256
  const host = "iat-api.xfyun.cn";
  const path = "/v2/iat";
  const date = new Date().toUTCString();

  const signString = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
  const hmac = crypto.createHmac("sha256", API_SECRET);
  hmac.update(signString);
  const signature = hmac.digest("base64");

  const authBase64 = Buffer.from(
    `api_key="${API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`
  ).toString("base64");

  const url = `wss://${host}${path}?authorization=${encodeURIComponent(authBase64)}&date=${encodeURIComponent(date)}&host=${host}&appid=${APPID}`;

  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json({ url });
};
