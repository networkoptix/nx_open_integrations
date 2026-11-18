#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for rest_configure_site.py.

These run with no VMS server, no Cloud account and no network: every HTTP call
is served by the fakes below.
"""

import pytest
import requests
import requests.adapters

import rest_configure_site as sample


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, status_code=200, payload=None, text="", bad_json=False):
        self.status_code = status_code
        self.reason = ""
        self._payload = payload if payload is not None else {}
        self.text = text
        self._bad_json = bad_json

    def json(self):
        if self._bad_json:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return self._payload

    def raise_for_status(self):
        # What requests raises, with the response attached.
        if self.status_code >= 400:
            raise requests.exceptions.HTTPError(
                "{} Error".format(self.status_code), response=self)


class FakeSession:
    def __init__(self, responses=None):
        self.headers = {}
        self.calls = []                      # (method, url, json_body)
        self.verify_args = []                # the verify= each call was given
        self.responses = responses or {}     # (method, url_suffix) -> FakeResponse

    def _respond(self, method, url, json_body=None, verify=None):
        self.calls.append((method, url, json_body))
        self.verify_args.append(verify)
        if url.endswith("/site/setup") and "Authorization" not in self.headers:
            # What a real server does: site/setup needs an administrator.
            return FakeResponse(401, text="Unauthorized")
        for (want_method, suffix), response in self.responses.items():
            if method == want_method and url.endswith(suffix):
                return response
        return FakeResponse(200, {})

    def post(self, url, json=None, timeout=None, verify=None):
        return self._respond("POST", url, json, verify)

    def get(self, url, params=None, timeout=None, verify=None):
        self.params = params
        return self._respond("GET", url, verify=verify)

    def patch(self, url, json=None, timeout=None, verify=None):
        return self._respond("PATCH", url, json, verify)

    def delete(self, url, timeout=None, verify=None):
        return self._respond("DELETE", url, verify=verify)


def make_client(responses=None):
    client = sample.NxServerClient("https://server:7001")
    client.session = FakeSession(responses)
    return client


@pytest.mark.parametrize("verify_tls", [True, False])
def test_every_request_passes_verify_explicitly(verify_tls):
    """requests lets REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE override session.verify,
    so --insecure only works if verify= is passed on each request."""
    server = sample.NxServerClient("https://server:7001", verify_tls=verify_tls)
    server.session = FakeSession(
        {("POST", "/login/sessions"): FakeResponse(200, {"token": "tok-1"}),
         ("GET", "/site/settings"): FakeResponse(200, {"a": 1})})
    server.get_site_info()
    server.login("admin", "pw")
    server.setup("Site", "pw", {})
    server.apply_settings({"a": 2})
    server.cloud_bind("key", "owner@example.com", "site-1")
    server.logout()

    cloud = sample.NxCloudClient("https://cloud", verify_tls=verify_tls)
    cloud.session = FakeSession(
        {("POST", "/cdb/oauth2/token"): FakeResponse(200, {"access_token": "t"}),
         ("POST", "/cdb/systems/bind"): FakeResponse(200, {"id": "i", "authKey": "k"})})
    cloud.login("user", "pw")
    cloud.register_site("Site", "default")

    sent = server.session.verify_args + cloud.session.verify_args
    assert len(sent) == 9
    assert sent == [verify_tls] * 9


def test_insecure_is_not_undone_by_a_ca_bundle_in_the_environment(monkeypatch):
    monkeypatch.setenv("REQUESTS_CA_BUNDLE", "/nonexistent/ca.pem")
    client = sample.NxServerClient("https://server:7001", verify_tls=False)
    merged = client.session.merge_environment_settings(
        client.host, {}, None, client.verify_tls, None)
    assert merged["verify"] is False


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------

def test_login_posts_credentials_and_stores_token():
    client = make_client({("POST", "/login/sessions"): FakeResponse(200, {"token": "tok-1"})})

    token = client.login("admin", "secret")

    assert token == "tok-1"
    assert client.token == "tok-1"
    assert client.session.headers["Authorization"] == "Bearer tok-1"

    method, url, body = client.session.calls[0]
    assert (method, body) == ("POST", {"username": "admin", "password": "secret"})
    assert url.endswith("/rest/v4/login/sessions")


@pytest.mark.parametrize("status", [401, 403])
def test_login_unauthorized_raises_autherror(status):
    client = make_client({("POST", "/login/sessions"): FakeResponse(status)})
    with pytest.raises(sample.AuthError):
        client.login("admin", "wrong")


def test_login_403_says_the_account_may_not_do_this():
    """A 403 is not a typo in the password. The account lacks the rights."""
    client = make_client({("POST", "/login/sessions"): FakeResponse(403)})
    with pytest.raises(sample.AuthError, match="may not do this"):
        client.login("admin", "secret")


def test_login_401_points_at_the_credentials():
    client = make_client({("POST", "/login/sessions"): FakeResponse(401)})
    with pytest.raises(sample.AuthError, match="user name and password"):
        client.login("admin", "wrong")


def test_login_without_token_in_response_raises_apierror():
    client = make_client({("POST", "/login/sessions"): FakeResponse(200, {})})
    with pytest.raises(sample.ApiError):
        client.login("admin", "secret")


# ---------------------------------------------------------------------------
# Logout
# ---------------------------------------------------------------------------

def test_logout_deletes_the_session_and_clears_the_token():
    client = make_client()
    client.token = "tok-1"
    client.session.headers["Authorization"] = "Bearer tok-1"

    client.logout()

    method, url, _ = client.session.calls[-1]
    assert method == "DELETE"
    assert url.endswith("/rest/v4/login/sessions/tok-1")
    assert client.token is None
    assert "Authorization" not in client.session.headers


def test_logout_without_a_token_is_a_noop():
    client = make_client()
    client.logout()
    assert client.session.calls == []


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def clean_nx_environment(monkeypatch):
    """Tests must not pick up NX_* variables from the machine they run on."""
    import os
    for name in list(os.environ):
        if name.startswith("NX_"):
            monkeypatch.delenv(name)


def _args(**overrides):
    import argparse
    defaults = {"host": None, "password": None}
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


SERVER_ENV = {"NX_SERVER_HOST": "https://server:7001",
              "NX_SERVER_PASSWORD": "admin-pass",
              "NX_SITE_NAME": "My Site"}


def test_load_env_file_reads_pairs_and_skips_comments_blanks_and_quotes(tmp_path):
    path = tmp_path / "alt.env"
    path.write_text('# a comment\n\nNX_SITE_NAME="Quoted Name"\nNX_SERVER_HOST=https://h:7001\n'
                    'NX_ORGANIZATION_ID = org-1\nnot a pair\n', encoding="utf-8")

    assert sample.load_env_file(str(path)) == {"NX_SITE_NAME": "Quoted Name",
                                               "NX_SERVER_HOST": "https://h:7001",
                                               "NX_ORGANIZATION_ID": "org-1"}


def test_load_env_file_of_a_missing_file_is_empty(tmp_path):
    assert sample.load_env_file(str(tmp_path / "missing.env")) == {}


def test_config_reads_the_server_and_site_variables():
    config = sample.resolve_config(_args(), dict(SERVER_ENV))

    assert config["host"] == "https://server:7001"
    assert config["password"] == "admin-pass"
    assert config["site_name"] == "My Site"


def test_cli_beats_environment_beats_dotenv_for_host_and_password(monkeypatch):
    dotenv = dict(SERVER_ENV)
    monkeypatch.setenv("NX_SERVER_HOST", "https://from-env:7001")

    assert sample.resolve_config(_args(), dotenv)["host"] == "https://from-env:7001"
    assert sample.resolve_config(
        _args(host="https://from-cli:7001"), dotenv)["host"] == "https://from-cli:7001"
    monkeypatch.delenv("NX_SERVER_HOST")
    assert sample.resolve_config(_args(), dotenv)["host"] == "https://server:7001"

    monkeypatch.setenv("NX_SERVER_PASSWORD", "env-pass")
    assert sample.resolve_config(_args(), dotenv)["password"] == "env-pass"
    assert sample.resolve_config(_args(password="cli-pass"), dotenv)["password"] == "cli-pass"


def test_the_site_name_has_no_flag_so_the_environment_beats_dotenv(monkeypatch):
    monkeypatch.setenv("NX_SITE_NAME", "From Env")
    assert sample.resolve_config(_args(), dict(SERVER_ENV))["site_name"] == "From Env"


def test_trailing_slash_is_stripped_from_the_host():
    env = dict(SERVER_ENV, NX_SERVER_HOST="https://server:7001/")
    assert sample.resolve_config(_args(), env)["host"] == "https://server:7001"


CLOUD_ENV = dict(SERVER_ENV,
                 NX_CONNECT_TO_CLOUD="true",
                 NX_CLOUD_HOST="https://cloud.example.com/",
                 NX_CLOUD_USER="owner@example.com",
                 NX_CLOUD_PASSWORD="cloud-pass")


def test_connecting_to_the_cloud_is_off_by_default_and_needs_no_cloud_values():
    config = sample.resolve_config(_args(), dict(SERVER_ENV))
    assert config["connect_to_cloud"] is False


@pytest.mark.parametrize("text, expected", [("true", True), ("TRUE", True), ("1", True),
                                            ("false", False), ("False", False), ("0", False)])
def test_connect_to_cloud_accepts_true_false_1_and_0(text, expected):
    env = dict(CLOUD_ENV, NX_CONNECT_TO_CLOUD=text)
    assert sample.resolve_config(_args(), env)["connect_to_cloud"] is expected


@pytest.mark.parametrize("text", ["yes", "on", "maybe", "2"])
def test_connect_to_cloud_rejects_anything_else(text):
    env = dict(CLOUD_ENV, NX_CONNECT_TO_CLOUD=text)
    with pytest.raises(sample.ConfigError, match="NX_CONNECT_TO_CLOUD"):
        sample.resolve_config(_args(), env)


@pytest.mark.parametrize("missing", ["NX_CLOUD_USER", "NX_CLOUD_PASSWORD"])
def test_connecting_without_a_cloud_value_is_a_config_error_naming_it(missing):
    env = {name: value for name, value in CLOUD_ENV.items() if name != missing}
    with pytest.raises(sample.ConfigError, match=missing):
        sample.resolve_config(_args(), env)


def test_cloud_values_are_read_when_connecting():
    config = sample.resolve_config(_args(), dict(CLOUD_ENV, NX_ORGANIZATION_ID="org-1"))
    assert config["cloud_host"] == "https://cloud.example.com"
    assert config["cloud_user"] == "owner@example.com"
    assert config["cloud_password"] == "cloud-pass"
    assert config["organization_id"] == "org-1"


def test_the_cloud_host_is_optional_and_the_organization_defaults_to_none():
    env = {k: v for k, v in CLOUD_ENV.items() if k != "NX_CLOUD_HOST"}
    config = sample.resolve_config(_args(), env)
    assert config["cloud_host"] is None
    assert config["organization_id"] is None


def test_nx_customization_is_not_read_any_more():
    """The server reports its own customization, see cloud_target."""
    config = sample.resolve_config(_args(), dict(CLOUD_ENV, NX_CUSTOMIZATION="metavms"))
    assert "customization" not in config


BAD_HOSTS = ["not-a-url", "ftp://h", "https://", "http://bad host:7001", "localhost:7001"]


@pytest.mark.parametrize("bad", BAD_HOSTS)
def test_a_server_address_that_is_not_a_full_url_is_a_config_error(bad):
    """Checked before anything is built, so nothing is sent to a nonsense address."""
    expected = ('The server address must be a full URL such as https://192.168.1.10:7001, '
                'not "{}" (NX_SERVER_HOST or --host).'.format(bad))

    with pytest.raises(sample.ConfigError) as from_env:
        sample.resolve_config(_args(), dict(SERVER_ENV, NX_SERVER_HOST=bad))
    with pytest.raises(sample.ConfigError) as from_flag:
        sample.resolve_config(_args(host=bad), dict(SERVER_ENV))

    assert str(from_env.value) == expected
    assert str(from_flag.value) == expected


def test_a_non_ascii_value_is_shown_as_typed_not_escaped():
    bad = chr(0xFC) + "n" + chr(0xEF)   # two accented letters, kept out of the source
    with pytest.raises(sample.ConfigError) as error:
        sample.resolve_config(_args(), dict(SERVER_ENV, NX_SERVER_HOST=bad))
    assert 'not "{}"'.format(bad) in str(error.value)
    assert "\\u" not in str(error.value)


@pytest.mark.parametrize("good", ["https://h", "HTTPS://192.168.1.10:7001",
                                  "https://abc.relay.vmsproxy.com"])
def test_a_full_https_server_address_is_accepted(good):
    config = sample.resolve_config(_args(), dict(SERVER_ENV, NX_SERVER_HOST=good))
    assert config["host"] == good


@pytest.mark.parametrize("plain", ["http://h", "http://192.168.1.10:7001", "HTTP://server:7001"])
def test_a_plain_http_server_address_is_a_config_error(plain):
    """The server's login works over http, so the password would go out in
    cleartext, and every Bearer call after it is refused with 403."""
    with pytest.raises(sample.ConfigError) as error:
        sample.resolve_config(_args(), dict(SERVER_ENV, NX_SERVER_HOST=plain))
    assert str(error.value) == (
        "The server address must be an https:// address, because the admin password "
        'is sent there, not "{}" (NX_SERVER_HOST or --host).'.format(plain))
    with pytest.raises(sample.ConfigError):
        sample.resolve_config(_args(host=plain), dict(SERVER_ENV))


@pytest.mark.parametrize("bad", BAD_HOSTS)
def test_a_cloud_address_that_is_not_a_full_url_is_a_config_error_when_connecting(bad):
    with pytest.raises(sample.ConfigError) as error:
        sample.resolve_config(_args(), dict(CLOUD_ENV, NX_CLOUD_HOST=bad))
    assert str(error.value) == ('NX_CLOUD_HOST must be a full URL such as https://nxvms.com, '
                                'not "{}".'.format(bad))


def test_the_cloud_address_is_not_checked_when_not_connecting():
    env = dict(SERVER_ENV, NX_CONNECT_TO_CLOUD="false", NX_CLOUD_HOST="not-a-url")
    assert sample.resolve_config(_args(), env)["connect_to_cloud"] is False


@pytest.mark.parametrize("missing", ["NX_SERVER_HOST", "NX_SERVER_PASSWORD", "NX_SITE_NAME"])
def test_a_missing_required_value_is_a_config_error_naming_it(missing):
    env = {name: value for name, value in SERVER_ENV.items() if name != missing}
    with pytest.raises(sample.ConfigError, match=missing):
        sample.resolve_config(_args(), env)


# ---------------------------------------------------------------------------
# The whole flow, with the clients faked
# ---------------------------------------------------------------------------

class FakeServer:
    """Records the order of calls. 'fail' names a method that raises ApiError.

    'info' is what site/info answers: {} is a factory-default server, a localId
    makes it a server that already belongs to a site, a cloudId a bound one.
    """

    def __init__(self, info=None, fail=None, log=None, rejected_passwords=()):
        self.log = log if log is not None else []
        # What every server reports: the Cloud it belongs to and its brand.
        self.info = dict(SERVER_BUILD, **(info or {}))
        self.rejected_passwords = rejected_passwords
        self.fail = fail
        self.token = None
        self.logged_out = False

    def _do(self, name, *args):
        self.log.append((name,) + args)
        if self.fail == name:
            raise sample.ApiError("{} failed".format(name))

    def get_site_info(self):
        self._do("server.get_site_info")
        return dict(self.info)

    def setup(self, site_name, admin_password, settings, cloud=None):
        if cloud is None:
            self._do("server.setup", site_name, admin_password, settings)
        else:
            self._do("server.setup", site_name, admin_password, settings, cloud)
        if not self.token:
            raise AssertionError("site/setup was called without a login")

    def login(self, username, password):
        self._do("server.login", username, password)
        if password in self.rejected_passwords:
            raise sample.AuthError("Login rejected (HTTP 401). Check the user name "
                                   "and password.")
        self.token = "tok"

    def cloud_bind(self, auth_key, owner, site_id, organization_id=None):
        self._do("server.cloud_bind", auth_key, owner, site_id, organization_id)

    def apply_settings(self, wanted):
        self._do("server.apply_settings", wanted)
        return {"statisticsAllowed": False}

    def logout(self):
        self.log.append(("server.logout",))
        self.token = None
        self.logged_out = True


SERVER_BUILD = {"cloudHost": "cloud.example.com", "customization": "default"}


class FakeCloud:
    def __init__(self, fail=None, log=None):
        self.log = log if log is not None else []
        self.fail = fail
        self.url = None

    def __call__(self, url):
        self.url = url
        return self

    def _do(self, name, *args):
        self.log.append((name,) + args)
        if self.fail == name:
            raise sample.ApiError("{} failed".format(name))

    def login(self, username, password, get_mfa_code=None):
        self._do("cloud.login", username, password)
        self.get_mfa_code = get_mfa_code

    def register_site(self, site_name, customization, organization_id=None):
        self._do("cloud.register_site", site_name, customization, organization_id)
        return {"siteId": "site-id-1", "authKey": "auth-key-1"}

    def logout(self):
        self.log.append(("cloud.logout",))
        self.logged_out = True


FLOW_CONFIG = {"host": "https://server:7001", "password": "admin-pass",
               "site_name": "My Site", "connect_to_cloud": False}
FLOW_CLOUD_CONFIG = dict(FLOW_CONFIG, connect_to_cloud=True,
                         cloud_host="https://cloud.example.com",
                         cloud_user="owner@example.com", cloud_password="cloud-pass",
                         organization_id=None)

EXISTING = {"localId": "{1b2c}", "name": "Front Office"}
EXISTING_BOUND = dict(EXISTING, cloudId="cloud-site-9")


def _names(log):
    return [entry[0] for entry in log]


def test_a_new_server_is_set_up_with_the_factory_login_then_the_new_password():
    log = []
    server = FakeServer(log=log)

    summary = sample.configure_site(FLOW_CONFIG, THREE_TRUE, server, make_cloud=None)

    assert _names(log) == ["server.get_site_info", "server.login", "server.setup",
                           "server.logout", "server.login", "server.apply_settings"]
    assert log[1] == ("server.login", "admin", "admin")
    assert log[2] == ("server.setup", "My Site", "admin-pass", THREE_TRUE)
    assert log[4] == ("server.login", "admin", "admin-pass")
    assert summary["set_up"] is True
    assert summary["site_name"] == "My Site"
    assert summary["cloud"] == "not connected"


def test_a_new_server_whose_factory_login_is_rejected_is_not_set_up():
    log = []
    server = FakeServer(log=log, rejected_passwords=("admin",))

    with pytest.raises(sample.ApiError, match="factory login"):
        sample.configure_site(FLOW_CONFIG, THREE_TRUE, server, make_cloud=None)

    assert "server.setup" not in _names(log)


def test_a_refused_setup_stops_the_run():
    log = []
    server = FakeServer(log=log, fail="server.setup")

    with pytest.raises(sample.ApiError):
        sample.configure_site(FLOW_CONFIG, THREE_TRUE, server, make_cloud=None)

    assert "server.apply_settings" not in _names(log)


def test_an_existing_site_is_refused_without_yes_and_nothing_is_changed():
    log = []
    server = FakeServer(info=EXISTING, log=log)

    with pytest.raises(sample.ExistingSiteError) as error:
        sample.configure_site(FLOW_CLOUD_CONFIG, THREE_TRUE, server, FakeCloud(log=log))

    assert _names(log) == ["server.get_site_info"]
    message = str(error.value)
    assert "Front Office" in message
    assert "--yes" in message


def test_an_existing_site_with_yes_is_updated_under_its_real_name():
    log = []
    server = FakeServer(info=EXISTING, log=log)

    summary = sample.configure_site(FLOW_CONFIG, THREE_TRUE, server, make_cloud=None,
                                    allow_existing=True)

    assert _names(log) == ["server.get_site_info", "server.login",
                           "server.apply_settings"]
    assert log[1] == ("server.login", "admin", "admin-pass")
    assert summary["set_up"] is False
    assert summary["site_name"] == "Front Office"


def test_an_existing_unbound_site_with_yes_is_registered_under_its_real_name():
    log = []
    server = FakeServer(info=EXISTING, log=log)

    summary = sample.configure_site(FLOW_CLOUD_CONFIG, THREE_TRUE, server,
                                    FakeCloud(log=log), allow_existing=True)

    assert ("cloud.register_site", "Front Office", "default", None) in log
    assert summary["cloud"] == "connected"


def test_a_site_already_bound_to_the_cloud_is_not_registered_again():
    log = []
    server = FakeServer(info=EXISTING_BOUND, log=log)

    summary = sample.configure_site(FLOW_CLOUD_CONFIG, THREE_TRUE, server,
                                    FakeCloud(log=log), allow_existing=True)

    assert not [name for name in _names(log) if name.startswith("cloud.")]
    assert "server.cloud_bind" not in _names(log)
    assert summary["cloud"] == "already"
    assert summary["cloud_id"] == "cloud-site-9"


def test_a_new_cloud_site_is_set_up_and_bound_in_one_site_setup():
    """site/setup carries "cloud" instead of "local": no local admin password
    is set, and the server rolls the setup back if the bind fails."""
    log = []
    server, cloud = FakeServer(log=log), FakeCloud(log=log)

    summary = sample.configure_site(FLOW_CLOUD_CONFIG, THREE_TRUE, server, cloud)

    # The Cloud login comes before anything on the server changes.
    assert _names(log) == ["server.get_site_info", "cloud.login", "server.login",
                           "cloud.register_site", "server.setup", "server.logout"]
    assert ("server.login", "admin", "admin") in log
    assert ("cloud.register_site", "My Site", "default", None) in log
    assert ("server.setup", "My Site", None, THREE_TRUE,
            {"authKey": "auth-key-1", "owner": "owner@example.com",
             "siteId": "site-id-1"}) in log
    assert summary["cloud"] == "connected"
    assert summary["set_up"] is True


def test_an_existing_site_with_yes_is_still_bound_with_cloud_bind():
    log = []
    server = FakeServer(info=EXISTING, log=log)

    sample.configure_site(FLOW_CLOUD_CONFIG, THREE_TRUE, server, FakeCloud(log=log),
                          allow_existing=True)

    assert _names(log) == ["server.get_site_info", "cloud.login", "server.login",
                           "cloud.register_site", "server.cloud_bind",
                           "server.apply_settings"]
    assert ("server.cloud_bind", "auth-key-1", "owner@example.com", "site-id-1",
            None) in log


def test_the_flow_passes_the_organization_to_both_cloud_calls():
    log = []
    config = dict(FLOW_CLOUD_CONFIG, organization_id="org-1")

    sample.configure_site(config, THREE_TRUE, FakeServer(log=log), FakeCloud(log=log))

    assert ("cloud.register_site", "My Site", "default", "org-1") in log
    assert ("server.setup", "My Site", None, THREE_TRUE,
            {"authKey": "auth-key-1", "owner": "owner@example.com",
             "siteId": "site-id-1", "organizationId": "org-1"}) in log


def test_a_new_site_is_set_up_with_the_defaults_for_what_the_file_leaves_out():
    log = []
    sample.configure_site(FLOW_CONFIG, {"statisticsAllowed": False},
                          FakeServer(log=log), make_cloud=None)

    assert ("server.setup", "My Site", "admin-pass",
            dict(THREE_TRUE, statisticsAllowed=False)) in log
    assert ("server.apply_settings", {"statisticsAllowed": False}) in log


def test_an_existing_site_is_patched_only_with_what_the_file_names():
    """An administrator turned autoDiscoveryEnabled off. A file that names only
    statisticsAllowed must not turn it back on."""
    log = []
    sample.configure_site(FLOW_CONFIG, {"statisticsAllowed": False},
                          FakeServer(info=EXISTING, log=log), make_cloud=None,
                          allow_existing=True)

    assert ("server.apply_settings", {"statisticsAllowed": False}) in log


def test_an_existing_site_with_no_settings_named_gets_no_settings_call():
    log = []
    summary = sample.configure_site(FLOW_CONFIG, {}, FakeServer(info=EXISTING, log=log),
                                    make_cloud=None, allow_existing=True)

    assert "server.apply_settings" not in _names(log)
    assert summary["settings_changed"] == {}


def test_the_cloud_and_customization_come_from_the_server():
    """A white-label server joins its own Cloud under its own customization."""
    log = []
    cloud = FakeCloud(log=log)
    server = FakeServer(log=log, info={"cloudHost": "cloud.brand.example",
                                       "customization": "brand_x"})
    config = dict(FLOW_CLOUD_CONFIG, cloud_host=None)

    summary = sample.configure_site(config, THREE_TRUE, server, cloud)

    assert cloud.url == "https://cloud.brand.example"
    assert ("cloud.register_site", "My Site", "brand_x", None) in log
    assert summary["cloud_url"] == "https://cloud.brand.example"


def test_nx_cloud_host_naming_another_cloud_stops_before_anything_changes():
    log = []
    server = FakeServer(log=log, info={"cloudHost": "cloud.brand.example"})
    config = dict(FLOW_CLOUD_CONFIG, cloud_host="https://nxvms.com")

    with pytest.raises(sample.ApiError) as error:
        sample.configure_site(config, THREE_TRUE, server, FakeCloud(log=log))

    assert _names(log) == ["server.get_site_info"]
    assert "https://cloud.brand.example" in str(error.value)
    assert "NX_CLOUD_HOST" in str(error.value)


def test_nx_cloud_host_naming_the_same_cloud_is_accepted():
    cloud = FakeCloud()
    config = dict(FLOW_CLOUD_CONFIG, cloud_host="https://CLOUD.example.com")
    sample.configure_site(config, THREE_TRUE, FakeServer(), cloud)
    assert cloud.url == "https://cloud.example.com"


def test_the_default_port_in_nx_cloud_host_names_the_same_cloud():
    """https://x and https://x:443 are the same Cloud."""
    cloud = FakeCloud()
    config = dict(FLOW_CLOUD_CONFIG, cloud_host="https://cloud.example.com:443")
    sample.configure_site(config, THREE_TRUE, FakeServer(), cloud)
    assert cloud.url == "https://cloud.example.com"


