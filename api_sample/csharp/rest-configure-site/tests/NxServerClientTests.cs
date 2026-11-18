// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the two API clients. Every HTTP call is served by the
// recording handler in TestSupport.cs: no VMS server, no Cloud account, no network.

using System.Text.Json;
using NxConfigureSite;
using Xunit;

namespace NxConfigureSite.Tests;

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

public class LoginTests
{
    [Fact]
    public async Task Login_posts_credentials_and_stores_token()
    {
        var (client, http, handler) = Clients.Server(
            new RecordingHandler().On("POST", "/login/sessions", 200, "{\"token\":\"tok-1\"}"));

        string token = await client.LoginAsync("admin", "secret");

        Assert.Equal("tok-1", token);
        Assert.Equal("tok-1", client.Token);
        Assert.Equal("Bearer tok-1", http.DefaultRequestHeaders.Authorization?.ToString());

        HttpCall call = handler.Calls[0];
        Assert.Equal("POST", call.Method);
        Assert.True(Json.Same(call.Body, "{\"username\":\"admin\",\"password\":\"secret\"}"));
        Assert.EndsWith("/rest/v4/login/sessions", call.Url);
    }

    [Theory]
    [InlineData(401)]
    [InlineData(403)]
    public async Task Login_unauthorized_raises_AuthException(int status)
    {
        var (client, _, _) = Clients.Server(new RecordingHandler().On("POST", "/login/sessions", status));
        await Assert.ThrowsAsync<AuthException>(() => client.LoginAsync("admin", "wrong"));
    }

    [Fact]
    public async Task Login_403_says_the_account_may_not_do_this()
    {
        // A 403 is not a typo in the password. The account lacks the rights.
        var (client, _, _) = Clients.Server(new RecordingHandler().On("POST", "/login/sessions", 403));
        var error = await Assert.ThrowsAsync<AuthException>(() => client.LoginAsync("admin", "secret"));
        Assert.Contains("may not do this", error.Message);
    }

    [Fact]
    public async Task Login_401_points_at_the_credentials()
    {
        var (client, _, _) = Clients.Server(new RecordingHandler().On("POST", "/login/sessions", 401));
        var error = await Assert.ThrowsAsync<AuthException>(() => client.LoginAsync("admin", "wrong"));
        Assert.Contains("user name and password", error.Message);
    }

    [Theory]
    [InlineData("<html>502 Bad Gateway</html>")]
    [InlineData("{\"token\": ")]
    public async Task Login_reply_that_is_not_json_raises_ApiException(string body)
    {
        var (client, _, _) = Clients.Server(new RecordingHandler().On("POST", "/login/sessions", 200, text: body));
        var error = await Assert.ThrowsAsync<ApiException>(() => client.LoginAsync("admin", "secret"));
        Assert.Equal("Login response was not valid JSON.", error.Message);
    }

    [Fact]
    public async Task Login_without_token_in_response_raises_ApiException()
    {
        var (client, _, _) = Clients.Server(new RecordingHandler().On("POST", "/login/sessions", 200, "{}"));
        await Assert.ThrowsAsync<ApiException>(() => client.LoginAsync("admin", "secret"));
    }
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

public class LogoutTests
{
    [Fact]
    public async Task Logout_deletes_the_session_and_clears_the_token()
    {
        var (client, http, handler) = Clients.Server(
            new RecordingHandler().On("POST", "/login/sessions", 200, "{\"token\":\"tok-1\"}"));
        await client.LoginAsync("admin", "secret");

        await client.LogoutAsync();

        HttpCall call = handler.Calls[^1];
        Assert.Equal("DELETE", call.Method);
        Assert.EndsWith("/rest/v4/login/sessions/tok-1", call.Url);
        Assert.Null(client.Token);
        Assert.Null(http.DefaultRequestHeaders.Authorization);
    }

    [Fact]
    public async Task Logout_without_a_token_is_a_noop()
    {
        var (client, _, handler) = Clients.Server();
        await client.LogoutAsync();
        Assert.Empty(handler.Calls);
    }
}

// ---------------------------------------------------------------------------
// Site info
// ---------------------------------------------------------------------------

public class SiteInfoTests
{
    [Fact]
    public async Task Get_site_info_needs_no_login_and_returns_the_reply()
    {
        var (client, _, handler) = Clients.Server(new RecordingHandler().On(
            "GET", "/site/info", 200, "{\"name\": \"Front Office\", \"localId\": \"{1b2c}\", \"cloudId\": \"c-9\", "
            + "\"cloudHost\": \"nxvms.com\", \"customization\": \"default\"}"));

        SiteInfo info = await client.GetSiteInfoAsync();

        Assert.Equal(new SiteInfo("{1b2c}", "c-9", "Front Office", "nxvms.com", "default"), info);
        HttpCall call = Assert.Single(handler.Calls);
        Assert.Equal("GET", call.Method);
        Assert.EndsWith("/rest/v4/site/info", call.Url);
        Assert.Null(call.Auth);
    }

