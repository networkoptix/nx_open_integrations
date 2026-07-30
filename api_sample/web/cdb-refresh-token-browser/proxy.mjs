// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * The CORS forwarder — JUST the proxy, no static file serving.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Nx Cloud lives on a different origin than the page and does NOT send CORS
 * headers for it, so a browser blocks direct calls. This module forwards those
 * calls from outside the browser (where CORS does not apply).
 *
 * This sample is CLOUD-ONLY: the refresh-token flow only ever talks to the
 * cloud's OAuth2 endpoint, so there is no relay route and no 307 hop to
 * re-attach a bearer across. The handler stays tiny on purpose.
 *
 * It deliberately does NOT serve the demo's HTML/JS — that's server.mjs's job.
 * Keeping the two apart means this forwarder is reusable by other web samples,
 * and the demo's static serving stays a separate concern. server.mjs mounts
 * this handler so everything still runs on one port (same-origin = no CORS).
 *
 * Routes it handles:
 *   ANY  /cloud/<path>   -> {cloud-host}/<path>   (e.g. /cdb/oauth2/token)
 */

import process from "node:process";

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

async function proxyTo(base, subPath, req, res) {
  const target = `${base}${subPath}`;
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: forwardHeaders(req.headers),
      body,
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
 * Build a request handler for the /cloud route.
 *
 * @param {object} [opts]
 * @param {string} [opts.cloudHost] Cloud origin (default https://nxvms.com).
 * @param {boolean} [opts.insecure] Skip TLS verification (local/self-signed).
 * @returns {(req, res) => Promise<boolean>} Resolves true if it handled the
 *   request (so the caller can fall through to static serving when false).
 */
export function createProxyHandler({ cloudHost = "https://nxvms.com", insecure = false } = {}) {
  if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const CLOUD = cloudHost.replace(/\/+$/, "");

  return async function handleProxy(req, res) {
    const url = req.url || "/";

    if (url.startsWith("/cloud/")) {
      await proxyTo(CLOUD, url.slice("/cloud".length), req, res);
      return true;
    }

    return false; // not a proxy route — let the caller serve it (e.g. static)
  };
}