def test_another_port_in_nx_cloud_host_names_another_cloud():
    config = dict(FLOW_CLOUD_CONFIG, cloud_host="https://cloud.example.com:8443")
    with pytest.raises(sample.ApiError, match="NX_CLOUD_HOST"):
        sample.configure_site(config, THREE_TRUE, FakeServer(), FakeCloud())


@pytest.mark.parametrize("missing", ["cloudHost", "customization"])
def test_a_server_that_does_not_report_its_cloud_cannot_be_connected(missing):
    log = []
    server = FakeServer(log=log, info={missing: ""})
    with pytest.raises(sample.ApiError, match="cloudHost and customization"):
        sample.configure_site(FLOW_CLOUD_CONFIG, THREE_TRUE, server, FakeCloud(log=log))
    assert _names(log) == ["server.get_site_info"]


def test_a_bound_site_needs_no_cloud_host_from_the_server():
    server = FakeServer(info=dict(EXISTING_BOUND, cloudHost=""))
    summary = sample.configure_site(FLOW_CLOUD_CONFIG, THREE_TRUE, server, FakeCloud(),
                                    allow_existing=True)
    assert summary["cloud"] == "already"


def test_a_rejected_login_with_the_new_password_is_an_auth_error():
    server = FakeServer(rejected_passwords=("admin-pass",))
    with pytest.raises(sample.AuthError):
        sample.configure_site(FLOW_CONFIG, THREE_TRUE, server, make_cloud=None)


