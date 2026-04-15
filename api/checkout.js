const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const PRICE_MAP = {
  "price_1TM83vDWe9VwpShT4qPHLsR8": { plan: "Pro", credits: 500, unlimited: false, period: "monthly" },
  "price_1TM84RDWe9VwpShTxY0YoPNZ": { plan: "Pro", credits: 500, unlimited: false, period: "annual" },
  "price_1TM84kDWe9VwpShTKzxJaaxX": { plan: "Premium", credits: 0, unlimited: true, period: "monthly" },
  "price_1TM85KDWe9VwpShTGj4Q4J09": { plan: "Premium", credits: 0, unlimited: true, period: "annual" },
};

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Non authentifie" });
  }
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: "Token invalide" });

  try {
    const { priceId } = req.body;
    if (!PRICE_MAP[priceId]) {
      return res.status(400).json({ error: "Prix invalide" });
    }

    const session = await stripe.checkout.sessions.create({
      allow_promotion_codes: true,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://retouch-landing.vercel.app/?success=true",
      cancel_url: "https://retouch-landing.vercel.app/?canceled=true",
      client_reference_id: user.id,
      customer_email: user.email,
      metadata: {
        userId: user.id,
        plan: PRICE_MAP[priceId].plan,
        credits: PRICE_MAP[priceId].credits.toString(),
        unlimited: PRICE_MAP[priceId].unlimited.toString(),
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: "Erreur Stripe: " + err.message });
  }
};
