#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Nx VMS REST Server API sample: set up a new site and optionally connect it to the Cloud.

This is the very first thing done to a factory-default server. It names the site,
sets the password of the local "admin" account, applies three site settings, and,
if you ask, connects the site to the Nx Cloud. The Cloud account you connect with
becomes the site owner, or the organization does if you name one.

  1. Check:     GET /rest/v4/site/info  (no login) -> localId, cloudId, name
                A server whose reply has a localId already belongs to a site, and
                the run stops there unless --yes is given.
  2. Set up (new server only):
       POST /rest/v4/login/sessions  {admin, admin}  (the factory account)
       POST /rest/v4/site/setup      {name, local.password, settings}
       With the Cloud, setup is a single call instead, after the Cloud
       registration in step 4: {name, settings, cloud: {authKey, owner, siteId
       [, organizationId]}}. The server binds the site as part of the setup and
       disables the local admin, so steps 3 to 5 are skipped.
  3. Log in:    POST /rest/v4/login/sessions  {admin, password}  -> {"token": ...}
  4. Cloud (only if NX_CONNECT_TO_CLOUD is true and the site is not bound yet):
       POST {cloud}/cdb/oauth2/token   -> Cloud bearer token
       POST {cloud}/cdb/systems/bind   -> site id and auth key (Cloud account)
       POST {cloud}/partners/api/v3/cloud_systems/
                                       -> site id and auth key (organization)
       POST /rest/v4/cloud/bind        {authKey, owner, siteId[, organizationId]}
  5. Settings:  PATCH /rest/v4/site/settings  (only what differs from now)
  6. Log out:   DELETE /rest/v4/login/sessions/<token>
                DELETE {cloud}/cdb/oauth2/token/<token>  (when the Cloud was used)

Where the configuration comes from:
  The server address (--host) and the admin password (--password) can be flags.
  Everything else is read from the environment or the .env file: NX_SITE_NAME,
  NX_CONNECT_TO_CLOUD, NX_ORGANIZATION_ID, NX_CLOUD_USER, NX_CLOUD_PASSWORD
  and, optionally, NX_CLOUD_HOST. Which Cloud to use and the customization to
  register under are read from the server itself (site/info), because a
  server can only join the Cloud it was built for. The three site settings live in
  site_settings.json, under the names the API uses.

