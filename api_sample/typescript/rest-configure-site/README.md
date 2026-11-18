# REST API, set up a new site and connect it to the Cloud (TypeScript)

Takes a factory-default server and turns it into a configured site. It names the
site, sets the password of the local `admin` account, applies three site
settings, and, if you ask, connects the site to the Nx Cloud. This is the very
first thing done to a server, so the Cloud account you connect with becomes the
site owner. Name an organization instead and the organization owns it.

TypeScript port of [`../../python/rest-configure-site`](../../python/rest-configure-site).
It runs directly on Node 22.6+ via native type stripping, with no build step.

```
$ node rest_configure_site.ts --dotenv ../../.env --insecure
Site name       : Lobby Site
Set up          : yes
Cloud           : connected to https://nxvms.com, owned by owner@example.com
Settings changed: none, the site already had them
```

## What the code does

1. Check the server: `GET /rest/v4/site/info`, which needs no login. A reply
   without `localId` is a factory-default server. A reply with `localId` is a
   server that already belongs to a site, and the run stops there unless you
   pass `--yes` (see below). `cloudId` says whether the site is already bound to
   the Cloud, and `name` is the site's real name. `cloudHost` and
   `customization` say which Cloud the server belongs to and which brand it
   is, and are used in step 4.
2. Set up, only for a factory-default server:
   1. `POST /rest/v4/login/sessions` with `{username: "admin", password: "admin"}`.
      `site/setup` needs an administrator, and before setup the factory `admin`
      account is the only account there is.
   2. `POST /rest/v4/site/setup` with `{name, local: {password}, settings}`,
      using that token. `settings` carries the three settings from
      `site_settings.json`. Any refusal stops the run.

   **With the Cloud** (`NX_CONNECT_TO_CLOUD=true`) the site is registered in the
   Cloud first (step 4.2), and then set up with a single `site/setup`:
   `{name, settings, cloud: {authKey, owner, siteId[, organizationId]}}`
   instead of `local`. The server binds the site to the Cloud as part of the
   setup and rolls the setup back if the bind fails, so the server is never left
   half configured. It also disables the local `admin` account: a Cloud site is
   used through the Cloud account or the organization, and `NX_SERVER_PASSWORD`
   is not set. Steps 3 to 5 do not apply then.
3. Log in: `POST /rest/v4/login/sessions` with `{username: "admin", password}`,
   which returns `{"token": ...}`.
4. Connect to the Cloud, only when `NX_CONNECT_TO_CLOUD` is true and `site/info`
   showed no `cloudId`. `{cloud}` is `https://` plus the `cloudHost` the server
   reported, and the site is registered under the server's own `customization`.
   A server can only join the Cloud it was built for, so a white-label server
   (DW Spectrum, WAVE and so on) goes to its own Cloud without any setting:
   1. `POST {cloud}/cdb/oauth2/token` logs in to the Cloud. This happens right
      after step 1, before the server is changed, so a wrong Cloud password or
      a wrong two-factor code stops the run while the server is still
      untouched. No scope is sent, so the token is cloud-wide.
      For an account with two-factor authentication the reply also carries
      `"error": "second_factor_required"`. The token is then confirmed with
      `GET {cloud}/cdb/account/self/2fa/totp/key/{code}?token=<token>`, using
      the 6-digit code from the account's authenticator app, and works from
      then on.
   2. Register the site, which returns its `id` and `authKey`:
      - for your Cloud account: `POST {cloud}/cdb/systems/bind` with
        `{name, customization, opaque}`. Your account owns the site.
      - for an organization (`NX_ORGANIZATION_ID` set):
        `POST {cloud}/partners/api/v3/cloud_systems/` with
        `{name, customization, opaque, organization}`. This binds the site to
        the organization, which owns it and gives its members access.
   3. `POST /rest/v4/cloud/bind` with `{authKey, owner, siteId}` tells the
      server about it. `owner` is your Cloud account; the server requires it
      and adds that account as a local administrator. For an organization it
      also carries `organizationId`.
