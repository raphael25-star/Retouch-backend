export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const API_KEY = process.env.KIE_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: "API key not configured" });
  try {
    const { model, input } = req.body;
    let finalInput = { ...input };
    if (input.image_urls && input.image_urls.length > 0) {
      const uploadedUrls = [];
      for (const img of input.image_urls) {
        if (img.startsWith("data:")) {
          const uploadRes = await fetch("https://kieai.redpandaai.co/api/upload/base64", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + API_KEY }, body: JSON.stringify({ base64: img, fileName: "retouch-" + Date.now() + ".png" }) });
          const uploadData = await uploadRes.json();
          if (uploadData.data?.fileUrl) { uploadedUrls.push(uploadData.data.fileUrl); }
          else { return res.status(400).json({ error: "Image upload failed" }); }
        } else { uploadedUrls.push(img); }
      }
      finalInput.image_urls = uploadedUrls;
    }
    if (input.image_input && input.image_input.length > 0) {
      const uploadedInputs = [];
      for (const img of input.image_input) {
        if (img.startsWith && img.startsWith("data:")) {
          const uploadRes = await fetch("https://kieai.redpandaai.co/api/upload/base64", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + API_KEY }, body: JSON.stringify({ base64: img, fileName: "retouch-" + Date.now() + ".png" }) });
          const uploadData = await uploadRes.json();
          if (uploadData.data?.fileUrl) { uploadedInputs.push(uploadData.data.fileUrl); }
          else { return res.status(400).json({ error: "Image upload failed" }); }
        } else { uploadedInputs.push(img); }
      }
      finalInput.image_input = uploadedInputs;
    }
    const r1 = await fetch("https://api.kie.ai/api/v1/jobs/createTask", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + API_KEY }, body: JSON.stringify({ model, input: finalInput }) });
    const d1 = await r1.json();
    const taskId = d1.data?.taskId || d1.data?.task_id;
    if (!taskId) return res.status(400).json({ error: d1.msg || d1.message || JSON.stringify(d1) });
    let result = null;
    let attempts = 0;
    while (!result && attempts < 60) {
      await new Promise(r => setTimeout(r, 3000));
      const r2 = await fetch("https://api.kie.ai/api/v1/jobs/" + taskId, { headers: { "Authorization": "Bearer " + API_KEY } });
      const d2 = await r2.json();
      const output = d2.data?.output;
      if (output?.image_url) { result = output.image_url; }
      else if (Array.isArray(output?.images) && output.images.length > 0) { result = output.images[0].url || output.images[0]; }
      else if (d2.data?.status === "failed") return res.status(500).json({ error: "Generation failed" });
      attempts++;
    }
    if (!result) return res.status(504).json({ error: "Timeout" });
    return res.status(200).json({ image_url: result });
  } catch (err) { return res.status(500).json({ error: "Server error: " + err.message }); }
}
