# REST API, back up and restore the Site database (Node.js)

Dumps the Site database to a file, and loads a dump back into a site. The
database is shared by every server in the site, so one dump is a snapshot of
the whole site configuration: servers, cameras, users, groups, layouts, rules,
licences and storage settings.

Node.js port of `../../python/rest-backup-site-database`, doing the same thing
with the same flags and the same output.

Both calls require an administrator on a fresh session, so this sample logs in
immediately before the call it is about to make and never accepts a token you
already hold. A restore restarts the server, so the session is gone the moment
the dump is accepted.

```
$ node rest_backup_site_database.mjs backup --dotenv ../../.env --insecure
Logged in to https://192.168.1.10:7001 as admin

Dumping Site database from https://192.168.1.10:7001
  -> nx-site-database-192-168-1-10-7001-20260914T031200Z.db  (4.812 MiB)
Done. Logged out.

$ node rest_backup_site_database.mjs restore site-a.db \
      --dotenv ../../.env --insecure --yes
Logged in to https://192.168.1.10:7001 as admin

Loading Site database into https://192.168.1.10:7001
  <- site-a.db  (4.812 MiB)
Accepted. The server is restarting; the session ends with it.
```

## What the code does

**backup**

1. Log in: `POST /rest/v4/login/sessions` with `{username, password}`, which
   returns `{"token": ...}`. This happens right before step 2, because the
   endpoint wants a fresh session.
2. Dump: `GET /rest/v4/site/database` with `Authorization: Bearer <token>`.
   The response body is the raw binary dump. It is piped straight from the web
   `ReadableStream` to the file, never decoded as text and never held whole in
   memory.
3. Log out: `DELETE /rest/v4/login/sessions/<token>`.

**restore**

1. Log in, as above.
2. Load: `POST /rest/v4/site/database` with `Content-Type:
   application/octet-stream` and the file bytes as the body, unchanged. No
   multipart, no base64. The file is sent from disk as it is read, with a
   `Content-Length`, so it is not held whole in memory either.
3. No log out. The server restarts as soon as it accepts the dump, so the
   session ends on its own and a `DELETE` would only produce a confusing
   connection error.

### Three things worth knowing

- **Fresh session.** The spec's permission line for both methods is
  "Administrator with a fresh session." A token you minted earlier can be
  rejected even though it has not expired, which is why this sample offers no
  `--token` flag at all.
- **The restart cuts the connection.** After a successful load the server may
  drop the connection instead of answering. `fetch` reports that as a
  `TypeError` whose `cause.code` is a socket error such as `ECONNRESET`, and
  the sample treats it as success, because the dump was already handed over.
- **The dump is opaque.** The spec says the format is proprietary, is not
  intended for manual modification, and is only intended for restoring via
  `POST /rest/v4/site/database`. The sample never parses it. The one check
  available is that it is not empty.

## Prerequisites

- **Node 18+** for the built-in `fetch`. No dependencies to install.
- An **administrator** account on the target site, local to the server. A
  cloud account uses the OAuth2 flow, which is a different sample.
- Enough free disk for the dump. A large site runs to tens of megabytes.

The tests need neither a server nor a network.

## Install

Nothing to install. The sample and its tests use only Node built-ins.

## Configure

Uses the shared server variables. Copy the example file once at the catalog
root (`cp ../../.env.example ../../.env`) and fill in:

| Variable | What it means here |
|---|---|
| `NX_SERVER_HOST` | The server to dump from or load into, with scheme and port, for example `https://192.168.1.10:7001`. |
| `NX_SERVER_USER` | A local administrator account. A non-administrator is refused by both calls. |
| `NX_SERVER_PASSWORD` | That account's password. |

This sample introduces no new `NX_*` variable.

## Run

```bash
# Dump to an auto-named file in the current directory:
node rest_backup_site_database.mjs backup --dotenv ../../.env --insecure

# Dump to a path you choose:
node rest_backup_site_database.mjs backup --out /backups/site-a.db \
    --dotenv ../../.env --insecure

# Dump to stdout, to pipe it somewhere. Progress goes to stderr, so the pipe
# carries nothing but the dump:
node rest_backup_site_database.mjs backup --out - \
    --dotenv ../../.env --insecure > site-a.db

# Load a dump back in. This replaces the whole site configuration and restarts
# the server, so it will not run without --yes:
node rest_backup_site_database.mjs restore site-a.db \
    --dotenv ../../.env --insecure --yes
```

`--insecure` is normal against a lab server, whose certificate is self-signed.

## CLI flags

