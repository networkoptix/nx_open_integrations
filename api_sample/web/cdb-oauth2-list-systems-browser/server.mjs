#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Dev server for the browser sample — JUST static file serving, plus it mounts
 * the CORS forwarder from proxy.mjs.
 *
 * This is the one command you run to try the demo:
 *
 *   node server.mjs
 *   node server.mjs --cloud-host https://nxvms.com --port 8080
 *   node server.mjs --insecure          # local cloud / self-signed certs
 *
 * Then open the printed URL and enter your cloud email + password.
 *
 * Separation of concerns: this file knows about the demo's files; proxy.mjs
 * knows about forwarding API calls. They run on one port so the page and its
 * API calls share an origin — which is what keeps the browser's CORS rule
 * satisfied. This is a DEV CONVENIENCE, not a production gateway.
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
  const flags = { port: "8080", cloudHost: "https://nxvms.com", insecure: false };
  const map = { "--port": "port", "--cloud-host": "cloudHost" };
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
const handleProxy = createProxyHandler({ cloudHost: args.cloudHost, insecure: args.insecure });

const server = http.createServer(async (req, res) => {
  // Try the proxy first; if it didn't own the route, serve a static file.
  if (await handleProxy(req, res)) return;
  serveStatic(req.url || "/", res);
});

server.listen(Number(args.port), () => {
  process.stdout.write(
    `\nNx browser sample running:\n` +
      `  open    http://localhost:${args.port}/\n` +
      `  static  served from this folder (index.html, app.mjs, …)\n` +
      `  cloud   /cloud/*   -> ${args.cloudHost.replace(/\/+$/, "")}\n\n` +
      `Leave this running; open the URL above in your browser.\n`,
  );
});
