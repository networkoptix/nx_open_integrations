// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Wires the form in index.html to NxCloudClient. No framework, no build
 * step — a plain ES module loaded with <script type="module">.
 *
 * All the API logic lives in nx-cloud-client.mjs (and is unit-tested offline).
 * This file only touches the DOM.
 */

import {
  NxCloudClient,
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

function renderSites(sites) {
  const tbody = $("site-rows");
  const picker = $("site-picker");
  tbody.innerHTML = "";
  picker.innerHTML = "";
  if (!sites.length) {
    setStatus("Logged in, but this account has no Sites.", "info");
    $("results").hidden = true;
    return;
  }
  for (const site of sites) {
    const tr = document.createElement("tr");
    for (const key of ["name", "status", "version", "id"]) {
      const td = document.createElement("td");
      td.textContent = site[key];
      if (key === "status") {
        td.dataset.status = String(site.status).toLowerCase();
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);

    const option = document.createElement("option");
    option.value = site.id;
    option.textContent = site.name || site.id;
    picker.appendChild(option);
  }
  $("results").hidden = false;
  setStatus(`Listed ${sites.length} site(s).`, "ok");
}

async function onSubmit(event) {
  event.preventDefault();
  $("results").hidden = true;
  $("site-rows").innerHTML = "";

  const config = resolveConfig({
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
  setStatus("Logging in to Nx Cloud…", "info");

  const client = new NxCloudClient(config);
  try {
    await client.login();
    setStatus("Logged in. Listing your Sites…", "info");
    const sites = await client.listSites();
    renderSites(sites);
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
