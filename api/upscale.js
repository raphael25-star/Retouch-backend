const { createClient } = require("@supabase/supabase-js");
const FormData = require("form-data");

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
    .select("credits, unlimited, plan, images_generated")
    .eq("id", user.id)
    .single();

  if (!profile) return res.status(404).json({ error: "Profil introuvable" });
  if (!profile.unlimited && profile.credits < CREDITS_PER_IMAGE) {
    return res.status(403).json({ error: "Credits insuffisants" });
  }

  try {
    const { image_url, prompt } = req.body;
    if (!image_url) return res.status(400).json({ error: "Image requise" });

    const finalPrompt = prompt || "Recreate this image in ultra high definition, realistic details, sharp focus, natural lighting. Preserve the original composition, subject and pose. Remove blur, noise and compression artifacts. Enhance textures and lighting while keeping a natural and realistic look..";

    let imageBuffer;
    if (image_url.startsWith("data:")) {
      const base64Data = image_url.split(",")[1];
      imageBuffer = Buffer.from(base64Data, "base64");
    } else {
      const imgRes = await fetch(image_url);
      imageBuffer = Buffer.from(await imgRes.arrayBuffer());
    }

    const form = new FormData();
    form.append("image", imageBuffer, { filename: "image.png", contentType: "image/png" });
    form.append("prompt", finalPrompt);
    form.append("model", "gpt-image-1");
    form.append("size", "1024x1024");

    const openaiRes = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
        ...form.getHeaders()
      },
      body: form
    });

    const openaiData = await openaiRes.json();

    if (openaiData.data && openaiData.data[0]) {
      const resultUrl = openaiData.data[0].url || openaiData.data[0].b64_json;

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

      return res.status(200).json({ image_url: resultUrl });
    }

    return res.status(500).json({ error: "Erreur OpenAI: " + JSON.stringify(openaiData) });

  } catch (err) {
    return res.status(500).json({ error: "Server error: " + err.message });
  }
};
