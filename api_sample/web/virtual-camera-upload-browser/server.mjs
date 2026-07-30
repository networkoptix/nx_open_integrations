#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Dev server for the browser sample — static file serving plus the CORS
 * forwarder from proxy.mjs, on ONE port (same-origin = no CORS).
 *
 * This is the one command you run to try the demo:
 *
 *   node server.mjs
 *   node server.mjs --server-host https://192.168.1.10:7001   # prefill the page field
 *   node server.mjs --port 8080
 *
 * Unlike the list-cameras sample, the target VMS server is chosen on the PAGE
 * (a Server address field). --server-host is optional and ONLY prefills that
 * field for convenience; the proxy reads the target from each request's
 * /server/<encoded-base> segment.
 *
 * The proxy always tolerates the server's self-signed TLS cert (a direct local
 * server practically always uses one). --insecure is accepted for parity but is
 * a no-op here. This is a DEV CONVENIENCE, not a production gateway.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createProxyHandler } from "./proxy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function parseArgs(argv) {
  const flags = { port: "8080", serverHost: "", insecure: false };
  const map = { "--port": "port", "--server-host": "serverHost" };
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

function serveStatic(urlPath, res) {
  let rel = (urlPath === "/" ? "/index.html" : urlPath).split("?")[0];
  // Surface the prefill server-host to the page via a tiny config endpoint.
  const file = path.join(HERE, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(HERE) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
}

const args = parseArgs(process.argv.slice(2));
const handleProxy = createProxyHandler({ insecure: args.insecure });
const PREFILL = (args.serverHost || "").replace(/\/+$/, "");

const server = http.createServer(async (req, res) => {
  const url = req.url || "/";
  // A tiny config endpoint so the page can prefill the Server address field.
  if (url === "/config.json" || url.startsWith("/config.json?")) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ serverHost: PREFILL }));
    return;
  }
  // Try the proxy first; if it didn't own the route, serve a static file.
  if (await handleProxy(req, res)) return;
  serveStatic(url, res);
});

server.listen(Number(args.port), () => {
  process.stdout.write(
    `\nNx virtual-camera upload sample running:\n` +
      `  open    http://localhost:${args.port}/\n` +
      `  static  served from this folder (index.html, app.mjs, …)\n` +
      `  proxy   /server/<encoded https://ip:port>/*   -> that server (self-signed TLS accepted)\n` +
      `  prefill server address field: ${PREFILL || "(none — type it on the page)"}\n\n` +
      `Leave this running; open the URL above in your browser.\n`,
  );
});