Reference: https://meta.nxvms.com/doc/developers/api-tool/main?type=1
"""

import argparse
import json
import os
import re
import sys
import urllib.parse

import requests


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class AuthError(Exception):
    """Login was rejected: wrong credentials, or an account that may not do this."""


class ApiError(Exception):
    """The server answered, but not with what the API contract promises."""


class ConfigError(Exception):
    """The configuration is missing or wrong. The run stops with exit code 2."""


class ExistingSiteError(Exception):
    """The server already belongs to a site and --yes was not given."""


def _json_body(response, what):
    """The reply body as a JSON object. A proxy or captive portal answering with
    an HTML page, or a body that is JSON but not an object, is an ApiError
    ("<what> was not valid JSON." / "...was not a JSON object."), not a crash."""
    try:
        body = response.json()
    except ValueError:
        raise ApiError("{} was not valid JSON.".format(what))
    if not isinstance(body, dict):
        raise ApiError("{} was not a JSON object.".format(what))
    return body


def _is_text(value):
    """A non-empty string, the only shape an id or a key may have here."""
    return isinstance(value, str) and bool(value)


def _origin(url):
    """scheme://host[:port] of a URL, without user info, path or query, which
    can hold a session token, the Cloud token or a two-factor code."""
    try:
        parts = urllib.parse.urlsplit(url)
        host = parts.hostname or ""
        if ":" in host:
            host = "[{}]".format(host)
        port = ":{}".format(parts.port) if parts.port else ""
    except ValueError:
        return ""
    return "{}://{}{}".format(parts.scheme, host, port) if host else ""


def _refuse_redirect(response, *args, **kwargs):
    """A response hook: a 3xx is an error. Only the addresses' origins are
    named, never a path or query."""
    if 300 <= response.status_code < 400:
        location = response.headers.get("Location")
        target = _origin(urllib.parse.urljoin(response.url, location)) if location else ""
        raise ApiError("{} answered with a redirect (HTTP {}{}). Check the address: "
                       "it must be the server or the Cloud itself, with the right "
                       "scheme and port.".format(
                           _origin(response.url), response.status_code,
                           " to " + target if target else ""))


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# The server address and password can be given as a flag. Everything else comes
# from the environment or the .env file only, so the order is
# CLI flag > environment variable > .env file for those two and
# environment variable > .env file for the rest.

def load_env_file(path=".env"):
    """Read a simple KEY=VALUE .env file into a dict. Missing file -> {}."""
    values = {}
    if not os.path.exists(path):
        return values
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip('"').strip("'")
    except (OSError, UnicodeDecodeError) as error:
        raise ConfigError(_cannot_read(path, error))
    return values


def _cannot_read(path, error):
    reason = getattr(error, "strerror", None) or str(error)
    return "Cannot read {}: {}.".format(path, reason)


def resolve_config(cli_args, env_file_values):
    """Collect the run's configuration from flags, the environment and .env."""

    def pick(env_name, cli_value=None):
        if cli_value:
            return cli_value
        return os.environ.get(env_name) or env_file_values.get(env_name, "")

    server_host = pick("NX_SERVER_HOST", cli_args.host)
    config = {
        "host": server_host.rstrip("/"),
        "password": pick("NX_SERVER_PASSWORD", cli_args.password),
        "site_name": pick("NX_SITE_NAME"),
    }
    _require(config, [("host", "NX_SERVER_HOST"),
                      ("password", "NX_SERVER_PASSWORD"),
                      ("site_name", "NX_SITE_NAME")])
    # Checked here, before any client exists, so a typo is a configuration error
    # (exit 2) and nothing is ever sent to a nonsense address.
    if not _is_http_url(server_host):
        raise ConfigError(
            "The server address must be a full URL such as https://192.168.1.10:7001, "
            "not {} (NX_SERVER_HOST or --host).".format(_json_text(server_host)))
    # The server serves its login over plain http too, so the admin password
    # would go out in cleartext, and then refuses every Bearer call on http.
    if not server_host.lower().startswith("https://"):
        raise ConfigError(
            "The server address must be an https:// address, because the admin "
            "password is sent there, not {} (NX_SERVER_HOST or --host)."
            .format(_json_text(server_host)))

    config["connect_to_cloud"] = _parse_bool(
        "NX_CONNECT_TO_CLOUD", pick("NX_CONNECT_TO_CLOUD") or "false")
    if config["connect_to_cloud"]:
        cloud_host = pick("NX_CLOUD_HOST")
        config.update({
            # Optional. The server says which Cloud it belongs to; this is only
            # a check that it is the Cloud you expect.
            "cloud_host": cloud_host.rstrip("/") or None,
            "cloud_user": pick("NX_CLOUD_USER"),
            "cloud_password": pick("NX_CLOUD_PASSWORD"),
            # Set: the organization owns the site. Unset: the Cloud account does.
            "organization_id": pick("NX_ORGANIZATION_ID") or None,
        })
        _require(config, [("cloud_user", "NX_CLOUD_USER"),
                          ("cloud_password", "NX_CLOUD_PASSWORD")])
        if cloud_host and not _is_http_url(cloud_host):
            raise ConfigError(
                "NX_CLOUD_HOST must be a full URL such as https://nxvms.com, "
                "not {}.".format(_json_text(cloud_host)))
        if cloud_host and not cloud_host.lower().startswith("https://"):
            raise ConfigError(
                "NX_CLOUD_HOST must be an https:// address, because the Cloud "
                "password is sent there, not {}.".format(_json_text(cloud_host)))
        if not cloud_host and getattr(cli_args, "insecure", False):
            # With --insecure nothing proves the server is the real one, so the
            # Cloud it names cannot be trusted with the Cloud password.
            raise ConfigError(
                "With --insecure, set NX_CLOUD_HOST to the Cloud the server belongs "
                "to, for example https://nxvms.com. The server's certificate is not "
                "checked, so the sample will not send the Cloud password to a Cloud "
                "address that only the server reported.")
    return config


def _json_text(value):
    """A value as JSON text for a message, characters left as typed."""
    return json.dumps(value, ensure_ascii=False)


