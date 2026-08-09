import "dotenv/config";

/** Diagnoses which Gemini call shapes the key's tier allows (prints statuses only). */
const key = process.env.GEMINI_API_KEY ?? "";
if (!key) { console.error("GEMINI_API_KEY empty"); process.exit(1); }

async function probe(label: string, model: string, grounded: boolean): Promise<void> {
  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: "Reply with exactly: OK" }] }],
    generationConfig: { temperature: 0 },
  };
  if (grounded) body.tools = [{ google_search: {} }];
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
    const detail = res.ok ? "" : ` — ${(await res.text()).slice(0, 120).replace(/\s+/g, " ")}`;
    console.log(`${label}: http ${res.status}${detail}`);
  } catch (err) {
    console.log(`${label}: ${String((err as Error).message).slice(0, 100)}`);
  }
}

await probe("ungrounded gemini-flash-latest", "gemini-flash-latest", false);
await probe("ungrounded gemini-flash-lite-latest", "gemini-flash-lite-latest", false);
await probe("grounded   gemini-flash-latest", "gemini-flash-latest", true);
