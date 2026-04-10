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
    const r1 = await fetch("https://api.kie.ai/api/v1/task", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + API_KEY }, body: JSON.stringify({ model, input }) });
    const d1 = await r1.json();
    if (d1.code !== 0 || !d1.data?.task_id) return res.status(400).json({ error: d1.message || "Task creation failed" });
    const taskId = d1.data.task_id;
    let result = null;
    let attempts = 0;
    while (!result && attempts < 60) {
      await new Promise(r => setTimeout(r, 3000));
      const r2 = await fetch("https://api.kie.ai/api/v1/task/" + taskId, { headers: { "Authorization": "Bearer " + API_KEY } });
      const d2 = await r2.json();
      if (d2.data?.status === "completed" && d2.data?.output?.image_url) result = d2.data.output.image_url;
      else if (d2.data?.status === "failed") return res.status(500).json({ error: "Generation failed" });
      attempts++;
    }
    if (!result) return res.status(504).json({ error: "Timeout" });
    return res.status(200).json({ image_url: result });
  } catch (err) { return res.status(500).json({ error: "Server error" }); }
}