def _is_http_url(text):
    """True for an absolute http or https URL that names a host and has no spaces."""
    if any(char.isspace() for char in text):
        return False
    try:
        parts = urllib.parse.urlsplit(text)
        return parts.scheme in ("http", "https") and bool(parts.hostname)
    except ValueError:
        return False


def _parse_bool(name, text):
    lowered = text.strip().lower()
    if lowered in ("true", "1"):
        return True
    if lowered in ("false", "0"):
        return False
    raise ConfigError("{} must be true, false, 1 or 0, not {!r}.".format(name, text))


def _require(config, required):
    """Raise ConfigError naming every required value that is empty."""
    missing = [env_name for key, env_name in required if not config[key]]
    if missing:
        raise ConfigError("Missing configuration: {}. Set it in the environment "
                          "or in the .env file.".format(", ".join(missing)))


# ---------------------------------------------------------------------------
# The site settings this sample handles
# ---------------------------------------------------------------------------

# The key is the API name, used unchanged in the settings file and on the wire.
# Each one defaults to on. The site has many more settings than these three, see
# the README for how to add one.
DEFAULT_SETTINGS = {
    "autoDiscoveryEnabled": True,
    "cameraSettingsOptimization": True,
    "statisticsAllowed": True,
}

# Looked up next to this script, so the sample runs from any directory.
DEFAULT_SETTINGS_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "site_settings.json")


def load_settings(path):
    """Read the settings file and return the settings it names, checked.

    Only what the file names is returned. A new site gets DEFAULT_SETTINGS for
    the rest (see configure_site), while on an existing site a setting the file
    leaves out is left as it is. A file that does not exist names nothing.
    """
    settings = {}
    if not os.path.exists(path):
        return settings

    try:
        with open(path, "r", encoding="utf-8") as handle:
            from_file = json.load(handle)
    except OSError as error:
        raise ConfigError(_cannot_read(path, error))
    except ValueError as error:
        raise ConfigError("{} is not valid JSON: {}".format(path, error))
    if not isinstance(from_file, dict):
        raise ConfigError("{} must hold a JSON object such as "
                          '{{"statisticsAllowed": false}}.'.format(path))

    for name, value in from_file.items():
        if name not in DEFAULT_SETTINGS:
            raise ConfigError(
                "{} is not a setting this sample handles (it handles: {}). The "
                "site has many more settings, and the README explains how to add "
                "one.".format(name, ", ".join(DEFAULT_SETTINGS)))
        if not isinstance(value, bool):
            raise ConfigError("{} must be true or false, not {}.".format(
                name, _json_text(value)))

    settings.update(from_file)
    return settings


# ---------------------------------------------------------------------------
# Server client
# ---------------------------------------------------------------------------

# API version path segment. v4 is the latest Nx REST API.
API = "/rest/v4"

# How much of an error response body is kept for a message.
MAX_DETAIL_CHARS = 300

# What a factory-default server's local "admin" account logs in with. site/setup
# needs an administrator, and before setup this is the only account there is.
FACTORY_PASSWORD = "admin"


class _BearerClient:
    """What the server and the Cloud client share: one session and one token.

    Deliberately small, with no retry logic. The point is to show the calls, not
    to be a library.
    """

    def __init__(self, host, verify_tls=True):
        self.host = host.rstrip("/")
        self.session = requests.Session()
        self.session.hooks["response"].append(_refuse_redirect)
        # Passed as verify= on every request rather than set on the session:
        # requests lets REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE override
        # session.verify, which would make --insecure do nothing.
        self.verify_tls = verify_tls
        if not verify_tls:
            # --insecure is expected for local servers with self-signed certs;
            # don't spam the console with a warning for every request.
            requests.packages.urllib3.disable_warnings(
                requests.packages.urllib3.exceptions.InsecureRequestWarning)
        self.token = None

    def _store_token(self, token):
        """Keep the token and send it as a bearer header from now on."""
        self.token = token
        self.session.headers["Authorization"] = "Bearer " + token

    def _require_login(self):
        if not self.token:
            raise ApiError("Not logged in. Call login() first.")