| Flag | Purpose |
|------|---------|
| `backup` | Dump the Site database to a file. |
| `--out` | Where to write it. Default (or an empty `--out=`): an auto-named file in the current directory. `-` means stdout. The file is created readable by you only (`0600`), because the dump holds every user's password hashes and the servers' auth keys. |
| `--force` | Overwrite `--out` if it already exists. The old file is replaced only once the new dump is complete, and without `--force` a file that appears during the download is never replaced. |
| `restore <dump>` | Load a dump back into the site. |
| `--yes` | Required for `restore`. The load replaces the site configuration and restarts the server. |
| `--host` | `https://<server>:7001` |
| `--user` / `--password` | A local administrator account. |
| `--dotenv` | Path to the shared `.env` (default `./.env`). Note the name: `--env-file` is a Node built-in flag, so this house uses `--dotenv`. |
| `--insecure` | Skip TLS verification (lab use only). |

Exit codes: 0 on success, 1 when the call failed or a guard refused, 2 when
configuration is missing or the command line was wrong.

## Run the tests

```bash
node --test test_rest_backup_site_database.mjs

# Or via the package script:
npm test
```

Note that plain `node --test` finds nothing here; name the test file, or use
`npm test`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login unauthorized (HTTP 401/403)` | Wrong password, or a cloud account. | Use a local server account. Cloud users need the OAuth2 flow. |
| `The site refused the dump (HTTP 403)` after a successful login | The account is not an administrator, or the session is no longer fresh. | Use an administrator. The sample already logs in immediately before the call, so a 403 here points at the role. |
| `Refusing to overwrite <file>` | The target file exists. | Choose another `--out`, or pass `--force`. |
| `<out> is a directory. Give --out a file path.` | `--out` names an existing folder. | Give a file path inside it, for example `--out backups/site.db`. |
| `The server returned an empty dump` | The server answered with a zero length body. | Check that the account is an administrator and that the site has finished starting. A zero byte file is never a valid dump. |
| A backup that stops with an error partway | The connection dropped mid-transfer. | Nothing is written: the dump goes to a side file named `<out>.<random>.partial`, unique to the run, and is moved into place only once complete, so an existing file kept under `--force` is untouched. Run the backup again. |
| `The server stopped sending the dump: nothing arrived for <n> s` | The server went silent mid-dump. The limit is on silence, not on the whole transfer, so a slow but steady dump is never cut off. | Nothing was written. Check the server, then run the backup again. |
| `Refusing to restore without --yes` | The guard did its job. | Re-run with `--yes` once you are sure of the target host. |
| `--yes takes no value` (and `--force`, `--insecure`) | A boolean flag was given `=value`, for example `--yes=no`. | Leave the flag out to mean no; give it bare to mean yes. |
| `The load request failed (HTTP <n>). The dump was not applied.` | The server rejected the dump, for example one taken from another VMS version, or a damaged file. Nothing was loaded and the server did not restart. | Check the dump came from this site's version. Take a fresh backup if in doubt. |
| `The connection was lost after <n> of <size> bytes were sent. The dump was not loaded.` | The connection was refused, reset or cut before the whole dump had gone up, so the server cannot have loaded it. (A drop after the whole dump went up is the normal restart, and is reported as Accepted.) | Check the server and the network, then restore again. |
| `The server stopped reading the dump after <n> of <size> bytes` | The server stopped taking the upload for the whole timeout. | The dump was not loaded. Check the server, then restore again. |
| `Refusing to overwrite <file>, which appeared during the download` | Something created `--out` while the dump was downloading. | The other file is kept. Choose another `--out`, or pass `--force`. |
| `No answer within <n> s after the dump was sent` | The upload went out but the server neither answered nor dropped the connection. | The outcome is unknown: the server may be restarting with the dump, or the load failed. Check the server (is it restarting? is the configuration the dump's?) before restoring again. |
| The restore command returns immediately with `Accepted` | Expected. The server restarted while answering. | Nothing to do. Give it a minute, then reconnect. |
| `certificate verification failed` | The lab server's self-signed certificate. | Add `--insecure`. |
| `Unknown argument: --env-file` | That is the Python sample's flag. | Use `--dotenv` here. |

## Files

| File | Purpose |
|------|---------|
| `rest_backup_site_database.mjs` | The sample (`NxServerClient` with `backupDatabase` and `restoreDatabase`, the sinks, and the CLI). |
| `test_rest_backup_site_database.mjs` | Offline tests (injected `fetch`). |
| `package.json` | Name, `type: module`, and the `start` and `test` scripts. No dependencies. |