5. Apply the settings: `GET /rest/v4/site/settings`, then `PATCH` only the
   settings that `site_settings.json` names and whose values differ. On a new
   site setup already applied them, so this only matters for an existing site
   run with `--yes`. If nothing differs, no `PATCH` is sent.
6. Log out, also after a failed run: `DELETE /rest/v4/login/sessions/<token>`
   on the server and, when the Cloud was used,
   `DELETE {cloud}/cdb/oauth2/token/<token>`, which revokes the Cloud token. That
   token has no scope, so it gives full access to the account until revoked.

The setup, login, bind and settings calls need an administrator on a fresh
session. That is why the sample logs in itself and has no `--token` flag.

### Things worth knowing

- **An existing site is left alone unless you pass `--yes`.** `NX_SERVER_HOST`
  and `NX_SERVER_PASSWORD` are shared with the other samples, so `.env` may well
  point at a site that is in use. Without `--yes` the sample stops after
  `site/info` and changes nothing. With `--yes` it logs in with
  `NX_SERVER_PASSWORD`, applies the settings, and connects the site to the Cloud
  if it is not connected yet. `NX_SITE_NAME` is not used then: the site keeps
  its name, and the Cloud record and the summary use it.
- **A site already bound to the Cloud is not registered again.** Registering
  creates a new Cloud record each time, and the server would then refuse the
  bind, leaving that record orphaned. So the Cloud step is skipped and the
  summary says the site was already connected.
- **Steps stop at the first failure.** Each step needs the one before it, so
  nothing runs after an error and the exit code is 1.
- **Site, not system.** The v4 API calls it a site everywhere. The older
  `rest-configure-system-via-api` sample predates that and also merges several
  servers. This one does only the first setup.
- **`--insecure` applies to the server only.** Node's global `fetch` has no
  per-client TLS switch, so each client gets its own small `makeFetch`, built on
  `node:http` and `node:https`. The server client's skips certificate
  verification with `--insecure`. The Cloud client's always verifies, and no
  process-wide `NODE_TLS_REJECT_UNAUTHORIZED` is set. This is the same as the
  Python and Node samples.

## Prerequisites

- **Node 22.6 or newer** (type stripping; enabled by default from Node 23.6).
  Check with `node --version`.
- A server in its factory-default state (local `admin` account with the
  password `admin`), reachable over HTTPS. A server that already belongs to a
  site is refused unless you pass `--yes`.
- Only when connecting to the Cloud: a Cloud account. With two-factor
  authentication, have the authenticator app at hand (see `--mfa-code`). If you
  name an organization, the Cloud account
  (`NX_CLOUD_USER`) must have the `manage_systems` permission in that
  organization, which is what allows it to add sites there. Without it the
  Channel Partners API refuses the site with HTTP 403.

The tests need neither a server nor a network. There is nothing to install to
run the sample. `npm install` in the parent folder adds the dev-only
`typescript` and `@types/node` for type-checking.

## Configure

Copy the shared example once at the catalog root
(`cp ../../.env.example ../../.env`) and fill in the variables below. The three
site settings are not variables. They are in `site_settings.json`, next to the
script, with the names the API uses.

| Variable | Required | What it means here |
|---|---|---|
| `NX_SERVER_HOST` | yes | The new server, as an `https://` address with port, for example `https://192.168.1.10:7001`. `http://` is refused: the server accepts the login over plain http, so the password would go out in cleartext, and it then refuses every authorized call on http. |
| `NX_SERVER_PASSWORD` | yes | The password this sample **sets** for the local `admin` account of a new local site, and logs in with on an existing site (`--yes`). A new site connected to the Cloud has no local admin, so the password is not used then. |
| `NX_SITE_NAME` | yes | The name of the new site. Not used for a site that already exists. |
| `NX_CONNECT_TO_CLOUD` | no | `true` to connect the site to the Cloud. Default `false`. Also accepts `1` and `0`. |
| `NX_CLOUD_HOST` | only with `--insecure` | Otherwise leave it blank: the server says which Cloud it belongs to. If you set it, it must be `https://`, for example `https://nxvms.com`, and it is only a check: the run stops before changing anything when the server belongs to another Cloud. With `--insecure` it is required, because the server's certificate is not checked and the sample will not send the Cloud password to a Cloud that only the server named. |
| `NX_CLOUD_USER`, `NX_CLOUD_PASSWORD` | only when connecting | The Cloud account that registers the site and becomes its owner. `NX_CLOUD_USER` must be the account's e-mail address, because it is sent as the site owner. |
| `NX_ORGANIZATION_ID` | no | Set it to make an organization own the site. Blank makes the Cloud account the owner. |

