import gatewayHandler, { ControlPlane, DeviceRelay } from "./gateway.js";

export { ControlPlane, DeviceRelay };

interface Env {
  CONTROL: DurableObjectNamespace<ControlPlane>;
  DEVICES: DurableObjectNamespace<DeviceRelay>;
}

const gatewayFetch = gatewayHandler.fetch as (request: Request, env: Env) => Promise<Response>;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function page(body: string, title: string): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#161719;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}.shell{max-width:720px;margin:0 auto;padding:56px 22px}.brand{display:flex;gap:12px;align-items:center;margin-bottom:26px}.mark{width:42px;height:42px;border-radius:12px;background:#111;color:#fff;display:grid;place-items:center;font-weight:800;font-size:20px}.brand strong{font-size:17px}.brand span{display:block;color:#666;font-size:13px}.card{background:#fff;border:1px solid #dddfe3;border-radius:18px;padding:28px;box-shadow:0 8px 28px rgba(0,0,0,.05)}h1{font-size:27px;line-height:1.2;margin:0 0 10px}h2{font-size:16px;margin:24px 0 8px}p{color:#51545a}.status{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:6px 10px;background:#e9f8ef;color:#126b39;font-weight:650;font-size:13px}.dot{width:8px;height:8px;border-radius:50%;background:#2fa66a}.steps{margin:18px 0 0;padding:0;list-style:none;counter-reset:step}.steps li{counter-increment:step;position:relative;padding:0 0 18px 42px;color:#3e4147}.steps li:before{content:counter(step);position:absolute;left:0;top:0;width:27px;height:27px;border-radius:50%;display:grid;place-items:center;background:#111;color:#fff;font-size:12px;font-weight:800}.code{font:750 29px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.08em;padding:16px;border:1px solid #cfd2d7;border-radius:11px;background:#f7f8fa;margin:14px 0}.note{padding:12px 14px;border-radius:10px;background:#f1f3f5;color:#4b4e54;font-size:13px}.foot{margin-top:20px;color:#767980;font-size:12px}@media(prefers-color-scheme:dark){body{background:#111315;color:#f2f3f4}.card{background:#1a1d20;border-color:#34383d}.brand span,p,.steps li{color:#b6bac0}.mark,.steps li:before{background:#f2f3f4;color:#141618}.code{background:#15181b;border-color:#3a3e43}.note{background:#22262a;color:#c8ccd1}.foot{color:#93979e}}
</style>
</head><body><div class="shell"><div class="brand"><div class="mark">C</div><div><strong>ChatGPT Bridge</strong><span>VS Code ↔ normal ChatGPT</span></div></div>${body}</div></body></html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function landingPage(origin: string): Response {
  return page(`<div class="card"><span class="status"><span class="dot"></span>Bridge relay online</span><h1>Connect VS Code to ChatGPT</h1><p>ChatGPT Bridge lets normal ChatGPT read the workspace you currently have open in VS Code. The Windows client is the VSIX extension; there is no companion EXE, localhost service, tunnel ID, or OpenAI API key.</p><ol class="steps"><li>Install the ChatGPT Bridge VSIX and open its <strong>ChatGPT Bridge: Open Setup</strong> panel.</li><li>In ChatGPT, add the <strong>ChatGPT Bridge</strong> plugin using <code>${escapeHtml(origin)}/mcp</code>.</li><li>When ChatGPT opens the authorization page, enter the pairing code shown in VS Code.</li><li>After authorization, enable ChatGPT Bridge in a conversation and ask about the current workspace.</li></ol><div class="note">The bridge is read-only in v0.2. Workspace content is fetched on demand when ChatGPT invokes a tool.</div></div><div class="foot">MCP endpoint: ${escapeHtml(origin)}/mcp</div>`, "ChatGPT Bridge");
}

function pairingPage(code: string): Response {
  return page(`<div class="card"><h1>Pair this VS Code with ChatGPT</h1><p>Keep this page open while connecting ChatGPT Bridge. When ChatGPT displays the authorization form, enter the code below.</p><div class="code">${escapeHtml(code)}</div><ol class="steps"><li>Open ChatGPT Plugins and connect <strong>ChatGPT Bridge</strong>.</li><li>ChatGPT will open the Bridge authorization page.</li><li>Enter this pairing code and approve the connection.</li></ol><div class="note">You never need to enter an OpenAI API key, tunnel ID, or local URL.</div></div>`, "Pair ChatGPT Bridge");
}

async function polishAuthorize(response: Response): Promise<Response> {
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) return response;
  let body = await response.text();
  body = body
    .replace("<title>Connect ChatGPT Bridge</title>", "<title>Authorize ChatGPT Bridge</title>")
    .replace("<h1>Connect ChatGPT Bridge</h1>", "<div class=\"brand\"><div class=\"brandmark\">C</div><div><strong>ChatGPT Bridge</strong><small>VS Code connection</small></div></div><h1>Authorize ChatGPT Bridge</h1>")
    .replace("This authorizes ChatGPT to use only the paired VS Code workspace.", "This connects ChatGPT to the VS Code device matching the pairing code below. The v0.2 tool set is read-only.")
    .replace("Authorize this VS Code", "Authorize this VS Code")
    .replace("</style>", `.brand{display:flex;gap:10px;align-items:center;margin-bottom:22px}.brandmark{width:38px;height:38px;border-radius:11px;background:#111;color:#fff;display:grid;place-items:center;font-weight:800}.brand strong{display:block}.brand small{display:block;color:#777;margin-top:2px}body{background:#f4f5f7}main{background:#fff;box-shadow:0 8px 28px rgba(0,0,0,.05);border-radius:18px!important}h1{font-size:26px;margin-bottom:8px}.error{margin-top:14px}button{cursor:pointer}</style>`);
  return new Response(body, { status: response.status, headers: response.headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return landingPage(url.origin);
    if (request.method === "GET" && url.pathname.startsWith("/pair/")) {
      return pairingPage(decodeURIComponent(url.pathname.slice("/pair/".length)));
    }

    const response = await gatewayFetch(request, env);
    if (url.pathname === "/authorize") return polishAuthorize(response);
    return response;
  },
} satisfies ExportedHandler<Env>;
