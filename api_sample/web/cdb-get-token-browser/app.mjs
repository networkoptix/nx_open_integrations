// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Wires the form in index.html to NxCloudTokenClient. No framework, no build
 * step — a plain ES module loaded with <script type="module">.
 *
 * All the API logic lives in nx-cloud-client.mjs (and is unit-tested offline).
 * This file only touches the DOM.
 */

import {
  NxCloudTokenClient,
  resolveConfig,
  missingFields,
  AuthError,
  ApiError,
} from "./nx-cloud-client.mjs";

const $ = (id) => document.getElementById(id);

function setStatus(message, kind = "info") {
  const el = $("status");
  el.textContent = message;
  el.className = `status ${kind}`;
}

function renderToken(data) {
  $("token").textContent = data.access_token;
  const expires = $("expires");
  if (data.expires_in !== undefined && data.expires_in !== null) {
    expires.textContent = `Expires in ${data.expires_in} seconds.`;
    expires.hidden = false;
  } else {
    expires.textContent = "";
    expires.hidden = true;
  }
  $("results").hidden = false;
  setStatus("Token acquired.", "ok");
}

async function copyToken() {
  const token = $("token").textContent;
  if (!token) return;
  try {
    await navigator.clipboard.writeText(token);
    setStatus("Token copied to clipboard.", "ok");
  } catch {
    setStatus("Could not copy — select the token text and copy it manually.", "info");
  }
}

async function onSubmit(event) {
  event.preventDefault();
  $("results").hidden = true;
  $("token").textContent = "";

  const config = resolveConfig({
    user: $("user").value,
    password: $("password").value,
    mfaCode: $("mfaCode").value,
    cloudSiteId: $("cloudSiteId").value,
  });

  const missing = missingFields(config);
  if (missing.length) {
    setStatus(`Missing: ${missing.join(", ")}.`, "error");
    return;
  }

  const button = $("submit");
  button.disabled = true;
  setStatus("Requesting a token…", "info");

  const client = new NxCloudTokenClient(config);
  try {
    const data = await client.getToken();
    renderToken(data);
  } catch (exc) {
    if (exc instanceof AuthError) setStatus(`Login failed: ${exc.message}`, "error");
    else if (exc instanceof ApiError) setStatus(exc.message, "error");
    else setStatus(`Unexpected error: ${exc.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  $("login-form").addEventListener("submit", onSubmit);
  $("copy").addEventListener("click", copyToken);
});
