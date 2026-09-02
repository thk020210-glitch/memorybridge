// api/gemini.js
// 图像分析：Qwen-VL-Max（破损检测 + 人脸定位）
// 图像编辑：wan2.7-image-pro（异步，原图+指令→修复后输出）
// 前端接口不变，内部替换为 DashScope

const BASE = "https://dashscope.aliyuncs.com/api/v1";

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 轮询预算需要小于 vercel.json 里的 maxDuration，留出提交任务和下载结果图的余量。
// 50 次 × 3000ms = 150s，配合 maxDuration:180 留了约 30s 缓冲。
async function pollTask(taskId, key) {
  for (let i = 0; i < 50; i++) {
    await sleep(3000);
    const r = await fetch(`${BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    const d = await r.json();
    const status = d?.output?.task_status;
    if (status === "SUCCEEDED") return d;
    if (status === "FAILED") throw new Error("任务失败：" + (d?.message || "未知错误"));
  }
  throw new Error("任务超时（150s）");
}

async function urlToBase64(url) {
  const r = await fetch(url);
  const buf = await r.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const key = process.env.DASHSCOPE_API_KEY;
  if (!key) return res.status(500).json({ error: "DASHSCOPE_API_KEY not configured" });

  const { action, imageBase64, mimeType, instruction } = req.body;

  try {
    // ── 图像分析：Qwen-VL-Max ───────────────────────────────────────────
    if (action === "analyze") {
      const prompt = `分析这张老照片，只返回以下格式的JSON，不含任何其他文字或解释：

{
  "damage": {
    "detected": true或false,
    "confidence": "high"或"medium"或"low",
    "area": "top-left"或"top-center"或"top-right"或"center-left"或"center"或"center-right"或"bottom-left"或"bottom-center"或"bottom-right"或null,
    "description": "15字以内中文描述或null"
  },
  "face": {
    "detected": true或false,
    "area": "top-left"或"top-center"或"top-right"或"center-left"或"center"或"center-right"或"bottom-left"或"bottom-center"或"bottom-right"或"full",
    "personCount": 数字
  }
}

规则：
- damage.detected=true仅当存在明显影响观看的划痕、撕裂、折痕、污渍或缺损区域
- damage.confidence: high=非常明显，medium=可见但不严重，low=仅轻微老化
- face.area指大多数人脸所在的九宫格区域
- 仅输出JSON`;

      const resp = await fetch(
        `${BASE}/services/aigc/multimodal-generation/generation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: "qwen-vl-max",
            input: {
              messages: [{
                role: "user",
                content: [
                  { image: `data:${mimeType || "image/jpeg"};base64,${imageBase64}` },
                  { text: prompt }
                ]
              }]
            },
            parameters: { result_format: "message" }
          })
        }
      );

      const d = await resp.json();
      if (!resp.ok) return res.status(resp.status).json({ ok: false, error: d });

      const text = d?.output?.choices?.[0]?.message?.content?.[0]?.text || "";
      const cleaned = text.replace(/```json\n?|```\n?/g, "").trim();
      try {
        return res.status(200).json({ ok: true, result: JSON.parse(cleaned) });
      } catch {
        return res.status(200).json({ ok: true, result: null, raw: text });
      }

    // ── 图像编辑：wan2.7-image-pro（异步） ─────────────────────────────
    } else if (action === "edit") {
      // 提交异步任务
      const submitResp = await fetch(
        `${BASE}/services/aigc/image-generation/generation`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
            "X-DashScope-Async": "enable"
          },
          body: JSON.stringify({
            model: "qwen-image-3.0-pro",
            input: {
              messages: [{
                role: "user",
                content: [
                  { image: `data:${mimeType || "image/jpeg"};base64,${imageBase64}` },
                  { text: instruction }
                ]
              }]
            },
            parameters: { n: 1, watermark: false, prompt_extend: false }
          })
        }
      );

      const submitData = await submitResp.json();
      if (!submitResp.ok) {
        return res.status(submitResp.status).json({ ok: false, error: submitData });
      }

      const taskId = submitData?.output?.task_id;
      if (!taskId) return res.status(500).json({ ok: false, error: "未获取到 task_id", raw: submitData });

      // 轮询等待结果
      const result = await pollTask(taskId, key);

      // 提取图片 URL
      const imageUrl =
        result?.output?.choices?.[0]?.message?.content?.[0]?.image ||
        result?.output?.results?.[0]?.url;

      if (!imageUrl) {
        return res.status(500).json({ ok: false, error: "结果中没有图片", raw: result });
      }

      // 下载图片并转 base64 返回前端
      const base64 = await urlToBase64(imageUrl);
      return res.status(200).json({ ok: true, imageBase64: base64, mimeType: "image/png" });

    } else {
      return res.status(400).json({ error: "Unknown action. Use 'analyze' or 'edit'." });
    }

  } catch (err) {
    console.error("DashScope error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
