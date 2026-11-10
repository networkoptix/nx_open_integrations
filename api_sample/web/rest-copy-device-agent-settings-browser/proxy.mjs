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
 * Route it handles:
 *   ANY  /server/<path>   -> {server-host}/<path>
 *   (e.g. /rest/v4/analytics/engines/<engineId>/deviceAgents/<deviceId>/settings)
 *
 * Both the request and the answer are held whole in memory before they are
 * passed on. That is a choice for small bodies only: Device Agent settings are
 * a small JSON object, so the copy is cheap here. A proxy for large bodies
 * (a database dump, a video export) has to stream instead.
 *
 * Holding the answer whole also means a failure while reading it can still be
 * reported to the page as a clean error, because nothing has been sent yet.
 *
 * WHAT THE PAGE CAN LEARN FROM A FAILURE
 * --------------------------------------
 * Every answer the proxy, not the VMS server, produces names its cause in the
 * `x-nx-upstream-error` header: the socket error code (e.g. ECONNREFUSED,
 * ECONNRESET), or UPSTREAM_TIMEOUT (answer 504) when the server took the
 * request and then said nothing for too long (with the seconds it waited in
 * `x-nx-upstream-timeout-seconds`). The proxy's own answers carry a
 * code too: NO_SERVER_HOST (502, no --server-host given), BAD_REQUEST (400,
 * the page's request body never arrived whole) and PROXY_ERROR (500, a fault
 * in the proxy). The page reads the code before the status, so it can tell
 * "the settings never left" from "the settings may have been applied", and
 * never mistakes the proxy's status for the VMS server's.
 *
 * Nothing is followed: fetch uses redirect "manual", and only Content-Type is
 * copied back, so a 3xx reaches the page without its Location and the page
 * reports it as a failure.
 */

// Headers we must not copy verbatim between hops.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

/** The header that names a failure the proxy itself saw. */
export const UPSTREAM_ERROR_HEADER = "x-nx-upstream-error";

/** The code sent when the server took the request but did not answer in time. */
export const UPSTREAM_TIMEOUT = "UPSTREAM_TIMEOUT";

/** Sent with UPSTREAM_TIMEOUT: how many seconds the proxy waited, so the page can say so. */
export const UPSTREAM_TIMEOUT_SECONDS_HEADER = "x-nx-upstream-timeout-seconds";

/** The codes of the answers the proxy makes without asking the VMS server. */
export const NO_SERVER_HOST = "NO_SERVER_HOST";
export const BAD_REQUEST = "BAD_REQUEST";
export const PROXY_ERROR = "PROXY_ERROR";

/** How long the server may take to answer, body included. */
const UPSTREAM_TIMEOUT_MS = 60000;

/**
 * Collect the request body. Rejects, never hangs, when the browser goes away
 * mid-request: 'error' and 'aborted' cover a broken socket, and a 'close'
 * without an 'end' covers the rest.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let ended = false;
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      ended = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("the browser aborted the request")));
    req.on("close", () => {
      if (!ended) reject(new Error("the browser closed the connection mid-request"));
    });
  });
}

function forwardHeaders(incoming) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Answer with an error the proxy produced. Writes nothing to a closed socket. */
function answer(res, status, message, code, extraHeaders = {}) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { "content-type": "text/plain", [UPSTREAM_ERROR_HEADER]: code, ...extraHeaders });
  res.end(message);
}

async function proxyTo(base, subPath, req, res, agent, fetchImpl, timeoutMs) {
  const target = `${base}${subPath}`;

  let body;
  if (!["GET", "HEAD", "DELETE"].includes(req.method)) {
    try {
      body = await readBody(req);
    } catch (exc) {
      answer(res, 400, `Proxy could not read the request: ${exc.message}`, BAD_REQUEST);
      return;
    }
  }

  // One signal for the whole exchange: it fires on our timeout, or when the
  // browser goes away before it got its answer, so the upstream call is not
  // left running for nobody.
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.on?.("close", onClose);
  // Started last, so nothing above can throw and leave it running.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const upstream = await fetchImpl(target, {
      method: req.method,
      headers: forwardHeaders(req.headers),
      body,
      // Nothing is followed: the page sees the 3xx itself.
      redirect: "manual",
      signal: controller.signal,
      // Node's fetch uses this Undici dispatcher to reach the upstream; the
      // agent (when --insecure) is what accepts the server's self-signed cert.
      ...(agent ? { dispatcher: agent } : {}),
    });
    // Read inside the try: a server that drops mid-answer is reported too.
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (res.destroyed) return;
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json",
    });
    res.end(buf);
  } catch (exc) {
    if (timedOut) {
      answer(
        res,
        504,
        `Proxy got no answer from ${target} within ${timeoutMs / 1000} s`,
        UPSTREAM_TIMEOUT,
        { [UPSTREAM_TIMEOUT_SECONDS_HEADER]: String(timeoutMs / 1000) },
      );
    } else {
      // Tell the page WHY, so "never reached" can be told from "dropped".
      const code = exc?.cause?.code || exc?.code || "UPSTREAM_ERROR";
      answer(res, 502, `Proxy could not reach ${target}: ${exc?.cause?.message || exc.message}`, code);
    }
  } finally {
    clearTimeout(timer);
    res.off?.("close", onClose);
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

/**
 * Build a request handler for the /server route.
 *
 * @param {object} [opts]
 * @param {string} [opts.serverHost] VMS server base URL
 *        (e.g. https://192.168.1.10:7001). When unset, the proxy returns a
 *        502 NO_SERVER_HOST explaining the missing --server-host flag.
 * @param {boolean} [opts.insecure] Accept the server's self-signed TLS cert.
 * @param {Function} [opts.fetchImpl] Injected for the offline tests. Defaults
 *        to the global fetch.
 * @param {number} [opts.upstreamTimeoutMs] How long the server may take to
 *        answer before the page gets a 504 UPSTREAM_TIMEOUT.
 * @returns {(req, res) => Promise<boolean>} Resolves true if it handled the
 *   request (so the caller can fall through to static serving when false).
 */
export function createProxyHandler({
  serverHost = "",
  insecure = false,
  fetchImpl = fetch,
  upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  const SERVER = (serverHost || "").replace(/\/+$/, "");
  // Build the insecure agent lazily, but only once.
  const agentPromise = insecure ? makeInsecureAgent() : Promise.resolve(null);

  return async function handleProxy(req, res) {
    const url = req.url || "/";

    if (url.startsWith("/server/") || url === "/server") {
      if (!SERVER) {
        answer(
          res,
          502,
          "No VMS server configured. Restart server.mjs with " +
            "--server-host https://<ip>:7001 (add --insecure for a self-signed cert).",
          NO_SERVER_HOST,
        );
        return true;
      }
      const subPath = url.slice("/server".length) || "/";
      const agent = await agentPromise;
      try {
        await proxyTo(SERVER, subPath, req, res, agent, fetchImpl, upstreamTimeoutMs);
      } catch (exc) {
        // Never let one bad request reject into the HTTP server's callback:
        // an unhandled rejection there takes the whole dev server down.
        answer(res, 500, `Proxy error: ${exc.message}`, PROXY_ERROR);
      }
      return true;
    }

    return false; // not a proxy route, let the caller serve it (e.g. static)
  };
}
