const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CREDITS_PER_IMAGE = 10;

// Mapping du ratio user vers les ratios acceptés par Nano Banana Pro
function mapRatioToAspect(ratio) {
  switch (ratio) {
    case "1:1":  return "1:1";
    case "9:16": return "9:16";
    case "4:5":  return "4:5";
    case "3:4":  return "3:4";
    case "16:9": return "16:9";
    default:     return "1:1";
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const API_KEY = process.env.KIE_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: "API key not configured" });

  // ============ 1. AUTH ============
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Non authentifié" });
  }
  const token = authHeader.replace("Bearer ", "");

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: "Token invalide" });

  // ============ 2. CRÉDITS ============
  const { data: profile } = await supabase
    .from("profiles")
    .select("credits, unlimited, plan, images_generated")
    .eq("id", user.id)
    .single();

  if (!profile) return res.status(404).json({ error: "Profil introuvable" });
  if (!profile.unlimited && profile.credits < CREDITS_PER_IMAGE) {
    return res.status(403).json({ error: "Crédits insuffisants" });
  }

  // ============ 3. GÉNÉRATION VIA NANO BANANA PRO ============
  try {
    const { image_url, prompt, ratio, resolution } = req.body;
    if (!image_url) return res.status(400).json({ error: "Image requise" });

    // Prompt expert généraliste pour restauration / amélioration HD hyper-réaliste
    // Inspiré du master prompt Higgsfield - fonctionne pour tout type de photo
    const expertPrompt = "Restore and enhance this image into a hyper-detailed, ultra-realistic high-resolution photograph. Preserve EXACTLY the subject's identity, age, gender, facial features, body type, and ethnicity as shown in the original image. Preserve EXACTLY the clothing, accessories, hair, pose, expression, and framing. Preserve EXACTLY the background, environment, and other people present in the scene. Apply hyper-detailed realism: visible skin pores, natural skin texture and imperfections, realistic hair strands, fabric texture, realistic shadows and lighting. Match the original light direction, color temperature, and atmosphere of the scene exactly - do not modernize, do not change to studio lighting. Apply realistic photographic qualities: organic sharpness, micro-contrast, slight digital grain, natural color rendering, smartphone photography aesthetic. The result should feel real, imperfect, human, and unretouched - like a genuine smartphone photo, not AI-generated, not polished, not beautified. Do NOT change the subject's age. Do NOT change the subject's identity. Do NOT add or remove people. Do NOT modify clothing or accessories. Do NOT modernize the scene. Do NOT make it look like a studio photo.";

    // Si l'user a fourni un prompt additionnel, on l'ajoute
    const finalPrompt = prompt
      ? expertPrompt + " Additional user instructions: " + prompt
      : expertPrompt;

    // Mapping du ratio
    const aspectRatio = mapRatioToAspect(ratio || "1:1");

    // ─── LOGS ───
    console.log("[Upscale Pro] User:", user.id);
    console.log("[Upscale Pro] Plan:", profile.plan, "| Crédits:", profile.unlimited ? "illimité" : profile.credits);
    console.log("[Upscale Pro] Ratio:", aspectRatio);
    console.log("[Upscale Pro] Resolution user:", resolution);
    console.log("[Upscale Pro] Modèle: nano-banana-pro");

    // ============ 4. UPLOAD IMAGE BASE64 → URL Kie.ai ============
    let imageUrlForKie = image_url;
    if (image_url.startsWith("data:")) {
      console.log("[Upscale Pro] Upload base64 vers Kie.ai...");
      const upRes = await fetch("https://kieai.redpandaai.co/api/file-base64-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + API_KEY },
        body: JSON.stringify({
          base64Data: image_url,
          uploadPath: "images/retouch",
          fileName: "upscale-" + Date.now() + ".png"
        })
      });
      const upData = await upRes.json();
      if (!upData.data?.downloadUrl) {
        console.error("[Upscale Pro] ✗ Upload échoué:", JSON.stringify(upData).slice(0, 200));
        return res.status(400).json({ error: "Upload image failed" });
      }
      imageUrlForKie = upData.data.downloadUrl;
      console.log("[Upscale Pro] ✓ Image uploadée:", imageUrlForKie.slice(0, 80));
    }

    // ============ 5. APPEL NANO BANANA PRO via Kie.ai ============
    const finalInput = {
      prompt: finalPrompt,
      image_input: [imageUrlForKie],
      aspect_ratio: aspectRatio
    };

    console.log("[Upscale Pro] Création tâche Kie.ai...");
    const r1 = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + API_KEY },
      body: JSON.stringify({ model: "nano-banana-pro", input: finalInput })
    });
    const d1 = await r1.json();
    const taskId = d1.data?.taskId || d1.data?.task_id;
    if (!taskId) {
      console.error("[Upscale Pro] ✗ Erreur création tâche:", JSON.stringify(d1).slice(0, 300));
      return res.status(400).json({ error: d1.msg || d1.message || "Erreur création tâche" });
    }
    console.log("[Upscale Pro] ✓ Tâche créée:", taskId);

    // ============ 6. POLLING DU RÉSULTAT ============
    let result = null;
    let attempts = 0;
    while (!result && attempts < 60) {
      await new Promise(r => setTimeout(r, 3000));
      const r2 = await fetch("https://api.kie.ai/api/v1/jobs/recordInfo?taskId=" + taskId, {
        headers: { "Authorization": "Bearer " + API_KEY }
      });
      const d2 = await r2.json();
      if (d2.data?.state === "success" && d2.data?.resultJson) {
        try {
          const parsed = JSON.parse(d2.data.resultJson);
          if (parsed.resultUrls && parsed.resultUrls.length > 0) result = parsed.resultUrls[0];
          else if (parsed.image_url) result = parsed.image_url;
          else result = d2.data.resultJson;
        } catch (e) {
          result = d2.data.resultJson;
        }
      } else if (d2.data?.state === "fail") {
        const failMsg = d2.data?.failMsg || "Generation failed";
        console.error("[Upscale Pro] ✗ Échec:", failMsg);
        return res.status(500).json({ error: failMsg });
      }
      attempts++;
    }
    if (!result) {
      console.error("[Upscale Pro] ✗ Timeout après 60 tentatives");
      return res.status(504).json({ error: "Timeout" });
    }
    console.log("[Upscale Pro] ✓ Génération réussie");

    // ============ 7. DÉCOMPTE CRÉDITS ============
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
      image_url: result,
      credits_remaining: profile.unlimited ? "unlimited" : profile.credits - CREDITS_PER_IMAGE
    });

  } catch (err) {
    console.error("[Upscale Pro] ✗ Erreur serveur:", err.message);
    return res.status(500).json({ error: "Server error: " + err.message });
  }
};
