// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Wires the form in index.html to NxVirtualCameraClient. No framework, no build
 * step — a plain ES module loaded with <script type="module">.
 *
 * All API logic lives in nx-virtual-camera-client.mjs (unit-tested offline).
 * This file only touches the DOM: it reads the form (including the <input
 * type="file">), runs the upload orchestration, and streams progress.
 */

import {
  NxVirtualCameraClient,
  uploadVideo,
  parseStartTimeMs,
  resolveConfig,
  missingFields,
  AuthError,
  ApiError,
} from "./nx-virtual-camera-client.mjs";

const $ = (id) => document.getElementById(id);

function setStatus(message, kind = "info") {
  const el = $("status");
  el.textContent = message;
  el.className = `status ${kind}`;
}

function logLine(message) {
  const ul = $("log");
  const li = document.createElement("li");
  li.textContent = message;
  ul.appendChild(li);
  $("results").hidden = false;
}

async function onSubmit(event) {
  event.preventDefault();
  $("results").hidden = true;
  $("log").innerHTML = "";

  const config = resolveConfig({
    serverHost: $("serverHost").value,
    user: $("user").value,
    password: $("password").value,
  });

  const missing = missingFields(config);
  if (missing.length) {
    setStatus(`Missing: ${missing.join(", ")}.`, "error");
    return;
  }

  const fileInput = $("file");
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    setStatus("Choose a video file to upload.", "error");
    return;
  }

  let startTimeMs;
  try {
    startTimeMs = parseStartTimeMs($("startTime").value);
  } catch (exc) {
    setStatus(exc.message, "error");
    return;
  }

  const name = $("name").value.trim() || "Virtual Camera";
  const deviceId = $("deviceId").value.trim() || null;

  // Optional: if left blank, the server derives the clip's duration from the
  // video file's own metadata.
  const durationMsRaw = $("durationMs").value.trim();
  let durationMs = null;
  if (durationMsRaw) {
    durationMs = Number(durationMsRaw);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      setStatus("Clip duration must be a positive number of milliseconds.", "error");
      return;
    }
  }

  const button = $("submit");
  button.disabled = true;
  setStatus("Logging in to the server…", "info");

  const client = new NxVirtualCameraClient(config);
  try {
    await client.login();
    setStatus("Logged in. Uploading footage…", "info");
    const result = await uploadVideo(client, file, {
      name,
      startTimeMs,
      durationMs,
      deviceId,
      onProgress: logLine,
    });
    setStatus(
      `Done. Uploaded ${result.sizeB} byte(s) in ${result.chunkCount} chunk(s) ` +
        `to device ${result.deviceId}, archive starting ${result.startTimeMs}ms.`,
      "ok",
    );
  } catch (exc) {
    if (exc instanceof AuthError) setStatus(`Auth failed: ${exc.message}`, "error");
    else if (exc instanceof ApiError) setStatus(exc.message, "error");
    else setStatus(`Unexpected error: ${exc.message}`, "error");
  } finally {
    client.logout();
    button.disabled = false;
  }
}

// Default the start-time field to now, and prefill the server address from the
// dev server's optional --server-host (via /config.json). Both are convenience
// only; the user can change either.
function toLocalDatetimeValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

window.addEventListener("DOMContentLoaded", async () => {
  $("startTime").value = toLocalDatetimeValue(new Date());
  $("upload-form").addEventListener("submit", onSubmit);
  try {
    const res = await fetch("/config.json");
    if (res.ok) {
      const cfg = await res.json();
      if (cfg.serverHost && !$("serverHost").value) $("serverHost").value = cfg.serverHost;
    }
  } catch {
    // No dev-server config endpoint — leave the field for the user to fill.
  }
});
