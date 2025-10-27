import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import pino from "pino";
import { Pool } from "pg";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(express.json({ limit: "1mb" }));

/** --------------------------------------------------------------
 *  CORS — allow configured origins + common dev + github.io/render
 *  -------------------------------------------------------------- */
const fromEnv = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DEFAULT_DEV = new Set([
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5500"
]);
function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin or curl/postman
  if (fromEnv.includes(origin) || DEFAULT_DEV.has(origin)) return true;
  try {
    const u = new URL(origin);
    // Allow GitHub Pages (user or org sites) and Render-hosted frontends by default
    if (u.hostname.endsWith(".github.io")) return true;
    if (u.hostname.endsWith(".onrender.com")) return true;
  } catch {
    /* ignore */
  }
  return false;
}
app.use(
  cors({
    origin(origin, cb) {
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    }
  })
);

/** --------------------------------------------------------------
 *  Optional PostgreSQL (Render Managed PG) for lightweight analytics
 *  -------------------------------------------------------------- */
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.PGSSLMODE === "disable"
          ? false
          : { rejectUnauthorized: false },
      max: 5
    })
  : null;

async function initAnalytics() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id           BIGSERIAL PRIMARY KEY,
      ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
      session_id   TEXT,
      user_agent   TEXT,
      ip           TEXT,
      page         TEXT,
      step         INTEGER,
      section_id   TEXT,
      event_name   TEXT NOT NULL,
      payload      JSONB
    );
  `);
  logger.info("Analytics table ready.");
}
initAnalytics().catch((err) =>
  logger.error({ err }, "Failed to init analytics")
);

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

async function recordEvent(row) {
  // row: { session_id, user_agent, ip, page, step, section_id, event_name, payload }
  if (pool) {
    await pool.query(
      `INSERT INTO events (session_id, user_agent, ip, page, step, section_id, event_name, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.session_id || null,
        row.user_agent || null,
        row.ip || null,
        row.page || null,
        Number.isFinite(row.step) ? row.step : null,
        row.section_id || null,
        row.event_name,
        row.payload || null
      ]
    );
  } else {
    logger.info({ type: "analytics", ...row }, "event");
  }
}

/** --------------------------------------------------------------
 *  Health
 *  -------------------------------------------------------------- */
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res, next) => {
  // If we're serving static, let the static middleware handle "/"
  if (process.env.SERVE_STATIC !== "false") return next();
  res.send("CE2407A AI‑Coach proxy is running.");
});

/** --------------------------------------------------------------
 *  Client-side analytics endpoint
 *  -------------------------------------------------------------- */
app.post("/api/track", async (req, res) => {
  try {
    const { event, page, step, sectionId, sessionId, payload } = req.body || {};
    if (!event || typeof event !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'event' field" });
    }

    const row = {
      session_id: typeof sessionId === "string" ? sessionId : null,
      user_agent: req.headers["user-agent"] || "",
      ip: clientIp(req),
      page: typeof page === "string" ? page : null,
      step: Number.isFinite(step) ? step : null,
      section_id: typeof sectionId === "string" ? sectionId : null,
      event_name: event.slice(0, 64),
      payload: payload && typeof payload === "object" ? payload : null
    };

    // Optional sampling: skip some events to reduce volume
    const sample = Number(process.env.ANALYTICS_SAMPLE ?? "1");
    if (sample < 1 && Math.random() > sample) {
      return res.json({ ok: true, sampled: false });
    }

    await recordEvent(row);
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "track failed");
    return res.status(500).json({ error: "track failed" });
  }
});

/** --------------------------------------------------------------
 *  Chat proxy + lightweight server-side analytics
 *  -------------------------------------------------------------- */
app.post("/api/chat", async (req, res) => {
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const OPENAI_API_BASE =
      process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    let { model = "gpt-4o-mini", temperature = 0.2, system = "", messages = [] } =
      req.body || {};
    if (!Array.isArray(messages)) messages = [];

    const clean = messages
      .filter((m) => m && typeof m.role === "string" && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: String(m.content) }));

    if (system && !clean.some((m) => m.role === "system")) {
      clean.unshift({ role: "system", content: String(system) });
    }

    const r = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: isNaN(Number(temperature)) ? 0.2 : Number(temperature),
        messages: clean
      })
    });

    const text = await r.text();
    if (!r.ok) {
      await recordEvent({
        session_id: req.headers["x-session-id"] || null,
        user_agent: req.headers["user-agent"] || "",
        ip: clientIp(req),
        page: req.headers["referer"] || null,
        step: null,
        section_id: null,
        event_name: "coach_chat_error",
        payload: { status: r.status, body: text.slice(0, 512) }
      });
      return res.status(r.status).json({ error: text });
    }

    const data = JSON.parse(text);
    const reply = data?.choices?.[0]?.message?.content ?? "";

    // --- Log a chat usage event (privacy-friendly by default)
    const lastUser = [...clean].reverse().find((m) => m.role === "user")?.content || "";
    const logChatContent = String(process.env.ANALYTICS_LOG_CHAT_CONTENT || "false") === "true";
    await recordEvent({
      session_id: req.headers["x-session-id"] || null,
      user_agent: req.headers["user-agent"] || "",
      ip: clientIp(req),
      page: req.headers["referer"] || null,
      step: null,
      section_id: null,
      event_name: "coach_chat",
      payload: {
        model,
        temperature: Number(temperature),
        prompt_len: lastUser.length,
        // Store only a small sample when explicitly enabled
        prompt_sample: logChatContent ? lastUser.slice(0, 500) : undefined,
        reply_len: reply.length
      }
    });

    return res.json({ reply });
  } catch (err) {
    logger.error({ err }, "Proxy error");
    return res.status(500).json({ error: "Proxy error" });
  }
});

/** --------------------------------------------------------------
 *  Static hosting (optional; default ON)
 *  Place your HTML in /public (e.g., public/index.html)
 *  -------------------------------------------------------------- */
if (process.env.SERVE_STATIC !== "false") {
  app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], maxAge: "1h" }));
  // Fallback to index.html for non-API routes (SPA-like)
  app.get(/^(?!\/api\/).+/, (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });
}

/** --------------------------------------------------------------
 *  Start
 *  -------------------------------------------------------------- */
const port = process.env.PORT || 3000;
app.listen(port, () => {
  logger.info(`AI coach proxy listening on :${port}`);
  logger.info(`Health check at: http://localhost:${port}/api/health`);
});