class NxServerClient(_BearerClient):
    """A client for one VMS server."""

    def get_site_info(self):
        """GET site/info -> what the server says about its site. No login needed.

        The two fields this sample reads: "localId" is absent while the server
        is factory-default and present once it belongs to a site, and "cloudId"
        is present once the site is bound to the Cloud. "name" is the site's
        real name.
        """
        response = self.session.get(self.host + API + "/site/info",
                                    timeout=30, verify=self.verify_tls)
        response.raise_for_status()
        return _json_body(response, "Site info response")

    def setup(self, site_name, admin_password, settings, cloud=None):
        """POST site/setup: turn a factory-default server into a new site.

        Needs an administrator on a fresh session, which on a factory-default
        server means logging in as admin with the factory password first.

        Local site: the body sets the site name, the new password of the local
        "admin" account and the initial settings.

        Cloud site: instead of "local" the body carries "cloud", the auth key,
        owner, site id (and organization id) from the Cloud registration. The
        server binds the site to the Cloud as part of the setup, rolls the setup
        back if the bind fails, and disables the local "admin" account, so the
        site is used through the Cloud only.
        """
        self._require_login()
        body = {"name": site_name, "settings": settings}
        if cloud:
            body["cloud"] = cloud
        else:
            body["local"] = {"password": admin_password}
        response = self.session.post(
            self.host + API + "/site/setup", json=body,
            timeout=30, verify=self.verify_tls,
        )
        # Only a 2xx means the site was set up. A 3xx is not success either: it
        # would mean a proxy or a wrong address answered instead of the server.
        if not 200 <= response.status_code < 300:
            raise ApiError("Site setup was refused (HTTP {}: {}).".format(
                response.status_code,
                (response.text or "")[:MAX_DETAIL_CHARS]))

    def login(self, username, password):
        """POST login/sessions -> bearer token, stored on this client."""
        response = self.session.post(
            self.host + API + "/login/sessions",
            json={"username": username, "password": password},
            timeout=30, verify=self.verify_tls,
        )
        if response.status_code == 401:
            raise AuthError(
                "Login rejected (HTTP 401). Check the user name and password. "
                "A Cloud account cannot log in to a server here.")
        if response.status_code == 403:
            raise AuthError(
                "Login forbidden (HTTP 403). This account may not do this. "
                "Changing site settings needs an administrator.")
        response.raise_for_status()

        token = _json_body(response, "Login response").get("token")
        if not token:
            raise ApiError("Login response did not contain a token.")

        self._store_token(token)
        return token

    def get_settings(self):
        """GET site/settings -> every site setting and its current value."""
        self._require_login()
        response = self.session.get(self.host + API + "/site/settings",
                                    timeout=30, verify=self.verify_tls)
        response.raise_for_status()
        return _json_body(response, "Settings response")

    def apply_settings(self, wanted):
        """PATCH site/settings with the settings that differ from the current ones.

        Setup already sent these on a new site, so this is what makes a re-run
        on an existing site converge. Returns the dict that was sent, which is
        empty when nothing needed to change (no PATCH is made then).
        """
        current = self.get_settings()
        changes = {name: value for name, value in wanted.items()
                   if current.get(name) != value}
        if changes:
            response = self.session.patch(
                self.host + API + "/site/settings", json=changes,
                timeout=30, verify=self.verify_tls)
            response.raise_for_status()
        return changes

    def cloud_bind(self, auth_key, owner, site_id, organization_id=None):
        """POST cloud/bind: tell the server it now belongs to a Cloud site record.

        auth_key and site_id come from the Cloud's own bind call (see
        NxCloudClient.register_site). owner is the e-mail of the Cloud account
        that registered the site; the server requires it, also for a site bound
        to an organization, and adds that account as a local administrator.
        organization_id is sent for a site bound to an organization.
        """
        self._require_login()
        body = {"authKey": auth_key, "owner": owner, "siteId": site_id}
        if organization_id:
            body["organizationId"] = organization_id
        response = self.session.post(
            self.host + API + "/cloud/bind", json=body,
            timeout=30, verify=self.verify_tls)
        response.raise_for_status()

    def logout(self):
        """DELETE the session so the token is not left valid. Safe to call twice."""
        if not self.token:
            return
        self.session.delete(
            self.host + API + "/login/sessions/" + self.token,
            timeout=30, verify=self.verify_tls)
        self.token = None
        self.session.headers.pop("Authorization", None)


# ---------------------------------------------------------------------------
# Cloud client
# ---------------------------------------------------------------------------

# A fixed client id Nx uses for third-party integrations in its examples.
CLIENT_ID = "3rdParty"


