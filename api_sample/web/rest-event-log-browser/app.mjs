// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * DOM wiring for the event-log browser sample. No framework, no build step.
 *
 * Two steps:
 *   1. Connect — log in, then fetch the site's event-type manifest
 *      (GET /rest/v4/events/manifest/events) and fill the Event type dropdown.
 *   2. Load events — read /rest/v4/events/log for the chosen window/type.
 *
 * The API logic lives in nx-eventlog-client.mjs; this file only touches the DOM.
 */

import {
  NxEventLogClient,
  resolveConfig,
  missingFields,
  windowEndingNow,
  AuthError,
  ApiError,
} from "./nx-eventlog-client.mjs";

const $ = (id) => document.getElementById(id);

let client = null; // kept alive between Connect and Load events

function setStatus(message, kind = "info") {
  const el = $("status");
  el.textContent = message;
  el.className = `status ${kind}`;
}

/** Fill the Event type <select> with the manifest types (just the type name). */
function fillEventTypes(types) {
  const select = $("eventType");
  select.innerHTML = '<option value="">All event types</option>';
  for (const t of types) {
    const opt = document.createElement("option");
    opt.value = t.id;        // the eventType id sent to the API
    opt.textContent = t.id;  // show just the event type name, as requested
    select.appendChild(opt);
  }
}

function renderEvents(events) {
  const tbody = $("event-rows");
  tbody.innerHTML = "";
  for (const ev of events) {
    const tr = document.createElement("tr");
    const cells = [["time", ev.time], ["", ev.eventType], ["", ev.actionType], ["", ev.resource]];
    for (const [cls, value] of cells) {
      const td = document.createElement("td");
      if (cls) td.className = cls;
      td.textContent = value;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  $("results").hidden = false;
}

// Step 1 — connect and build the dropdown first.
async function onConnect(event) {
  event.preventDefault();
  $("query").hidden = true;
  $("results").hidden = true;

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

  const btn = $("connect-btn");
  btn.disabled = true;
  setStatus("Connecting and loading event types…", "info");

  try {
    client = new NxEventLogClient(config); // baseUrl "" -> same-origin proxy
    await client.login();
    const types = await client.getEventTypes(); // GET /rest/v4/events/manifest/events
    fillEventTypes(types);
    $("query").hidden = false;
    setStatus(`Connected. ${types.length} event type(s) loaded — pick a window and load events.`, "ok");
  } catch (exc) {
    if (exc instanceof AuthError) setStatus(`Login/access failed: ${exc.message}`, "error");
    else if (exc instanceof ApiError) setStatus(exc.message, "error");
    else setStatus(`Unexpected error: ${exc.message}`, "error");
  } finally {
    btn.disabled = false;
  }
}

// Step 2 — load the event log for the chosen window/type.
async function onLoad() {
  if (!client || !client.token) {
    setStatus("Please connect first.", "error");
    return;
  }
  $("results").hidden = true;
  $("event-rows").innerHTML = "";

  const since = $("since").value;
  const limit = Math.max(1, Number.parseInt($("limit").value, 10) || 50);
  const eventType = $("eventType").value || null; // "" = all types
  const [startMs, durationMs] = windowEndingNow(Date.now(), since);

  const btn = $("load-btn");
  btn.disabled = true;
  setStatus("Reading the event log…", "info");

  try {
    const events = await client.getEventLog(startMs, durationMs, { eventType, order: "desc", limit });
    if (!events.length) {
      setStatus("No events in this time range.", "info");
    } else {
      renderEvents(events);
      setStatus(`${events.length} event(s) in the last ${since}.`, "ok");
    }
  } catch (exc) {
    if (exc instanceof AuthError) setStatus(`Access failed: ${exc.message}`, "error");
    else if (exc instanceof ApiError) setStatus(exc.message, "error");
    else setStatus(`Unexpected error: ${exc.message}`, "error");
  } finally {
    btn.disabled = false;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  $("login-form").addEventListener("submit", onConnect);
  $("load-btn").addEventListener("click", onLoad);
});

// Best-effort: revoke the cloud token when the page closes.
window.addEventListener("beforeunload", () => {
  if (client) client.logout();
});