def test_the_summary_reports_which_settings_were_changed():
    summary = sample.configure_site(FLOW_CONFIG, THREE_TRUE, FakeServer(), make_cloud=None)
    assert summary["settings_changed"] == {"statisticsAllowed": False}


@pytest.mark.parametrize("failing, later", [
    ("server.get_site_info", ["server.login", "server.setup", "cloud.login"]),
    ("server.setup", ["cloud.login", "server.apply_settings"]),
    ("server.login", ["cloud.login", "cloud.register_site", "server.apply_settings"]),
    ("cloud.login", ["cloud.register_site", "server.cloud_bind", "server.apply_settings"]),
    ("cloud.register_site", ["server.cloud_bind", "server.apply_settings"]),
])
def test_a_failing_step_stops_the_flow_before_the_next_ones(failing, later):
    log = []
    server = FakeServer(log=log, fail=failing if failing.startswith("server.") else None)
    cloud = FakeCloud(log=log, fail=failing if failing.startswith("cloud.") else None)

    with pytest.raises(sample.ApiError):
        sample.configure_site(FLOW_CLOUD_CONFIG, THREE_TRUE, server, cloud)

    ran = _names(log)
    assert failing in ran
    assert not set(later) & set(ran[ran.index(failing) + 1:])


# ---------------------------------------------------------------------------
# The summary text
# ---------------------------------------------------------------------------

