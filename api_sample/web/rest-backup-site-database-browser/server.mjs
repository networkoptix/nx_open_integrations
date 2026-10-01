#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Dev server for the browser sample: just static file serving, plus it mounts
 * the CORS forwarder from proxy.mjs.
 *
 * This is the one command you run to try the demo. Point it at YOUR server:
 *
 *   node server.mjs --server-host https://192.168.1.10:7001 --insecure
 *   node server.mjs --server-host https://192.168.1.10:7001 --port 8080
 *
 * --server-host is the single VMS server this sample talks to (include https://
 * and the port). --insecure makes the proxy accept that server's self-signed
 * TLS certificate, which local lab servers almost always use.
 *
 * Then open the printed URL and enter your server username and password.
 *
 * Separation of concerns: this file knows about the demo's files; proxy.mjs
 * knows about forwarding API calls. They run on one port so the page and its
 * API calls share an origin, which is what keeps the browser's CORS rule
 * satisfied. This is a DEV CONVENIENCE, not a production gateway.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createProxyHandler } from "./proxy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Placeholder shown when no --server-host is given.
const SERVER_HOST_PLACEHOLDER = "https://192.168.1.10:7001";

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
  // Drop the query string first, so /?v=2 is the page and not a 404.
  const bare = urlPath.split("?")[0];
  const rel = bare === "/" ? "/index.html" : bare;
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
const handleProxy = createProxyHandler({ serverHost: args.serverHost, insecure: args.insecure });

const server = http.createServer(async (req, res) => {
  try {
    // Try the proxy first; if it did not own the route, serve a static file.
    if (await handleProxy(req, res)) return;
    serveStatic(req.url || "/", res);
  } catch (exc) {
    // Last line of defence: one failed request must not stop the dev server.
    process.stderr.write(`Request failed: ${exc?.stack ?? exc}\n`);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal error");
  }
});

// Loopback only. The page forwards an administrator's password to the VMS
// server, and with --insecure skips its certificate check, so this must not be
// reachable from anyone else on the network.
const LISTEN_HOST = "127.0.0.1";

server.listen(Number(args.port), LISTEN_HOST, () => {
  const configured = args.serverHost
    ? args.serverHost.replace(/\/+$/, "")
    : `(none, pass --server-host ${SERVER_HOST_PLACEHOLDER})`;
  process.stdout.write(
    `\nNx browser sample running:\n` +
      `  open    http://${LISTEN_HOST}:${args.port}/   (this machine only)\n` +
      `  static  served from this folder (index.html, app.mjs, ...)\n` +
      `  server  /server/*   -> ${configured}\n` +
      `  TLS     ${args.insecure ? "self-signed certs accepted (--insecure)" : "verified (add --insecure for self-signed certs)"}\n\n` +
      (args.serverHost
        ? `Leave this running; open the URL above in your browser.\n`
        : `No --server-host set: API calls will return a 502 until you restart with one.\n`),
  );
});
