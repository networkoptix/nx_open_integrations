// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Wires the form in index.html to NxCloudSiteClient. No framework, no build
 * step — a plain ES module loaded with <script type="module">.
 *
 * All the API logic lives in nx-cloud-client.mjs (and is unit-tested offline).
 * This file only touches the DOM.
 */

import {
  NxCloudSiteClient,
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

function renderCameras(cameras) {
  const tbody = $("camera-rows");
  tbody.innerHTML = "";
  if (!cameras.length) {
    setStatus("Connected, but this site has no cameras.", "info");
    $("results").hidden = true;
    return;
  }
  for (const cam of cameras) {
    const tr = document.createElement("tr");
    for (const key of ["name", "status", "model", "id"]) {
      const td = document.createElement("td");
      td.textContent = cam[key];
      if (key === "status") {
        td.dataset.status = String(cam.status).toLowerCase();
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  $("results").hidden = false;
  setStatus(`Listed ${cameras.length} camera(s).`, "ok");
}

async function onSubmit(event) {
  event.preventDefault();
  $("results").hidden = true;
  $("camera-rows").innerHTML = "";

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

  const button = $("submit");
  button.disabled = true;
  setStatus("Requesting a site-scoped token…", "info");

  const client = new NxCloudSiteClient(config);
  try {
    await client.login();
    setStatus("Token acquired. Listing cameras…", "info");
    const cameras = await client.listCameras();
    renderCameras(cameras);
  } catch (exc) {
    if (exc instanceof AuthError) setStatus(`Login failed: ${exc.message}`, "error");
    else if (exc instanceof ApiError) setStatus(exc.message, "error");
    else setStatus(`Unexpected error: ${exc.message}`, "error");
  } finally {
    // Best-effort: revoke the token so it doesn't linger.
    client.logout();
    button.disabled = false;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  $("login-form").addEventListener("submit", onSubmit);
});
