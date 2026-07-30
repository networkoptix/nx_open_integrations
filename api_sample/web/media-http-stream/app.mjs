// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Wires the form in index.html to NxMediaClient. No framework, no build step —
 * a plain ES module loaded with <script type="module">.
 *
 * All the API logic lives in nx-media-client.mjs (and is unit-tested offline).
 * This file only touches the DOM:
 *   - the mode toggle shows/hides cloud-only fields,
 *   - Play logs in, builds the same-origin media URL, and points <video> at it,
 *   - Stop clears the <video> src.
 */

import {
  NxMediaClient,
  resolveConfig,
  missingFields,
  parsePositionMs,
  MODE_CLOUD,
  AuthError,
  ApiError,
} from "./nx-media-client.mjs";

const $ = (id) => document.getElementById(id);

function setStatus(message, kind = "info") {
  const el = $("status");
  el.textContent = message;
  el.className = `status ${kind}`;
}

function currentMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : "direct";
}

/** Show/hide the fields that only apply to one mode. */
function applyMode() {
  const cloud = currentMode() === MODE_CLOUD;
  // Direct-only field: the media server address.
  $("field-serverAddress").hidden = cloud;
  $("serverAddress").required = !cloud;
  // Cloud-only fields.
  $("field-siteId").hidden = !cloud;
  $("field-mfa").hidden = !cloud;
  $("siteId").required = cloud;
  $("user-label").textContent = cloud ? "Cloud email" : "Local server username";
  $("user").type = cloud ? "email" : "text";
  $("user").placeholder = cloud ? "you@example.com" : "admin";
  $("user-hint").textContent = cloud
    ? "Your Nx Cloud account email."
    : "A LOCAL server account (not a cloud account).";
  $("password-label").textContent = cloud ? "Cloud password" : "Local server password";
}

// Keep a reference so Stop/replay can revoke the previous token.
let client = null;

async function onSubmit(event) {
  event.preventDefault();

  const config = resolveConfig({
    mode: currentMode(),
    serverAddress: $("serverAddress").value,
    user: $("user").value,
    password: $("password").value,
    siteId: $("siteId").value,
    mfaCode: $("mfaCode").value,
    deviceId: $("deviceId").value,
    stream: $("stream").value,
    position: $("position").value,
  });

  const missing = missingFields(config);
  if (missing.length) {
    setStatus(`Missing: ${missing.join(", ")}.`, "error");
    return;
  }

  let positionMs;
  try {
    positionMs = parsePositionMs(config.position);
  } catch (exc) {
    setStatus(exc.message, "error");
    return;
  }

  // Revoke any previous token before starting a new session.
  if (client) client.logout();

  const button = $("play");
  button.disabled = true;
  setStatus(config.mode === MODE_CLOUD ? "Requesting a site-scoped token…" : "Logging in to the media server…", "info");

  client = new NxMediaClient(config);
  try {
    await client.login();
    const url = client.buildMediaUrl({
      deviceId: config.deviceId,
      stream: config.stream,
      positionMs,
    });
    const video = $("video");
    video.src = url;
    video.play().catch(() => {
      // Autoplay can be blocked; the controls let the user start it manually.
    });
    setStatus(positionMs === null ? "Playing live video…" : "Playing archive video…", "ok");
  } catch (exc) {
    if (exc instanceof AuthError) setStatus(`Login failed: ${exc.message}`, "error");
    else if (exc instanceof ApiError) setStatus(exc.message, "error");
    else setStatus(`Unexpected error: ${exc.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

function onStop() {
  const video = $("video");
  video.pause();
  video.removeAttribute("src");
  video.load();
  if (client) client.logout();
  setStatus("Stopped.", "info");
}

window.addEventListener("DOMContentLoaded", () => {
  // Optional prefill for the Server address field, injected by server.mjs from
  // an (optional) --server-host flag. Not required; the user can type it.
  if (typeof window.__NX_SERVER_PREFILL__ === "string" && window.__NX_SERVER_PREFILL__) {
    $("serverAddress").value = window.__NX_SERVER_PREFILL__;
  }
  applyMode();
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener("change", applyMode);
  }
  $("play-form").addEventListener("submit", onSubmit);
  $("stop").addEventListener("click", onStop);
});