def _summary(**overrides):
    base = {"site_name": "My Site", "set_up": True, "cloud": "not connected",
            "cloud_id": None, "cloud_url": None, "settings_changed": {}}
    base.update(overrides)
    return base


def test_the_summary_names_the_cloud_account_as_owner_for_a_personal_site():
    text = sample.format_summary(
        FLOW_CLOUD_CONFIG, _summary(cloud="connected", cloud_url="https://cloud.example.com"))
    assert "connected to https://cloud.example.com, owned by owner@example.com" in text


def test_the_summary_names_the_organization_as_owner_for_an_organization_site():
    config = dict(FLOW_CLOUD_CONFIG, organization_id="org-1")
    text = sample.format_summary(
        config, _summary(cloud="connected", cloud_url="https://cloud.example.com"))
    assert "owned by organization org-1" in text
    assert "owner@example.com" not in text


def test_the_summary_says_when_the_site_was_already_connected():
    text = sample.format_summary(
        FLOW_CLOUD_CONFIG, _summary(cloud="already", cloud_id="cloud-site-9"))
    assert "already connected (Cloud id cloud-site-9)" in text


def test_the_summary_uses_the_real_site_name_of_an_existing_site():
    text = sample.format_summary(
        FLOW_CONFIG, _summary(site_name="Front Office", set_up=False))
    assert "Site name       : Front Office" in text
    assert "My Site" not in text
    assert "already belonged to a site" in text


def test_the_summary_says_when_nothing_is_connected_or_changed():
    text = sample.format_summary(FLOW_CONFIG, _summary())
    assert "not connected" in text
    assert "none" in text


def test_the_summary_lists_changed_settings_with_lowercase_values():
    text = sample.format_summary(
        FLOW_CONFIG, _summary(settings_changed={"statisticsAllowed": False}))
    assert "statisticsAllowed=false" in text


# ---------------------------------------------------------------------------
# main(): exit codes and output
# ---------------------------------------------------------------------------

@pytest.fixture
def fakes(monkeypatch):
    state = {"log": [], "server": None, "cloud": None, "info": None,
             "server_fail": None, "cloud_fail": None}

    def make_server(host, verify_tls=True):
        state["server"] = FakeServer(info=state["info"], log=state["log"],
                                     fail=state["server_fail"])
        state["server"].host, state["server"].verify_tls = host, verify_tls
        return state["server"]

    def make_cloud(host, verify_tls=True):
        state["cloud"] = FakeCloud(log=state["log"], fail=state["cloud_fail"])
        state["cloud"].verify_tls = verify_tls
        return state["cloud"]

    monkeypatch.setattr(sample, "NxServerClient", make_server)
    monkeypatch.setattr(sample, "NxCloudClient", make_cloud)
    return state


def write_env_file(tmp_path, values):
    path = tmp_path / ".env"
    path.write_text("\n".join("{}={}".format(k, v) for k, v in values.items()),
                    encoding="utf-8")
    return str(path)


def test_main_runs_the_flow_prints_a_summary_and_exits_0(tmp_path, fakes, capsys):
    env_file = write_env_file(tmp_path, SERVER_ENV)

    code = sample.main(["--env-file", env_file,
                        "--settings-file", write_settings_file(tmp_path, '{"statisticsAllowed": false}')])

    assert code == 0
    output = capsys.readouterr().out
    assert "My Site" in output
    assert "statisticsAllowed" in output
    assert fakes["server"].logged_out is True
    assert fakes["server"].host == "https://server:7001"


def test_main_with_a_missing_required_value_exits_2_and_runs_nothing(tmp_path, fakes, capsys):
    env = {k: v for k, v in SERVER_ENV.items() if k != "NX_SITE_NAME"}

    code = sample.main(["--env-file", write_env_file(tmp_path, env)])

    assert code == 2
    assert "NX_SITE_NAME" in capsys.readouterr().err
    assert fakes["log"] == []


def test_main_with_an_unsupported_setting_exits_2_and_runs_nothing(tmp_path, fakes, capsys):
    settings = write_settings_file(tmp_path, '{"auditTrailEnabled": true}')

    code = sample.main(["--env-file", write_env_file(tmp_path, SERVER_ENV),
                        "--settings-file", settings])

    assert code == 2
    assert "auditTrailEnabled" in capsys.readouterr().err
    assert fakes["log"] == []


def test_main_with_a_malformed_server_address_exits_2_and_runs_nothing(tmp_path, fakes, capsys):
    env = dict(SERVER_ENV, NX_SERVER_HOST="not-a-url")

    code = sample.main(["--env-file", write_env_file(tmp_path, env)])

    assert code == 2
    assert 'not "not-a-url"' in capsys.readouterr().err
    assert fakes["log"] == []


def test_an_env_file_that_exists_but_cannot_be_read_is_a_config_error(tmp_path):
    """A directory where the file should be."""
    with pytest.raises(sample.ConfigError) as error:
        sample.load_env_file(str(tmp_path))
    assert str(error.value).startswith("Cannot read {}: ".format(tmp_path))
    assert str(error.value).endswith(".")


def test_a_settings_file_that_exists_but_cannot_be_read_is_a_config_error(tmp_path):
    with pytest.raises(sample.ConfigError) as error:
        sample.load_settings(str(tmp_path))
    assert str(error.value).startswith("Cannot read {}: ".format(tmp_path))


def test_main_exits_2_when_the_env_file_is_a_directory(tmp_path, fakes, capsys):
    code = sample.main(["--env-file", str(tmp_path)])

    assert code == 2
    assert "Cannot read" in capsys.readouterr().err
    assert fakes["log"] == []


def test_main_exits_2_when_the_settings_file_is_a_directory(tmp_path, fakes, capsys):
    code = sample.main(["--env-file", write_env_file(tmp_path, SERVER_ENV),
                        "--settings-file", str(tmp_path)])

    assert code == 2
    assert "Cannot read" in capsys.readouterr().err
    assert fakes["log"] == []


@pytest.mark.parametrize("argv", [["--bogus"], ["--password"], ["--insecure=1"], ["extra"]])
def test_a_bad_command_line_prints_error_then_usage_and_exits_2(argv, fakes, capsys):
    """An ERROR line, then the usage."""
    with pytest.raises(SystemExit) as exit_info:
        sample.main(argv)

    captured = capsys.readouterr()
    lines = captured.err.splitlines()
    assert exit_info.value.code == 2
    assert lines[0].startswith("ERROR: ")
    assert any(line.startswith("usage:") for line in lines[1:])
    assert captured.out == ""
    assert fakes["log"] == []


def test_help_prints_the_usage_on_stdout_and_exits_0(fakes, capsys):
    with pytest.raises(SystemExit) as exit_info:
        sample.main(["--help"])

    captured = capsys.readouterr()
    assert exit_info.value.code == 0
    assert "usage:" in captured.out
    assert "--env-file" in captured.out
    assert captured.err == ""


def test_main_says_so_when_the_settings_file_is_not_found(tmp_path, fakes, capsys):
    sample.main(["--env-file", write_env_file(tmp_path, SERVER_ENV),
                 "--settings-file", str(tmp_path / "typo.json")])

    assert "typo.json" in capsys.readouterr().err


@pytest.mark.parametrize("failing", ["server.get_site_info", "server.setup",
                                     "server.login", "server.apply_settings"])
def test_main_exits_1_when_a_server_step_fails_and_still_logs_out(
        tmp_path, fakes, capsys, failing):
    fakes["server_fail"] = failing

    code = sample.main(["--env-file", write_env_file(tmp_path, SERVER_ENV),
                        "--settings-file", write_settings_file(tmp_path, '{"statisticsAllowed": false}')])

    assert code == 1
    assert "{} failed".format(failing) in capsys.readouterr().err
    assert fakes["server"].logged_out is True


@pytest.mark.parametrize("failing", ["cloud.login", "cloud.register_site"])
def test_main_exits_1_when_a_cloud_step_fails_and_still_logs_out(
        tmp_path, fakes, capsys, failing):
    fakes["cloud_fail"] = failing

    code = sample.main(["--env-file", write_env_file(tmp_path, CLOUD_ENV),
                        "--settings-file", str(tmp_path / "none.json")])

    assert code == 1
    assert fakes["server"].logged_out is True


