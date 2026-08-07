import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_REQUEST_BYTES = 1024 * 1024;
const ALLOWED_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

interface FetchHandler {
  fetch(request: Request): Promise<Response>;
}

function hostnameFromAuthority(authority: string): string | null {
  try {
    return new URL(`http://${authority}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function rejectForbidden(res: ServerResponse): false {
  res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "Forbidden" }));
  return false;
}

export function validateLoopbackRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const host = req.headers.host;
  const hostName = host ? hostnameFromAuthority(host) : null;
  if (!hostName || !ALLOWED_LOCAL_HOSTS.has(hostName)) return rejectForbidden(res);

  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin === "null") return rejectForbidden(res);
    let originHost: string;
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return rejectForbidden(res);
    }
    if (!ALLOWED_LOCAL_HOSTS.has(originHost)) return rejectForbidden(res);
  }
  return true;
}

async function readRequestBody(req: IncomingMessage): Promise<string | undefined> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) throw new Error(`MCP request exceeds ${MAX_REQUEST_BYTES} byte limit.`);
    chunks.push(buffer);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks).toString("utf8");
}

async function toWebRequest(req: IncomingMessage, signal: AbortSignal): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(":")) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }

  const body = await readRequestBody(req);
  return new Request(`http://127.0.0.1${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers,
    signal,
    ...(body !== undefined ? { body } : {}),
  });
}

async function writeWebResponse(response: Response, res: ServerResponse, signal: AbortSignal): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) headers[name] = value;
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            res.off("drain", finish);
            signal.removeEventListener("abort", finish);
            resolve();
          };
          res.once("drain", finish);
          signal.addEventListener("abort", finish, { once: true });
        });
      }
    }
  } finally {
    if (signal.aborted) await reader.cancel().catch(() => undefined);
  }
  res.end();
}

export function toNodeHandler(handler: FetchHandler): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const abort = new AbortController();
    let finished = false;
    res.once("close", () => {
      if (!finished) abort.abort();
    });

    try {
      const request = await toWebRequest(req, abort.signal);
      const response = await handler.fetch(request);
      await writeWebResponse(response, res, abort.signal);
      finished = true;
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      res.writeHead(error instanceof Error && error.message.includes("byte limit") ? 413 : 500, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ error: "MCP request failed" }));
    }
  };
}
