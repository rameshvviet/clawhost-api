import "dotenv/config";
import express from "express";
import pkg from "pg";
import OpenAI from "openai";
import Stripe from "stripe";

const { Pool } = pkg;

const app = express();

if (!process.env.DATABASE_URL) process.exit(1);
if (!process.env.OPENAI_API_KEY) process.exit(1);
if (!process.env.GATEWAY_SHARED_SECRET) process.exit(1);
if (!process.env.STRIPE_SECRET_KEY) process.exit(1);
if (!process.env.STRIPE_PRICE_ID) process.exit(1);
if (!process.env.STRIPE_WEBHOOK_SECRET) process.exit(1);
if (!process.env.APP_BASE_URL) process.exit(1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// 1) Stripe webhook MUST be raw body and MUST be declared before json parser
app.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const email = session.customer_email;
      const customerId = session.customer;
      const subscriptionId = session.subscription;

      // Upsert tenant
      const existing = await pool.query("SELECT id FROM tenants WHERE email=$1", [email]);

      if (existing.rows.length === 0) {
        await pool.query(
          `INSERT INTO tenants (email, subscription_status, stripe_customer_id, stripe_subscription_id)
           VALUES ($1, 'active', $2, $3)`,
          [email, customerId, subscriptionId]
        );
      } else {
        await pool.query(
          `UPDATE tenants
           SET subscription_status='active',
               stripe_customer_id=$1,
               stripe_subscription_id=$2
           WHERE email=$3`,
          [customerId, subscriptionId, email]
        );
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// 2) JSON parser for everything else
app.use(express.json({ limit: "1mb" }));

async function initDB() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  // Create base table (older versions might already exist)
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

  // ✅ Add Stripe columns if missing (one-time migration)
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;`);

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

  console.log("Tables ensured + migrations ensured");
}

app.get("/health", async (req, res) => {
  const r = await pool.query("SELECT 1 as ok");
  res.json({ ok: true, db: r.rows[0].ok });
});

app.post("/create-checkout-session", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    customer_email: email,
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${process.env.APP_BASE_URL}/success`,
    cancel_url: `${process.env.APP_BASE_URL}/cancel`
  });

  res.json({ url: session.url });
});

app.post("/llm/chat", async (req, res) => {
  const tenantId = req.header("x-tenant-id");
  const sharedSecret = req.header("x-shared-secret");

  if (sharedSecret !== process.env.GATEWAY_SHARED_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!tenantId) return res.status(400).json({ error: "Missing x-tenant-id" });

  const { messages, max_tokens } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages must be a non-empty array" });
  }

  const t = await pool.query(`SELECT * FROM tenants WHERE id=$1`, [tenantId]);
  if (t.rows.length === 0) return res.status(404).json({ error: "Tenant not found" });

  const tenant = t.rows[0];

  if (tenant.subscription_status !== "active") {
    return res.status(403).json({ error: "Subscription inactive" });
  }

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    max_tokens: Math.min(Number(max_tokens || 500), 500)
  });

  const usage = completion.usage;
  const totalTokens = usage.total_tokens;

  const newUsed = Number(tenant.tokens_used) + Number(totalTokens);
  if (newUsed > Number(tenant.monthly_token_limit)) {
    return res.status(402).json({ error: "Token limit reached" });
  }

  await pool.query(
    `INSERT INTO usage_events (tenant_id, model, input_tokens, output_tokens, total_tokens)
     VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, "gpt-4o-mini", usage.prompt_tokens, usage.completion_tokens, totalTokens]
  );

  await pool.query(`UPDATE tenants SET tokens_used=$1 WHERE id=$2`, [newUsed, tenantId]);

  res.json({
    message: completion.choices[0].message,
    tokens_used: newUsed,
    monthly_token_limit: tenant.monthly_token_limit
  });
});

const port = process.env.PORT || 8080;

app.listen(port, async () => {
  await initDB();
  console.log(`API running on ${port}`);
});