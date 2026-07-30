// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Wires the form in index.html to NxRuleClient. No framework, no build step —
 * a plain ES module loaded with <script type="module">.
 *
 * All the API logic lives in nx-rule-client.mjs (and is unit-tested offline).
 * This file only touches the DOM:
 *   - the mode toggle shows/hides cloud-only fields,
 *   - "Log in & list rules" logs in and renders the rules table with checkboxes,
 *   - "Set schedule on selected rules" PATCHes EVERY ticked rule to the preset,
 *     one PATCH /rest/v4/events/rules/{id} call per selected rule.
 */

import {
  NxRuleClient,
  resolveConfig,
  missingFields,
  buildScheduleFromDays,
  summarizeSchedule,
  WEEKDAYS,
  WEEKEND,
  MODE_CLOUD,
  AuthError,
  ApiError,
} from "./nx-rule-client.mjs";

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
  // Direct-only field: the server address.
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

// The logged-in client, the rules we last listed, and the set of ticked ids.
let client = null;
let rules = [];
const selectedIds = new Set();

/** Render the rules table with a checkbox per row (multi-select). */
function renderRules() {
  const body = $("rules-body");
  body.innerHTML = "";
  if (!rules.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No event rules found on this site.";
    row.appendChild(cell);
    body.appendChild(row);
    syncSelectAll();
    return;
  }
  for (const rule of rules) {
    const row = document.createElement("tr");
    if (selectedIds.has(rule.id)) row.className = "selected";

    const pick = document.createElement("td");
    pick.className = "pick";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = rule.id;
    box.checked = selectedIds.has(rule.id);
    box.addEventListener("change", () => {
      if (box.checked) selectedIds.add(rule.id);
      else selectedIds.delete(rule.id);
      row.className = box.checked ? "selected" : "";
      syncSelectAll();
    });
    pick.appendChild(box);

    row.appendChild(pick);
    row.appendChild(td(String(rule.id ?? "")));
    row.appendChild(td(rule.enabled === false ? "no" : "yes"));
    row.appendChild(td(String(rule.comment ?? "")));
    row.appendChild(td(summarizeSchedule(rule.schedule)));
    body.appendChild(row);
  }
  syncSelectAll();
}

/** Keep the header "select all" checkbox in sync with the row selection. */
function syncSelectAll() {
  const all = $("select-all");
  if (!all) return;
  const total = rules.length;
  const picked = selectedIds.size;
  all.checked = total > 0 && picked === total;
  all.indeterminate = picked > 0 && picked < total;
}

function td(text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
}

/** Log in (if needed) and list the rules. */
async function onLogin(event) {
  event.preventDefault();

  const config = resolveConfig({
    mode: currentMode(),
    serverAddress: $("serverAddress").value,
    user: $("user").value,
    password: $("password").value,
    siteId: $("siteId").value,
    mfaCode: $("mfaCode").value,
  });

  const missing = missingFields(config);
  if (missing.length) {
    setStatus(`Missing: ${missing.join(", ")}.`, "error");
    return;
  }

  // Revoke any previous token before starting a new session.
  if (client) client.logout();

  const button = $("list");
  button.disabled = true;
  setStatus(config.mode === MODE_CLOUD ? "Requesting a site-scoped token…" : "Logging in to the server…", "info");

  client = new NxRuleClient(config);
  try {
    await client.login();
    setStatus("Listing event rules…", "info");
    rules = await client.listRules();
    selectedIds.clear();
    renderRules();
    $("rules-panel").hidden = false;
    setStatus(`Loaded ${rules.length} rule(s). Tick the rules to change and set a schedule.`, "ok");
  } catch (exc) {
    reportError(exc);
  } finally {
    button.disabled = false;
  }
}

/** Read the ticked day checkboxes as dayOfWeek numbers (1=Mon..7=Sun). */
function selectedDays() {
  return Array.from(document.querySelectorAll(".day-box"))
    .filter((b) => b.checked)
    .map((b) => Number(b.value));
}

/** PATCH every selected rule to the chosen day/time schedule (one call per rule). */
async function onApply() {
  if (!client) {
    setStatus("Log in and list rules first.", "error");
    return;
  }
  const ids = rules.map((r) => r.id).filter((id) => selectedIds.has(id));
  if (!ids.length) {
    setStatus("Tick at least one rule to set its schedule.", "error");
    return;
  }

  let schedule;
  try {
    const allDay = $("allDay").checked;
    const startHour = allDay ? 0 : Number($("startHour").value);
    const endHour = allDay ? 24 : Number($("endHour").value);
    schedule = buildScheduleFromDays(selectedDays(), startHour, endHour);
  } catch (exc) {
    setStatus(exc.message, "error");
    return;
  }

  const button = $("apply");
  button.disabled = true;

  let done = 0;
  const failures = [];
  for (const id of ids) {
    setStatus(`Setting schedule on rule ${id} (${done + 1}/${ids.length})…`, "info");
    try {
      const updated = await client.patchSchedule(id, schedule);
      const next = (updated && updated.schedule) || schedule;
      const found = rules.find((r) => r.id === id);
      if (found) found.schedule = next;
      done++;
    } catch (exc) {
      failures.push(`${id}: ${exc.message}`);
    }
  }
  renderRules();
  button.disabled = false;

  if (failures.length) {
    setStatus(
      `Updated ${done}/${ids.length} rule(s) -> ${summarizeSchedule(schedule)}. ` +
        `Failed: ${failures.join("; ")}`,
      "error",
    );
  } else {
    setStatus(`Updated ${done} rule(s) -> ${summarizeSchedule(schedule)}.`, "ok");
  }
}

function reportError(exc) {
  if (exc instanceof AuthError) setStatus(`Login failed: ${exc.message}`, "error");
  else if (exc instanceof ApiError) setStatus(exc.message, "error");
  else setStatus(`Unexpected error: ${exc.message}`, "error");
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
  $("login-form").addEventListener("submit", onLogin);
  $("apply").addEventListener("click", onApply);

  // Header checkbox: select / clear all rules at once.
  $("select-all").addEventListener("change", (e) => {
    selectedIds.clear();
    if (e.target.checked) for (const r of rules) selectedIds.add(r.id);
    renderRules();
  });

  // Quick-fill buttons set the day checkboxes (Weekdays / Weekend / Every day / Clear).
  const setDays = (wanted) => {
    const want = new Set(wanted.map(Number));
    for (const box of document.querySelectorAll(".day-box")) box.checked = want.has(Number(box.value));
  };
  for (const btn of document.querySelectorAll(".chip")) {
    btn.addEventListener("click", () => {
      const which = btn.dataset.days;
      if (which === "weekdays") setDays(WEEKDAYS);
      else if (which === "weekend") setDays(WEEKEND);
      else if (which === "all") setDays([1, 2, 3, 4, 5, 6, 7]);
      else setDays([]); // clear
    });
  }

  // "All day" disables the hour inputs (they're forced to 00:00–24:00).
  const allDay = $("allDay");
  const syncAllDay = () => {
    $("startHour").disabled = allDay.checked;
    $("endHour").disabled = allDay.checked;
  };
  allDay.addEventListener("change", syncAllDay);
  syncAllDay();

  // Default the picker to a sensible starting point: Weekdays ticked.
  setDays(WEEKDAYS);
});
