const { createClient } = require("@supabase/supabase-js");
const https = require("https");
const FormData = require("form-data");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CREDITS_PER_IMAGE = 10;

function callOpenAI(form) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.openai.com",
      path: "/v1/images/edits",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
        ...form.getHeaders()
      }
    };
    const request = https.request(options, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Réponse OpenAI invalide: " + data.slice(0, 200)));
        }
      });
    });
    request.on("error", reject);
    form.pipe(request);
  });
}

// Mapping du ratio user vers la taille acceptée par GPT-Image
// GPT-Image n'accepte que: 1024x1024, 1024x1536, 1536x1024
function mapRatioToSize(ratio) {
  switch (ratio) {
    case "1:1":  return "1024x1024";
    case "9:16": return "1024x1536"; // vertical le plus proche
    case "4:5":  return "1024x1536"; // vertical proche
    case "3:4":  return "1024x1536"; // vertical proche
    case "16:9": return "1536x1024"; // horizontal
    default:     return "1024x1024";
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Non authentifié" });
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
    return res.status(403).json({ error: "Crédits insuffisants" });
  }

  try {
    const { image_url, prompt, ratio, resolution } = req.body;
    if (!image_url) return res.status(400).json({ error: "Image requise" });

    // Prompt expert ultra-contraignant pour une recréation fidèle
    const expertPrompt = "Recreate the uploaded image as a faithful modern 4K version. Use the uploaded image as the main visual reference. Keep the same composition, camera angle, pose, clothing, lighting, colors, background, mood, and atmosphere. Preserve the subject's facial structure and overall identity as much as possible. Reconstruct missing details naturally and realistically. Do not redesign the scene. Do not create a different person. Do not turn it into a studio photo. The result should look like the same moment captured today with a high-end modern camera.";

    // Si l'user a fourni un prompt additionnel, on l'ajoute en fin
    const finalPrompt = prompt
      ? expertPrompt + " Additional user instructions: " + prompt
      : expertPrompt;

    // Mapping du ratio choisi par l'user vers une taille OpenAI valide
    const sizeForOpenAI = mapRatioToSize(ratio || "1:1");

    // Conversion image en buffer
    let imageBuffer;
    if (image_url.startsWith("data:")) {
      const base64Data = image_url.split(",")[1];
      imageBuffer = Buffer.from(base64Data, "base64");
    } else {
      const imgRes = await fetch(image_url);
      imageBuffer = Buffer.from(await imgRes.arrayBuffer());
    }

    // ─── LOGS DÉTAILLÉS ───
    console.log("[Upscale] User:", user.id);
    console.log("[Upscale] Plan:", profile.plan, "| Crédits:", profile.unlimited ? "illimité" : profile.credits);
    console.log("[Upscale] Ratio user:", ratio, "→ Size OpenAI:", sizeForOpenAI);
    console.log("[Upscale] Resolution user (informatif, pas envoyé à OpenAI):", resolution);
    console.log("[Upscale] Image buffer size:", (imageBuffer.length / 1024).toFixed(1), "KB");
    console.log("[Upscale] Modèle: gpt-image-1");
    console.log("[Upscale] Quality: high");
    console.log("[Upscale] Prompt envoyé:", finalPrompt.slice(0, 200) + "...");

    // Construction du form-data pour OpenAI
    const form = new FormData();
    form.append("image", imageBuffer, { filename: "image.png", contentType: "image/png" });
    form.append("prompt", finalPrompt);
    form.append("model", "gpt-image-1");
    form.append("size", sizeForOpenAI);
    form.append("quality", "high"); // qualité maximale pour rendu pro

    const openaiData = await callOpenAI(form);

    if (openaiData.data && openaiData.data[0]) {
      let resultUrl = openaiData.data[0].url;
      if (!resultUrl && openaiData.data[0].b64_json) {
        resultUrl = "data:image/png;base64," + openaiData.data[0].b64_json;
      }

      console.log("[Upscale] ✓ Génération réussie | Taille résultat:", resultUrl.length > 100 ? (resultUrl.length / 1024).toFixed(1) + " KB (b64)" : resultUrl.slice(0, 80));

      // Décompte des crédits
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

      return res.status(200).json({
        image_url: resultUrl,
        credits_remaining: profile.unlimited ? "unlimited" : profile.credits - CREDITS_PER_IMAGE
      });
    }

    console.error("[Upscale] ✗ Erreur OpenAI:", JSON.stringify(openaiData).slice(0, 300));
    return res.status(500).json({ error: "Erreur OpenAI: " + JSON.stringify(openaiData).slice(0, 200) });

  } catch (err) {
    console.error("[Upscale] ✗ Erreur serveur:", err.message);
    return res.status(500).json({ error: "Server error: " + err.message });
  }
};