def test_main_exits_1_on_a_rejected_login(tmp_path, monkeypatch, fakes, capsys):
    def reject(self, username, password):
        if password == "admin":     # the factory login still works
            self.token = "tok"
            return
        raise sample.AuthError("Login forbidden (HTTP 403). This account may not do this.")
    monkeypatch.setattr(FakeServer, "login", reject)

    code = sample.main(["--env-file", write_env_file(tmp_path, SERVER_ENV),
                        "--settings-file", str(tmp_path / "none.json")])

    assert code == 1
    assert "may not do this" in capsys.readouterr().err


def test_main_exits_1_with_a_hint_when_the_server_is_unreachable(
        tmp_path, monkeypatch, fakes, capsys):
    import requests

    def unreachable(self):
        raise requests.exceptions.ConnectionError("no route")
    monkeypatch.setattr(FakeServer, "get_site_info", unreachable)

    code = sample.main(["--env-file", write_env_file(tmp_path, SERVER_ENV),
                        "--settings-file", str(tmp_path / "none.json")])

    assert code == 1
    assert "https://server:7001" in capsys.readouterr().err


def test_main_suggests_insecure_on_a_certificate_error(
        tmp_path, monkeypatch, fakes, capsys):
    import requests

    def bad_cert(self):
        request = requests.Request("GET", "https://server:7001/rest/v4/site/info").prepare()
        raise requests.exceptions.SSLError(
            "[SSL: CERTIFICATE_VERIFY_FAILED] self-signed certificate", request=request)
    monkeypatch.setattr(FakeServer, "get_site_info", bad_cert)

    code = sample.main(["--env-file", write_env_file(tmp_path, SERVER_ENV),
                        "--settings-file", str(tmp_path / "none.json")])

    assert code == 1
    assert capsys.readouterr().err.endswith(
        "ERROR: certificate verification failed for https://server:7001. A local "
        "server uses a self-signed certificate, so add --insecure.\n")


def test_a_cloud_certificate_failure_does_not_suggest_insecure(
        tmp_path, monkeypatch, fakes, capsys):
    def bad_cert(self, username, password, get_mfa_code=None):
        request = requests.Request("POST", "https://cloud.example.com/cdb/oauth2/token").prepare()
        raise requests.exceptions.SSLError(
            "[SSL: CERTIFICATE_VERIFY_FAILED] unable to get local issuer certificate",
            request=request)
    monkeypatch.setattr(FakeCloud, "login", bad_cert)

    code = sample.main(["--env-file", write_env_file(tmp_path, CLOUD_ENV),
                        "--settings-file", str(tmp_path / "none.json")])

    err = capsys.readouterr().err
    assert code == 1
    assert "certificate verification failed for https://cloud.example.com." in err
    assert "--insecure applies to the server only" in err
    assert "so add --insecure" not in err


def test_a_tls_error_that_is_not_a_certificate_failure_is_reported_as_it_is(
        tmp_path, monkeypatch, fakes, capsys):
    """For example https pointed at an http port: --insecure would not help."""
    def wrong_version(self):
        request = requests.Request("GET", "https://server:7001/rest/v4/site/info").prepare()
        raise requests.exceptions.SSLError(
            "[SSL: WRONG_VERSION_NUMBER] wrong version number", request=request)
    monkeypatch.setattr(FakeServer, "get_site_info", wrong_version)

    code = sample.main(["--env-file", write_env_file(tmp_path, SERVER_ENV),
                        "--settings-file", str(tmp_path / "none.json")])

    err = capsys.readouterr().err
    assert code == 1
    assert "ERROR: could not complete a request to https://server:7001: " in err
    assert "WRONG_VERSION_NUMBER" in err
    assert "--insecure" not in err


def test_a_failed_logout_is_not_fatal(tmp_path, monkeypatch, fakes):
    import requests

    def broken_logout(self):
        # Only the final logout, the one main() makes after the run.
        self.token = None
        if "server.apply_settings" in _names(self.log):
            raise requests.exceptions.ConnectionError("gone")
    monkeypatch.setattr(FakeServer, "logout", broken_logout)

    code = sample.main(["--env-file", write_env_file(tmp_path, SERVER_ENV),
                        "--settings-file", str(tmp_path / "none.json")])

    assert code == 0


def test_insecure_turns_tls_verification_off_for_the_server_only(tmp_path, fakes):
    env_file = write_env_file(tmp_path, SERVER_ENV)
    none = str(tmp_path / "none.json")

    sample.main(["--env-file", env_file, "--settings-file", none])
    assert fakes["server"].verify_tls is True

    sample.main(["--env-file", env_file, "--settings-file", none, "--insecure"])
    assert fakes["server"].verify_tls is False


def test_insecure_never_turns_tls_verification_off_for_the_cloud(tmp_path, fakes):
    """The Cloud password must never be sent without a certificate check."""
    env_file = write_env_file(tmp_path, CLOUD_ENV)
    none = str(tmp_path / "none.json")

    code = sample.main(["--env-file", env_file, "--settings-file", none, "--insecure"])

    assert code == 0
    assert fakes["server"].verify_tls is False
    assert fakes["cloud"].verify_tls is True


def test_a_4xx_from_the_server_ends_the_run_with_its_status_and_reason(
        tmp_path, monkeypatch, fakes, capsys):
    """The real path: raise_for_status raises requests.HTTPError, which main
    reports with the host, the status and the server's reason, and exit 1."""
    def refused(self, wanted):
        self._do("server.apply_settings", wanted)
        FakeResponse(422, {"errorString": "Invalid value for statisticsAllowed."}
                     ).raise_for_status()
    monkeypatch.setattr(FakeServer, "apply_settings", refused)

    code = sample.main(["--env-file", write_env_file(tmp_path, SERVER_ENV),
                        "--settings-file",
                        write_settings_file(tmp_path, '{"statisticsAllowed": false}')])

    assert code == 1
    assert ("ERROR: could not complete a request to https://server:7001: HTTP 422: "
            "Invalid value for statisticsAllowed.") in capsys.readouterr().err
    assert fakes["server"].logged_out is True


def test_main_refuses_an_existing_site_without_yes_and_exits_1(tmp_path, fakes, capsys):
    fakes["info"] = EXISTING

    code = sample.main(["--env-file", write_env_file(tmp_path, SERVER_ENV),
                        "--settings-file", str(tmp_path / "none.json")])

    assert code == 1
    assert "--yes" in capsys.readouterr().err
    assert _names(fakes["log"]) == ["server.get_site_info", "server.logout"]


def test_main_with_yes_updates_an_existing_site(tmp_path, fakes, capsys):
    fakes["info"] = EXISTING

    code = sample.main(["--env-file", write_env_file(tmp_path, SERVER_ENV),
                        "--settings-file", write_settings_file(tmp_path, '{"statisticsAllowed": false}'), "--yes"])

    assert code == 0
    assert "Front Office" in capsys.readouterr().out
    assert "server.apply_settings" in _names(fakes["log"])


def test_main_connects_to_the_cloud_only_when_asked(tmp_path, fakes):
    sample.main(["--env-file", write_env_file(tmp_path, SERVER_ENV),
                 "--settings-file", str(tmp_path / "none.json")])
    assert fakes["cloud"] is None


def test_main_with_cloud_prints_the_owner(tmp_path, fakes, capsys):
    code = sample.main(["--env-file", write_env_file(tmp_path, CLOUD_ENV),
                        "--settings-file", str(tmp_path / "none.json")])

    assert code == 0
    assert "owner@example.com" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# The settings file
# ---------------------------------------------------------------------------

def write_settings_file(tmp_path, text):
    path = tmp_path / "site_settings.json"
    path.write_text(text, encoding="utf-8")
    return str(path)


def test_a_missing_settings_file_names_no_settings(tmp_path):
    assert sample.load_settings(str(tmp_path / "no-such-file.json")) == {}


@pytest.mark.parametrize("name", ["autoDiscoveryEnabled",
                                  "cameraSettingsOptimization",
                                  "statisticsAllowed"])
def test_a_false_in_the_file_goes_out_as_false_under_the_same_name(tmp_path, name):
    """The wire field name is the key in the file, unchanged."""
    path = write_settings_file(tmp_path, '{"%s": false}' % name)

    assert sample.load_settings(path) == {name: False}


@pytest.mark.parametrize("value", ['"false"', "0", "1", "null", "[]"])
def test_a_non_boolean_value_is_a_config_error(tmp_path, value):
    path = write_settings_file(tmp_path, '{"autoDiscoveryEnabled": %s}' % value)
    with pytest.raises(sample.ConfigError, match="autoDiscoveryEnabled"):
        sample.load_settings(path)


@pytest.mark.parametrize("value, shown", [('"false"', '"false"'), ("0", "0"), ("1", "1"),
                                          ("null", "null"), ("[]", "[]")])
def test_a_non_boolean_value_is_shown_as_its_json_text(tmp_path, value, shown):
    path = write_settings_file(tmp_path, '{"autoDiscoveryEnabled": %s}' % value)
    with pytest.raises(sample.ConfigError) as error:
        sample.load_settings(path)
    assert "autoDiscoveryEnabled must be true or false, not {}.".format(shown) \
        == str(error.value)


