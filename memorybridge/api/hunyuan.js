// api/hunyuan.js
// Proxy for Tencent Hunyuan API (OpenAI-compatible endpoint)
// Handles intent classification for the voice input → repair chain

const HUNYUAN_ENDPOINT = "https://api.hunyuan.cloud.tencent.com/v1/chat/completions";

// Intent classification prompt template
function buildPrompt(transcript, storyContext, stage) {
  const stageLabel = {
    face: "面部修复（表情、清晰度、肤色、面部细节等）",
    damage: "照片损伤修复（划痕、折痕、污渍、缺损等）",
    color: "色彩调整（整体色调、饱和度、明暗等）"
  }[stage] || "照片修复";

  return `你是一个老照片修复助手的意图理解模块，当前处理阶段：${stageLabel}。

【用户关于照片的背景描述】（如为空则忽略）：
${storyContext || "（用户未提供）"}

【用户刚才说的原话】：
"${transcript}"

判断标准：
- specific：用户明确指出了一个可执行的具体调整属性，例如"让眼睛更清晰""脸色亮堂点""笑容自然些""修掉那道划痕"
- vague：表达模糊笼统，例如"好看点""你看着弄""改一改""随便"
- unsupported：超出当前阶段范围，或要求在多人合照中指定修改特定某个人，或要求凭空添加照片中不存在的内容

输出规则（严格遵守）：
1. attribute_status 必须是 "specific" | "vague" | "unsupported" 之一
2. intents 最多识别前2个独立诉求，超出部分忽略
3. variants 只围绕 intents 第一条生成3条英文图像编辑指令；如果是 vague，使用固定方向；如果是 unsupported，返回空数组
4. vague 固定 variants（按顺序）：
   - "Restore faces naturally with subtle, lifelike enhancement"
   - "Brighten and sharpen the faces significantly for clarity"
   - "Gently restore while preserving the vintage photograph character"
5. variants 中的3条指令必须在满足同一诉求的前提下在【程度或风格】上有明显区别，不能互相矛盾或偏离诉求
6. confirmation_phrase：口语化中文，复用用户原话中的关键词，不含技术术语，不超过30字
7. 若有第二条诉求，只在 confirmation_phrase 末尾用"另外……"带出，不出现在 variants 中
8. 仅输出JSON，不含任何其他文字、解释或 markdown 标记

输出格式：
{
  "attribute_status": "specific" | "vague" | "unsupported",
  "intents": ["意图描述1"],
  "variants": ["英文编辑指令1", "英文编辑指令2", "英文编辑指令3"],
  "confirmation_phrase": "口语化中文确认语句"
}`;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const key = process.env.HUNYUAN_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "HUNYUAN_API_KEY not configured" });
  }

  const { transcript, storyContext, stage } = req.body;

  if (!transcript) {
    return res.status(400).json({ error: "transcript is required" });
  }

  const prompt = buildPrompt(transcript, storyContext, stage || "face");

  try {
    const resp = await fetch(HUNYUAN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        model: "hunyuan-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 500
      })
    });

    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);

    const text = data?.choices?.[0]?.message?.content || "";
    const cleaned = text.replace(/```json\n?|```\n?/g, "").trim();

    try {
      const parsed = JSON.parse(cleaned);
      return res.status(200).json({ ok: true, result: parsed });
    } catch {
      return res.status(200).json({ ok: false, raw: text, error: "JSON parse failed" });
    }

  } catch (err) {
    console.error("Hunyuan proxy error:", err);
    return res.status(500).json({ error: err.message });
  }
}
