import "dotenv/config";

/** Prints the Gemini models available to the configured key (names only, never the key). */
const key = process.env.GEMINI_API_KEY ?? "";
if (!key) {
  console.error("GEMINI_API_KEY is empty in .env");
  process.exit(1);
}

const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=50`);
if (!res.ok) {
  console.error(`ListModels failed: http ${res.status}`);
  process.exit(1);
}
const data = (await res.json()) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
for (const m of data.models ?? []) {
  if (m.supportedGenerationMethods?.includes("generateContent")) {
    console.log(m.name.replace("models/", ""));
  }
}
