import "dotenv/config";
import express from "express";
import pkg from "pg";

const { Pool } = pkg;

const app = express();
app.use(express.json());

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  // Enable UUID extension
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  // Tenants table
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

  // Usage events table
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

app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({ ok: true, db: r.rows[0].ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post("/create-test-tenant", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email required" });
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