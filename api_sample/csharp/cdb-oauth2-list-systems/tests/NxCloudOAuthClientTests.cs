// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the cdb-oauth2-list-systems sample. No account, no network:
// the HTTP layer is replaced with a fake HttpMessageHandler, and the pure
// helpers (BuildTokenBody, SystemList.Extract, SystemsTable, DotEnv, Config) are
// tested directly.

using System.Net;
using System.Text;
using System.Text.Json;
using NxOauth2ListSystems;
using Xunit;

namespace NxOauth2ListSystems.Tests;

/// <summary>A fake transport: records each request and returns a canned response per verb.</summary>
internal sealed class FakeHandler : HttpMessageHandler
{
    private readonly HttpResponseMessage? _post;
    private readonly HttpResponseMessage? _get;

    public string? PostUrl { get; private set; }
    public string PostBody { get; private set; } = "";
    public string? GetUrl { get; private set; }
    public string? GetAuthorization { get; private set; }

    public FakeHandler(HttpResponseMessage? post = null, HttpResponseMessage? get = null)
    {
        _post = post;
        _get = get;
    }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (request.Method == HttpMethod.Post)
        {
            PostUrl = request.RequestUri?.ToString();
            PostBody = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
            return _post ?? throw new InvalidOperationException("No POST response queued.");
        }

        GetUrl = request.RequestUri?.ToString();
        GetAuthorization = request.Headers.TryGetValues("Authorization", out var values)
            ? string.Join(",", values)
            : null;
        return _get ?? throw new InvalidOperationException("No GET response queued.");
    }
}

internal static class Http
{
    public static HttpResponseMessage Json(HttpStatusCode status, string body)
        => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    public static HttpResponseMessage Text(HttpStatusCode status, string body)
        => new(status) { Content = new StringContent(body, Encoding.UTF8, "text/plain") };
}

// ---------------------------------------------------------------------------
// LoginAsync()
// ---------------------------------------------------------------------------

public class LoginAsyncTests
{
    [Fact]
    public async Task ReturnsAndStoresToken_WithDocumentedFields()
    {
        var fake = new FakeHandler(post: Http.Json(HttpStatusCode.OK, "{\"access_token\":\"nxcdb-xyz\"}"));
        var client = new NxCloudOAuthClient(new HttpClient(fake), "https://nxvms.com");

        string token = await client.LoginAsync("me@x.com", "pw");

        Assert.Equal("nxcdb-xyz", token);
        Assert.Equal("nxcdb-xyz", client.Token);
        Assert.Equal("https://nxvms.com/cdb/oauth2/token", fake.PostUrl);
        // The documented password-grant fields must be present.
        Assert.Contains("\"grant_type\":\"password\"", fake.PostBody);
        Assert.Contains("\"client_id\":\"3rdParty\"", fake.PostBody);
        Assert.Contains("\"username\":\"me@x.com\"", fake.PostBody);
        // No 2FA code was supplied, so it must not be in the body.
        Assert.DoesNotContain("mfaCode", fake.PostBody);
    }

    [Fact]
    public async Task IncludesMfaCodeWhenSet()
    {
        var fake = new FakeHandler(post: Http.Json(HttpStatusCode.OK, "{\"access_token\":\"t\"}"));
        var client = new NxCloudOAuthClient(new HttpClient(fake), "https://nxvms.com");

        await client.LoginAsync("me@x.com", "pw", mfaCode: "123456");

        Assert.Contains("\"mfaCode\":\"123456\"", fake.PostBody);
    }

    [Fact]
    public async Task BadCredentialsThrowsAuthException()
    {
        var fake = new FakeHandler(post: Http.Text(HttpStatusCode.Unauthorized, "no"));
        var client = new NxCloudOAuthClient(new HttpClient(fake), "https://nxvms.com");

        await Assert.ThrowsAsync<AuthException>(() => client.LoginAsync("me@x.com", "pw"));
    }

    [Fact]
    public async Task MissingTokenThrowsApiException()
    {
        var fake = new FakeHandler(post: Http.Json(HttpStatusCode.OK, "{\"something_else\":1}"));
        var client = new NxCloudOAuthClient(new HttpClient(fake), "https://nxvms.com");

        await Assert.ThrowsAsync<ApiException>(() => client.LoginAsync("me@x.com", "pw"));
    }

    [Fact]
    public async Task NoScopeMeansCloudWideToken()
    {
        // Without a cloud_site_id, the request body must NOT carry a scope:
        // that yields a cloud-wide (cdb) token, correct for listing Sites.
        var fake = new FakeHandler(post: Http.Json(HttpStatusCode.OK, "{\"access_token\":\"t\"}"));
        var client = new NxCloudOAuthClient(new HttpClient(fake), "https://nxvms.com");

        await client.LoginAsync("me@x.com", "pw");

        Assert.DoesNotContain("scope", fake.PostBody);
    }

