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

/** A usage mistake: say so and exit 2, the usage-error exit code. */
function usageError(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(2);
}

/** Any other error the operator can cause: say so and exit 1. No stack trace. */
function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = { port: "8080", serverHost: "", insecure: false };
  const booleans = { "--insecure": "insecure" };
  const values = { "--port": "port", "--server-host": "serverHost" };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    if (a.startsWith("--") && a.includes("=")) {
      const e = a.indexOf("=");
      inline = a.slice(e + 1);
      a = a.slice(0, e);
    }
    if (a in booleans) {
      // --insecure=no would otherwise read as --insecure.
      if (inline !== null) usageError(`${a} takes no value`);
      flags[booleans[a]] = true;
    } else if (a in values) {
      let value = inline;
      if (value === null) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) value = argv[++i];
      }
      if (!value) usageError(`Missing value for ${a}`);
      flags[values[a]] = value;
    } else {
      usageError(`unknown argument: ${a}`);
    }
  }
  if (!/^\d+$/.test(flags.port) || Number(flags.port) < 1 || Number(flags.port) > 65535) {
    usageError(`--port must be a number from 1 to 65535, not ${flags.port}`);
  }
  if (flags.serverHost) {
    let url;
    try {
      url = new URL(flags.serverHost);
    } catch {
      url = null;
    }
    if (!url || !["http:", "https:"].includes(url.protocol)) {
      fail(`--server-host must be a URL with scheme and port, e.g. ${SERVER_HOST_PLACEHOLDER}, not ${flags.serverHost}`);
    }
  }
  return flags;
}

function serveStatic(urlPath, res) {
  const rel = (urlPath === "/" ? "/index.html" : urlPath).split("?")[0];
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
  // Try the proxy first; if it did not own the route, serve a static file.
  if (await handleProxy(req, res)) return;
  serveStatic(req.url || "/", res);
});

// e.g. the port is taken: a one-line error, not a stack trace.
server.on("error", (exc) => fail(`could not listen on port ${args.port}: ${exc.message}`));

process.on("SIGINT", () => {
  process.stderr.write("\nInterrupted.\n");
  process.exit(130);
});

// Loopback only: the forwarder has no authentication of its own.
server.listen(Number(args.port), "127.0.0.1", () => {
  const configured = args.serverHost
    ? args.serverHost.replace(/\/+$/, "")
    : `(none, pass --server-host ${SERVER_HOST_PLACEHOLDER})`;
  process.stdout.write(
    `\nNx browser sample running:\n` +
      `  open    http://localhost:${args.port}/\n` +
      `  static  served from this folder (index.html, app.mjs, ...)\n` +
      `  server  /server/*   -> ${configured}\n` +
      `  TLS     ${args.insecure ? "self-signed certs accepted (--insecure)" : "verified (add --insecure for self-signed certs)"}\n\n` +
      (args.serverHost
        ? `Leave this running; open the URL above in your browser.\n`
        : `No --server-host set: API calls will return a 502 until you restart with one.\n`),
  );
});