    [Fact]
    public async Task A_factory_default_server_has_no_local_id()
    {
        var (client, _, _) = Clients.Server(new RecordingHandler().On("GET", "/site/info", 200, "{}"));
        Assert.Equal(new SiteInfo(null, null, null, null, null), await client.GetSiteInfoAsync());
    }

    [Fact]
    public async Task A_site_info_reply_that_is_not_a_json_object_is_an_ApiException()
    {
        var (client, _, _) = Clients.Server(new RecordingHandler().On("GET", "/site/info", 200, "[\"x\"]"));
        await Assert.ThrowsAsync<ApiException>(() => client.GetSiteInfoAsync());
    }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

public class SetupTests
{
    private static async Task<(NxServerClient Client, RecordingHandler Handler)> LoggedIn(RecordingHandler? handler = null)
    {
        handler ??= new RecordingHandler();
        handler.On("POST", "/login/sessions", 200, "{\"token\":\"tok-1\"}");
        var (client, _, _) = Clients.Server(handler);
        await client.LoginAsync("admin", "admin");
        handler.Calls.Clear();
        return (client, handler);
    }

    [Fact]
    public async Task Setup_without_a_login_is_refused_before_anything_is_sent()
    {
        // site/setup needs an administrator, so an anonymous call cannot work.
        var (client, _, handler) = Clients.Server();

        var error = await Assert.ThrowsAsync<ApiException>(
            () => client.SetupAsync("My Site", "admin-pass", Settings.ThreeTrue()));

        Assert.Contains("Not logged in", error.Message);
        Assert.Empty(handler.Calls);
    }

    [Fact]
    public async Task The_fake_server_refuses_an_anonymous_setup_like_a_real_one()
    {
        var handler = new RecordingHandler().On("POST", "/login/sessions", 200, "{\"token\":\"tok-1\"}");
        var http = new HttpClient(handler);
        var client = new NxServerClient(http, "https://server:7001");
        await client.LoginAsync("admin", "admin");
        // Get past the client's own guard, but send no Authorization header.
        http.DefaultRequestHeaders.Authorization = null;

        var error = await Assert.ThrowsAsync<ApiException>(
            () => client.SetupAsync("My Site", "admin-pass", Settings.ThreeTrue()));

        Assert.Contains("401", error.Message);
    }

    [Fact]
    public async Task Setup_posts_name_password_and_settings_with_the_bearer_token()
    {
        var (client, handler) = await LoggedIn();

        await client.SetupAsync("My Site", "admin-pass", Settings.ThreeTrue());

        HttpCall call = handler.Calls[0];
        Assert.Equal("POST", call.Method);
        Assert.EndsWith("/rest/v4/site/setup", call.Url);
        Assert.Equal("Bearer tok-1", call.Auth);
        Assert.True(Json.Same(call.Body, """
            {"name": "My Site",
             "local": {"password": "admin-pass"},
             "settings": {"autoDiscoveryEnabled": true,
                          "cameraSettingsOptimization": true,
                          "statisticsAllowed": true}}
            """));
    }

    [Fact]
    public async Task Setup_for_a_cloud_site_sends_cloud_instead_of_local()
    {
        var (client, handler) = await LoggedIn();

        await client.SetupAsync("My Site", null, Settings.ThreeTrue(),
            new CloudAuth("k", "owner@example.com", "s"));

        HttpCall call = handler.Calls[0];
        Assert.Equal("POST", call.Method);
        Assert.EndsWith("/rest/v4/site/setup", call.Url);
        Assert.True(Json.Same(call.Body, """
            {"name": "My Site",
             "settings": {"autoDiscoveryEnabled": true,
                          "cameraSettingsOptimization": true,
                          "statisticsAllowed": true},
             "cloud": {"authKey": "k", "owner": "owner@example.com", "siteId": "s"}}
            """));
        Assert.False(Json.Has(call.Body, "local"));
    }

