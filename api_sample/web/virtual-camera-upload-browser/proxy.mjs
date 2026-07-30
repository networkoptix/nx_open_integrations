// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * The CORS forwarder — JUST the proxy, no static file serving.
 *
 * WHY THIS EXISTS
 * ---------------
 * A local Nx VMS server lives on a different origin than the page and does NOT
 * send CORS headers for it, so a browser blocks direct calls. On top of that,
 * local servers almost always present a SELF-SIGNED TLS certificate, which a
 * browser refuses outright. This module forwards calls from outside the browser
 * (where CORS does not apply) and accepts the self-signed cert, neither of
 * which is possible from page JavaScript.
 *
 * This is the DIRECT variant — a single same-origin hop to ONE VMS server — but
 * unlike rest-list-cameras-local-browser the target server is chosen by the
 * PAGE, not fixed at start time. The page URL-encodes the server address into a
 * path segment, so this proxy decodes it per request:
 *
 *   ANY  /server/<encodeURIComponent(base)>/<path>
 *        -> <base>/<path>            (e.g. /rest/v4/devices/(asterisk)/virtual)
 *
 * Because the target is always a user-typed DIRECT server (which uses a
 * self-signed cert), this proxy ALWAYS tolerates self-signed TLS. An optional
 * --server-host on server.mjs is only used to PREFILL the page's address field.
 *
 * It forwards the method, the body (including raw PUT chunk bodies), and the
 * Authorization: Bearer header for every verb (GET/POST/PATCH/PUT/DELETE). It
 * deliberately does NOT serve the demo's HTML/JS — that's server.mjs's job, so
 * this forwarder stays reusable by other web samples.
 */

// Headers we must not copy verbatim between hops.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function forwardHeaders(incoming) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

async function proxyTo(target, req, res, agent) {
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: forwardHeaders(req.headers),
      body,
      // Node's fetch uses this Undici dispatcher to reach the upstream; the
      // agent accepts the server's self-signed cert.
      ...(agent ? { dispatcher: agent } : {}),
    });
  } catch (exc) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`Proxy could not reach ${target}: ${exc.message}`);
    return;
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json",
  });
  res.end(buf);
}

/**
 * Build the dispatcher that lets fetch accept a self-signed cert. Prefers
 * Undici's Agent (Node's fetch backend); falls back to flipping the global TLS
 * env var if Undici isn't importable for some reason.
 */
async function makeInsecureAgent() {
  try {
    const { Agent } = await import("undici");
    return new Agent({ connect: { rejectUnauthorized: false } });
  } catch {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    return null;
  }
}

/**
 * Decode the /server/<encoded-base>/<rest> URL into { base, subPath }.
 * Returns null if the shape doesn't match (so the caller falls through).
 * Exported for the offline tests.
 */
export function decodeServerRoute(url) {
  if (url !== "/server" && !url.startsWith("/server/")) return null;
  const after = url.slice("/server".length); // "" | "/<enc>" | "/<enc>/rest/..."
  if (after === "" || after === "/") return { base: "", subPath: "/" };
  const rest = after.slice(1); // strip the leading "/"
  const slash = rest.indexOf("/");
  const encBase = slash === -1 ? rest : rest.slice(0, slash);
  const subPath = slash === -1 ? "/" : rest.slice(slash); // keeps leading "/" and ?query
  let base;
  try {
    base = decodeURIComponent(encBase).replace(/\/+$/, "");
  } catch {
    base = "";
  }
  return { base, subPath };
}

/**
 * Build a request handler for the /server route.
 *
 * Always tolerates self-signed TLS (the direct target is user-typed and uses a
 * self-signed cert). `insecure` is accepted for parity but the agent is built
 * unconditionally.
 *
 * @returns {(req, res) => Promise<boolean>} Resolves true if it handled the
 *   request (so the caller can fall through to static serving when false).
 */
export function createProxyHandler({ insecure = true } = {}) {
  // Direct servers always need the self-signed-tolerant agent.
  void insecure;
  let agentPromise = makeInsecureAgent();

  return async function handleProxy(req, res) {
    const url = req.url || "/";
    const decoded = decodeServerRoute(url);
    if (!decoded) return false; // not a proxy route — let the caller serve it

    if (!decoded.base) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(
        "No server address in the request. The page must call " +
          "/server/<encoded https://ip:port>/... — enter a Server address on the page.",
      );
      return true;
    }
    const target = `${decoded.base}${decoded.subPath}`;
    const agent = await agentPromise;
    await proxyTo(target, req, res, agent);
    return true;
  };
}