`NX_SERVER_USER` is not used. The sample logs in as the local `admin` account,
first with the factory password `admin` to run setup, then with
`NX_SERVER_PASSWORD`.

Only `--host` and `--password` also exist as flags. Everything else comes from
the environment or the `.env` file, and the environment wins over the file.

### Site settings

This sample handles exactly three settings, which every new site gets by default.
They live in `site_settings.json`, under the names the API uses.

- **A new site** gets all three in `site/setup`: the values in the file, and
  `true` for any the file leaves out.
- **An existing site** (run with `--yes`) gets only the settings the file names.
  One the file leaves out is not sent, so it stays as an administrator left it.
  The shipped file names all three, so remove the ones you do not want to
  touch.

| Setting | What it does |
|---|---|
| `autoDiscoveryEnabled` | Automatically find cameras and servers on the network. |
| `cameraSettingsOptimization` | Let the server tune the cameras' own settings. |
| `statisticsAllowed` | Send the anonymous statistics report. |

To turn one off, change it in the file:

```json
{
  "statisticsAllowed": false
}
```

### Other settings

**A site has many more settings than these three.** The v4 spec lists about 135
of them, and `POST /rest/v4/site/setup` and `PATCH /rest/v4/site/settings` take
the same names. They cover security and encryption, email, time synchronization,
audit trail and event log retention, Cloud connection behaviour, backup, update
behaviour and a large set of tuning limits. Some are nested objects, for example
`emailSettings` and `watermarkSettings`. Read the full list with
`GET /rest/v4/site/settings` against your server, or in the spec under
`/rest/v4/site/settings`.

To add one to this sample:

1. Add its name and a default to `DEFAULT_SETTINGS` in `rest_configure_site.ts`.
   The name is the API name, unchanged, and it is what goes in the file.
2. If it is not a plain true or false, change the type check in `loadSettings`
   (and the `Settings` type).
3. Write a test that the value in `site_settings.json` goes out under that name.

A key in `site_settings.json` that is not in `DEFAULT_SETTINGS` is refused with
exit code 2, so a mistyped name never passes silently.

## Run

```bash
# A local site only, with the three default settings:
node rest_configure_site.ts --dotenv ../../.env --insecure

# Connect it to the Cloud: set NX_CONNECT_TO_CLOUD=true in .env, then run the
# same command.

# Use a different settings file:
node rest_configure_site.ts --dotenv ../../.env --insecure \
    --settings-file my_settings.json
```

`--insecure` is normal against a lab server, whose certificate is self-signed.
It applies to the server only, not to the Cloud.

### CLI flags

| Flag | Purpose |
|------|---------|
| `--host` | `https://<server>:7001`. Overrides `NX_SERVER_HOST`. |
| `--password` | The admin password to set. Overrides `NX_SERVER_PASSWORD`. Keep it in `.env` instead, because other people on the machine can see a command line. |
| `--dotenv` | Path to the shared `.env` (default `./.env`). Note the name: `--env-file` is a Node built-in flag, so this house uses `--dotenv`. |
| `--settings-file` | JSON file with the settings (default: `site_settings.json` next to the script). A file that does not exist names no settings: a new site gets the defaults, an existing one keeps its own, and a note says so. |
| `--insecure` | Skip TLS verification (lab use only). |
| `--mfa-code` | The 6-digit code from your authenticator app, for a Cloud account with two-factor authentication. Without it the sample asks for the code when it runs in a terminal. It is not read from `.env`, because a code is only valid for about 30 seconds. |
| `--yes` | Also change a server that already belongs to a site: apply the settings, and connect it to the Cloud if it is not connected yet. |