    [Theory]
    [InlineData(400)]
    [InlineData(401)]
    [InlineData(403)]
    [InlineData(409)]
    [InlineData(422)]
    [InlineData(500)]
    [InlineData(503)]
    public async Task A_refused_setup_throws_with_its_status_and_body(int status)
    {
        var (client, _) = await LoggedIn(
            new RecordingHandler().On("POST", "/site/setup", status, text: "password too weak"));

        var error = await Assert.ThrowsAsync<ApiException>(
            () => client.SetupAsync("My Site", "admin-pass", Settings.ThreeTrue()));

        Assert.Equal($"Site setup was refused (HTTP {status}: password too weak).", error.Message);
    }

    [Fact]
    public async Task Setup_keeps_only_the_start_of_a_long_error_body()
    {
        var (client, _) = await LoggedIn(
            new RecordingHandler().On("POST", "/site/setup", 400, text: new string('x', 5000)));

        var error = await Assert.ThrowsAsync<ApiException>(
            () => client.SetupAsync("My Site", "admin-pass", Settings.ThreeTrue()));

        Assert.True(error.Message.Length < 400);
    }
}

// ---------------------------------------------------------------------------
// Site settings and the Cloud bind on the server
// ---------------------------------------------------------------------------

public class SettingsTests
{
    private static async Task<(NxServerClient Client, RecordingHandler Handler)> LoggedIn(RecordingHandler handler)
    {
        handler.On("POST", "/login/sessions", 200, "{\"token\":\"tok-1\"}");
        var (client, _, _) = Clients.Server(handler);
        await client.LoginAsync("admin", "secret");
        handler.Calls.Clear();
        return (client, handler);
    }

    [Fact]
    public async Task Get_settings_returns_the_settings_object()
    {
        const string current = "{\"siteName\":\"My Site\",\"autoDiscoveryEnabled\":false}";
        var (client, handler) = await LoggedIn(new RecordingHandler().On("GET", "/site/settings", 200, current));

        JsonElement settings = await client.GetSettingsAsync();

        Assert.Equal("My Site", settings.GetProperty("siteName").GetString());
        Assert.False(settings.GetProperty("autoDiscoveryEnabled").GetBoolean());
        Assert.Equal("GET", handler.Calls[0].Method);
        Assert.EndsWith("/rest/v4/site/settings", handler.Calls[0].Url);
    }

    [Fact]
    public async Task Settings_reply_that_is_not_json_raises_ApiException()
    {
        var (client, _) = await LoggedIn(
            new RecordingHandler().On("GET", "/site/settings", 200, text: "<html>proxy error</html>"));
        var error = await Assert.ThrowsAsync<ApiException>(() => client.GetSettingsAsync());
        Assert.Equal("Settings response was not valid JSON.", error.Message);
    }

    [Fact]
    public async Task Get_settings_without_login_raises()
    {
        var (client, _, _) = Clients.Server();
        await Assert.ThrowsAsync<ApiException>(() => client.GetSettingsAsync());
    }

    [Fact]
    public async Task Apply_settings_patches_only_the_settings_that_differ()
    {
        const string current = """
            {"autoDiscoveryEnabled": true, "cameraSettingsOptimization": false, "statisticsAllowed": true}
            """;
        var (client, handler) = await LoggedIn(new RecordingHandler().On("GET", "/site/settings", 200, current));

        Dictionary<string, bool> changed = await client.ApplySettingsAsync(Settings.ThreeTrue());

        Assert.Equal(new Dictionary<string, bool> { ["cameraSettingsOptimization"] = true }, changed);
        HttpCall call = handler.Calls[^1];
        Assert.Equal("PATCH", call.Method);
        Assert.EndsWith("/rest/v4/site/settings", call.Url);
        Assert.True(Json.Same(call.Body, "{\"cameraSettingsOptimization\": true}"));
    }

    [Fact]
    public async Task Apply_settings_sends_nothing_when_everything_already_matches()
    {
        const string current = """
            {"autoDiscoveryEnabled": true, "cameraSettingsOptimization": true, "statisticsAllowed": true}
            """;
        var (client, handler) = await LoggedIn(new RecordingHandler().On("GET", "/site/settings", 200, current));

        Assert.Empty(await client.ApplySettingsAsync(Settings.ThreeTrue()));
        Assert.Equal(new[] { "GET" }, handler.Calls.Select(c => c.Method).ToArray());
    }

    [Fact]
    public async Task Cloud_bind_sends_key_owner_and_site_id()
    {
        var (client, handler) = await LoggedIn(new RecordingHandler());

        await client.CloudBindAsync("auth-key-1", "owner@example.com", "site-id-1");

        HttpCall call = handler.Calls[0];
        Assert.Equal("POST", call.Method);
        Assert.EndsWith("/rest/v4/cloud/bind", call.Url);
        Assert.True(Json.Same(call.Body, """
            {"authKey": "auth-key-1", "owner": "owner@example.com", "siteId": "site-id-1"}
            """));
    }

