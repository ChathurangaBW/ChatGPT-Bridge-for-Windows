import assert from "node:assert/strict";

const baseUrl = (process.env.BRIDGE_SMOKE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

async function main() {
  const landing = await fetch(`${baseUrl}/`);
  assert.equal(landing.status, 200);
  assert.match(landing.headers.get("content-type") ?? "", /text\/html/i);
  const landingHtml = await landing.text();
  assert.match(landingHtml, /Bridge relay online/);
  assert.match(landingHtml, /Connect VS Code to ChatGPT/);
  assert.match(landingHtml, /ChatGPT Bridge: Open Setup/);
  assert.match(landingHtml, new RegExp(`${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/mcp`));
  assert.doesNotMatch(landingHtml, /OPENAI_API_KEY|tunnel ID required|ChatGPTBridge\.exe/i);

  const pairing = await fetch(`${baseUrl}/pair/ABCD-EFGH-JKLM`);
  assert.equal(pairing.status, 200);
  assert.match(pairing.headers.get("content-type") ?? "", /text\/html/i);
  const pairingHtml = await pairing.text();
  assert.match(pairingHtml, /Pair this VS Code with ChatGPT/);
  assert.match(pairingHtml, /ABCD-EFGH-JKLM/);
  assert.match(pairingHtml, /OpenAI API key/);

  console.log("Hosted product UI smoke passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