    [Fact]
    public async Task ScopeSetWhenCloudSiteIdGiven()
    {
        // With a cloud_site_id, the body must carry scope=cloudSystemId=<id>,
        // which produces a site-scoped token.
        var fake = new FakeHandler(post: Http.Json(HttpStatusCode.OK, "{\"access_token\":\"t\"}"));
        var client = new NxCloudOAuthClient(new HttpClient(fake), "https://nxvms.com");

        await client.LoginAsync("me@x.com", "pw", cloudSiteId: "sys-123");

        Assert.Contains("cloudSystemId=sys-123", fake.PostBody);
    }
}

// ---------------------------------------------------------------------------
// BuildTokenBody()
// ---------------------------------------------------------------------------

public class BuildTokenBodyTests
{
    [Fact]
    public void IncludesGrantAndClientId_OmitsOptionalsByDefault()
    {
        var body = NxCloudOAuthClient.BuildTokenBody("me@x.com", "pw");
        Assert.Equal("password", body["grant_type"]);
        Assert.Equal("token", body["response_type"]);
        Assert.Equal("3rdParty", body["client_id"]);
        Assert.Equal("me@x.com", body["username"]);
        Assert.False(body.ContainsKey("mfaCode"));
        Assert.False(body.ContainsKey("scope"));
    }

    [Fact]
    public void AddsMfaCodeAndScopeWhenProvided()
    {
        var body = NxCloudOAuthClient.BuildTokenBody("u", "p", mfaCode: "123456", cloudSiteId: "SITE-1");
        Assert.Equal("123456", body["mfaCode"]);
        Assert.Equal("cloudSystemId=SITE-1", body["scope"]);
    }
}

// ---------------------------------------------------------------------------
// ListSystemsAsync()
// ---------------------------------------------------------------------------

public class ListSystemsAsyncTests
{
    [Fact]
    public async Task SendsBearerHeaderAndParsesSites()
    {
        const string payload = "[{\"id\":\"s1\",\"name\":\"HQ\",\"status\":\"activated\",\"version\":\"6.0\"}]";
        var fake = new FakeHandler(get: Http.Json(HttpStatusCode.OK, payload));
        var client = new NxCloudOAuthClient(new HttpClient(fake), "https://nxvms.com");
        SetToken(client, "nxcdb-abc"); // pretend we already logged in

        List<JsonElement> sites = await client.ListSystemsAsync();

        Assert.Equal("HQ", sites[0].GetProperty("name").GetString());
        Assert.Equal("https://nxvms.com/cdb/systems", fake.GetUrl);
        Assert.Equal("Bearer nxcdb-abc", fake.GetAuthorization);
    }

    [Fact]
    public async Task WithoutLoginThrowsApiException()
    {
        var fake = new FakeHandler(get: Http.Json(HttpStatusCode.OK, "[]"));
        var client = new NxCloudOAuthClient(new HttpClient(fake), "https://nxvms.com");

        await Assert.ThrowsAsync<ApiException>(() => client.ListSystemsAsync());
    }

    [Fact]
    public async Task RejectedTokenThrowsAuthException()
    {
        var fake = new FakeHandler(get: Http.Text(HttpStatusCode.Unauthorized, "no"));
        var client = new NxCloudOAuthClient(new HttpClient(fake), "https://nxvms.com");
        SetToken(client, "nxcdb-abc");

        await Assert.ThrowsAsync<AuthException>(() => client.ListSystemsAsync());
    }

    [Fact]
    public async Task UnwrapsObjectEnvelope()
    {
        // The real CDB may wrap the array in an object; we must still find Sites.
        const string payload = "{\"sites\":[{\"id\":\"s1\",\"name\":\"HQ\"},{\"id\":\"s2\",\"name\":\"Lab\"}]}";
        var fake = new FakeHandler(get: Http.Json(HttpStatusCode.OK, payload));
        var client = new NxCloudOAuthClient(new HttpClient(fake), "https://nxvms.com");
        SetToken(client, "nxcdb-abc");

        List<JsonElement> sites = await client.ListSystemsAsync();

        Assert.Equal(new[] { "HQ", "Lab" }, sites.Select(s => s.GetProperty("name").GetString()));
    }

    // The Token setter is private (filled by LoginAsync); reflection lets the
    // tests skip a real login when they only want to exercise ListSystemsAsync.
    private static void SetToken(NxCloudOAuthClient client, string token)
        => typeof(NxCloudOAuthClient).GetProperty("Token")!.SetValue(client, token);
}

