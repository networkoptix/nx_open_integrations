#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Dev server for the browser sample — JUST static file serving, plus it mounts
 * the CORS forwarder from proxy.mjs.
 *
 * This is the one command you run to try the demo:
 *
 *   # Just run it — both modes work with no required flags:
 *   node server.mjs
 *   node server.mjs --cloud-host https://nxvms.com --port 8080
 *
 *   # Optional: prefill the "Server address" field of Direct mode on the page:
 *   node server.mjs --server-host https://192.168.1.10:7001
 *
 * In "Direct to Media Server" mode the user types the media server address
 * (scheme+host+port) AND the local server account ON THE PAGE — the proxy
 * forwards there, tolerating the self-signed cert local servers normally use.
 * --server-host is now ONLY an optional prefill/default for that form field; it
 * is not required. --cloud-host is the cloud origin the CLOUD mode uses
 * (default https://nxvms.com). --insecure makes the proxy accept a self-signed
 * TLS certificate for the CLOUD/RELAY upstreams too (Direct mode always does).
 *
 * Then open the printed URL, pick a mode, and fill in the form.
 *
 * Separation of concerns: this file knows about the demo's files; proxy.mjs
 * knows about forwarding API calls (and converting the <video> ?auth token into
 * a bearer header). They run on one port so the page and its API/video calls
 * share an origin — which is what keeps the browser's CORS rule satisfied. This
 * is a DEV CONVENIENCE, not a production gateway.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createProxyHandler, RELAY_SUFFIX } from "./proxy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Example address shown in usage; the page collects the real one.
const SERVER_HOST_PLACEHOLDER = "https://192.168.1.10:7001";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function parseArgs(argv) {
  const flags = { port: "8080", cloudHost: "https://nxvms.com", serverHost: "", insecure: false };
  const map = { "--port": "port", "--cloud-host": "cloudHost", "--server-host": "serverHost" };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    if (a.includes("=")) { const e = a.indexOf("="); inline = a.slice(e + 1); a = a.slice(0, e); }
    if (a === "--insecure") flags.insecure = true;
    else if (a in map) flags[map[a]] = inline !== null ? inline : argv[++i];
    else { process.stderr.write(`Unknown argument: ${a}\n`); process.exit(2); }
  }
  return flags;
}

function serveStatic(urlPath, res, { serverPrefill = "" } = {}) {
  let rel = (urlPath === "/" ? "/index.html" : urlPath).split("?")[0];
  const file = path.join(HERE, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(HERE) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  const ext = path.extname(file);
  let bytes = fs.readFileSync(file);
  // Inject the optional Direct-mode "Server address" prefill (from
  // --server-host) into index.html as a global the page reads on load.
  if (ext === ".html" && serverPrefill) {
    const tag = `<script>window.__NX_SERVER_PREFILL__=${JSON.stringify(serverPrefill)};</script>`;
    bytes = Buffer.from(bytes.toString("utf8").replace("</head>", `  ${tag}\n  </head>`), "utf8");
  }
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
  res.end(bytes);
}

const args = parseArgs(process.argv.slice(2));
const serverPrefill = (args.serverHost || "").replace(/\/+$/, "");
const handleProxy = createProxyHandler({
  cloudHost: args.cloudHost,
  insecure: args.insecure,
});

const server = http.createServer(async (req, res) => {
  // Try the proxy first; if it didn't own the route, serve a static file.
  if (await handleProxy(req, res)) return;
  serveStatic(req.url || "/", res, { serverPrefill });
});

server.listen(Number(args.port), () => {
  const prefillNote = serverPrefill
    ? `prefills the page's Server address (${serverPrefill})`
    : `(none — type the Server address on the page; e.g. ${SERVER_HOST_PLACEHOLDER})`;
  process.stdout.write(
    `\nNx browser sample running:\n` +
      `  open    http://localhost:${args.port}/\n` +
      `  static  served from this folder (index.html, app.mjs, …)\n` +
      `  cloud   /cloud/*                  -> ${args.cloudHost.replace(/\/+$/, "")}\n` +
      `  relay   /relay/<siteId>/*       -> https://<siteId>${RELAY_SUFFIX}\n` +
      `  server  /server/<encoded-base>/* -> the base URL entered on the page (direct)\n` +
      `  prefill ${prefillNote}\n` +
      `  TLS     direct: self-signed always accepted; cloud/relay: ${args.insecure ? "self-signed accepted (--insecure)" : "verified (add --insecure for self-signed)"}\n\n` +
      `Leave this running; open the URL above in your browser.\n`,
  );
});
