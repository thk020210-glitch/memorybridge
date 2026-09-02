// api/gemini.js — 诊断版本
// 分析：qwen-vl-max（稳定 JSON）
// 编辑：qwen-image-3.0-pro 异步，完整记录响应结构供调试

const BASE = "https://dashscope.aliyuncs.com/api/v1";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function safeJson(resp) {
  const text = await resp.text();
  try { return { ok: resp.ok, status: resp.status, data: JSON.parse(text) }; }
  catch { return { ok: false, status: resp.status, data: null, raw: text.slice(0, 400) }; }
}

// 从任意响应结构中尝试提取图片 URL
function extractImageUrl(data) {
  if (!data) return null;
  const o = data.output || data;
  // 尝试所有已知路径
  const paths = [
    o?.choices?.[0]?.message?.content?.[0]?.image,
    o?.choices?.[0]?.message?.content?.[0]?.image_url,
    o?.choices?.[0]?.message?.content?.find?.(c => c.image)?.image,
    o?.choices?.[0]?.message?.content?.find?.(c => c.image_url)?.image_url,
    o?.results?.[0]?.url,
    o?.results?.[0]?.orig_url,
    o?.image_url,
    o?.url,
  ];
  return paths.find(p => typeof p === 'string' && p.startsWith('http')) || null;
}

async function pollTask(taskId, key) {
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const r = await fetch(`${BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    const { data } = await safeJson(r);
    const status = data?.output?.task_status;
    console.log(`[poll ${i+1}] task=${taskId} status=${status}`);
    if (status === "SUCCEEDED") return data;
    if (status === "FAILED") {
      const msg = data?.output?.message || data?.message || "任务失败";
      throw new Error(msg);
    }
  }
  throw new Error("轮询超时（60s）");
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
    // ── 分析：qwen-vl-max ───────────────────────────────────────────
    if (action === "analyze") {
      const prompt = `分析这张老照片。只返回JSON，不要有任何其他文字。格式：
{"damage":{"detected":false,"confidence":"low","area":null,"description":null},"face":{"detected":true,"area":"center","personCount":1}}
其中damage.detected为true仅当有明显划痕撕裂折痕或缺损，confidence为high/medium/low，area为nine-grid位置或null。`;

      const { ok, status, data, raw } = await safeJson(
        await fetch(`${BASE}/services/aigc/multimodal-generation/generation`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: "qwen-vl-max",
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
      console.log("[analyze] raw text:", text.slice(0, 200));
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return res.status(200).json({ ok: true, result: JSON.parse(jsonMatch[0]) });
        } catch(e) {
          console.error("[analyze] json parse error:", e.message, jsonMatch[0].slice(0,100));
        }
      }
      return res.status(200).json({ ok: true, result: null, raw: text.slice(0, 200) });

    // ── 编辑：qwen-image-3.0-pro 异步 ──────────────────────────────
    } else if (action === "edit") {
      // 提交任务
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
        const errMsg = submitData?.message || submitData?.code || raw || "提交失败";
        console.error("[edit submit failed]", errMsg);
        return res.status(status).json({ ok: false, error: errMsg });
      }

      const taskId = submitData?.output?.task_id;
      if (!taskId) {
        console.error("[edit] no task_id. submitData:", JSON.stringify(submitData).slice(0,300));
        return res.status(500).json({ ok: false, error: "未获取 task_id", debug: JSON.stringify(submitData).slice(0,200) });
      }

      console.log("[edit] task submitted:", taskId);

      // 轮询结果
      const result = await pollTask(taskId, key);

      // 记录完整结构到日志
      console.log("[edit] poll result keys:", JSON.stringify({
        output_keys: Object.keys(result?.output||{}),
        choices_count: result?.output?.choices?.length,
        results_count: result?.output?.results?.length,
        first_content: result?.output?.choices?.[0]?.message?.content
      }));

      const imageUrl = extractImageUrl(result);

      if (!imageUrl) {
        // 返回完整结构供调试（截断以防 toast 过长）
        const debug = {
          output_keys: Object.keys(result?.output||{}),
          choices: result?.output?.choices?.slice(0,1),
          results: result?.output?.results?.slice(0,1),
        };
        console.error("[edit] imageUrl not found. structure:", JSON.stringify(debug));
        return res.status(500).json({
          ok: false,
          error: "无图片URL",
          debug: JSON.stringify(debug).slice(0, 400)
        });
      }

      console.log("[edit] image URL found:", imageUrl.slice(0, 80));
      const base64 = await urlToBase64(imageUrl);
      return res.status(200).json({ ok: true, imageBase64: base64, mimeType: "image/png" });

    } else {
      return res.status(400).json({ error: "Unknown action" });
    }

  } catch (err) {
    console.error("[handler error]", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