class NxCloudClient(_BearerClient):
    """A client for the Nx Cloud (the CDB API)."""

    def login(self, username, password, get_mfa_code=None):
        """POST /cdb/oauth2/token -> bearer token, stored on this client.

        An account with two-factor authentication gets a token that must first
        be confirmed with a one-time code (see _confirm_second_factor).
        get_mfa_code() returns that code, or is None when there is no way to
        get one.

        No scope is sent, so the token is cloud-wide. That is what registering a
        new site needs: a token scoped to one site cannot create another.
        """
        response = self.session.post(
            self.host + "/cdb/oauth2/token",
            json={"grant_type": "password",
                  "response_type": "token",
                  "client_id": CLIENT_ID,
                  "username": username,
                  "password": password},
            timeout=30, verify=self.verify_tls,
        )
        if response.status_code in (401, 403):
            raise AuthError(
                "Cloud login rejected (HTTP {}). Check NX_CLOUD_USER and "
                "NX_CLOUD_PASSWORD.".format(response.status_code))
        response.raise_for_status()

        reply = _json_body(response, "Cloud login response")
        token = reply.get("access_token")
        if not token:
            raise ApiError("Cloud login response did not contain an access_token.")

        # An account with two-factor authentication gets HTTP 200 and a token,
        # plus this error. Every other call refuses that token until it is
        # confirmed with a code from the account's authenticator app.
        if reply.get("error") == "second_factor_required":
            code = get_mfa_code() if get_mfa_code else None
            if not code:
                raise AuthError(
                    "Cloud login for {} needs a two-factor code. Run again with "
                    "--mfa-code <the 6-digit code from your authenticator app>, or "
                    "run it in a terminal to be asked for one.".format(username))
            self._confirm_second_factor(token, code)

        self._store_token(token)
        return token

    def _confirm_second_factor(self, token, code):
        """GET /cdb/account/self/2fa/totp/key/{code}?token=<token>.

        Confirms the login token with a one-time code (TOTP). From then on the
        same token works for every call. The token goes in the query string
        here: this call does not accept it as a bearer header.
        """
        response = self.session.get(
            self.host + "/cdb/account/self/2fa/totp/key/"
            + urllib.parse.quote(code.strip(), safe=""),
            params={"token": token},
            timeout=30, verify=self.verify_tls,
        )
        if response.status_code in (400, 401, 403):
            raise AuthError(
                "The two-factor code was not accepted (HTTP {}). A code is only "
                "valid for about 30 seconds, so run again with a fresh one."
                .format(response.status_code))
        response.raise_for_status()

    def register_site(self, site_name, customization, organization_id=None):
        """Create the site's record in the Cloud.

        Without an organization_id: POST /cdb/systems/bind. The account that is
        logged in becomes the owner.

        With an organization_id: POST /partners/api/v3/cloud_systems/ (the
        Channel Partners API), which binds the site to the organization. The
        organization owns the site and its members get access through it.

        Both replies carry the site id and an auth key. They go to the server in
        NxServerClient.cloud_bind, which is what completes the connection.

        "opaque" is a free-text field the Cloud stores for the VMS. It is a
        required field in the spec and this sample has nothing to put in it.
        """
        self._require_login()

        body = {"name": site_name, "customization": customization, "opaque": ""}
        if organization_id:
            body["organization"] = organization_id
            url = self.host + "/partners/api/v3/cloud_systems/"
        else:
            url = self.host + "/cdb/systems/bind"
        response = self.session.post(url, json=body,
                                     timeout=30, verify=self.verify_tls)
        response.raise_for_status()

        reply = _json_body(response, "Cloud bind reply")
        if not _is_text(reply.get("id")) or not _is_text(reply.get("authKey")):
            raise ApiError("The Cloud bind reply did not contain both an id and "
                           "an authKey.")
        return {"siteId": reply["id"], "authKey": reply["authKey"]}

    def logout(self):
        """DELETE /cdb/oauth2/token/{token}: revoke the Cloud token, which has no
        scope and so gives full access to the account. Safe to call twice."""
        if not self.token:
            return
        self.session.delete(
            self.host + "/cdb/oauth2/token/" + urllib.parse.quote(self.token, safe=""),
            timeout=30, verify=self.verify_tls)
        self.token = None
        self.session.headers.pop("Authorization", None)


