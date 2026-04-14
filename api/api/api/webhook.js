import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export const config = {
  api: { bodyParser: false },
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const buf = await buffer(req);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(buf.toString());
    }
  } catch (err) {
    return res.status(400).json({ error: "Webhook Error: " + err.message });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata?.userId || session.client_reference_id;
    const plan = session.metadata?.plan;
    const credits = parseInt(session.metadata?.credits || "0");
    const unlimited = session.metadata?.unlimited === "true";

    if (userId && plan) {
      await supabase
        .from("profiles")
        .update({
          plan: plan,
          credits: unlimited ? 0 : credits,
          unlimited: unlimited,
        })
        .eq("id", userId);
    }
  }

  if (event.type === "invoice.paid") {
    const invoice = event.data.object;
    const subscriptionId = invoice.subscription;

    // Récupérer la subscription pour avoir les metadata
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const userId = subscription.metadata?.userId;

    if (userId) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("plan, unlimited")
        .eq("id", userId)
        .single();

      if (profile && !profile.unlimited) {
        // Renouveler les crédits pour le plan Pro
        const credits = profile.plan === "Pro" ? 500 : 0;
        await supabase
          .from("profiles")
          .update({ credits: credits })
          .eq("id", userId);
      }
    }
  }

  return res.status(200).json({ received: true });
}
