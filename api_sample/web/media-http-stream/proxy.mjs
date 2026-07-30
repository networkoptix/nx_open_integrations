// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * The CORS forwarder — JUST the proxy, no static file serving.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Nx Cloud, the site relay, and a local VMS server all live on different
 * origins than the page and do NOT send CORS headers for it, so a browser blocks
 * direct calls. A local server also presents a SELF-SIGNED TLS cert the browser
 * refuses outright. This module forwards those calls from outside the browser
 * (where CORS does not apply), accepts the self-signed cert when asked
 * (--insecure), and performs the relay's 307 + re-attach-the-bearer hop a
 * browser cannot do.
 *
 * It deliberately does NOT serve the demo's HTML/JS — that's server.mjs's job.
 * Keeping the two apart means this forwarder is reusable, and server.mjs mounts
 * it so everything runs on ONE port (same-origin = no CORS).
 *
 * Routes it handles:
 *   ANY  /cloud/<path>                  -> {cloud-host}/<path>          (cloud login)
 *   ANY  /relay/<siteId>/<path>       -> https://<siteId>.relay.vmsproxy.com/<path>
 *   ANY  /server/<encoded-base>/<path> -> <decoded-base>/<path>        (direct)
 *
 * For the DIRECT route the FIRST path segment after /server/ is the URI-encoded
 * media server base URL the PAGE supplied (scheme+host+port), e.g.
 * /server/https%3A%2F%2F192.168.1.10%3A7001/rest/v4/... — the proxy decodes it
 * and forwards there. The target is no longer a fixed server-host flag; it is
 * whatever the user typed on the page.
 *
 * THE auth=<token> -> Authorization: Bearer <token> CONVERSION
 * ------------------------------------------------------------
 * A <video src> GET cannot carry an Authorization header, so the page puts the
 * token on the URL as `?auth=<token>`. Before forwarding, this proxy:
 *   1. REMOVES the `auth` query param from the upstream URL, and
 *   2. sends `Authorization: Bearer <token>` to Nx instead.
 * So the token only ever travels same-origin to this local proxy; Nx receives a
 * normal bearer header, never a URL param.
 *
 * STREAMING
 * ---------
 * Video responses are piped straight through to the browser (we do NOT buffer
 * the whole stream), so a live <video> plays progressively.
 */

import process from "node:process";
import { Readable } from "node:stream";

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
 * Pull an `auth` query param off a path+query string. Returns the path with the
 * param REMOVED plus the token (or null). The leading route prefix has already
 * been stripped by the caller, so `subPath` looks like "/rest/v4/...?stream=...".
 *
 * Exported for the offline tests.
 */
export function extractAuth(subPath) {
  const q = subPath.indexOf("?");
  if (q === -1) return { path: subPath, token: null };
  const params = new URLSearchParams(subPath.slice(q + 1));
  const token = params.get("auth");
  if (token === null) return { path: subPath, token: null };
  params.delete("auth");
  const rest = params.toString();
  return { path: subPath.slice(0, q) + (rest ? `?${rest}` : ""), token };
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

async function proxyTo(base, subPath, req, res, { agent = null } = {}) {
  // Convert ?auth=<token> into a bearer header, dropping it from the URL.
  const { path, token } = extractAuth(subPath);
  const headers = forwardHeaders(req.headers);
  if (token) headers["authorization"] = `Bearer ${token}`;

  const target = `${base}${path}`;
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);

  let upstream;
  try {
    upstream = await fetchFollowing(target, {
      method: req.method,
      headers,
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

  // Pass the status and content-type straight through.
  const outHeaders = {
    "content-type": upstream.headers.get("content-type") || "application/octet-stream",
  };
  // Forward Content-Length ONLY when the upstream body is not content-encoded.
  // Node's fetch (undici) transparently decompresses a gzip/br response, so for
  // an encoded body the upstream Content-Length is the COMPRESSED size and would
  // make the browser truncate the (larger) decompressed body. Video isn't
  // gzipped, so this keeps the length (and the <video> seek/progress bar) for
  // real clips while staying correct if a response ever arrives compressed.
  const len = upstream.headers.get("content-length");
  if (len && !upstream.headers.get("content-encoding")) outHeaders["content-length"] = len;
  res.writeHead(upstream.status, outHeaders);

  // STREAM the body — do not buffer the whole (possibly endless) video. Pipe
  // the upstream's web ReadableStream straight to the Node response.
  if (upstream.body) {
    Readable.fromWeb(upstream.body).pipe(res);
  } else {
    res.end();
  }
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

// A Direct-mode base URL must be an http(s) origin with a host; reject anything
// else before forwarding (and to avoid being used as an open proxy).
function isValidServerBase(base) {
  try {
    const u = new URL(base);
    return (u.protocol === "https:" || u.protocol === "http:") && !!u.host;
  } catch {
    return false;
  }
}

/**
 * Build a request handler for the /cloud, /relay, and /server routes.
 *
 * @param {object} [opts]
 * @param {string} [opts.cloudHost]  Cloud origin (default https://nxvms.com).
 * @param {boolean} [opts.insecure]  Accept self-signed TLS certs for the cloud/
 *        relay routes too. The DIRECT (/server) route ALWAYS tolerates a
 *        self-signed cert: it points at a local media server (this is a
 *        localhost dev tool), and such servers normally present one.
 * @returns {(req, res) => Promise<boolean>} Resolves true if it handled the
 *   request (so the caller can fall through to static serving when false).
 */
export function createProxyHandler({ cloudHost = "https://nxvms.com", insecure = false } = {}) {
  const CLOUD = cloudHost.replace(/\/+$/, "");
  // Build the insecure agent lazily, but only once. Direct mode always uses it
  // (self-signed local certs are normal); cloud/relay use it only with --insecure.
  const insecureAgentPromise = makeInsecureAgent();
  const agentPromise = insecure ? insecureAgentPromise : Promise.resolve(null);

  return async function handleProxy(req, res) {
    const url = req.url || "/";

    if (url.startsWith("/cloud/")) {
      await proxyTo(CLOUD, url.slice("/cloud".length), req, res, { agent: await agentPromise });
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
      await proxyTo(`https://${siteId}${RELAY_SUFFIX}`, subPath, req, res, { agent: await agentPromise });
      return true;
    }

    // /server/<encoded-base>/<rest...> -> <decoded-base>/<rest...>
    // The FIRST segment is the URI-encoded media server base URL the PAGE
    // supplied (scheme+host+port); we decode it and forward there.
    if (url.startsWith("/server/")) {
      const rest = url.slice("/server/".length);
      const slash = rest.indexOf("/");
      const encodedBase = slash === -1 ? rest : rest.slice(0, slash);
      const subPath = slash === -1 ? "" : rest.slice(slash);
      let base;
      try {
        base = decodeURIComponent(encodedBase);
      } catch {
        base = "";
      }
      base = base.replace(/\/+$/, "");
      if (!isValidServerBase(base)) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(
          "Bad /server path: expected /server/<encodeURIComponent(serverBaseUrl)>/... " +
            "where the base is an http(s) URL like https://192.168.1.10:7001.",
        );
        return true;
      }
      // Direct mode always tolerates a self-signed cert (local dev tool).
      await proxyTo(base, subPath, req, res, { agent: await insecureAgentPromise });
      return true;
    }

    return false; // not a proxy route — let the caller serve it (e.g. static)
  };
}