    /// <summary>
    /// The server's cloud/bind requires owner, also with an organizationId
    /// ("Missing required parameter: owner" otherwise).
    /// </summary>
    [Fact]
    public async Task Cloud_bind_for_an_organization_still_sends_the_owner()
    {
        var (client, handler) = await LoggedIn(new RecordingHandler());

        await client.CloudBindAsync("auth-key-1", "owner@example.com", "site-id-1", "org-1");

        Assert.True(Json.Same(handler.Calls[0].Body, """
            {"authKey": "auth-key-1", "owner": "owner@example.com", "siteId": "site-id-1",
             "organizationId": "org-1"}
            """));
    }

    [Fact]
    public async Task A_channel_partners_error_shows_the_detail_from_its_errors_list()
    {
        var (client, _) = await LoggedIn(new RecordingHandler().On("POST", "/cloud/bind", 403,
            """{"type": "client_error", "errors": [{"code": "permission_denied", "detail": "You do not have permission.", "attr": null}]}"""));

        var error = await Assert.ThrowsAsync<HttpRequestException>(
            () => client.CloudBindAsync("auth-key-1", "owner@example.com", "site-id-1"));

        Assert.Equal("HTTP 403: You do not have permission.", error.Message);
    }

    [Fact]
    public async Task An_http_error_includes_the_servers_reason_but_not_the_url()
    {
        var (client, _) = await LoggedIn(new RecordingHandler().On("POST", "/cloud/bind", 422,
            """{"error": "4", "errorId": "cantProcessRequest", "errorString": "Site is already bound."}"""));

        var error = await Assert.ThrowsAsync<HttpRequestException>(
            () => client.CloudBindAsync("auth-key-1", "owner@example.com", "site-id-1"));

        Assert.Equal("HTTP 422: Site is already bound.", error.Message);
        Assert.DoesNotContain("/rest/v4", error.Message);
        Assert.DoesNotContain(client.Token!, error.Message);
        Assert.Equal("https://server:7001", BearerClient.RequestOrigin(error));
    }

    [Fact]
    public async Task Cloud_bind_without_login_raises()
    {
        var (client, _, _) = Clients.Server();
        await Assert.ThrowsAsync<ApiException>(() => client.CloudBindAsync("k", "o@example.com", "s"));
    }
}

// ---------------------------------------------------------------------------
// The Cloud client
// ---------------------------------------------------------------------------

public class CloudClientTests
{
    private const string Registered = "{\"id\":\"site-id-1\",\"authKey\":\"auth-key-1\",\"name\":\"My Site\"}";

    private static async Task<(NxCloudClient Client, RecordingHandler Handler)> LoggedIn(RecordingHandler handler)
    {
        handler.On("POST", "/cdb/oauth2/token", 200, "{\"access_token\":\"nxcdb-1\"}");
        var (client, _, _) = Clients.Cloud(handler);
        await client.LoginAsync("owner@example.com", "cloud-pass");
        handler.Calls.Clear();
        return (client, handler);
    }

    [Fact]
    public async Task Cloud_login_requests_a_cloud_wide_bearer_token()
    {
        var (client, http, handler) = Clients.Cloud(
            new RecordingHandler().On("POST", "/cdb/oauth2/token", 200, "{\"access_token\":\"nxcdb-1\"}"));

        string token = await client.LoginAsync("owner@example.com", "cloud-pass");

        Assert.Equal("nxcdb-1", token);
        Assert.Equal("Bearer nxcdb-1", http.DefaultRequestHeaders.Authorization?.ToString());
        HttpCall call = handler.Calls[0];
        Assert.Equal("POST", call.Method);
        Assert.Equal("https://cloud.example.com/cdb/oauth2/token", call.Url);
        Assert.True(Json.Same(call.Body, """
            {"grant_type": "password",
             "response_type": "token",
             "client_id": "3rdParty",
             "username": "owner@example.com",
             "password": "cloud-pass"}
            """));
        Assert.False(Json.Has(call.Body, "scope"), "a scoped token cannot register a new site");
    }

    [Theory]
    [InlineData(401)]
    [InlineData(403)]
    public async Task Cloud_login_rejected_raises_AuthException(int status)
    {
        var (client, _, _) = Clients.Cloud(new RecordingHandler().On("POST", "/cdb/oauth2/token", status));
        var error = await Assert.ThrowsAsync<AuthException>(
            () => client.LoginAsync("owner@example.com", "wrong"));
        Assert.Contains("Cloud", error.Message);
    }

