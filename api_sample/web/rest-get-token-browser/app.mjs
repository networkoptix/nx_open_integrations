// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Wires the form in index.html to NxLoginClient. No framework, no build step —
 * a plain ES module loaded with <script type="module">.
 *
 * All the API logic lives in nx-login-client.mjs (and is unit-tested offline).
 * This file only touches the DOM.
 */

import {
  NxLoginClient,
  sessionRows,
  resolveConfig,
  missingFields,
  AuthError,
  ApiError,
} from "./nx-login-client.mjs";

const $ = (id) => document.getElementById(id);

const STEPS = ["login", "use", "logout", "recheck"];

function setStatus(message, kind = "info") {
  const el = $("status");
  el.textContent = message;
  el.className = `status ${kind}`;
}

/** Mark one timeline step, and optionally write its one-line outcome. */
function setStep(name, state, outcome = null) {
  const li = $(`step-${name}`);
  if (li) li.dataset.state = state;
  if (outcome !== null) {
    const out = $(`out-${name}`);
    if (out) out.textContent = outcome;
  }
}

function resetSteps() {
  for (const name of STEPS) {
    const li = $(`step-${name}`);
    if (li) delete li.dataset.state;
    const out = $(`out-${name}`);
    if (out) out.textContent = "";
  }
  $("results").hidden = true;
  $("session-rows").innerHTML = "";
}

function renderSession(session) {
  const tbody = $("session-rows");
  tbody.innerHTML = "";
  for (const [label, value] of sessionRows(session)) {
    const tr = document.createElement("tr");
    const th = document.createElement("td");
    th.textContent = label;
    const td = document.createElement("td");
    td.textContent = value;
    td.className = "value";
    tr.append(th, td);
    tbody.appendChild(tr);
  }
  $("results").hidden = false;
}

async function onSubmit(event) {
  event.preventDefault();
  resetSteps();

  const config = resolveConfig({
    user: $("user").value,
    password: $("password").value,
  });

  const missing = missingFields(config);
  if (missing.length) {
    setStatus(`Missing: ${missing.join(", ")}.`, "error");
    return;
  }

  const button = $("submit");
  button.disabled = true;

  const client = new NxLoginClient(config);
  try {
    // 1. Trade the username/password for a token.
    setStatus("Logging in to the mediaserver…", "info");
    setStep("login", "busy");
    const session = await client.login();
    setStep("login", "done", `Got a token, valid for ${session.expiresInS ?? "?"} seconds.`);
    renderSession(session);

    // 2. Use the token on a real authenticated request.
    setStatus("Using the token…", "info");
    setStep("use", "busy");
    const live = await client.getCurrentSession();
    setStep(
      "use",
      "done",
      `200 OK — the server recognised the token (session belongs to ` +
        `'${live.username ?? ""}').`,
    );

    // 3. Hand the token back. Keep a copy so we can prove it stopped working.
    const spentToken = client.token;
    setStatus("Logging out…", "info");
    setStep("logout", "busy");
    const confirmed = await client.logout();
    setStep(
      "logout",
      "done",
      confirmed
        ? "Session deleted."
        : "The server did not confirm the delete (it may still expire on its own).",
    );

    // 4. Show that the token really is gone. A rejection here is success.
    setStatus("Re-checking the old token…", "info");
    setStep("recheck", "busy");
    const { isLive, status } = await client.tokenStillWorks(spentToken);
    if (isLive) {
      setStep("recheck", "fail", "Unexpectedly still accepted — the session was not released.");
      setStatus("Finished, but the token still works. See the README.", "error");
    } else if (status === null) {
      setStep("recheck", "fail", "Could not reach the server to confirm.");
      setStatus("Finished, but the last check could not reach the server.", "error");
    } else {
      setStep(
        "recheck",
        "done",
        `HTTP ${status} — the token is rejected. That is the expected result: logout worked.`,
      );
      setStatus("All four steps completed. The token is gone.", "ok");
    }
  } catch (exc) {
    // Mark whichever step was in flight as failed, so the timeline shows where
    // it stopped rather than silently going quiet.
    for (const name of STEPS) {
      if ($(`step-${name}`)?.dataset.state === "busy") setStep(name, "fail");
    }
    if (exc instanceof AuthError) setStatus(`Login failed: ${exc.message}`, "error");
    else if (exc instanceof ApiError) setStatus(exc.message, "error");
    else setStatus(`Unexpected error: ${exc.message}`, "error");
  } finally {
    // If we bailed out early the session is still open; release it.
    client.logout();
    button.disabled = false;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  $("login-form").addEventListener("submit", onSubmit);
});
