// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * The page: wires the DOM to nx-device-agent-settings-client.mjs and nothing
 * more.
 *
 * All the API logic lives in nx-device-agent-settings-client.mjs so it can be
 * tested offline. This file is the part that cannot be: it reads inputs,
 * calls the client, and writes the result into the page. Keep it thin, and
 * keep decisions out of it.
 *
 * The one decision that deliberately does NOT live here is the apply guard.
 * "Are you sure" belongs to the client (applySettings refuses without
 * confirmed: true), so that it is covered by a test rather than by a comment.
 * This file only collects the operator's confirmation.
 */

import {
  NxDeviceAgentSettingsClient,
  buildApplyBody,
  defaultOutputName,
  formatSettingsFile,
  parseSettingsFile,
  runSession,
} from "./nx-device-agent-settings-client.mjs";

const $ = (id) => document.getElementById(id);

function say(kind, message) {
  const box = $("status");
  box.className = `status ${kind}`;
  box.textContent = message;
}

/** Hand a string to the browser as a downloaded file. */
function offerDownload(text, filename) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Not at once: some browsers start reading the blob after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function credentials() {
  return { user: $("user").value.trim(), password: $("password").value };
}

let busy = false;

function setControlsDisabled(disabled) {
  for (const button of document.querySelectorAll("button")) button.disabled = disabled;
}

/** Log in, run one action, log out; show the outcome once all three are done. */
async function withClient(run, options) {
  if (busy) return;
  const { user, password } = credentials();
  if (!user || !password) {
    say("error", "Enter the server username and password first.");
    return;
  }
  // One run at a time: a second click must not start a second session or PUT.
  busy = true;
  setControlsDisabled(true);
  try {
    const { ok, message } = await runSession(new NxDeviceAgentSettingsClient(), { user, password }, run, options);
    say(ok ? "ok" : "error", message);
  } finally {
    busy = false;
    setControlsDisabled(false);
  }
}

async function onDownload() {
  const engineId = $("dl-engine-id").value.trim();
  const deviceId = $("dl-device-id").value.trim();
  if (!engineId || !deviceId) {
    say("error", "Enter the engine ID and the source device ID first.");
    return;
  }

  await withClient(async (client) => {
    say("busy", "Downloading Device Agent settings...");
    const settings = await client.downloadSettings(engineId, deviceId);
    const name = defaultOutputName(deviceId);
    offerDownload(formatSettingsFile(settings), name);
    return `Saved ${name}.`;
  });
}

async function onApply(event) {
  event.preventDefault();
  const engineId = $("apply-engine-id").value.trim();
  const deviceId = $("apply-device-id").value.trim();
  if (!engineId || !deviceId) {
    say("error", "Enter the engine ID and the target device ID first.");
    return;
  }
  const file = $("settings-file").files[0];
  if (!file) {
    say("error", "Choose a settings file first.");
    return;
  }
  // The operator types the target device ID to confirm. The client still
  // refuses without confirmed: true.
  const typed = $("confirm").value.trim();
  if (!typed || typed !== deviceId) {
    say("error", `Type ${deviceId || "the target device ID"} in the confirmation box to enable apply.`);
    return;
  }

  // Checked before logging in: not JSON, or not a JSON object, is refused here.
  let body;
  try {
    body = buildApplyBody(parseSettingsFile(await file.text(), file.name));
  } catch (exc) {
    say("error", exc.message);
    return;
  }

  await withClient(async (client) => {
    say("busy", "Applying Device Agent settings...");
    await client.applySettings(engineId, deviceId, body, { confirmed: true });
    return `Applied Device Agent settings to device ${deviceId} (engine ${engineId}).`;
  }, { applying: true });
}

$("download").addEventListener("click", onDownload);
$("apply-form").addEventListener("submit", onApply);
