// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * DOM wiring for the WebRTC live-view sample. No framework, no build step.
 *
 * Flow:
 *   1. Log in (cloud OAuth2, site-scoped token) and list cameras  -> via proxy
 *   2. User picks a camera and clicks Play
 *   3. startLiveView() streams that camera into the <video>       -> direct WebRTC
 *
 * The API logic lives in nx-cloud-client.mjs (login/list) and webrtc-view.mjs
 * (the stream). This file only touches the DOM.
 */

import { NxCloudSiteClient, resolveConfig, missingFields, AuthError, ApiError } from "./nx-cloud-client.mjs";
import { startLiveView } from "./webrtc-view.mjs";

const $ = (id) => document.getElementById(id);

let client = null;   // kept alive after login so its token can feed the stream
let liveView = null; // the current { stop } handle, if playing

function setStatus(message, kind = "info") {
  const el = $("status");
  el.textContent = message;
  el.className = `status ${kind}`;
}

function fillCameraOptions(cameras) {
  const select = $("camera-select");
  select.innerHTML = "";
  for (const cam of cameras) {
    const opt = document.createElement("option");
    opt.value = cam.id;
    opt.textContent = cam.name ? `${cam.name} (${cam.status})` : cam.id;
    select.appendChild(opt);
  }
}

async function onLogin(event) {
  event.preventDefault();
  stopPlayback();
  $("player").hidden = true;

  const config = resolveConfig({
    siteId: $("siteId").value,
    user: $("user").value,
    password: $("password").value,
    mfaCode: $("mfaCode").value,
  });
  const missing = missingFields(config);
  if (missing.length) {
    setStatus(`Missing: ${missing.join(", ")}.`, "error");
    return;
  }

  const btn = $("login-btn");
  btn.disabled = true;
  setStatus("Logging in and loading cameras…", "info");

  try {
    client = new NxCloudSiteClient(config); // baseUrl "" -> same-origin proxy
    await client.login();
    const cameras = await client.listCameras();
    if (!cameras.length) {
      setStatus("Logged in, but this site has no cameras.", "info");
      return;
    }
    fillCameraOptions(cameras);
    $("player").hidden = false;
    setStatus(`Loaded ${cameras.length} camera(s). Pick one and press Play.`, "ok");
  } catch (exc) {
    if (exc instanceof AuthError) setStatus(`Login failed: ${exc.message}`, "error");
    else if (exc instanceof ApiError) setStatus(exc.message, "error");
    else setStatus(`Unexpected error: ${exc.message}`, "error");
  } finally {
    btn.disabled = false;
  }
}

async function onPlay() {
  if (!client || !client.token) {
    setStatus("Please log in first.", "error");
    return;
  }
  stopPlayback();
  const cameraId = $("camera-select").value;
  setStatus("Starting live video…", "info");
  $("play-btn").disabled = true;

  try {
    liveView = await startLiveView({
      video: $("video"),
      siteId: client.siteId,
      cameraId,
      // Pass a factory so the library always reads the freshest token.
      accessToken: () => client.token,
      onError: (err) => setStatus(`Stream error: ${err.message}`, "error"),
    });
    $("stop-btn").disabled = false;
    setStatus("Live. If the picture doesn't appear, see the README troubleshooting.", "ok");
  } catch (exc) {
    setStatus(`Could not start live view: ${exc.message}`, "error");
  } finally {
    $("play-btn").disabled = false;
  }
}

function stopPlayback() {
  if (liveView) {
    liveView.stop();
    liveView = null;
  }
  $("stop-btn").disabled = true;
}

function onStop() {
  stopPlayback();
  setStatus("Stopped.", "info");
}

window.addEventListener("DOMContentLoaded", () => {
  $("login-form").addEventListener("submit", onLogin);
  $("play-btn").addEventListener("click", onPlay);
  $("stop-btn").addEventListener("click", onStop);
});

// Best-effort: revoke the cloud token when the page closes.
window.addEventListener("beforeunload", () => {
  stopPlayback();
  if (client) client.logout();
});
