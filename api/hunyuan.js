// api/hunyuan.js
// 意图分类：Qwen-Turbo via DashScope OpenAI-compatible endpoint
// 前端接口不变（/api/hunyuan），内部从混元切换到 Qwen-Turbo
// 指令改为中文生成，匹配 wan2.7-image-pro 对中文指令的优化

const QWEN_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

function buildPrompt(transcript, storyContext) {
  const storySection = storyContext
    ? `【照片背景信息】\n${storyContext}\n\n`
    : "";

  return `你是"记忆桥"照片修复应用的意图理解助手。用户正在看着一张老照片，
口头描述这张照片希望修复成什么样子。

${storySection}【你的任务，分四步】

第一步：识别用户这句话里包含几个可以分开处理的独立诉求。最多
只识别前两个，如果用户提到了两个以上，只取按顺序说的前两个，
后面的忽略，不需要提及。如果只有一个诉求，intents 数组里只放
一项，不要用空字符串或说明文字占位。每条诉求用一句简短的话
概括，不要用技术词汇，尽量贴近用户原话的语气和整体意思。

第二步：只针对第一步列表里的第一条诉求，判断它属于以下三种
情况中的哪一种：
- specific（具体）：用户指名了一个具体的、可执行的调整诉求，
  可以是表情、神态、清晰度、色彩、背景等任何方面的具体诉求，
  也包括要求修复照片本身已经存在的物理损伤（比如破损、缺失、
  模糊、划痕、变色），即使损伤程度描述得比较重（比如"烂了"
  "缺了一块"），也算 specific。对于修改物品的款式、样式（比如
  更换衣服的样式）这类边界情况，只要没有替换人物身份或添加新的
  人物，也倾向于判定为 specific，允许尝试处理
- vague（模糊）：用户只是笼统地表达好、随便、你看着办，没有
  指向任何具体内容
- unsupported（暂不支持）：包括以下情况——
  a) 要求凭空生成照片中原本不存在的内容，包括替换人物身份、添加
     原本没有出现过的人物或物品、去除照片中原有的人物
  b) 描述指向照片中多个人物里的某一个具体的人（比如"中间那个"
     "左边那个""戴眼镜那个"这类需要先定位是谁的描述），即使
     调整本身单独来看是合理的诉求，也判定为 unsupported

第三步：仅针对 intents 列表中的第一条诉求生成 variants，不论
intents 列表里是否存在第二条，variants 都只能围绕第一条诉求
展开。如果第一条诉求的 attribute_status 是 specific，生成三条
针对这个诉求的中文图像编辑指令。三条指令必须在满足用户诉求的
前提下彼此有明显可感知的区别（程度差异或风格差异），不能意思
相近，不能有任何一条偏离诉求核心。每条指令是可以直接用于图像
编辑的简短中文句子，不超过30字。如果不是 specific，留空数组。

第四步：生成一句确认话术，用大白话说出你理解到的意思，语气亲切
自然，禁止使用"修复、增强、处理、优化"这类技术词汇，改用"弄
清楚、调一调、改一改"这类日常口语。

- 如果第一条诉求是 specific：正常转述确认这个具体诉求
- 如果第一条诉求是 vague：转述为"我准备了几个方向给您看看，
  您挑一个"这类意思
- 如果第一条诉求是 unsupported：坦诚说明暂时处理不了，语气自然
- 如果列表里有第二条诉求，在末尾自然带一句"这个弄完了我们再说"

【判断细则】
- 拿不准 specific 还是 vague 时，一律判定为 vague
- unsupported 仅限第二步明确列出的两类，不要因为可能做不好就归为不支持

【输出格式】
只输出纯 JSON，不含任何其他文字或 markdown 标记：
{"intents":["意图描述"],"attribute_status":"specific"或"vague"或"unsupported","variants":["中文编辑指令1","中文编辑指令2","中文编辑指令3"],"confirmation_phrase":"一句确认话术"}

variants 非 specific 时必须是空数组 []，specific 时固定长度为 3。
附加约束：稳定输出，减少随机变化，禁止输出思考过程，只输出JSON。

【用户刚才说的话】
${transcript}`;
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

  const { transcript, storyContext } = req.body;
  if (!transcript) return res.status(400).json({ error: "transcript is required" });

  const prompt = buildPrompt(transcript, storyContext);

  try {
    const resp = await fetch(QWEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: "qwen-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 600
      })
    });

    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ ok: false, error: data });

    const text = data?.choices?.[0]?.message?.content || "";
    const cleaned = text.replace(/```json\n?|```\n?/g, "").trim();

    try {
      const parsed = JSON.parse(cleaned);
      return res.status(200).json({ ok: true, result: parsed });
    } catch {
      return res.status(200).json({ ok: false, raw: text, error: "JSON parse failed" });
    }

  } catch (err) {
    console.error("Qwen-Turbo error:", err);
    return res.status(500).json({ error: err.message });
  }
};