# ---------------------------------------------------------------------------
# The flow
# ---------------------------------------------------------------------------

# Setup creates this account, so it is the one to log in with.
LOCAL_ADMIN = "admin"


def cloud_target(config, info):
    """The Cloud URL and customization to register the site with, from site/info.

    A server can only be bound to the Cloud it was built for, under its own
    customization (a white-label build has its own), so both come from the
    server. NX_CLOUD_HOST, when set, must name the same Cloud.
    """
    reported = info.get("cloudHost")
    reported = reported.strip().rstrip("/") if isinstance(reported, str) else ""
    customization = info.get("customization")
    customization = customization if isinstance(customization, str) else ""
    if not reported or not customization:
        raise ApiError("The server's site/info did not report its cloudHost and "
                       "customization, so the sample cannot tell which Cloud to "
                       "register the site with.")
    if "://" not in reported:
        reported = "https://" + reported
    if not reported.lower().startswith("https://") or not _is_http_url(reported):
        raise ApiError("The server reports its Cloud as {}, which is not an https:// "
                       "address, so the sample will not send the Cloud password "
                       "there.".format(_json_text(reported)))
    wanted = config.get("cloud_host")
    if wanted and _host_and_port(wanted) != _host_and_port(reported):
        raise ApiError(
            "NX_CLOUD_HOST is {}, but this server belongs to the Cloud at {}. A "
            "server can only be connected to its own Cloud. Remove NX_CLOUD_HOST "
            "or set it to {}.".format(wanted, reported, reported))
    return reported, customization


def _host_and_port(url):
    """host[:port] in lower case."""
    try:
        parts = urllib.parse.urlsplit(url)
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        return url.lower()
    if port is None or port == {"https": 443, "http": 80}.get(parts.scheme.lower()):
        return host
    return "{}:{}".format(host, port)


def _cloud_auth(registered, config):
    """The "cloud" object of site/setup: what the Cloud registration returned,
    plus the owner the API requires and the organization, if any."""
    auth = {"authKey": registered["authKey"], "owner": config["cloud_user"],
            "siteId": registered["siteId"]}
    if config["organization_id"]:
        auth["organizationId"] = config["organization_id"]
    return auth


def configure_site(config, settings, server, make_cloud, allow_existing=False,
                   get_mfa_code=None):
    """Run the steps in order and return a summary. Any failure stops the run.

    site/info decides the path. A factory-default server is set up. A server
    that already belongs to a site is left alone unless allow_existing (--yes)
    is set, because NX_SERVER_HOST and NX_SERVER_PASSWORD are shared with the
    other samples and may well point at a site in use. A site that is already
    bound to the Cloud is not registered again.

    make_cloud(url) returns the Cloud client. It is called only once site/info
    has said which Cloud the server belongs to.
    """
    info = server.get_site_info()
    is_new = not info.get("localId")
    cloud_id = info.get("cloudId")

    # Worked out before anything changes, so a Cloud mismatch stops the run
    # while the server is still untouched.
    connecting = config["connect_to_cloud"] and not cloud_id
    if connecting:
        cloud_url, customization = cloud_target(config, info)

    if not is_new and not allow_existing:
        raise ExistingSiteError(
            "{} already belongs to the site {}. Refusing to change it without "
            "--yes. With --yes its settings are updated{}.".format(
                config["host"], _json_text(info.get("name") or config["site_name"]),
                "" if not connecting else " and it is connected to the Cloud"))

    # Log in to the Cloud before the server is changed, so a wrong Cloud
    # password (or an account with two-factor authentication) stops the run
    # while the server is still untouched.
    if connecting:
        cloud = make_cloud(cloud_url)
        cloud.login(config["cloud_user"], config["cloud_password"], get_mfa_code)

    if is_new:
        site_name = config["site_name"]
        try:
            server.login(LOCAL_ADMIN, FACTORY_PASSWORD)
        except AuthError:
            raise ApiError(
                "The server has not been set up, but its factory login "
                "(admin/admin) was rejected, so the sample cannot set it up.")
        # A new site gets every setting this sample handles: the file's values,
        # and the defaults for what it leaves out.
        all_settings = dict(DEFAULT_SETTINGS, **settings)
        if connecting:
            # One site/setup that also binds the site to the Cloud: nothing is
            # left half done if the bind fails, and no local admin password is
            # set (the server disables the local admin of a Cloud site).
            registered = cloud.register_site(
                site_name, customization, config["organization_id"])
            server.setup(site_name, None, all_settings,
                         cloud=_cloud_auth(registered, config))
            server.logout()
            return {"site_name": site_name, "set_up": True, "cloud": "connected",
                    "cloud_id": cloud_id, "cloud_url": cloud_url,
                    "settings_changed": {}}
        server.setup(site_name, config["password"], all_settings)
        # The password just changed, so start a new session with the new one.
        server.logout()
    else:
        site_name = info.get("name") or config["site_name"]

    server.login(LOCAL_ADMIN, config["password"])

    if connecting:
        registered = cloud.register_site(
            site_name, customization, config["organization_id"])
        server.cloud_bind(registered["authKey"], config["cloud_user"],
                          registered["siteId"], config["organization_id"])
        cloud_state = "connected"
    elif cloud_id:
        cloud_state = "already"
    else:
        cloud_state = "not connected"

    # Only the settings the file names. On an existing site the others stay as
    # an administrator left them.
    changed = server.apply_settings(settings) if settings else {}
    return {"site_name": site_name, "set_up": is_new, "cloud": cloud_state,
            "cloud_id": cloud_id, "cloud_url": cloud_url if connecting else None,
            "settings_changed": changed}


