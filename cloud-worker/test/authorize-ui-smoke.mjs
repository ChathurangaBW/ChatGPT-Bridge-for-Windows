import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const baseUrl = (process.env.BRIDGE_SMOKE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const resource = `${baseUrl}/mcp`;

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

async function main() {
  const registration = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "VSIX OAuth UI smoke",
      redirect_uris: ["http://127.0.0.1:8790/callback"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const url = new URL(`${baseUrl}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1:8790/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "bridge:read offline_access",
    state: "ui-smoke",
    resource,
  }).toString();
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /ChatGPT Bridge VS Code extension/);
  assert.match(html, /Authorize this VS Code/);
  assert.doesNotMatch(html, /ChatGPTBridge\.exe/);
  console.log("OAuth VSIX-only UI smoke passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
