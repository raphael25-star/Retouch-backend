import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CREDITS_PER_IMAGE = 10;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const API_KEY = process.env.KIE_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: "API key not configured" });

  // ============ 1. VÉRIFIER L'UTILISATEUR ============
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Non authentifié" });
  }
  const token = authHeader.replace("Bearer ", "");

  // Vérifier le token Supabase
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: "Token invalide" });
  }

  // ============ 2. VÉRIFIER LES CRÉDITS ============
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("credits, unlimited, plan")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    return res.status(404).json({ error: "Profil introuvable" });
  }

  // Si pas illimité, vérifier les crédits
  if (!profile.unlimited && profile.credits < CREDITS_PER_IMAGE) {
    return res.status(403).json({ 
      error: "Crédits insuffisants", 
      credits: profile.credits,
      required: CREDITS_PER_IMAGE 
    });
  }

  // ============ 3. GÉNÉRATION (code existant) ============
  try {
    const { model, input } = req.body;
    let finalInput = { ...input };

    if (input.image_urls && input.image_urls.length > 0) {
      const uploadedUrls = [];
      for (const img of input.image_urls) {
        if (img.startsWith("data:")) {
          const upRes = await fetch("https://kieai.redpandaai.co/api/file-base64-upload", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + API_KEY },
            body: JSON.stringify({ base64Data: img, uploadPath: "images/retouch", fileName: "retouch-" + Date.now() + ".png" })
          });
          const upData = await upRes.json();
          if (upData.data?.downloadUrl) uploadedUrls.push(upData.data.downloadUrl);
          else return res.status(400).json({ error: "Upload failed" });
        } else uploadedUrls.push(img);
      }
      finalInput.image_urls = uploadedUrls;
    }

    if (input.image_input && input.image_input.length > 0) {
      const uploadedInputs = [];
      for (const img of input.image_input) {
        if (img.startsWith && img.startsWith("data:")) {
          const upRes = await fetch("https://kieai.redpandaai.co/api/file-base64-upload", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + API_KEY },
            body: JSON.stringify({ base64Data: img, uploadPath: "images/retouch", fileName: "retouch-" + Date.now() + ".png" })
          });
          const upData = await upRes.json();
          if (upData.data?.downloadUrl) uploadedInputs.push(upData.data.downloadUrl);
          else return res.status(400).json({ error: "Upload failed" });
        } else uploadedInputs.push(img);
      }
      finalInput.image_input = uploadedInputs;
    }

    const r1 = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + API_KEY },
      body: JSON.stringify({ model, input: finalInput })
    });
    const d1 = await r1.json();
    const taskId = d1.data?.taskId || d1.data?.task_id;
    if (!taskId) return res.status(400).json({ error: d1.msg || d1.message || JSON.stringify(d1) });

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
        } catch (e) { result = d2.data.resultJson; }
      } else if (d2.data?.state === "fail") {
        return res.status(500).json({ error: d2.data?.failMsg || "Generation failed" });
      }
      attempts++;
    }
    if (!result) return res.status(504).json({ error: "Timeout" });

    // ============ 4. DÉCOMPTER LES CRÉDITS ============
    if (!profile.unlimited) {
      await supabase
        .from("profiles")
        .update({ 
          credits: profile.credits - CREDITS_PER_IMAGE,
          images_generated: (profile.images_generated || 0) + 1
        })
        .eq("id", user.id);
    } else {
      // Même illimité, on compte les images générées
      await supabase
        .from("profiles")
        .update({ 
          images_generated: (profile.images_generated || 0) + 1
        })
        .eq("id", user.id);
    }

    return res.status(200).json({ 
      image_url: result,
      credits_remaining: profile.unlimited ? "unlimited" : profile.credits - CREDITS_PER_IMAGE
    });

  } catch (err) {
    return res.status(500).json({ error: "Server error: " + err.message });
  }
}
