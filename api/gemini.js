// api/gemini.js
// 图像分析：Qwen-VL-Max（破损检测 + 人脸定位）
// 图像编辑：qwen-image-3.0（平衡档，非 pro）——同一模型家族里生成更快、价格更低的一档，
// 编辑能力不变，最大分辨率仍是 2048x2048，换成 -pro 只是要更强的复杂版式/小字渲染能力，本项目用不上
// 前端接口不变，内部替换为 DashScope

const sharp = require("sharp");

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

// DashScope 返回的结果图通常是无损 PNG，体积可能远超 Vercel 4.5MB 的请求/响应体上限，
// 尤其是这张图后面还要作为下一次 edit 的输入再传回来一次。统一压成较高质量的 JPEG
// 并限制最长边，把体积稳定控制在几百 KB～1MB，两头（返回给前端 / 前端下次再传上来）都安全。
async function urlToBase64(url) {
  const r = await fetch(url);
  const buf = Buffer.from(await r.arrayBuffer());
  const out = await sharp(buf)
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return out.toString("base64");
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
      // 用 5x5 网格分类 + 粗粒度大小分档，取代此前的自由坐标边界框。
      // 原因：VLM 在"选一个格子"这类分类任务上普遍可靠，在"吐出精确浮点坐标"
      // 这类数值回归任务上普遍不可靠——实测边界框版本的聚焦准确度反而不如
      // 最早的九宫格版本。这里保留分类任务的可靠性，同时把格子从 3x3 加密到
      // 5x5，位置精度还是比原来的九宫格更细。
      const prompt = `分析这张老照片，只返回以下格式的JSON，不含任何其他文字或解释：

{
  "damage": {
    "detected": true或false,
    "confidence": "high"或"medium"或"low",
    "gridCol": 1到5的整数或null,
    "gridRow": 1到5的整数或null,
    "size": "small"或"medium"或"large"或null,
    "description": "15字以内中文描述或null"
  },
  "face": {
    "detected": true或false,
    "gridCol": 1到5的整数或null,
    "gridRow": 1到5的整数或null,
    "size": "small"或"medium"或"large"或null,
    "personCount": 数字
  }
}

网格与大小说明：
- 把整张图片划分成 5列×5行共25个格子，gridCol 是列号（1=最左，5=最右），gridRow 是行号（1=最上，5=最下）
- gridCol、gridRow 指目标区域中心点所在的格子
- size 指目标区域占整张图片面积的大致比例：small=不到图片的1/6，medium=1/6到1/3之间，large=超过1/3
- face 的网格与大小指所有人脸所在的整体范围（如有多张人脸，取能覆盖全部人脸的中心位置与大小）

规则：
- damage.detected=true仅当存在明显影响观看的划痕、撕裂、折痕、污渍或缺损区域
- damage.confidence: high=非常明显，medium=可见但不严重，low=仅轻微老化
- face.gridCol、face.gridRow、face.size 在 face.detected=false 时均为 null
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
            // qwen-vl-max 默认把输入图压到约131万像素再做检测，我们准备的照片
            // 长边1600px（方图约256万像素）已经超过这个默认上限，会被二次压缩，
            // 官方文档也提到超出鲁棒分辨率范围时"偶发检测框漂移"。开启
            // vl_high_resolution_images 让模型按图片实际分辨率处理（上限约1677万
            // 像素，我们的图远低于此），避免这层不必要的画质损失。
            parameters: { result_format: "message", vl_high_resolution_images: true }
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
            model: "qwen-image-3.0",
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
      return res.status(200).json({ ok: true, imageBase64: base64, mimeType: "image/jpeg" });

    } else {
      return res.status(400).json({ error: "Unknown action. Use 'analyze' or 'edit'." });
    }

  } catch (err) {
    console.error("DashScope error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
