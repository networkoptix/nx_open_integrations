// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * The page: wires the DOM to nx-backup-client.mjs and nothing more.
 *
 * All the API logic lives in nx-backup-client.mjs so it can be tested offline.
 * This file is the part that cannot be: it reads inputs, calls the client, and
 * writes the result into the page. Keep it thin, and keep decisions out of it.
 *
 * The one decision that deliberately does NOT live here is the restore guard.
 * "Are you sure" belongs to the client (restoreDatabase refuses without
 * confirmed: true), so that it is covered by a test rather than by a comment.
 * This file only collects the operator's confirmation.
 */

import {
  NxBackupClient,
  defaultOutName,
  loadServerHost,
  confirmsHost,
  AuthError,
} from "./nx-backup-client.mjs";

const $ = (id) => document.getElementById(id);

// The server the dev proxy forwards to, as given by its --server-host. It names
// the dump file and is what the operator types to confirm a restore.
let serverHost = "";

function say(kind, message) {
  const box = $("status");
  box.className = `status ${kind}`;
  box.textContent = message;
}

/**
 * Hand the Blob to the browser as a download.
 *
 * This is where the browser costs you something the CLI samples do not pay:
 * the whole dump is in memory as a Blob before any of it reaches disk.
 */
function offerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Release the Blob, but not straight away: revoking in the same tick as the
  // click can cancel the download in some browsers before it has started.
  // Without the revoke at all the dump would stay in memory until the tab dies.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Block both buttons while a call is in flight, so a double click is one call. */
function setBusy(busy) {
  for (const button of document.querySelectorAll("button")) {
    button.disabled = busy || !serverHost;
  }
}

function credentials() {
  return { user: $("user").value.trim(), password: $("password").value };
}

async function withClient(run) {
  const client = new NxBackupClient();
  const { user, password } = credentials();
  if (!user || !password) {
    say("error", "Enter the server username and password first.");
    return;
  }
  setBusy(true);
  try {
    // Log in here, immediately before the call: both endpoints want a fresh
    // session, so a token from earlier in the page's life is not good enough.
    await client.login(user, password);
    await run(client);
  } catch (exc) {
    const hint =
      exc instanceof AuthError
        ? " Check that the account is a local administrator."
        : "";
    say("error", `${exc.message}${hint}`);
  } finally {
    setBusy(false);
  }
}

async function onBackup() {
  await withClient(async (client) => {
    say("busy", "Dumping the Site database...");
    try {
      const blob = await client.backupDatabase();
      const name = defaultOutName(serverHost);
      offerDownload(blob, name);
      say("ok", `Saved ${name} (${blob.size.toLocaleString()} bytes).`);
    } finally {
      // Log out whether or not the dump worked: a failure is no reason to leave
      // an administrator session valid. And a logout that cannot be delivered
      // is no reason to replace "Saved" with an error, the file is already
      // downloaded.
      await client.logout().catch(() => {});
    }
  });
}

async function onRestore(event) {
  event.preventDefault();
  const file = $("dump").files[0];
  if (!file) {
    say("error", "Choose a dump file first.");
    return;
  }
  // The operator types the host to confirm, which is this page's stand-in for
  // the CLI versions' --yes. The client still refuses without confirmed: true.
  if (!confirmsHost($("confirm").value, serverHost)) {
    say("error", `Type ${serverHost} in the confirmation box to enable the restore.`);
    return;
  }

  await withClient(async (client) => {
    say("busy", "Loading the Site database...");
    try {
      await client.restoreDatabase(file, { confirmed: true });
    } catch (exc) {
      // Refused, or the outcome is unknown: the server did not visibly
      // restart, so the administrator session must not be left open.
      await client.logout().catch(() => {});
      throw exc;
    }
    say("ok", "Accepted. The server is restarting; the session ends with it.");
  });
}

$("backup").addEventListener("click", onBackup);
$("restore-form").addEventListener("submit", onRestore);

serverHost = await loadServerHost();
if (serverHost) {
  $("host-label").textContent = serverHost;
} else {
  // Nothing to back up from and nothing to confirm a restore against.
  $("host-label").textContent = "no server configured";
  setBusy(false);
  say("error", "The dev server has no --server-host. Restart it with one, then reload.");
}
