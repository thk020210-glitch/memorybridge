// api/hunyuan.js
// Proxy for Tencent Hunyuan API (OpenAI-compatible endpoint)
// Handles intent classification for the voice input → repair chain
// Prompt: v7 final — 经过七轮迭代验证的正式版本

const HUNYUAN_ENDPOINT = "https://api.hunyuan.cloud.tencent.com/v1/chat/completions";

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
  修复照片本身已经存在的损伤，以及调整整体或不需要区分人物的
  诉求（不论是脸部、颜色、背景中的哪一类），不属于 unsupported，
  不要混淆

第三步：仅针对 intents 列表中的第一条诉求生成 variants，不论
intents 列表里是否存在第二条，variants 都只能围绕第一条诉求
展开，绝不能把第二条诉求的内容混入 variants 或者 confirmation_
phrase 的主体部分（第二条诉求只能出现在 confirmation_phrase
末尾"这个弄完了我们再说"那句话里，不能出现在其他任何地方）。
如果第一条诉求的 attribute_status 是 specific，同时
生成三条针对这个诉求的图像编辑指令文本。三条指令必须都是在满足
用户这条诉求本身的前提下，彼此之间要有明显、可感知的区别，不能
意思相近（可以是程度上的差异，比如轻微/适中/明显，也可以是风格
上的差异，根据诉求本身的性质选择更合适的区分方式），但不能有
任何一条偏离了诉求本身的核心意思（比如换新衣服这件事，三条都
应该是真的换成新衣服，不能有一条变成"清洗原有的衣服"）。每条
指令是一句可以直接用于图像编辑的具体描述。如果不是 specific，
这一项留空数组。

第四步：生成一句确认话术，用大白话说出你理解到的意思，语气亲切
自然，禁止使用"修复、增强、处理、优化"这类技术词汇，改用"弄
清楚、调一调、改一改"这类日常口语。这里的"贴近用户原话"指的是
保留用户话里的关键信息和整体语气基调，不是逐字复述用户说过的
句子。
- 如果第一条诉求是 specific：正常转述确认这个具体诉求
- 如果第一条诉求是 vague：转述为"我准备了几个方向给您看看，
  您挑一个"这类意思，不要说成"交给系统全权处理"，因为接下来
  用户依然会看到几个选项做选择
- 如果第一条诉求是 unsupported：不要说"没听清楚"，坦诚说明这个
  暂时处理不了，语气自然带过，不要显得沉重；如果是因为涉及
  "指定照片中某个具体人物"，可以说明"目前还没法单独调整照片
  里的某一个人，可以处理整张照片的调整"
- 如果列表里有第二条诉求，在确认话术末尾自然地带一句，说明
  "这个弄完了我们再说"

【判断细则】
- 核心原则：拿不准是 specific 还是 vague 时，一律判定为 vague，
  不要勉强当作具体诉求处理
- unsupported 的判定要谨慎，仅限于第二步里明确列出的两类情况，
  不要因为诉求"可能不属于某个特定类别"或"效果可能做不好"就
  归为不支持——只要是对这张照片本身某个方面的具体调整诉求，
  不论属于面部、色彩、背景中的哪一类，都应正常处理

【输出格式】
只输出纯 JSON 字符串，不能有任何其他文字、解释、markdown 代码块
标记。四个字段必须完整：intents、attribute_status、variants、
confirmation_phrase，缺一不可。variants 非 specific 时必须是
空数组 []，specific 时固定为长度 3 的数组。

{"intents": ["第一条诉求"] 或 ["第一条诉求", "第二条诉求"],
 "attribute_status": "specific" 或 "vague" 或 "unsupported",
 "variants": ["变体1指令", "变体2指令", "变体3指令"],
 "confirmation_phrase": "一句确认话术"}

【用户刚才说的话】
${transcript}
附加约束：本次任务输出必须严谨、稳定，减少随机变化，每次相同输入返回一致的判断结果。禁止输出思考过程，禁止额外文字，只输出JSON。只做文本判断，不需要任何形式的图片生成`;
}

module.exports = async function handler(req, res) {
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

  const prompt = buildPrompt(transcript, storyContext);

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
        max_tokens: 600
      })
    });

    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);

    const text = data?.choices?.[0]?.message?.content || "";
    // Strip any markdown fences the model might add despite instructions
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