def test_an_unsupported_setting_is_a_config_error_that_points_at_the_readme(tmp_path):
    path = write_settings_file(tmp_path, '{"auditTrailEnabled": true}')
    with pytest.raises(sample.ConfigError) as error:
        sample.load_settings(path)
    assert "auditTrailEnabled" in str(error.value)
    assert "README" in str(error.value)


@pytest.mark.parametrize("text", ["{not json", "[true, false]", '"text"'])
def test_a_settings_file_that_is_not_a_json_object_is_a_config_error(tmp_path, text):
    path = write_settings_file(tmp_path, text)
    with pytest.raises(sample.ConfigError, match="JSON"):
        sample.load_settings(path)


# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

THREE_TRUE = {"autoDiscoveryEnabled": True,
              "cameraSettingsOptimization": True,
              "statisticsAllowed": True}


def logged_in_client(responses=None):
    client = make_client(responses)
    client._store_token("tok-1")
    return client


def test_get_site_info_needs_no_login_and_returns_the_reply():
    info = {"name": "Front Office", "localId": "{1b2c}"}
    client = make_client({("GET", "/site/info"): FakeResponse(200, info)})

    assert client.get_site_info() == info
    method, url, _ = client.session.calls[0]
    assert method == "GET"
    assert url.endswith("/rest/v4/site/info")


def test_a_site_info_reply_that_is_not_a_json_object_is_an_apierror():
    client = make_client({("GET", "/site/info"): FakeResponse(200, ["x"])})
    with pytest.raises(sample.ApiError):
        client.get_site_info()


def test_setup_without_a_login_is_refused_before_anything_is_sent():
    """site/setup needs an administrator, so an anonymous call cannot work."""
    client = make_client()
    with pytest.raises(sample.ApiError, match="Not logged in"):
        client.setup("My Site", "admin-pass", THREE_TRUE)
    assert client.session.calls == []


def test_the_fake_server_refuses_an_anonymous_setup_like_a_real_one():
    client = make_client()
    client.token = "tok-1"          # bypass the guard, send no Authorization
    with pytest.raises(sample.ApiError, match="401"):
        client.setup("My Site", "admin-pass", THREE_TRUE)


def test_setup_posts_name_password_and_settings_with_the_bearer_token():
    client = logged_in_client()

    client.setup("My Site", "admin-pass", THREE_TRUE)

    method, url, body = client.session.calls[0]
    assert method == "POST"
    assert url.endswith("/rest/v4/site/setup")
    assert body == {"name": "My Site",
                    "local": {"password": "admin-pass"},
                    "settings": THREE_TRUE}


@pytest.mark.parametrize("status", [400, 401, 403, 409, 422, 500, 503])
def test_a_refused_setup_raises_with_its_status_and_body(status):
    client = logged_in_client({("POST", "/site/setup"):
                               FakeResponse(status, text="password too weak")})

    with pytest.raises(sample.ApiError) as error:
        client.setup("My Site", "admin-pass", THREE_TRUE)

    assert str(status) in str(error.value)
    assert "password too weak" in str(error.value)


def test_setup_keeps_only_the_start_of_a_long_error_body():
    client = logged_in_client({("POST", "/site/setup"): FakeResponse(400, text="x" * 5000)})
    with pytest.raises(sample.ApiError) as error:
        client.setup("My Site", "admin-pass", THREE_TRUE)
    assert len(str(error.value)) < 400


def test_get_settings_returns_the_settings_object():
    current = {"siteName": "My Site", "autoDiscoveryEnabled": False}
    client = make_client({("GET", "/site/settings"): FakeResponse(200, current)})
    client.token = "tok-1"

    assert client.get_settings() == current

    method, url, _ = client.session.calls[0]
    assert method == "GET"
    assert url.endswith("/rest/v4/site/settings")


def test_get_settings_without_login_raises():
    with pytest.raises(sample.ApiError):
        make_client().get_settings()


def test_apply_settings_patches_only_the_settings_that_differ():
    current = {"autoDiscoveryEnabled": True,
               "cameraSettingsOptimization": False,
               "statisticsAllowed": True}
    client = make_client({("GET", "/site/settings"): FakeResponse(200, current)})
    client.token = "tok-1"

    changed = client.apply_settings(THREE_TRUE)

    assert changed == {"cameraSettingsOptimization": True}
    method, url, body = client.session.calls[-1]
    assert method == "PATCH"
    assert url.endswith("/rest/v4/site/settings")
    assert body == {"cameraSettingsOptimization": True}


def test_cloud_bind_sends_key_owner_and_site_id():
    client = make_client()
    client.token = "tok-1"

    client.cloud_bind("auth-key-1", "owner@example.com", "site-id-1")

    method, url, body = client.session.calls[0]
    assert method == "POST"
    assert url.endswith("/rest/v4/cloud/bind")
    assert body == {"authKey": "auth-key-1",
                    "owner": "owner@example.com",
                    "siteId": "site-id-1"}


def test_cloud_bind_without_login_raises():
    with pytest.raises(sample.ApiError):
        make_client().cloud_bind("k", "o@example.com", "s")


def make_cloud_client(responses=None):
    client = sample.NxCloudClient("https://cloud.example.com")
    client.session = FakeSession(responses)
    return client


def test_cloud_login_requests_a_cloud_wide_bearer_token():
    client = make_cloud_client(
        {("POST", "/cdb/oauth2/token"): FakeResponse(200, {"access_token": "nxcdb-1"})})

    token = client.login("owner@example.com", "cloud-pass")

    assert token == "nxcdb-1"
    assert client.session.headers["Authorization"] == "Bearer nxcdb-1"
    method, url, body = client.session.calls[0]
    assert (method, url) == ("POST", "https://cloud.example.com/cdb/oauth2/token")
    assert body == {"grant_type": "password",
                    "response_type": "token",
                    "client_id": "3rdParty",
                    "username": "owner@example.com",
                    "password": "cloud-pass"}
    assert "scope" not in body, "a scoped token cannot register a new site"


@pytest.mark.parametrize("status", [401, 403])
def test_cloud_login_rejected_raises_autherror(status):
    client = make_cloud_client({("POST", "/cdb/oauth2/token"): FakeResponse(status)})
    with pytest.raises(sample.AuthError, match="Cloud"):
        client.login("owner@example.com", "wrong")


def test_cloud_login_without_access_token_raises_apierror():
    client = make_cloud_client({("POST", "/cdb/oauth2/token"): FakeResponse(200, {})})
    with pytest.raises(sample.ApiError):
        client.login("owner@example.com", "cloud-pass")
    assert "Authorization" not in client.session.headers


REGISTERED = {"id": "site-id-1", "authKey": "auth-key-1", "name": "My Site"}


def test_register_site_for_a_personal_account_has_no_organization_id():
    client = make_cloud_client({("POST", "/cdb/systems/bind"): FakeResponse(200, REGISTERED)})
    client.token = "nxcdb-1"

    result = client.register_site("My Site", "default")

    assert result == {"siteId": "site-id-1", "authKey": "auth-key-1"}
    method, url, body = client.session.calls[0]
    assert (method, url) == ("POST", "https://cloud.example.com/cdb/systems/bind")
    assert body == {"name": "My Site", "customization": "default", "opaque": ""}
    assert "organizationId" not in body


def test_register_site_for_an_organization_uses_the_partners_api():
    client = make_cloud_client({("POST", "/partners/api/v3/cloud_systems/"):
                                FakeResponse(200, REGISTERED)})
    client.token = "nxcdb-1"

    assert client.register_site("My Site", "default", organization_id="org-1") == {
        "siteId": REGISTERED["id"], "authKey": REGISTERED["authKey"]}

    method, url, body = client.session.calls[0]
    assert (method, url) == ("POST",
                             "https://cloud.example.com/partners/api/v3/cloud_systems/")
    assert body == {"name": "My Site", "customization": "default", "opaque": "",
                    "organization": "org-1"}


def test_cloud_bind_for_an_organization_still_sends_the_owner():
    """The server's cloud/bind requires owner, also with an organizationId
    ("Missing required parameter: owner" otherwise)."""
    client = make_client()
    client.token = "tok-1"
    client.cloud_bind("auth-key-1", "owner@example.com", "site-id-1", "org-1")
    assert client.session.calls[0][2] == {"authKey": "auth-key-1",
                                          "owner": "owner@example.com",
                                          "siteId": "site-id-1",
                                          "organizationId": "org-1"}


def test_register_site_without_login_raises():
    with pytest.raises(sample.ApiError):
        make_cloud_client().register_site("My Site", "default")


@pytest.mark.parametrize("payload", [{}, {"id": "site-id-1"}, {"authKey": "k"}])
def test_register_site_response_missing_id_or_key_raises_apierror(payload):
    client = make_cloud_client({("POST", "/cdb/systems/bind"): FakeResponse(200, payload)})
    client.token = "nxcdb-1"
    with pytest.raises(sample.ApiError):
        client.register_site("My Site", "default")


NOT_JSON = FakeResponse(200, bad_json=True)


def test_a_server_login_reply_that_is_not_json_is_an_apierror():
    client = make_client({("POST", "/login/sessions"): NOT_JSON})
    with pytest.raises(sample.ApiError) as error:
        client.login("admin", "secret")
    assert str(error.value) == "Login response was not valid JSON."


def test_a_settings_reply_that_is_not_json_is_an_apierror():
    client = make_client({("GET", "/site/settings"): NOT_JSON})
    client.token = "tok-1"
    with pytest.raises(sample.ApiError) as error:
        client.get_settings()
    assert str(error.value) == "Settings response was not valid JSON."