// ---------------------------------------------------------------------------
// SystemList.Extract()
// ---------------------------------------------------------------------------

public class SystemListTests
{
    private static List<JsonElement> Extract(string json) => SystemList.Extract(json);

    [Fact]
    public void HandlesBareArrayAndKnownWrappers()
    {
        Assert.Single(Extract("[{\"id\":\"s1\"}]"));
        Assert.Single(Extract("{\"sites\":[{\"id\":\"s1\"}]}"));
        Assert.Single(Extract("{\"reply\":[{\"id\":\"s1\"}]}"));
        Assert.Single(Extract("{\"data\":{\"sites\":[{\"id\":\"s1\"}]}}")); // nested
    }

    [Fact]
    public void UnknownKeyWithObjectsFoundByFallback()
        => Assert.Single(Extract("{\"whatever\":[{\"id\":\"s1\"}]}"));

    [Fact]
    public void GenuinelyNothingReturnsEmpty()
    {
        Assert.Empty(Extract("{\"count\":0}"));
        Assert.Empty(Extract("\"nope\""));
    }
}

// ---------------------------------------------------------------------------
// SystemsTable.Format()
// ---------------------------------------------------------------------------

public class SystemsTableTests
{
    [Fact]
    public void RendersHeaderAndRow()
    {
        List<JsonElement> sites = SystemList.Extract(
            "[{\"id\":\"s1\",\"name\":\"HQ\",\"status\":\"activated\",\"version\":\"6.0\"}]");
        string output = SystemsTable.Format(sites);
        Assert.Contains("NAME", output);
        Assert.Contains("HQ", output);
    }

    [Fact]
    public void EmptyListReportsNoSites()
        => Assert.Contains("No Sites", SystemsTable.Format(new List<JsonElement>()));
}

// ---------------------------------------------------------------------------
// DotEnv + Config
// ---------------------------------------------------------------------------

public class DotEnvTests
{
    [Fact]
    public void ParsesKeyValuesIgnoresCommentsStripsQuotes()
    {
        string path = Path.GetTempFileName();
        File.WriteAllText(path,
            "# a comment\nNX_CLOUD_HOST=https://nxvms.com\nNX_CLOUD_USER=\"me@x.com\"\n\nbad line without equals\n");
        try
        {
            var env = DotEnv.Load(path);
            Assert.Equal("https://nxvms.com", env["NX_CLOUD_HOST"]);
            Assert.Equal("me@x.com", env["NX_CLOUD_USER"]); // quotes stripped
            Assert.False(env.ContainsKey("bad line without equals"));
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void MissingFileReturnsEmpty() => Assert.Empty(DotEnv.Load("/no/such/file.env"));
}

public class ConfigTests
{
    [Fact]
    public void ParsesValueAndBooleanFlags_BothForms()
    {
        var a = Config.ParseArgs(new[] { "--host", "https://h", "--user=me@x.com", "--insecure", "--debug" });
        Assert.Equal("https://h", a.Host);
        Assert.Equal("me@x.com", a.User);
        Assert.True(a.Insecure);
        Assert.True(a.Debug);
    }

    [Fact]
    public void UnknownArgThrows()
        => Assert.Throws<ArgumentException>(() => Config.ParseArgs(new[] { "--nope" }));

    [Fact]
    public void CliOverridesEnvVar()
    {
        string? saved = Environment.GetEnvironmentVariable("NX_CLOUD_HOST");
        Environment.SetEnvironmentVariable("NX_CLOUD_HOST", "https://env");
        try
        {
            var cfg = Config.Resolve(
                new CliArgs { Host = "https://cli" },
                new Dictionary<string, string> { ["NX_CLOUD_HOST"] = "https://file" });
            Assert.Equal("https://cli", cfg.Host);
        }
        finally
        {
            Environment.SetEnvironmentVariable("NX_CLOUD_HOST", saved);
        }
    }

    [Fact]
    public void ResolveUsesEnvFileWhenNoCliOrEnvVar()
    {
        string? saved = Environment.GetEnvironmentVariable("NX_CLOUD_HOST");
        Environment.SetEnvironmentVariable("NX_CLOUD_HOST", null);
        try
        {
            var cfg = Config.Resolve(new CliArgs(),
                new Dictionary<string, string> { ["NX_CLOUD_HOST"] = "https://from-file" });
            Assert.Equal("https://from-file", cfg.Host);
        }
        finally
        {
            Environment.SetEnvironmentVariable("NX_CLOUD_HOST", saved);
        }
    }
}
