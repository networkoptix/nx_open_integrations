// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * The CORS forwarder — JUST the proxy, no static file serving.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Nx Cloud and the site relay live on different origins than the page and
 * do NOT send CORS headers for it, so a browser blocks direct calls. This
 * module forwards those calls from outside the browser (where CORS does not
 * apply) and performs the relay's 307 + re-attach-the-bearer hop that a browser
 * cannot do (see ../../node/rest-event-log for that pattern).
 *
 * It deliberately does NOT serve the demo's HTML/JS — that's server.mjs's job.
 * Keeping the two apart means this forwarder is reusable by other web samples,
 * and the demo's static serving stays a separate concern. server.mjs mounts
 * this handler so everything still runs on one port (same-origin = no CORS).
 *
 * Routes it handles:
 *   ANY  /cloud/<path>            -> {cloud-host}/<path>   (e.g. /cdb/oauth2/token)
 *   ANY  /relay/<siteId>/<path> -> https://<siteId>.relay.vmsproxy.com/<path>
 *
 * The Site ID comes from the URL (the page builds it from the form), so there
 * is nothing to configure.
 */

import process from "node:process";

export const RELAY_SUFFIX = ".relay.vmsproxy.com";

// A Site ID is a UUID; reject anything else before building a relay host.
const SITE_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

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

/**
 * Fetch the target, following redirects MANUALLY so we can re-attach the
 * Authorization header across the relay's cross-host 307 (the exact thing a
 * browser refuses to do).
 */
async function fetchFollowing(url, init, maxHops = 5) {
  let current = url;
  for (let hop = 0; hop < maxHops; hop++) {
    const res = await fetch(current, { ...init, redirect: "manual" });
    if ([301, 302, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) return res;
      current = new URL(location, current).toString();
      continue; // same init -> Authorization header is re-sent deliberately
    }
    return res;
  }
  throw new Error("Too many redirects from the upstream relay.");
}

async function proxyTo(base, subPath, req, res) {
  const target = `${base}${subPath}`;
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
  let upstream;
  try {
    upstream = await fetchFollowing(target, {
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
 * Build a request handler for the /cloud and /relay routes.
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

    // /relay/<siteId>/<rest...> -> https://<siteId>.relay.vmsproxy.com/<rest...>
    if (url.startsWith("/relay/")) {
      const rest = url.slice("/relay/".length);
      const slash = rest.indexOf("/");
      const siteId = slash === -1 ? rest : rest.slice(0, slash);
      const subPath = slash === -1 ? "" : rest.slice(slash);
      if (!SITE_ID_RE.test(siteId)) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("Bad /relay path: expected /relay/<siteId>/...");
        return true;
      }
      await proxyTo(`https://${siteId}${RELAY_SUFFIX}`, subPath, req, res);
      return true;
    }

    return false; // not a proxy route — let the caller serve it (e.g. static)
  };
}
