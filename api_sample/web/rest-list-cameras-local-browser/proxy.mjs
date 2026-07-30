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
 * (where CORS does not apply) and can be told to accept the self-signed cert
 * (--insecure), neither of which is possible from page JavaScript.
 *
 * Unlike the cloud sample, there is NO relay and NO 307 hop here: this is the
 * DIRECT variant, a single same-origin hop to ONE configured VMS server.
 *
 * It deliberately does NOT serve the demo's HTML/JS — that's server.mjs's job.
 * Keeping the two apart means this forwarder is reusable by other web samples,
 * and the demo's static serving stays a separate concern. server.mjs mounts
 * this handler so everything still runs on one port (same-origin = no CORS).
 *
 * Route it handles:
 *   ANY  /server/<path>   -> {server-host}/<path>   (e.g. /rest/v4/devices)
 *
 * The server host is configured once at start time (server.mjs --server-host),
 * so there is nothing for the page to configure.
 */

import https from "node:https";

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

async function proxyTo(base, subPath, req, res, agent) {
  const target = `${base}${subPath}`;
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: forwardHeaders(req.headers),
      body,
      // Node's fetch uses this Undici dispatcher to reach the upstream; the
      // agent (when --insecure) is what accepts the server's self-signed cert.
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
    // Last resort: also covers any non-fetch https usage.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    return null;
  }
}

/**
 * Build a request handler for the /server route.
 *
 * @param {object} [opts]
 * @param {string} [opts.serverHost] VMS server base URL
 *        (e.g. https://192.168.1.10:7001). When unset, the proxy returns a
 *        clear 502 explaining the missing --server-host flag.
 * @param {boolean} [opts.insecure] Accept the server's self-signed TLS cert.
 * @returns {(req, res) => Promise<boolean>} Resolves true if it handled the
 *   request (so the caller can fall through to static serving when false).
 */
export function createProxyHandler({ serverHost = "", insecure = false } = {}) {
  const SERVER = (serverHost || "").replace(/\/+$/, "");
  // Build the insecure agent lazily, but only once.
  let agentPromise = insecure ? makeInsecureAgent() : Promise.resolve(null);

  return async function handleProxy(req, res) {
    const url = req.url || "/";

    if (url.startsWith("/server/") || url === "/server") {
      if (!SERVER) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(
          "No VMS server configured. Start the dev server with " +
            "--server-host https://<ip>:7001 (add --insecure for a self-signed cert).",
        );
        return true;
      }
      const subPath = url.slice("/server".length) || "/";
      const agent = await agentPromise;
      await proxyTo(SERVER, subPath, req, res, agent);
      return true;
    }

    return false; // not a proxy route — let the caller serve it (e.g. static)
  };
}