def test_a_cloud_login_reply_that_is_not_json_is_an_apierror():
    client = make_cloud_client({("POST", "/cdb/oauth2/token"): NOT_JSON})
    with pytest.raises(sample.ApiError) as error:
        client.login("owner@example.com", "cloud-pass")
    assert str(error.value) == "Cloud login response was not valid JSON."


def test_a_cloud_bind_reply_that_is_not_json_is_an_apierror():
    client = make_cloud_client({("POST", "/cdb/systems/bind"): NOT_JSON})
    client.token = "nxcdb-1"
    with pytest.raises(sample.ApiError) as error:
        client.register_site("My Site", "default")
    assert str(error.value) == "Cloud bind reply was not valid JSON."


def test_apply_settings_sends_nothing_when_everything_already_matches():
    client = make_client({("GET", "/site/settings"): FakeResponse(200, dict(THREE_TRUE))})
    client.token = "tok-1"

    assert client.apply_settings(THREE_TRUE) == {}
    assert [call[0] for call in client.session.calls] == ["GET"]


# ---------------------------------------------------------------------------
# Redirects, non-object replies, broken addresses, Cloud safety
# ---------------------------------------------------------------------------

class _OneReplyAdapter(requests.adapters.BaseAdapter):
    def __init__(self, status, headers=None, body=b"{}"):
        super().__init__()
        self.status, self.headers, self.body, self.sent = status, headers or {}, body, []

    def send(self, request, **kwargs):
        self.sent.append(request.url)
        response = requests.Response()
        response.status_code = self.status
        response.headers.update(self.headers)
        response._content = self.body
        response.url = request.url
        response.request = request
        return response

    def close(self):
        pass


def _real_client_answering(status, headers=None):
    client = sample.NxServerClient("https://server:7001")
    adapter = _OneReplyAdapter(status, headers)
    client.session.mount("https://", adapter)
    return client, adapter


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_a_redirect_is_an_error_and_is_not_followed(status):
    client, adapter = _real_client_answering(status, {"Location": "https://elsewhere/"})
    client._store_token("tok-1")

    with pytest.raises(sample.ApiError) as error:
        client.setup("My Site", "admin-pass", THREE_TRUE)

    assert adapter.sent == ["https://server:7001/rest/v4/site/setup"]
    assert "HTTP {}".format(status) in str(error.value)
    assert "to https://elsewhere)" in str(error.value)


def test_the_cloud_client_refuses_redirects_too():
    cloud = sample.NxCloudClient("https://cloud.example.com")
    cloud.session.mount("https://", _OneReplyAdapter(302, {"Location": "https://x/"}))
    with pytest.raises(sample.ApiError, match="redirect"):
        cloud.login("owner@example.com", "cloud-pass")


@pytest.mark.parametrize("body", [[], [1], None, "text", 5])
def test_a_reply_that_is_json_but_not_an_object_is_an_apierror(body):
    client = make_client({("GET", "/site/settings"): FakeResponse(200, body)})
    client.session.responses[("GET", "/site/settings")]._payload = body
    client.token = "tok-1"
    with pytest.raises(sample.ApiError, match="Settings response was not a JSON object"):
        client.get_settings()


def test_a_login_reply_of_null_is_an_apierror_not_a_crash():
    client = make_client({("POST", "/login/sessions"): FakeResponse(200)})
    client.session.responses[("POST", "/login/sessions")]._payload = None
    with pytest.raises(sample.ApiError, match="Login response was not a JSON object"):
        client.login("admin", "pw")


@pytest.mark.parametrize("payload", [{"id": 7, "authKey": "k"}, {"id": "i", "authKey": 9},
                                     {"id": ["i"], "authKey": "k"}])
def test_a_bind_reply_id_and_key_must_be_text(payload):
    client = make_cloud_client({("POST", "/cdb/systems/bind"): FakeResponse(200, payload)})
    client.token = "t"
    with pytest.raises(sample.ApiError, match="both an id and an authKey"):
        client.register_site("My Site", "default")


@pytest.mark.parametrize("bad", ["http://[abc", "https://[::1"])
def test_a_broken_ipv6_address_is_a_config_error_not_a_crash(bad):
    with pytest.raises(sample.ConfigError, match="full URL"):
        sample.resolve_config(_args(), dict(SERVER_ENV, NX_SERVER_HOST=bad))


def test_a_broken_cloud_host_reported_by_the_server_is_an_apierror():
    with pytest.raises(sample.ApiError):
        sample.cloud_target(FLOW_CLOUD_CONFIG,
                            {"cloudHost": "[abc", "customization": "default"})


def test_nx_cloud_host_must_be_https():
    with pytest.raises(sample.ConfigError, match="https://"):
        sample.resolve_config(_args(), dict(CLOUD_ENV, NX_CLOUD_HOST="http://nxvms.com"))


def test_a_cloud_the_server_reports_as_plain_http_is_refused():
    with pytest.raises(sample.ApiError, match="not an https:// address"):
        sample.cloud_target(dict(FLOW_CLOUD_CONFIG, cloud_host=None),
                            {"cloudHost": "http://cloud.example.com",
                             "customization": "default"})


def test_with_insecure_the_cloud_host_must_be_given():
    """Without a checked certificate the server could be anyone, so the Cloud it
    names must not receive the Cloud password."""
    env = {k: v for k, v in CLOUD_ENV.items() if k != "NX_CLOUD_HOST"}
    with pytest.raises(sample.ConfigError, match="With --insecure, set NX_CLOUD_HOST"):
        sample.resolve_config(_args(insecure=True), env)
    assert sample.resolve_config(_args(insecure=True), CLOUD_ENV)["cloud_host"]
    assert sample.resolve_config(_args(), env)["cloud_host"] is None


def test_main_exits_2_for_insecure_cloud_without_a_cloud_host(tmp_path, fakes, capsys):
    env = {k: v for k, v in CLOUD_ENV.items() if k != "NX_CLOUD_HOST"}
    code = sample.main(["--env-file", write_env_file(tmp_path, env), "--insecure",
                        "--settings-file", str(tmp_path / "none.json")])
    assert code == 2
    assert "NX_CLOUD_HOST" in capsys.readouterr().err
    assert fakes["log"] == []


def test_a_redirect_on_the_final_logout_is_not_fatal(tmp_path, monkeypatch, fakes):
    def redirected_logout(self):
        self.token = None
        if "server.apply_settings" in _names(self.log):
            raise sample.ApiError("https://server:7001 answered with a redirect (HTTP 302).")
    monkeypatch.setattr(FakeServer, "logout", redirected_logout)

    code = sample.main(["--env-file", write_env_file(tmp_path, SERVER_ENV),
                        "--settings-file", str(tmp_path / "none.json")])

    assert code == 0


# ---------------------------------------------------------------------------
# Cloud login first, two-factor accounts, and which host an error names
# ---------------------------------------------------------------------------

def test_a_failed_cloud_login_leaves_a_new_server_untouched():
    log = []
    with pytest.raises(sample.ApiError):
        sample.configure_site(FLOW_CLOUD_CONFIG, THREE_TRUE, FakeServer(log=log),
                              FakeCloud(log=log, fail="cloud.login"))
    assert _names(log) == ["server.get_site_info", "cloud.login"]


def test_an_existing_site_is_refused_before_the_cloud_login():
    log = []
    with pytest.raises(sample.ExistingSiteError):
        sample.configure_site(FLOW_CLOUD_CONFIG, THREE_TRUE,
                              FakeServer(info=EXISTING, log=log), FakeCloud(log=log))
    assert _names(log) == ["server.get_site_info"]


def test_a_failed_cloud_request_names_the_cloud_not_the_server(
        tmp_path, monkeypatch, fakes, capsys):
    def forbidden(self, site_name, customization, organization_id=None):
        request = requests.Request("POST", "https://cloud.example.com/cdb/systems/bind")
        raise requests.exceptions.HTTPError("403 Client Error", request=request.prepare())
    monkeypatch.setattr(FakeCloud, "register_site", forbidden)

    code = sample.main(["--env-file", write_env_file(tmp_path, CLOUD_ENV),
                        "--settings-file", str(tmp_path / "none.json")])

    err = capsys.readouterr().err
    assert code == 1
    assert "could not complete a request to https://cloud.example.com:" in err
    assert "server:7001" not in err


# ---------------------------------------------------------------------------
# Two-factor authentication on the Cloud account
# ---------------------------------------------------------------------------

TWO_FA_LOGIN = FakeResponse(200, {"access_token": "t-2fa", "error": "second_factor_required"})


def test_a_two_factor_login_is_confirmed_with_the_code_then_used():
    """The Cloud answers HTTP 200 with a token and second_factor_required; the
    same token works once GET .../2fa/totp/key/{code}?token=... accepts it."""
    client = make_cloud_client({("POST", "/cdb/oauth2/token"): TWO_FA_LOGIN,
                                ("GET", "/totp/key/123456"): FakeResponse(200, {})})

    token = client.login("owner@example.com", "cloud-pass", lambda: " 123456 ")

    assert token == "t-2fa"
    assert client.session.headers["Authorization"] == "Bearer t-2fa"
    method, url, _ = client.session.calls[1]
    assert (method, url) == (
        "GET", "https://cloud.example.com/cdb/account/self/2fa/totp/key/123456")
    assert client.session.params == {"token": "t-2fa"}


