// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * The CORS forwarder, JUST the proxy, no static file serving.
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
 * It deliberately does NOT serve the demo's HTML/JS, that is server.mjs's job.
 *
 * Routes it handles:
 *   ANY  /server/<path>   -> {server-host}/<path>   (e.g. /rest/v4/site/database)
 *   GET  /config.json     -> {"serverHost": "<server-host>"}, so the page can
 *                            show which server it talks to and make the
 *                            operator type that address to confirm a restore
 *
 * TWO THINGS THIS PROXY DOES THAT THE OTHER WEB SAMPLES' PROXIES DO NOT
 * ---------------------------------------------------------------------
 *
 * 1. It STREAMS the response instead of buffering it.
 *
 *    Every other web sample ends with `Buffer.from(await upstream.arrayBuffer())`,
 *    which is fine for a JSON camera list and wrong for a Site database dump:
 *    that is tens of megabytes, and buffering it here would hold the whole
 *    thing in the proxy's memory on top of the copy the browser already has to
 *    keep. Piping the upstream body straight to the response costs nothing and
 *    removes one of the two copies.
 *
 *    The browser end still buffers, because saving a file there means a Blob
 *    and a Blob is memory. That limit is the browser's, not this proxy's, and
 *    the README says so plainly.
 *
 * 2. It reports socket-level failures in a header.
 *
 *    A successful restore restarts the server, which usually cuts the
 *    connection instead of answering. The CLI versions recognise that from the
 *    error's `cause.code`. A browser sees only "Failed to fetch", which is
 *    identical to a dead proxy or a dead network, so a browser alone cannot
 *    tell a successful restore from a failed one. This proxy can: it names the
 *    upstream error code in `x-nx-upstream-error`, and nx-backup-client.mjs
 *    treats the restart codes as success and everything else as failure.
 *    A drop only means "restarted" once the whole upload went up, so before
 *    that the header says UPLOAD_INCOMPLETE; and a server that took the whole
 *    upload but went silent gets UPSTREAM_TIMEOUT, which the page reports as
 *    an unknown outcome rather than a failure.
 *
 * A request with a body (the restore upload, the login) goes upstream through
 * node:http, piped, not through fetch: undici reads a request body ahead of the
 * socket, so a fetch upload would hold the whole dump in this process. Nothing
 * is followed: a redirect reaches the browser as a 3xx without its Location,
 * which the client reports as a failure, never as an accepted load.
 */

import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";

// Headers we must not copy verbatim between hops.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

/** Names the socket-level reason an upstream call died, for the browser. */
export const UPSTREAM_ERROR_HEADER = "x-nx-upstream-error";

/** Where the page reads the configured server address from. */
export const CONFIG_ROUTE = "/config.json";

/** Upstream silence, either way, after which an upload is given up on. */
const UPLOAD_IDLE_MS = 300000;