def format_summary(config, summary):
    """Render the outcome as the text to print."""
    if summary["set_up"]:
        setup_line = "yes"
    else:
        setup_line = "no, the server already belonged to a site"

    if summary["cloud"] == "connected":
        if config.get("organization_id"):
            owner = "organization " + config["organization_id"]
        else:
            owner = config["cloud_user"]
        cloud_line = "connected to {}, owned by {}".format(summary["cloud_url"], owner)
    elif summary["cloud"] == "already":
        cloud_line = "already connected (Cloud id {}), left as it was".format(
            summary["cloud_id"])
    else:
        cloud_line = "not connected"

    changed = summary["settings_changed"]
    if changed:
        changed_line = ", ".join("{}={}".format(name, str(value).lower())
                                 for name, value in changed.items())
    else:
        changed_line = "none, the site already had them"

    return "\n".join([
        "Site name       : {}".format(summary["site_name"]),
        "Set up          : {}".format(setup_line),
        "Cloud           : {}".format(cloud_line),
        "Settings changed: {}".format(changed_line),
    ])


class _ArgumentParser(argparse.ArgumentParser):
    """argparse, but a bad command line reads like every other error here: an
    "ERROR: ..." line, then the usage, and exit code 2."""

    def error(self, message):
        sys.stderr.write("ERROR: {}\n".format(message))
        self.print_usage(sys.stderr)
        sys.exit(2)


def build_arg_parser():
    parser = _ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--host", help="https://<server>:7001 of a factory-default server")
    parser.add_argument("--password", help="the local admin password to set")
    parser.add_argument("--env-file", default=".env",
                        help="path to the shared .env (default: ./.env)")
    parser.add_argument("--settings-file", default=DEFAULT_SETTINGS_FILE,
                        help="JSON file with the site settings "
                             "(default: site_settings.json next to this script)")
    parser.add_argument("--insecure", action="store_true",
                        help="skip TLS verification (normal for a lab server's "
                             "self-signed certificate)")
    parser.add_argument("--mfa-code",
                        help="the one-time code from your authenticator app, for "
                             "a Cloud account with two-factor authentication. "
                             "Without it, the sample asks for one when it runs "
                             "in a terminal")
    parser.add_argument("--yes", action="store_true",
                        help="also change a server that already belongs to a "
                             "site (its settings, and its Cloud connection if "
                             "it has none)")
    return parser


def _is_certificate_failure(error):
    """True when TLS failed because the certificate could not be verified, not
    for other TLS errors such as https pointed at an http port."""
    return "CERTIFICATE_VERIFY_FAILED" in str(error)


def _certificate_message(where, server_host):
    """What to do about a certificate that could not be verified: --insecure
    for the server, nothing the sample can skip for the Cloud."""
    if _host_and_port(where) == _host_and_port(server_host):
        return ("certificate verification failed for {}. A local server uses a "
                "self-signed certificate, so add --insecure.".format(where))
    return ("certificate verification failed for {}. --insecure applies to the "
            "server only; the Cloud's certificate is always checked. A proxy that "
            "inspects TLS traffic can cause this.".format(where))


