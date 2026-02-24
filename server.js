import "dotenv/config";
import express from "express";
import pkg from "pg";
import OpenAI from "openai";

const { Pool } = pkg;

const app = express();
app.use(express.json({ limit: "1mb" }));

// REQUIRED ENV
if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}
if (!process.env.GATEWAY_SHARED_SECRET) {
  console.error("Missing GATEWAY_SHARED_SECRET");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function initDB() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      subscription_status TEXT NOT NULL DEFAULT 'inactive',
      monthly_token_limit INTEGER NOT NULL DEFAULT 400000,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID REFERENCES tenants(id),
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  console.log("Tables ensured");
}

// Health check
app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({ ok: true, db: r.rows[0].ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// TEMP test route (browser friendly)
app.get("/create-test-tenant", async (req, res) => {
  try {
    const email = req.query.email;

    if (!email) {
      return res.status(400).json({ error: "Add ?email=you@example.com" });
    }

    const result = await pool.query(
      `INSERT INTO tenants (email, subscription_status)
       VALUES ($1, 'active')
       RETURNING *`,
      [email]
    );

    res.json({ success: true, tenant: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * LLM Gateway (token enforced)
 * Headers:
 *  - x-tenant-id: tenant UUID
 *  - x-shared-secret: must equal GATEWAY_SHARED_SECRET (prevents public abuse)
 *
 * Body:
 *  { "messages": [...], "max_tokens": 500 }
 */
app.post("/llm/chat", async (req, res) => {
  try {
    const tenantId = req.header("x-tenant-id");
    const sharedSecret = req.header("x-shared-secret");

    if (!tenantId) return res.status(400).json({ error: "Missing x-tenant-id" });
    if (!sharedSecret) return res.status(400).json({ error: "Missing x-shared-secret" });
    if (sharedSecret !== process.env.GATEWAY_SHARED_SECRET) {
      return res.status(401).json({ error: "Bad shared secret" });
    }

    const { messages, max_tokens } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages must be a non-empty array" });
    }

    const MAX_OUTPUT = 500;
    const maxOut = Math.min(Number(max_tokens || MAX_OUTPUT), MAX_OUTPUT);

    // Load tenant
    const t = await pool.query(
      `SELECT id, subscription_status, monthly_token_limit, tokens_used
       FROM tenants WHERE id = $1`,
      [tenantId]
    );
    if (t.rows.length === 0) return res.status(404).json({ error: "Tenant not found" });

    const tenant = t.rows[0];

    if (tenant.subscription_status !== "active") {
      return res.status(403).json({ error: "Subscription inactive" });
    }

    // Call OpenAI (locked to gpt-4o-mini for $7.99 plan)
    const model = "gpt-4o-mini";

    const completion = await openai.chat.completions.create({
      model,
      messages,
      max_tokens: maxOut,
    });

    const inputTokens = completion.usage?.prompt_tokens ?? 0;
    const outputTokens = completion.usage?.completion_tokens ?? 0;
    const totalTokens = completion.usage?.total_tokens ?? (inputTokens + outputTokens);

    // Enforce token limit AFTER actual usage known
    const newUsed = Number(tenant.tokens_used) + Number(totalTokens);
    if (newUsed > Number(tenant.monthly_token_limit)) {
      return res.status(402).json({
        error: "Token limit reached",
        tokens_used: tenant.tokens_used,
        monthly_token_limit: tenant.monthly_token_limit,
      });
    }

    // Persist usage
    await pool.query(
      `INSERT INTO usage_events (tenant_id, model, input_tokens, output_tokens, total_tokens)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, model, inputTokens, outputTokens, totalTokens]
    );

    await pool.query(
      `UPDATE tenants SET tokens_used = $1 WHERE id = $2`,
      [newUsed, tenantId]
    );

    res.json({
      model,
      usage: { inputTokens, outputTokens, totalTokens },
      tokens_used: newUsed,
      monthly_token_limit: tenant.monthly_token_limit,
      message: completion.choices?.[0]?.message ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 8080;

app.listen(port, async () => {
  try {
    await initDB();
    console.log(`API running on ${port}`);
  } catch (err) {
    console.error("DB init failed:", err);
    process.exit(1);
  }
});