    [Fact]
    public async Task Cloud_login_reply_that_is_not_json_raises_ApiException()
    {
        var (client, _, _) = Clients.Cloud(
            new RecordingHandler().On("POST", "/cdb/oauth2/token", 200, text: "<html>maintenance</html>"));
        var error = await Assert.ThrowsAsync<ApiException>(
            () => client.LoginAsync("owner@example.com", "cloud-pass"));
        Assert.Equal("Cloud login response was not valid JSON.", error.Message);
    }

    [Fact]
    public async Task Cloud_login_without_access_token_raises_ApiException()
    {
        var (client, http, _) = Clients.Cloud(new RecordingHandler().On("POST", "/cdb/oauth2/token", 200, "{}"));
        await Assert.ThrowsAsync<ApiException>(() => client.LoginAsync("owner@example.com", "cloud-pass"));
        Assert.Null(http.DefaultRequestHeaders.Authorization);
    }

    [Fact]
    public async Task Register_site_for_a_personal_account_has_no_organization_id()
    {
        var (client, handler) = await LoggedIn(new RecordingHandler().On("POST", "/cdb/systems/bind", 200, Registered));

        RegisteredSite result = await client.RegisterSiteAsync("My Site", "default");

        Assert.Equal(new RegisteredSite("site-id-1", "auth-key-1"), result);
        HttpCall call = handler.Calls[0];
        Assert.Equal("POST", call.Method);
        Assert.Equal("https://cloud.example.com/cdb/systems/bind", call.Url);
        Assert.True(Json.Same(call.Body, "{\"name\": \"My Site\", \"customization\": \"default\", \"opaque\": \"\"}"));
        Assert.False(Json.Has(call.Body, "organizationId"));
    }

    [Fact]
    public async Task Register_site_for_an_organization_uses_the_partners_api()
    {
        var (client, handler) = await LoggedIn(
            new RecordingHandler().On("POST", "/partners/api/v3/cloud_systems/", 200, Registered));

        RegisteredSite result = await client.RegisterSiteAsync("My Site", "default", organizationId: "org-1");

        Assert.Equal(new RegisteredSite("site-id-1", "auth-key-1"), result);
        HttpCall call = handler.Calls[0];
        Assert.Equal("POST", call.Method);
        Assert.Equal("https://cloud.example.com/partners/api/v3/cloud_systems/", call.Url);
        Assert.True(Json.Same(call.Body, """
            {"name": "My Site", "customization": "default", "opaque": "", "organization": "org-1"}
            """));
    }

    [Fact]
    public async Task Register_site_without_login_raises()
    {
        var (client, _, _) = Clients.Cloud();
        await Assert.ThrowsAsync<ApiException>(() => client.RegisterSiteAsync("My Site", "default"));
    }

    [Fact]
    public async Task Register_site_reply_that_is_not_json_raises_ApiException()
    {
        var (client, _) = await LoggedIn(
            new RecordingHandler().On("POST", "/cdb/systems/bind", 200, text: "<html>maintenance</html>"));
        var error = await Assert.ThrowsAsync<ApiException>(() => client.RegisterSiteAsync("My Site", "default"));
        Assert.Equal("Cloud bind reply was not valid JSON.", error.Message);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"id\": \"site-id-1\"}")]
    [InlineData("{\"authKey\": \"k\"}")]
    public async Task Register_site_response_missing_id_or_key_raises_ApiException(string payload)
    {
        var (client, _) = await LoggedIn(new RecordingHandler().On("POST", "/cdb/systems/bind", 200, payload));
        await Assert.ThrowsAsync<ApiException>(() => client.RegisterSiteAsync("My Site", "default"));
    }

    [Fact]
    public async Task Cloud_logout_deletes_the_token_and_clears_it()
    {
        var handler = new RecordingHandler()
            .On("POST", "/cdb/oauth2/token", 200, "{\"access_token\":\"cloud/tok\"}");
        var (client, http, _) = Clients.Cloud(handler);
        await client.LoginAsync("owner@example.com", "cloud-pass");
        handler.Calls.Clear();

        await client.LogoutAsync();

        HttpCall call = Assert.Single(handler.Calls);
        Assert.Equal("DELETE", call.Method);
        Assert.Equal("https://cloud.example.com/cdb/oauth2/token/cloud%2Ftok", call.Url);
        Assert.Null(client.Token);
        Assert.Null(http.DefaultRequestHeaders.Authorization);
    }