def _describe(error):
    """The error without the request's path or query string, which can hold a
    session token, the Cloud token or a two-factor code."""
    response = getattr(error, "response", None)
    if response is not None:
        text = "HTTP {}".format(response.status_code)
        reason = _error_text(response)
        return "{}: {}".format(text, reason) if reason else text
    return re.sub(r"(with url: )\S+", r"\1...", str(error))


def _error_text(response):
    """The reason the server or the Cloud gives in its JSON error body, if any:
    "errorString" from the server, "errorText" from the Cloud, and "detail" or
    {"errors": [{"detail": ...}]} from the Channel Partners API."""
    try:
        body = response.json()
    except ValueError:
        return ""
    if not isinstance(body, dict):
        return ""
    for key in ("errorString", "errorText", "detail"):
        if isinstance(body.get(key), str) and body[key]:
            return body[key][:MAX_DETAIL_CHARS]
    errors = body.get("errors")
    if isinstance(errors, list) and errors and isinstance(errors[0], dict):
        detail = errors[0].get("detail")
        if isinstance(detail, str) and detail:
            return detail[:MAX_DETAIL_CHARS]
    return ""


def _where(error, fallback):
    """scheme://host:port of the request that failed (the server or the Cloud),
    so the message names the right one."""
    request = getattr(error, "request", None)
    url = getattr(request, "url", None)
    if not url:
        return fallback
    parts = urllib.parse.urlsplit(url)
    return "{}://{}".format(parts.scheme, parts.netloc)


def _mfa_code_source(args, config, stdin=None, ask=input):
    """Where a two-factor code comes from, if the Cloud asks for one: the
    --mfa-code flag, else a prompt when the sample runs in a terminal, else
    nowhere (None). It is only called when the account needs it."""
    if args.mfa_code:
        return lambda: args.mfa_code
    stdin = sys.stdin if stdin is None else stdin
    if stdin is not None and stdin.isatty():
        return lambda: ask("Two-factor code for {}: ".format(
            config.get("cloud_user"))).strip()
    return None


def main(argv=None):
    args = build_arg_parser().parse_args(argv)
    try:
        config = resolve_config(args, load_env_file(args.env_file))
        settings = load_settings(args.settings_file)
    except ConfigError as error:
        print("ERROR: {}".format(error), file=sys.stderr)
        return 2

    if not os.path.exists(args.settings_file):
        # Not an error: a new site gets the defaults, and an existing one keeps
        # its settings. But a mistyped path would otherwise be ignored without
        # a word.
        print("Note: {} not found. A new site gets the default settings, an "
              "existing one keeps its own.".format(args.settings_file),
              file=sys.stderr)

    server = NxServerClient(config["host"], verify_tls=not args.insecure)
    clouds = []   # the Cloud client, once the flow has made it

    def make_cloud(url):
        clouds.append(NxCloudClient(url))
        return clouds[-1]

    try:
        summary = configure_site(config, settings, server, make_cloud,
                                 allow_existing=args.yes,
                                 get_mfa_code=_mfa_code_source(args, config))
        print(format_summary(config, summary))
    except (AuthError, ApiError, ExistingSiteError) as error:
        print("ERROR: {}".format(error), file=sys.stderr)
        return 1
    except requests.exceptions.SSLError as error:
        if not _is_certificate_failure(error):
            print("ERROR: could not complete a request to {}: {}"
                  .format(_where(error, config["host"]), _describe(error)),
                  file=sys.stderr)
            return 1
        where = _where(error, config["host"])
        print("ERROR: " + _certificate_message(where, config["host"]), file=sys.stderr)
        return 1
    except requests.exceptions.RequestException as error:
        print("ERROR: could not complete a request to {}: {}"
              .format(_where(error, config["host"]), _describe(error)),
              file=sys.stderr)
        return 1
    finally:
        # Always release the server session and revoke the Cloud token, even
        # when a step failed.
        for client in [server] + clouds:
            try:
                client.logout()
            except (requests.exceptions.RequestException, ApiError):
                # A logout that cannot be delivered (or is redirected) is not a
                # reason to report failure.
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
