const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CREDITS_PER_IMAGE = 10;

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

  const { data: profile } = await supabase
    .from("profiles")
    .select("credits, unlimited, plan")
    .eq("id", user.id)
    .single();

  if (!profile) return res.status(404).json({ error: "Profil introuvable" });
  if (!profile.unlimited && profile.credits < CREDITS_PER_IMAGE) {
    return res.status(403).json({ error: "Credits insuffisants" });
  }

  try {
    const { image_url } = req.body;
    if (!image_url) return res.status(400).json({ error: "Image requise" });

    const falResponse = await fetch("https://queue.fal.run/fal-ai/esrgan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Key " + process.env.FAL_KEY
      },
      body: JSON.stringify({ image_url: image_url, scale: 4 })
    });

    const falData = await falResponse.json();

    if (falData.request_id) {
      let result = null;
      let attempts = 0;
      while (!result && attempts < 60) {
        await new Promise(r => setTimeout(r, 3000));
        const statusRes = await fetch("https://queue.fal.run/fal-ai/esrgan/requests/" + falData.request_id, {
          headers: { "Authorization": "Key " + process.env.FAL_KEY }
        });
        const statusData = await statusRes.json();
        if (statusData.image) {
          result = statusData.image.url;
        } else if (statusData.status === "COMPLETED" && statusData.image) {
          result = statusData.image.url;
        }
        attempts++;
      }
      if (!result) return res.status(504).json({ error: "Timeout" });

      if (!profile.unlimited) {
        await supabase.from("profiles").update({
          credits: profile.credits - CREDITS_PER_IMAGE,
          images_generated: (profile.images_generated || 0) + 1
        }).eq("id", user.id);
      } else {
        await supabase.from("profiles").update({
          images_generated: (profile.images_generated || 0) + 1
        }).eq("id", user.id);
      }

      return res.status(200).json({ image_url: result });
    }

    if (falData.image) {
      if (!profile.unlimited) {
        await supabase.from("profiles").update({
          credits: profile.credits - CREDITS_PER_IMAGE,
          images_generated: (profile.images_generated || 0) + 1
        }).eq("id", user.id);
      }
      return res.status(200).json({ image_url: falData.image.url });
    }

    return res.status(500).json({ error: "Erreur fal.ai: " + JSON.stringify(falData) });

  } catch (err) {
    return res.status(500).json({ error: "Server error: " + err.message });
  }
};