Exit codes: 0 on success, 1 when a step failed or an existing site was refused
without `--yes`, 2 when the configuration is missing or wrong, or the command
line was wrong.

## Next step: share the site

This sample makes one Cloud account (or an organization) the owner. To give
other Cloud accounts access to the site, share it with them under a role. Any
site connected to the Cloud can be shared, including one this sample just
connected. `{siteId}` is the `siteId` the Cloud returned at the bind (the
site's `cloudId`).

Access is given by role id. The share request,
`POST {cloud}/cdb/v2/systems/{siteId}/users?sendNotification=false`, made with
the owner's Cloud bearer token, carries a `roleIds` list with one of the six
predefined role ids:

| Role | `roleId` |
|---|---|
| Administrators | `00000000-0000-0000-0000-100000000000` |
| Power Users | `00000000-0000-0000-0000-100000000001` |
| Advanced Viewers | `00000000-0000-0000-0000-100000000002` |
| Viewers | `00000000-0000-0000-0000-100000000003` |
| Live Viewers | `00000000-0000-0000-0000-100000000004` |
| System Health Viewers | `00000000-0000-0000-0000-100000000005` |

For example, sharing the site with an account as a Viewer:

```json
{ "accountEmail": "xyz@example.com", "roleIds": ["00000000-0000-0000-0000-100000000003"],
  "permissions": [], "isEnabled": true, "vmsUserId": "" }
```

A custom user group cannot be given this way: share with one of these roles,
then add the account to the custom group on the site itself.

## Run the tests

Offline. HTTP is faked, and no server or Cloud account is needed:

```bash
node --test test_rest_configure_site.ts

# Or the whole TypeScript house, plus type-checking:
cd .. && npm test && npm run typecheck
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing configuration: NX_SITE_NAME` (or another name), exit 2 | The variable is in neither the environment nor the `.env` file. | Set it. The message names every missing one. |
| `The server address must be an https:// address, because the admin password is sent there, not "http://..."`, exit 2 | `NX_SERVER_HOST` (or `--host`) starts with `http://`. | Use `https://` with the same host and port. |
| `The server address must be a full URL such as https://192.168.1.10:7001, not "..."` or `NX_CLOUD_HOST must be a full URL such as https://nxvms.com, not "..."`, exit 2 | The address has no `https://` in front, has no host, or contains a space. The message quotes the value it read. | Give the whole URL with its scheme, for example `https://192.168.1.10:7001`. `NX_CLOUD_HOST` is only checked when it is set and you connect to the Cloud. Nothing was sent to the server. |
| `NX_CLOUD_HOST is ..., but this server belongs to the Cloud at ...` | The server was built for another Cloud than the one `NX_CLOUD_HOST` names, for example a white-label server and the public Nx Cloud. | Remove `NX_CLOUD_HOST`, or set it to the Cloud the message names. Nothing was changed. |
| `Cannot read <path>: ...`, exit 2 | The `--dotenv` or `--settings-file` path exists but cannot be read, for example it is a directory or you have no permission. | Point the flag at the file itself and check its permissions. A path that does not exist is not this error: a missing `.env` is skipped and a missing settings file names no settings. |
| `... was not valid JSON.` or `... was not a JSON object.`, exit 1 | Something between you and the server, such as a proxy or a login page, answered instead of the server. | Check the address and any proxy in between. |
| `... answered with a redirect (HTTP 302 to ...)`, exit 1 | The address is not the server (or Cloud) itself, for example `http://` instead of `https://`, a wrong port, or a proxy. Redirects are never followed, so nothing was changed by that request. | Use the server's own `https://` address and port. |
| `With --insecure, set NX_CLOUD_HOST ...`, exit 2 | You connect to the Cloud with `--insecure` and `NX_CLOUD_HOST` blank. | Set `NX_CLOUD_HOST` to the Cloud the server belongs to, for example `https://nxvms.com`. |
| `NX_CLOUD_HOST must be an https:// address ...`, exit 2, or `The server reports its Cloud as ..., which is not an https:// address` | The Cloud password is only ever sent over `https://`. | Use the `https://` address of the Cloud. |
| `... is not a setting this sample handles` | `site_settings.json` has a key that is not one of the three. | Check the spelling, or add the setting as described under Other settings. |
| `certificate verification failed for https://<server>` | A local server uses a self-signed certificate. | Add `--insecure`. |
| `certificate verification failed for https://<cloud>. --insecure applies to the server only` | The Cloud's certificate could not be verified, often because a proxy inspects TLS traffic. `--insecure` never applies to the Cloud. | Run from a network without the inspecting proxy, or add the proxy's CA to the system's trusted certificates. |
| `<host> already belongs to the site "...". Refusing to change it without --yes.` | `NX_SERVER_HOST` points at a server that was set up before, perhaps one you use with the other samples. | Check the address. If you do mean to change that site, add `--yes`. To start over, reset the server to factory defaults. |
| `Site setup was refused (HTTP 400: ...)` | The server rejected the setup request, for example because `NX_SERVER_PASSWORD` is too weak. | Read the status and body in the message. For a weak password, choose a stronger `NX_SERVER_PASSWORD`. |
| `The server has not been set up, but its factory login (admin/admin) was rejected` | The server is not in the state `site/info` describes, or its factory password was changed. | Reset the server to factory defaults and run again. |
| `Login forbidden (HTTP 403). This account may not do this.` | The account is not an administrator. | Use the site's administrator account. |
| `Set up: no, the server already belonged to a site` | You ran with `--yes` against a site that already existed, so only the settings (and a missing Cloud connection) were applied. | Expected on a re-run with `--yes`. Reset the server to factory defaults if you wanted a fresh site. |
| `Cloud: already connected (Cloud id ...), left as it was` | The site was bound to the Cloud before, so it was not registered again. | Expected on a re-run. To move it to another account or organization, disconnect it from the Cloud first. |
| `Cloud login rejected (HTTP 401)` | Wrong Cloud credentials. | Check `NX_CLOUD_USER` and `NX_CLOUD_PASSWORD`. The server was not changed. |
| `Cloud login for ... needs a two-factor code.` | The Cloud account has two-factor authentication, and the sample is not running in a terminal (so it cannot ask) and `--mfa-code` was not given. | Run again with `--mfa-code <code>` from your authenticator app. The server was not changed. |
| `could not complete a request to https://<cloud>: HTTP 403: User does not have manage_systems permission for this organization` | The Cloud account in `NX_CLOUD_USER` is a member of the organization in `NX_ORGANIZATION_ID`, but its role there lacks the `manage_systems` permission, so it cannot add sites to it. | Give the account a role with `manage_systems` in that organization (in the Cloud portal, or ask the organization's administrator), or use an organization where it has it. If the server was factory-default, it has already been set up; run again with `--yes` once the permission is in place. |
| `The two-factor code was not accepted (HTTP 403).` | The code was wrong or had already expired. | Run again with a fresh code. The server was not changed. |
| The run fails at the Cloud bind with HTTP 4xx | The Cloud refused to register the site, for example a wrong `NX_ORGANIZATION_ID`, or a Cloud account that does not exist on the server's Cloud. | Check both. A site registered before the failure stays in the Cloud until you remove it there. |
| `Unknown argument: --env-file` | That is the Python sample's flag. | Use `--dotenv` here. |

## Files

| File | Purpose |
|---|---|
| `rest_configure_site.ts` | The sample: configuration, the two clients, the flow and the CLI. |
| `site_settings.json` | The three site settings, under their API names. |
| `test_rest_configure_site.ts` | Offline tests (injected `fetch` and injected clients). |

Types come from the shared `../nx-types.ts`, imported type-only, and the house
`package.json` and `tsconfig.json` are one level up. This sample declares no
dependencies of its own, which is deliberate rather than an omission.