/** Wait until `res` can take more, or until the browser has gone. */
function drained(res) {
  return new Promise((resolve) => {
    // Already gone: 'close' has fired and will not fire again.
    if (res.destroyed) return resolve();
    const done = () => {
      res.off?.("drain", done);
      res.off?.("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

function forwardHeaders(incoming) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Answer 502, naming the upstream failure in the header the client reads. */
function upstreamFailed(res, target, code, message) {
  const headers = { "content-type": "text/plain" };
  if (code) headers[UPSTREAM_ERROR_HEADER] = code;
  res.writeHead(502, headers);
  res.end(`Proxy could not reach ${target}: ${message}`);
}

/**
 * Forward a request that has a body, piped both ways through node:http(s), so
 * neither the upload nor the answer is ever held here whole.
 */
function forwardUpload(target, req, res, { insecure, idleMs }) {
  return new Promise((resolve) => {
    const url = new URL(target);
    const { request } = url.protocol === "https:" ? https : http;
    const headers = forwardHeaders(req.headers);
    // Kept for an upload: the dump goes upstream with its length, streamed.
    if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
    let uploaded = false;
    let answered = false;
    const upstream = request(url, { method: req.method, headers, rejectUnauthorized: !insecure }, (up) => {
      answered = true;
      res.writeHead(up.statusCode, {
        "content-type": up.headers["content-type"] || "application/json",
      });
      // A browser that leaves destroys res, which stops the upstream read; an
      // upstream that dies mid-answer destroys res rather than ending it.
      pipeline(up, res).then(resolve, resolve);
    });
    upstream.setTimeout(idleMs, () =>
      upstream.destroy(Object.assign(new Error(`no answer for ${idleMs / 1000} s`), { code: "UPSTREAM_TIMEOUT" })),
    );
    upstream.on("finish", () => {
      uploaded = true;
    });
    upstream.on("error", (exc) => {
      if (answered) return; // the pipeline above handles it
      // A drop means "restarted" only once the whole upload went up.
      upstreamFailed(res, target, uploaded ? exc.code || "" : "UPLOAD_INCOMPLETE", exc.message);
      resolve();
    });
    // pipe, not pipeline: an upstream failure must not destroy the browser's
    // request, or the 502 above could never reach it.
    req.on("error", (exc) => upstream.destroy(exc));
    req.pipe(upstream);
  });
}

async function proxyTo(base, subPath, req, res, agent, fetchImpl, options) {
  const target = `${base}${subPath}`;
  if (!["GET", "HEAD", "DELETE"].includes(req.method)) {
    await forwardUpload(target, req, res, options);
    return;
  }

  let upstream;
  try {
    upstream = await fetchImpl(target, {
      method: req.method,
      headers: forwardHeaders(req.headers),
      // Nothing is followed: the browser sees the 3xx itself.
      redirect: "manual",
      // Node's fetch uses this Undici dispatcher to reach the upstream; the
      // agent (when --insecure) is what accepts the server's self-signed cert.
      ...(agent ? { dispatcher: agent } : {}),
    });
  } catch (exc) {
    // Tell the browser WHY, so a restart after a restore can be told apart
    // from a server that was never reachable.
    upstreamFailed(res, target, exc?.cause?.code || exc?.code || "", exc.message);
    return;
  }

  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json",
  });

  // Stream, never buffer: a Site database dump is far too large to hold here.
  if (!upstream.body) {
    res.end();
    return;
  }
  try {
    for await (const chunk of upstream.body) {
      // The browser closed the tab or cancelled before this chunk: write()
      // would return false and no event would ever follow.
      if (res.destroyed) return;
      // Respect backpressure: a browser saving to a slow disk reads slower
      // than the server sends, and ignoring write()'s false queues it all here.
      if (!res.write(chunk)) await drained(res);
      // The browser closed the tab or cancelled. Leaving the loop cancels the
      // upstream body, so the server stops sending too.
      if (res.destroyed) return;
    }
  } catch (exc) {
    // The server went away mid-dump. The status line is already sent, so the
    // only honest signal left is to break the connection: a clean end() here
    // would hand the browser a truncated dump that looks complete.
    res.destroy(exc);
    return;
  }
  res.end();
}

/**
 * Let fetch accept the server's self-signed certificate.
 *
 * Node's built-in fetch has no per-request "skip verification" switch, and the
 * Undici Agent that would give one is not importable from stock Node (it ships
 * inside Node but is not exposed as a module, and this sample installs
 * nothing). So this turns verification off for the whole process. That is
 * acceptable here because this dev server makes outbound TLS calls to exactly
 * one place, the --server-host you gave it, and it is what --insecure asks for.
 * Node prints a warning saying so at startup, and that is correct.
 */
function makeInsecureAgent() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  return null;
}

/**
 * Build a request handler for the /server route.
 *
 * @param {object} [opts]
 * @param {string} [opts.serverHost] VMS server base URL
 *        (e.g. https://192.168.1.10:7001). When unset, the proxy returns a
 *        clear 502 explaining the missing --server-host flag.
 * @param {boolean} [opts.insecure] Accept the server's self-signed TLS cert.
 * @param {Function} [opts.fetchImpl] Injected for the offline tests. The other
 *        web samples call the global fetch directly, which leaves their
 *        forwarding path untested; the two behaviours above live in exactly
 *        that path, so here it is a seam.
 * @returns {(req, res) => Promise<boolean>} Resolves true if it handled the
 *   request (so the caller can fall through to static serving when false).
 */
export function createProxyHandler({
  serverHost = "",
  insecure = false,
  fetchImpl = fetch,
  uploadIdleMs = UPLOAD_IDLE_MS,
} = {}) {
  const SERVER = (serverHost || "").replace(/\/+$/, "");
  // Build the insecure agent lazily, but only once.
  const agentPromise = Promise.resolve(insecure ? makeInsecureAgent() : null);

  return async function handleProxy(req, res) {
    const url = req.url || "/";

    if (url === CONFIG_ROUTE) {
      // The page cannot know --server-host any other way, and without it the
      // restore confirmation has nothing to compare against.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ serverHost: SERVER }));
      return true;
    }

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
      try {
        await proxyTo(SERVER, subPath, req, res, agent, fetchImpl, { insecure, idleMs: uploadIdleMs });
      } catch (exc) {
        // Never let one bad request reject into the HTTP server's callback:
        // an unhandled rejection there takes the whole dev server down.
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end(`Proxy error: ${exc?.message ?? exc}`);
        } else {
          res.destroy(exc);
        }
      }
      return true;
    }

    return false; // not a proxy route, let the caller serve it (e.g. static)
  };
}
