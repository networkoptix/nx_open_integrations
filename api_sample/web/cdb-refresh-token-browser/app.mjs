// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Wires the form in index.html to TokenSession. No framework, no build step —
 * a plain ES module loaded with <script type="module">.
 *
 * All the API + session logic lives in nx-cloud-client.mjs (and is unit-tested
 * offline). This file only touches the DOM. The single TokenSession instance
 * persists to sessionStorage, so on load it can resume a saved session and
 * offer a refresh WITHOUT asking for the password again.
 *
 * See the README's "Security" section: storing tokens in the browser exposes
 * them to XSS. sessionStorage is used here only to demonstrate the refresh flow.
 */

import {
  TokenSession,
  resolveConfig,
  missingFields,
  shortToken,
  formatExpiry,
  AuthError,
  ApiError,
} from "./nx-cloud-client.mjs";

const $ = (id) => document.getElementById(id);

// One session for the page. Constructed once; it loads any saved session from
// sessionStorage in its constructor.
const session = new TokenSession();

function setStatus(message, kind = "info") {
  const el = $("status");
  el.textContent = message;
  el.className = `status ${kind}`;
}

/** Reflect the current session state into the status card + buttons. */
function renderSession() {
  const card = $("session");
  if (!session.hasSession()) {
    card.hidden = true;
    $("refresh").disabled = true;
    $("clear").disabled = true;
    return;
  }
  card.hidden = false;
  $("refresh").disabled = false;
  $("clear").disabled = false;

  $("stored").textContent = "yes (sessionStorage)";
  $("access").textContent = shortToken(session.accessToken) || "—";
  $("refreshTok").textContent = shortToken(session.refreshToken) || "—";

  const secs = session.secondsUntilExpiry();
  const expiring = session.isExpiring();
  const expiryEl = $("expiry");
  expiryEl.textContent = `~${formatExpiry(secs)} to expiry${expiring ? " (refresh recommended)" : ""}`;
  expiryEl.dataset.state = expiring ? "expiring" : "ok";
}

async function onLogin(event) {
  event.preventDefault();

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
  setStatus("Logging in (this is the only time the password is sent)…", "info");

  try {
    await session.login(config.user, config.password, config.mfaCode);
    setStatus("Logged in. Token + refresh token stored — refresh needs no password.", "ok");
    $("password").value = ""; // don't keep the password around in the DOM
    renderSession();
  } catch (exc) {
    reportError(exc);
  } finally {
    button.disabled = false;
  }
}

async function onRefresh() {
  $("refresh").disabled = true;
  const before = session.refreshToken;
  setStatus("Refreshing the session (no password)…", "info");
  try {
    await session.refresh();
    const rotated = session.refreshToken !== before;
    setStatus(`Refreshed.${rotated ? " The refresh token rotated." : ""}`, "ok");
    renderSession();
  } catch (exc) {
    reportError(exc);
    renderSession();
  }
}

function onClear() {
  session.clear();
  setStatus("Session cleared from this tab.", "info");
  renderSession();
}

function reportError(exc) {
  if (exc instanceof AuthError) setStatus(exc.message, "error");
  else if (exc instanceof ApiError) setStatus(exc.message, "error");
  else setStatus(`Unexpected error: ${exc.message}`, "error");
}

window.addEventListener("DOMContentLoaded", () => {
  $("login-form").addEventListener("submit", onLogin);
  $("refresh").addEventListener("click", onRefresh);
  $("clear").addEventListener("click", onClear);

  // On load: if a stored session exists, show it and offer Refresh without
  // asking for the password again.
  renderSession();
  if (session.hasSession()) {
    setStatus("Resumed a stored session. Click “Refresh now” to renew it — no password needed.", "info");
  }
});