    [Fact]
    public async Task Cloud_logout_without_a_token_is_a_noop()
    {
        var (client, _, handler) = Clients.Cloud();
        await client.LogoutAsync();
        Assert.Empty(handler.Calls);
    }
}

// ---------------------------------------------------------------------------
// Two-factor authentication on the Cloud account
// ---------------------------------------------------------------------------

public class CloudTwoFactorTests
{
    private const string TwoFaLogin = "{\"access_token\":\"t-2fa\",\"error\":\"second_factor_required\"}";

    private static Func<Task<string?>> Code(string code) => () => Task.FromResult<string?>(code);

    [Fact]
    public async Task A_two_factor_login_is_confirmed_with_the_code_then_used()
    {
        // The Cloud answers HTTP 200 with a token and second_factor_required; the
        // same token works once GET .../2fa/totp/key/{code}?token=... accepts it.
        var (client, http, handler) = Clients.Cloud(new RecordingHandler()
            .On("POST", "/cdb/oauth2/token", 200, TwoFaLogin)
            .On("GET", "/totp/key/123456?token=t-2fa", 200, "{}"));

        string token = await client.LoginAsync("owner@example.com", "cloud-pass", Code(" 123456 "));

        Assert.Equal("t-2fa", token);
        Assert.Equal("Bearer t-2fa", http.DefaultRequestHeaders.Authorization?.ToString());
        HttpCall call = handler.Calls[1];
        Assert.Equal("GET", call.Method);
        Assert.Equal("https://cloud.example.com/cdb/account/self/2fa/totp/key/123456?token=t-2fa", call.Url);
        // The token goes in the query string: this call refuses a bearer header.
        Assert.Null(call.Auth);
    }

    [Fact]
    public async Task A_two_factor_login_without_a_code_says_how_to_give_one()
    {
        var (client, http, handler) = Clients.Cloud(
            new RecordingHandler().On("POST", "/cdb/oauth2/token", 200, TwoFaLogin));

        var error = await Assert.ThrowsAsync<AuthException>(
            () => client.LoginAsync("owner@example.com", "cloud-pass", null));

        Assert.Equal(
            "Cloud login for owner@example.com needs a two-factor code. Run again with "
            + "--mfa-code <the 6-digit code from your authenticator app>, or run it in a "
            + "terminal to be asked for one.", error.Message);
        Assert.Null(client.Token);
        Assert.Null(http.DefaultRequestHeaders.Authorization);
        Assert.Single(handler.Calls);
    }

    [Fact]
    public async Task A_two_factor_login_with_an_empty_code_says_how_to_give_one()
    {
        var (client, _, handler) = Clients.Cloud(
            new RecordingHandler().On("POST", "/cdb/oauth2/token", 200, TwoFaLogin));

        var error = await Assert.ThrowsAsync<AuthException>(
            () => client.LoginAsync("owner@example.com", "cloud-pass", Code("")));

        Assert.StartsWith("Cloud login for owner@example.com needs a two-factor code.", error.Message);
        Assert.Null(client.Token);
        Assert.Single(handler.Calls);
    }

    [Theory]
    [InlineData(400)]
    [InlineData(401)]
    [InlineData(403)]
    public async Task A_wrong_two_factor_code_is_an_AuthException(int status)
    {
        // The Cloud answers a wrong code with 403 "Wrong totp".
        var (client, http, _) = Clients.Cloud(new RecordingHandler()
            .On("POST", "/cdb/oauth2/token", 200, TwoFaLogin)
            .On("GET", "/totp/key/000000?token=t-2fa", status,
                "{\"resultCode\":\"invalidTotp\",\"errorText\":\"Wrong totp\"}"));

        var error = await Assert.ThrowsAsync<AuthException>(
            () => client.LoginAsync("owner@example.com", "cloud-pass", Code("000000")));

        Assert.Equal(
            $"The two-factor code was not accepted (HTTP {status}). A code is only "
            + "valid for about 30 seconds, so run again with a fresh one.", error.Message);
        Assert.Null(client.Token);
        Assert.Null(http.DefaultRequestHeaders.Authorization);
    }

    [Fact]
    public async Task An_account_without_two_factor_is_never_asked_for_a_code()
    {
        var (client, _, handler) = Clients.Cloud(
            new RecordingHandler().On("POST", "/cdb/oauth2/token", 200, "{\"access_token\":\"t\"}"));

        string token = await client.LoginAsync(
            "owner@example.com", "cloud-pass", () => throw new Xunit.Sdk.XunitException("asked for a code"));

        Assert.Equal("t", token);
        Assert.Single(handler.Calls);
    }
}

// ---------------------------------------------------------------------------
// Redirects, non-object replies, the bind reply's types
// ---------------------------------------------------------------------------

public class RedirectTests
{
    private const string Advice =
        "Check the address: it must be the server or the Cloud itself, with the right scheme and port.";