def test_a_two_factor_login_without_a_code_says_how_to_give_one():
    client = make_cloud_client({("POST", "/cdb/oauth2/token"): TWO_FA_LOGIN})

    with pytest.raises(sample.AuthError) as error:
        client.login("owner@example.com", "cloud-pass", None)

    assert str(error.value) == (
        "Cloud login for owner@example.com needs a two-factor code. Run again with "
        "--mfa-code <the 6-digit code from your authenticator app>, or run it in a "
        "terminal to be asked for one.")
    assert client.token is None
    assert len(client.session.calls) == 1


@pytest.mark.parametrize("status", [400, 401, 403])
def test_a_wrong_two_factor_code_is_an_auth_error(status):
    """The Cloud answers a wrong code with 403 "Wrong totp"."""
    client = make_cloud_client({("POST", "/cdb/oauth2/token"): TWO_FA_LOGIN,
                                ("GET", "/totp/key/000000"): FakeResponse(status)})

    with pytest.raises(sample.AuthError, match="two-factor code was not accepted"):
        client.login("owner@example.com", "cloud-pass", lambda: "000000")

    assert client.token is None


def test_an_account_without_two_factor_is_never_asked_for_a_code():
    client = make_cloud_client({("POST", "/cdb/oauth2/token"):
                                FakeResponse(200, {"access_token": "t"})})

    def must_not_be_called():
        raise AssertionError("asked for a code")

    assert client.login("owner@example.com", "cloud-pass", must_not_be_called) == "t"
    assert len(client.session.calls) == 1


def test_the_flow_hands_the_code_source_to_the_cloud_login():
    cloud = FakeCloud()
    source = lambda: "123456"
    sample.configure_site(FLOW_CLOUD_CONFIG, THREE_TRUE, FakeServer(), cloud,
                          get_mfa_code=source)
    assert cloud.get_mfa_code is source


class _Tty:
    def __init__(self, tty):
        self.tty = tty

    def isatty(self):
        return self.tty


def test_the_code_comes_from_the_flag_first():
    args = _args(mfa_code="654321")
    assert sample._mfa_code_source(args, {}, stdin=_Tty(True))() == "654321"


def test_without_the_flag_a_terminal_is_asked_for_the_code():
    asked = []
    source = sample._mfa_code_source(
        _args(mfa_code=None), {"cloud_user": "owner@example.com"}, stdin=_Tty(True),
        ask=lambda prompt: asked.append(prompt) or " 111222 ")
    assert source() == "111222"
    assert asked == ["Two-factor code for owner@example.com: "]


def test_without_the_flag_or_a_terminal_there_is_no_code():
    assert sample._mfa_code_source(_args(mfa_code=None), {}, stdin=_Tty(False)) is None


def test_mfa_code_is_a_command_line_flag():
    args = sample.build_arg_parser().parse_args(["--mfa-code", "123456"])
    assert args.mfa_code == "123456"


# ---------------------------------------------------------------------------
# Error text never carries a token or a two-factor code
# ---------------------------------------------------------------------------

SECRET_URL = "https://cloud.example.com/cdb/account/self/2fa/totp/key/123456?token=SECRET"


def test_an_http_error_is_described_by_its_status_only():
    response = requests.Response()
    response.status_code, response.reason, response.url = 500, "Internal Server Error", SECRET_URL
    error = requests.exceptions.HTTPError("500 Server Error for url: " + SECRET_URL,
                                          response=response)
    text = sample._describe(error)
    assert text == "HTTP 500"


def test_a_connection_error_is_described_without_the_url():
    error = requests.exceptions.ConnectionError(
        "HTTPSConnectionPool(host='cloud.example.com', port=443): Max retries exceeded "
        "with url: /cdb/account/self/2fa/totp/key/123456?token=SECRET (Caused by x)")
    text = sample._describe(error)
    assert "SECRET" not in text and "123456" not in text
    assert "cloud.example.com" in text


def test_main_prints_no_token_when_a_request_fails(tmp_path, monkeypatch, fakes, capsys):
    def failing(self, site_name, customization, organization_id=None):
        request = requests.Request("GET", SECRET_URL).prepare()
        response = requests.Response()
        response.status_code, response.reason, response.url = 500, "Internal Server Error", SECRET_URL
        raise requests.exceptions.HTTPError("500 Server Error for url: " + SECRET_URL,
                                            request=request, response=response)
    monkeypatch.setattr(FakeCloud, "register_site", failing)

    code = sample.main(["--env-file", write_env_file(tmp_path, CLOUD_ENV),
                        "--settings-file", str(tmp_path / "none.json")])

    err = capsys.readouterr().err
    assert code == 1
    assert "SECRET" not in err and "123456" not in err
    assert "could not complete a request to https://cloud.example.com: HTTP 500" in err


@pytest.mark.parametrize("info", [{"cloudHost": 5, "customization": "default"},
                                  {"cloudHost": "cloud.example.com", "customization": 7}])
def test_a_non_string_cloud_host_or_customization_is_an_apierror(info):
    with pytest.raises(sample.ApiError, match="cloudHost and customization"):
        sample.cloud_target(FLOW_CLOUD_CONFIG, info)


def test_an_http_error_includes_the_servers_reason_but_not_the_url():
    response = requests.Response()
    response.status_code, response.reason, response.url = 422, "Unprocessable Entity", SECRET_URL
    response._content = b'{"error": "4", "errorId": "cantProcessRequest", "errorString": "Site is already bound."}'
    error = requests.exceptions.HTTPError("422 for url: " + SECRET_URL, response=response)
    text = sample._describe(error)
    assert text == "HTTP 422: Site is already bound."
    assert "SECRET" not in text


def test_a_channel_partners_error_shows_the_detail_from_its_errors_list():
    response = requests.Response()
    response.status_code = 403
    response._content = (b'{"type": "client_error", "errors": [{"code": "permission_denied",'
                         b' "detail": "You do not have permission.", "attr": null}]}')
    error = requests.exceptions.HTTPError("403", response=response)
    assert sample._describe(error) == "HTTP 403: You do not have permission."


# ---------------------------------------------------------------------------
# The Cloud token is revoked at the end of every run
# ---------------------------------------------------------------------------

def test_cloud_logout_deletes_the_token_and_clears_it():
    client = make_cloud_client()
    client._store_token("cloud/tok")

    client.logout()

    method, url, _ = client.session.calls[0]
    assert (method, url) == ("DELETE",
                             "https://cloud.example.com/cdb/oauth2/token/cloud%2Ftok")
    assert client.token is None
    assert "Authorization" not in client.session.headers


def test_cloud_logout_without_a_token_is_a_noop():
    client = make_cloud_client()
    client.logout()
    assert client.session.calls == []


def test_main_revokes_the_cloud_token_after_a_run(tmp_path, fakes):
    code = sample.main(["--env-file", write_env_file(tmp_path, CLOUD_ENV),
                        "--settings-file", str(tmp_path / "none.json")])
    assert code == 0
    assert fakes["cloud"].logged_out is True
    assert _names(fakes["log"])[-2:] in (["server.logout", "cloud.logout"],
                                         ["cloud.logout", "server.logout"])


@pytest.mark.parametrize("failing", ["cloud.register_site", "server.setup"])
def test_main_revokes_the_cloud_token_after_a_failed_run(tmp_path, fakes, failing):
    if failing.startswith("cloud."):
        fakes["cloud_fail"] = failing
    else:
        fakes["server_fail"] = failing
    code = sample.main(["--env-file", write_env_file(tmp_path, CLOUD_ENV),
                        "--settings-file", str(tmp_path / "none.json")])
    assert code == 1
    assert fakes["cloud"].logged_out is True


def test_a_run_without_the_cloud_revokes_nothing(tmp_path, fakes):
    sample.main(["--env-file", write_env_file(tmp_path, SERVER_ENV),
                 "--settings-file", str(tmp_path / "none.json")])
    assert fakes["cloud"] is None


def test_a_redirect_on_the_two_factor_call_names_no_token_or_code():
    """The confirmation URL carries the code and the Cloud token; a redirect
    error must name only the addresses' origins."""
    cloud = sample.NxCloudClient("https://cloud.example.com")
    cloud.session.mount("https://", _OneReplyAdapter(
        302, {"Location": "https://proxy.example:8443/login?token=SECRET2"}))

    with pytest.raises(sample.ApiError) as error:
        cloud._confirm_second_factor("SECRET", "123456")

    text = str(error.value)
    assert text.startswith("https://cloud.example.com answered with a redirect "
                           "(HTTP 302 to https://proxy.example:8443).")
    assert "SECRET" not in text and "123456" not in text and "/cdb" not in text


def test_origin_drops_user_info_path_and_query():
    assert sample._origin("https://u:p@Host.example:7001/a/b?token=x") == \
        "https://host.example:7001"
    assert sample._origin("https://[::1]:7001/x") == "https://[::1]:7001"
    assert sample._origin("not a url") == ""


def test_setup_for_a_cloud_site_sends_cloud_instead_of_local():
    client = logged_in_client()
    cloud = {"authKey": "k", "owner": "owner@example.com", "siteId": "s"}

    client.setup("My Site", None, THREE_TRUE, cloud=cloud)

    method, url, body = client.session.calls[0]
    assert (method, url.endswith("/rest/v4/site/setup")) == ("POST", True)
    assert body == {"name": "My Site", "settings": THREE_TRUE, "cloud": cloud}
