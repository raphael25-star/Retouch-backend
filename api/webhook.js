const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const event = req.body;

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

      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const userId = subscription.metadata?.userId;

        if (userId) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("plan, unlimited")
            .eq("id", userId)
            .single();

          if (profile && !profile.unlimited) {
            const credits = profile.plan === "Pro" ? 500 : 0;
            await supabase
              .from("profiles")
              .update({ credits: credits })
              .eq("id", userId);
          }
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