    [Theory]
    [InlineData(301)]
    [InlineData(302)]
    [InlineData(303)]
    [InlineData(307)]
    [InlineData(308)]
    public async Task A_redirect_is_an_error_and_is_not_followed(int status)
    {
        // A real HttpClientHandler, as Program builds it, against a real local
        // server.
        using var listener = new LoopbackServer(path => path switch
        {
            "/rest/v4/login/sessions" => (200, null, "{\"token\":\"tok-1\"}"),
            "/rest/v4/site/setup" => (status, "/elsewhere", ""),
            _ => (200, null, "{}"),
        });
        using HttpClient http = Program.BuildHttpClient(verifyTls: true);
        var client = new NxServerClient(http, listener.Url);
        await client.LoginAsync("admin", "admin");

        var error = await Assert.ThrowsAsync<ApiException>(
            () => client.SetupAsync("My Site", "admin-pass", Settings.ThreeTrue()));

        Assert.Equal(new[] { "POST /rest/v4/login/sessions", "POST /rest/v4/site/setup" }, listener.Requests);
        Assert.Contains($"HTTP {status}", error.Message);
        // Only the Location's origin, resolved against the request URL.
        Assert.Contains($"(HTTP {status} to {listener.Url})", error.Message);
        Assert.DoesNotContain("/elsewhere", error.Message);
        Assert.DoesNotContain("/rest/", error.Message);
    }

    [Fact]
    public async Task The_cloud_client_refuses_redirects_too()
    {
        using var listener = new LoopbackServer(_ => (302, "/x", ""));
        using HttpClient http = Program.BuildHttpClient(verifyTls: true);
        var cloud = new NxCloudClient(http, listener.Url);

        var error = await Assert.ThrowsAsync<ApiException>(
            () => cloud.LoginAsync("owner@example.com", "cloud-pass"));

        Assert.Contains("redirect", error.Message);
        Assert.Equal(new[] { "POST /cdb/oauth2/token" }, listener.Requests);
    }

    [Fact]
    public async Task The_redirect_message_names_the_origins_and_the_status()
    {
        var handler = new RecordingHandler().On("GET", "/site/info", () =>
        {
            HttpResponseMessage reply = RecordingHandler.Reply(302);
            reply.Headers.Location = new Uri("https://elsewhere/");
            return reply;
        });
        var (client, _, _) = Clients.Server(handler);

        var error = await Assert.ThrowsAsync<ApiException>(() => client.GetSiteInfoAsync());

        Assert.Equal(
            "https://server:7001 answered with a redirect (HTTP 302 to https://elsewhere). "
            + Advice, error.Message);
    }

    [Fact]
    public async Task A_redirect_without_a_location_is_still_an_error()
    {
        var (client, _, _) = Clients.Server(new RecordingHandler().On("POST", "/login/sessions", 307));

        var error = await Assert.ThrowsAsync<ApiException>(() => client.LoginAsync("admin", "pw"));

        Assert.Equal(
            "https://server:7001 answered with a redirect (HTTP 307). " + Advice,
            error.Message);
    }

    [Fact]
    public async Task A_redirect_on_the_two_factor_call_names_no_token_or_code()
    {
        // The confirmation URL carries the code and the Cloud token; a redirect
        // error must name only the addresses' origins.
        var (client, _, _) = Clients.Cloud(new RecordingHandler()
            .On("POST", "/cdb/oauth2/token", 200,
                "{\"access_token\":\"SECRET\",\"error\":\"second_factor_required\"}")
            .On("GET", "/totp/key/123456?token=SECRET", () =>
            {
                HttpResponseMessage reply = RecordingHandler.Reply(302);
                reply.Headers.Location = new Uri("https://proxy.example:8443/login?token=SECRET2");
                return reply;
            }));

        var error = await Assert.ThrowsAsync<ApiException>(() => client.LoginAsync(
            "owner@example.com", "cloud-pass", () => Task.FromResult<string?>("123456")));

        Assert.StartsWith(
            "https://cloud.example.com answered with a redirect (HTTP 302 to https://proxy.example:8443).",
            error.Message);
        Assert.DoesNotContain("SECRET", error.Message);
        Assert.DoesNotContain("123456", error.Message);
        Assert.DoesNotContain("/cdb", error.Message);
    }

