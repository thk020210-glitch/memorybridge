// api/gemini.js
// 分析：qwen-vl-flash（multimodal-generation 同步，速度快）
// 编辑：qwen-image-3.0-pro（multimodal-generation 异步，正确端点）

const BASE = "https://dashscope.aliyuncs.com/api/v1";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function safeJson(resp) {
  const text = await resp.text();
  try { return { ok: resp.ok, status: resp.status, data: JSON.parse(text) }; }
  catch { return { ok: false, status: resp.status, data: null, raw: text.slice(0, 300) }; }
}

async function pollTask(taskId, key) {
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const r = await fetch(`${BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    const { data } = await safeJson(r);
    const status = data?.output?.task_status;
    if (status === "SUCCEEDED") return data;
    if (status === "FAILED") throw new Error(
      data?.output?.message || data?.message || "任务失败"
    );
  }
  throw new Error("任务超时（60s）");
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
    // ── 分析：qwen-vl-flash（同步，速度快）──────────────────────────
    if (action === "analyze") {
      const prompt = `分析这张老照片，只返回JSON，不含任何其他文字：
{"damage":{"detected":true或false,"confidence":"high"或"medium"或"low","area":"top-left"或"top-center"或"top-right"或"center-left"或"center"或"center-right"或"bottom-left"或"bottom-center"或"bottom-right"或null,"description":"15字以内中文或null"},"face":{"detected":true或false,"area":"top-left"或"top-center"或"top-right"或"center-left"或"center"或"center-right"或"bottom-left"或"bottom-center"或"bottom-right"或"full","personCount":数字}}
damage.detected=true仅当有明显划痕撕裂折痕污渍或缺损。只输出JSON。`;

      const { ok, status, data, raw } = await safeJson(
        await fetch(`${BASE}/services/aigc/multimodal-generation/generation`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: "qwen-vl-flash",
            input: { messages: [{ role: "user", content: [
              { image: `data:${mimeType||"image/jpeg"};base64,${imageBase64}` },
              { text: prompt }
            ]}] },
            parameters: { result_format: "message" }
          })
        })
      );

      if (!ok) return res.status(status).json({ ok: false, error: data || raw });

      const text = data?.output?.choices?.[0]?.message?.content?.[0]?.text || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { return res.status(200).json({ ok: true, result: JSON.parse(jsonMatch[0]) }); }
        catch {}
      }
      return res.status(200).json({ ok: true, result: null, raw: text });

    // ── 编辑：qwen-image-3.0-pro 异步，multimodal-generation 端点 ──
    } else if (action === "edit") {
      // 提交异步任务（multimodal-generation + X-DashScope-Async: enable）
      const { ok, status, data: submitData, raw } = await safeJson(
        await fetch(`${BASE}/services/aigc/multimodal-generation/generation`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
            "X-DashScope-Async": "enable"
          },
          body: JSON.stringify({
            model: "qwen-image-3.0-pro",
            input: { messages: [{ role: "user", content: [
              { image: `data:${mimeType||"image/jpeg"};base64,${imageBase64}` },
              { text: instruction }
            ]}] },
            parameters: { prompt_extend: false }
          })
        })
      );

      if (!ok) {
        return res.status(status).json({
          ok: false,
          error: submitData?.message || submitData?.code || raw || "提交失败"
        });
      }

      const taskId = submitData?.output?.task_id;
      if (!taskId) {
        return res.status(500).json({
          ok: false,
          error: "未获取到 task_id",
          raw: JSON.stringify(submitData).slice(0, 200)
        });
      }

      // 轮询结果
      const result = await pollTask(taskId, key);

      // 提取图片 URL（qwen-image 通过 multimodal 返回的格式）
      const content = result?.output?.choices?.[0]?.message?.content || [];
      const imageUrl = content.find(c => c.image)?.image
        || result?.output?.results?.[0]?.url;

      if (!imageUrl) {
        return res.status(500).json({
          ok: false,
          error: "结果中没有图片",
          raw: JSON.stringify(result).slice(0, 300)
        });
      }

      const base64 = await urlToBase64(imageUrl);
      return res.status(200).json({ ok: true, imageBase64: base64, mimeType: "image/png" });

    } else {
      return res.status(400).json({ error: "Unknown action" });
    }

  } catch (err) {
    console.error("DashScope error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
