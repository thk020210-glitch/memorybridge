// api/gemini.js
// Proxy for Google Gemini API — keeps API key server-side
// Handles two actions:
//   "analyze" — damage detection + face detection (returns JSON text)
//   "edit"    — image editing, returns edited base64 image

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

module.exports = async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "GEMINI_API_KEY not configured" });
  }

  const { action, imageBase64, mimeType, prompt, instruction } = req.body;

  try {
    if (action === "analyze") {
      // ── Photo analysis: damage + face detection ──────────────────────────
      const analysisPrompt = `Analyze this photograph carefully and return ONLY a JSON object with this exact structure, no other text:
{
  "damage": {
    "detected": boolean,
    "confidence": "high" | "medium" | "low",
    "area": "top-left" | "top-center" | "top-right" | "center-left" | "center" | "center-right" | "bottom-left" | "bottom-center" | "bottom-right" | null,
    "description": "brief Chinese description under 15 chars or null"
  },
  "face": {
    "detected": boolean,
    "area": "top-left" | "top-center" | "top-right" | "center-left" | "center" | "center-right" | "bottom-left" | "bottom-center" | "bottom-right" | "full",
    "personCount": number
  }
}

Rules:
- damage.detected = true only if there are clearly visible scratches, tears, folds, stains, or missing regions that significantly affect readability
- damage.confidence: high = very obvious damage, medium = noticeable but not severe, low = slight aging/fading only
- face.area should indicate where the MAJORITY of faces are located using the nine-grid system
- If multiple people, area should cover the region containing most of them`;

      const endpoint = `${GEMINI_BASE}/gemini-3.1-flash-image:generateContent?key=${key}`;
      const body = {
        contents: [{
          parts: [
            { text: analysisPrompt },
            { inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 } }
          ]
        }],
        generationConfig: { temperature: 0.1 }
      };

      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);

      // Extract text from response
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      // Clean any markdown fences
      const cleaned = text.replace(/```json\n?|```\n?/g, "").trim();
      try {
        const parsed = JSON.parse(cleaned);
        return res.status(200).json({ ok: true, result: parsed });
      } catch {
        return res.status(200).json({ ok: true, result: null, raw: text });
      }

    } else if (action === "edit") {
      // ── Image editing: single instruction → returns edited image ─────────
      const endpoint = `${GEMINI_BASE}/gemini-3.1-flash-image:generateContent?key=${key}`;
      const body = {
        contents: [{
          parts: [
            {
              text: `Edit this photograph according to the following instruction. 
Output ONLY the edited image, preserve all other aspects of the photo.
Instruction: ${instruction}`
            },
            { inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 } }
          ]
        }],
        generationConfig: {
          responseModalities: ["IMAGE", "TEXT"],
          temperature: 0.7
        }
      };

      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);

      // Extract image data from response parts
      const parts = data?.candidates?.[0]?.content?.parts || [];
      let imageData = null;
      let imageMime = "image/png";

      for (const part of parts) {
        if (part.inline_data?.data) {
          imageData = part.inline_data.data;
          imageMime = part.inline_data.mime_type || "image/png";
          break;
        }
        // Some versions use inlineData (camelCase)
        if (part.inlineData?.data) {
          imageData = part.inlineData.data;
          imageMime = part.inlineData.mimeType || "image/png";
          break;
        }
      }

      if (!imageData) {
        return res.status(200).json({
          ok: false,
          error: "No image returned",
          raw: data
        });
      }

      return res.status(200).json({ ok: true, imageBase64: imageData, mimeType: imageMime });

    } else {
      return res.status(400).json({ error: "Unknown action. Use 'analyze' or 'edit'." });
    }

  } catch (err) {
    console.error("Gemini proxy error:", err);
    return res.status(500).json({ error: err.message });
  }
}