    [Fact]
    public async Task A_redirect_message_leaves_out_user_info()
    {
        var handler = new RecordingHandler().On("GET", "/site/info", () =>
        {
            HttpResponseMessage reply = RecordingHandler.Reply(302);
            reply.Headers.Location = new Uri("https://user:pw@elsewhere:8443/a?b=c");
            return reply;
        });
        var (client, _, _) = Clients.Server(handler);

        var error = await Assert.ThrowsAsync<ApiException>(() => client.GetSiteInfoAsync());

        Assert.StartsWith("https://server:7001 answered with a redirect (HTTP 302 to https://elsewhere:8443).",
            error.Message);
        Assert.DoesNotContain("pw", error.Message);
    }
}

public class NotAnObjectTests
{
    public static TheoryData<string> NotObjects => new() { "[]", "[1]", "null", "\"text\"", "5" };

    private static async Task<NxServerClient> LoggedInServer(RecordingHandler handler)
    {
        handler.On("POST", "/login/sessions", 200, "{\"token\":\"tok-1\"}");
        var (client, _, _) = Clients.Server(handler);
        await client.LoginAsync("admin", "secret");
        return client;
    }

    [Theory]
    [MemberData(nameof(NotObjects))]
    public async Task A_reply_that_is_json_but_not_an_object_is_an_ApiException(string body)
    {
        NxServerClient client = await LoggedInServer(new RecordingHandler().On("GET", "/site/settings", 200, body));
        var error = await Assert.ThrowsAsync<ApiException>(() => client.GetSettingsAsync());
        Assert.Equal("Settings response was not a JSON object.", error.Message);
    }

    [Fact]
    public async Task A_login_reply_of_null_is_an_ApiException_not_a_crash()
    {
        var (client, _, _) = Clients.Server(new RecordingHandler().On("POST", "/login/sessions", 200, "null"));
        var error = await Assert.ThrowsAsync<ApiException>(() => client.LoginAsync("admin", "pw"));
        Assert.Equal("Login response was not a JSON object.", error.Message);
    }

    [Fact]
    public async Task A_site_info_reply_of_null_names_the_site_info_response()
    {
        var (client, _, _) = Clients.Server(new RecordingHandler().On("GET", "/site/info", 200, "null"));
        var error = await Assert.ThrowsAsync<ApiException>(() => client.GetSiteInfoAsync());
        Assert.Equal("Site info response was not a JSON object.", error.Message);
    }

    [Fact]
    public async Task A_cloud_login_reply_that_is_a_list_is_an_ApiException()
    {
        var (cloud, _, _) = Clients.Cloud(new RecordingHandler().On("POST", "/cdb/oauth2/token", 200, "[]"));
        var error = await Assert.ThrowsAsync<ApiException>(() => cloud.LoginAsync("owner@example.com", "pw"));
        Assert.Equal("Cloud login response was not a JSON object.", error.Message);
    }

    [Fact]
    public async Task A_cloud_bind_reply_that_is_a_string_is_an_ApiException()
    {
        var handler = new RecordingHandler()
            .On("POST", "/cdb/oauth2/token", 200, "{\"access_token\":\"nxcdb-1\"}")
            .On("POST", "/cdb/systems/bind", 200, "\"ok\"");
        var (cloud, _, _) = Clients.Cloud(handler);
        await cloud.LoginAsync("owner@example.com", "cloud-pass");

        var error = await Assert.ThrowsAsync<ApiException>(() => cloud.RegisterSiteAsync("My Site", "default"));
        Assert.Equal("Cloud bind reply was not a JSON object.", error.Message);
    }

    [Theory]
    [InlineData("{\"id\": 7, \"authKey\": \"k\"}")]
    [InlineData("{\"id\": \"i\", \"authKey\": 9}")]
    [InlineData("{\"id\": [\"i\"], \"authKey\": \"k\"}")]
    public async Task A_bind_reply_id_and_key_must_be_text(string payload)
    {
        var handler = new RecordingHandler()
            .On("POST", "/cdb/oauth2/token", 200, "{\"access_token\":\"nxcdb-1\"}")
            .On("POST", "/cdb/systems/bind", 200, payload);
        var (cloud, _, _) = Clients.Cloud(handler);
        await cloud.LoginAsync("owner@example.com", "cloud-pass");

        var error = await Assert.ThrowsAsync<ApiException>(() => cloud.RegisterSiteAsync("My Site", "default"));
        Assert.Equal("The Cloud bind reply did not contain both an id and an authKey.", error.Message);
    }
}
