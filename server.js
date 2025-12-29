import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 5176;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.get("/health", (req, res) => res.json({ ok: true }));

function parseWeekdays(text = "") {
  const t = text.toLowerCase();
  const map = [
    [/sun(day)?/g, 0],
    [/mon(day)?/g, 1],
    [/tue(s(day)?)?|tues(day)?/g, 2],
    [/wed(nesday)?/g, 3],
    [/thu(rs(day)?)?|thurs(day)?/g, 4],
    [/fri(day)?/g, 5],
    [/sat(urday)?/g, 6]
  ];
  const out = new Set();
  for (const [re, i] of map) if (re.test(t)) out.add(i);
  return [...out].sort();
}

function impliesWholeYear(text = "") {
  return /(of the year|all year|entire year|throughout the year|for the year|every week)/i.test(text);
}

app.post("/api/parse", upload.array("images", 10), async (req, res) => {
  try {
    const text = (req.body?.text || "").trim();

    const weekdayHints = parseWeekdays(text);
    const wantsYear = impliesWholeYear(text);

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
              days_of_week: {
                type: ["array", "null"],
                items: { type: "integer", minimum: 0, maximum: 6 },
                description: "Weekly recurrence weekdays (Sun=0..Sat=6). Use with start_date/end_date."
              },
              title: { type: "string" },
              details: { type: "string" },
              all_day: { type: "boolean" },
              start_time: { type: ["string", "null"], description: "HH:MM 24h or null" },
              end_time: { type: ["string", "null"], description: "HH:MM 24h or null" }
            },
            required: ["date","start_date","end_date","days_of_week","title","details","all_day","start_time","end_time"]
          }
        }
      },
      required: ["events"]
    };

    const instructions = `
Extract calendar events for year 2026 only.

Rules:
- Single day -> use "date"
- Continuous span -> start_date/end_date
- Weekly recurring events (e.g. "every Monday and Thursday") -> use start_date/end_date + days_of_week (Sun=0..Sat=6).
  Do NOT create daily events.
- If no time given -> all_day=true and times null.
Return JSON only that matches the schema.
`.trim();

    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5-2025-08-07",
      input: [
        { role: "system", content: instructions },
        { role: "user", content: text }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "calendar_events",
          schema,
          strict: true
        }
      }
      // ✅ IMPORTANT: no "temperature" here (not supported for this model)
    });

    // extract output_text
    let outputText = null;
    for (const item of (response.output || [])) {
      if (item.type === "message") {
        for (const c of (item.content || [])) {
          if (c.type === "output_text") outputText = c.text;
        }
      }
    }
    if (!outputText) return res.status(500).json({ error: "No output_text found", raw: response });

    let data;
    try {
      data = JSON.parse(outputText);
    } catch {
      return res.status(500).json({ error: "Model returned invalid JSON", raw: outputText });
    }

    // If user clearly indicates weekdays + "of the year" and model forgot days_of_week, enforce it.
    if (weekdayHints.length && wantsYear && Array.isArray(data.events)) {
      data.events = data.events.map(e => {
        const hasRange = !e.date && e.start_date && e.end_date;
        const missingDOW = !Array.isArray(e.days_of_week) || e.days_of_week.length === 0;
        if (hasRange && missingDOW) return { ...e, days_of_week: weekdayHints };
        return e;
      });
    }

    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

const server = app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Port ${PORT} is already in use.`);
    console.error(`Try: PORT=5177 npm start`);
    process.exit(1);
  } else {
    console.error(err);
    process.exit(1);
  }
});
