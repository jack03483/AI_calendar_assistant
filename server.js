import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB/file

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

function toDataUrl(file) {
  const b64 = file.buffer.toString("base64");
  return `data:${file.mimetype};base64,${b64}`;
}

function extractOutputText(data) {
  // 1) Sometimes present as a convenience field
  if (typeof data?.output_text === "string" && data.output_text.length > 0) {
    return data.output_text;
  }

  // 2) Common shape: data.output is an array of items (reasoning, message, tool, etc.)
  const out = data?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      const content = item?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type === "output_text" && typeof c.text === "string" && c.text.length > 0) {
          return c.text;
        }
      }
    }
  }

  return null;
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/parse", upload.array("images", 8), async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY env var." });

    const model = process.env.OPENAI_MODEL || "gpt-5";
    const text = (req.body.text || "").toString().slice(0, 8000);
    const files = req.files || [];

    const userContent = [];
    if (text.trim()) userContent.push({ type: "input_text", text });

    for (const f of files) {
      if (f.mimetype && f.mimetype.startsWith("image/")) {
        userContent.push({ type: "input_image", image_url: toDataUrl(f) });
      }
    }

    if (userContent.length === 0) {
      return res.status(400).json({ error: "Provide text and/or at least one image." });
    }

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        events: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              date: { type: ["string", "null"], description: "YYYY-MM-DD for single-day events" },
              start_date: { type: ["string", "null"], description: "YYYY-MM-DD for range start" },
              end_date: { type: ["string", "null"], description: "YYYY-MM-DD for range end (inclusive)" },
              title: { type: "string" },
              details: { type: "string" },
              all_day: { type: "boolean" },
              start_time: { type: ["string", "null"], description: "HH:MM 24h or null" },
              end_time: { type: ["string", "null"], description: "HH:MM 24h or null" }
            },
            required: ["date","start_date","end_date","title","details","all_day","start_time","end_time"]
          }
        }
      },
      required: ["events"]
    };

    const instructions = [
      "Extract calendar events from the user's text and images.",
      "Assume the year is 2026 unless explicitly stated otherwise.",
      "If the user gives a date range (e.g., 'Jan 5th to Jan 16th'), set date=null and set start_date/end_date.",
      "If single-day, set date and leave start_date/end_date null.",
      "Return ONLY JSON that matches the schema exactly."
    ].join(" ");

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: [{ type: "input_text", text: instructions }] },
          { role: "user", content: userContent }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "calendar_events",
            schema,
            strict: true
          }
        }
      })
    });

    if (!r.ok) {
      const err = await r.text();
      console.error("OpenAI API error status:", r.status);
      console.error("OpenAI API error body:", err);
      return res.status(500).json({ error: "OpenAI API error", status: r.status, details: err });
    }

    const data = await r.json();
    const outputText = extractOutputText(data);

    if (!outputText) {
      return res.status(500).json({ error: "No output_text found", raw: data });
    }

    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      return res.status(500).json({ error: "Model returned non-JSON", outputText });
    }

    return res.json({ events: parsed.events || [] });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

app.listen(5176, () => {
  console.log("✅ Server running at http://localhost:5176");
  console.log("   Health: http://localhost:5176/api/health");
});
