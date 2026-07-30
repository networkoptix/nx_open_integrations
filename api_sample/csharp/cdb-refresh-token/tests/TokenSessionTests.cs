// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the cdb-refresh-token sample. No account, no network: the
// HTTP layer is replaced with a fake HttpMessageHandler that serves queued
// responses in order, and a controllable clock makes expiry deterministic.
//
// These cover the session lifecycle: request bodies, expiry tracking, proactive
// refresh, refresh token rotation, reactive 401-retry, on-disk persistence,
// errors, and config.

using System.Net;
using System.Text;
using NxRefreshToken;
using Xunit;

namespace NxRefreshToken.Tests;

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/// <summary>Serves queued responses in order; records each request (url, method, body).</summary>
internal sealed class FakeHandler : HttpMessageHandler
{
    private readonly Queue<HttpResponseMessage> _responses;
    public List<(string? Url, HttpMethod Method, string Body, string? Authorization)> Calls { get; } = new();

    public FakeHandler(IEnumerable<HttpResponseMessage> responses)
        => _responses = new Queue<HttpResponseMessage>(responses);

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        string body = request.Content is null
            ? ""
            : await request.Content.ReadAsStringAsync(cancellationToken);
        string? auth = request.Headers.TryGetValues("Authorization", out var vals)
            ? string.Join(",", vals)
            : null;
        Calls.Add((request.RequestUri?.ToString(), request.Method, body, auth));
        return _responses.Dequeue();
    }
}

/// <summary>A controllable epoch-seconds time source so expiry logic is deterministic.</summary>
internal sealed class Clock
{
    public double Now { get; private set; }
    public Clock(double now = 1000.0) => Now = now;
    public double Read() => Now;
    public void Advance(double seconds) => Now += seconds;
}

internal static class Http
{
    public static HttpResponseMessage Json(HttpStatusCode status, string body)
        => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
}

internal sealed class Harness
{
    public TokenSession Session { get; }
    public FakeHandler Fake { get; }
    public Clock Clock { get; }

    public Harness(IEnumerable<HttpResponseMessage>? responses = null, string? storePath = null, Clock? clock = null)
    {
        Clock = clock ?? new Clock();
        Fake = new FakeHandler(responses ?? Array.Empty<HttpResponseMessage>());
        Session = new TokenSession(new HttpClient(Fake), "https://nxvms.com", storePath, Clock.Read);
    }

    public IReadOnlyList<(string? Url, HttpMethod Method, string Body, string? Authorization)> Posts
        => Fake.Calls.Where(c => c.Method == HttpMethod.Post).ToList();

    public IReadOnlyList<(string? Url, HttpMethod Method, string Body, string? Authorization)> Gets
        => Fake.Calls.Where(c => c.Method == HttpMethod.Get).ToList();
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

public class RequestBodyTests
{
    [Fact]
    public void PasswordBody_HasGrantAndClientId_OmitsMfaByDefault()
    {
        var body = TokenSession.BuildPasswordBody("me@x.com", "pw");
        Assert.Equal("password", body["grant_type"]);
        Assert.Equal("token", body["response_type"]);
        Assert.Equal("3rdParty", body["client_id"]);
        Assert.Equal("me@x.com", body["username"]);
        Assert.False(body.ContainsKey("mfaCode"));
    }

    [Fact]
    public void RefreshBody_IsExact()
    {
        var body = TokenSession.BuildRefreshBody("r1");
        Assert.Equal("refresh_token", body["grant_type"]);
        Assert.Equal("token", body["response_type"]);
        Assert.Equal("3rdParty", body["client_id"]);
        Assert.Equal("r1", body["refresh_token"]);
        Assert.Equal(4, body.Count);
    }
}

// ---------------------------------------------------------------------------
// LoginAsync() / RefreshAsync() basics
// ---------------------------------------------------------------------------

public class LoginRefreshTests
{
    [Fact]
    public async Task Login_SetsTokensAndExpiry()
    {
        var h = new Harness(new[]
        {
            Http.Json(HttpStatusCode.OK,
                "{\"access_token\":\"a1\",\"refresh_token\":\"r1\",\"expires_in\":3600}"),
        });
        await h.Session.LoginAsync("me@x.com", "pw");
        Assert.Equal("a1", h.Session.AccessToken);
        Assert.Equal("r1", h.Session.RefreshToken);
        Assert.Equal(h.Clock.Now + 3600, h.Session.ExpiresAt);
        Assert.Contains("\"grant_type\":\"password\"", h.Posts[0].Body);
    }

    [Fact]
    public async Task Refresh_SendsNoPassword()
    {
        var h = new Harness(new[] { Http.Json(HttpStatusCode.OK, "{\"access_token\":\"a2\"}") });
        h.Session.RefreshToken = "r1";
        await h.Session.RefreshAsync();
        Assert.Contains("\"grant_type\":\"refresh_token\"", h.Posts[0].Body);
        Assert.DoesNotContain("password", h.Posts[0].Body);
    }

    [Fact]
    public async Task Refresh_WithoutToken_Throws()
    {
        var h = new Harness();
        await Assert.ThrowsAsync<ApiException>(() => h.Session.RefreshAsync());
    }
}

// ---------------------------------------------------------------------------
// Rotation: a new refresh token in the response must replace the old one
// ---------------------------------------------------------------------------

public class RotationTests
{
    [Fact]
    public async Task Refresh_AdoptsRotatedToken()
    {
        var h = new Harness(new[]
        {
            Http.Json(HttpStatusCode.OK, "{\"access_token\":\"a2\",\"refresh_token\":\"r2\"}"),
        });
        h.Session.RefreshToken = "r1";
        await h.Session.RefreshAsync();
        Assert.Equal("r2", h.Session.RefreshToken); // adopted the rotated token
    }

    [Fact]
    public async Task Refresh_KeepsOldToken_WhenNoneReturned()
    {
        var h = new Harness(new[] { Http.Json(HttpStatusCode.OK, "{\"access_token\":\"a2\"}") });
        h.Session.RefreshToken = "r1";
        await h.Session.RefreshAsync();
        Assert.Equal("r1", h.Session.RefreshToken); // unchanged when server omits it
    }
}

// ---------------------------------------------------------------------------
// Expiry + proactive EnsureValidAsync()
// ---------------------------------------------------------------------------

public class ExpiryTests
{
    [Fact]
    public void IsExpiring_RespectsMargin()
    {
        var h = new Harness();
        h.Session.AccessToken = "a1";
        h.Session.ExpiresAt = h.Clock.Now + 3600;
        Assert.False(h.Session.IsExpiring());
        h.Clock.Advance(3600 - 10); // 10s left, inside the 60s margin
        Assert.True(h.Session.IsExpiring());
    }

    [Fact]
    public async Task EnsureValid_RefreshesOnlyWhenNeeded()
    {
        // First login (fresh token, far from expiry), then EnsureValid should NOT
        // refresh. After we advance the clock, it SHOULD refresh.
        var h = new Harness(new[]
        {
            Http.Json(HttpStatusCode.OK,
                "{\"access_token\":\"a1\",\"refresh_token\":\"r1\",\"expires_in\":3600}"),
            Http.Json(HttpStatusCode.OK,
                "{\"access_token\":\"a2\",\"refresh_token\":\"r2\",\"expires_in\":3600}"),
        });
        await h.Session.LoginAsync("me@x.com", "pw");
        await h.Session.EnsureValidAsync();
        Assert.Equal("a1", h.Session.AccessToken); // no refresh happened
        Assert.Single(h.Posts);

        h.Clock.Advance(3600); // now expired
        await h.Session.EnsureValidAsync();
        Assert.Equal("a2", h.Session.AccessToken); // proactive refresh happened
        Assert.Equal(2, h.Posts.Count);
    }
}

// ---------------------------------------------------------------------------
// Reactive 401 -> refresh -> retry
// ---------------------------------------------------------------------------

public class ReactiveRetryTests
{
    [Fact]
    public async Task AuthorizedGet_RetriesAfter401()
    {
        var h = new Harness(new[]
        {
            Http.Json(HttpStatusCode.Unauthorized, "expired"),                 // first GET
            Http.Json(HttpStatusCode.OK, "{\"access_token\":\"a2\",\"refresh_token\":\"r2\"}"), // reactive refresh POST
            Http.Json(HttpStatusCode.OK, "{\"ok\":true}"),                     // retried GET
        });
        h.Session.AccessToken = "a1";
        h.Session.RefreshToken = "r1";
        h.Session.ExpiresAt = h.Clock.Now + 3600; // not expiring, so the 401 is a surprise

        HttpResponseMessage resp = await h.Session.AuthorizedGetAsync("/cdb/systems");

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.Single(h.Posts);                                   // one reactive refresh
        Assert.Equal("Bearer a2", h.Gets[1].Authorization);       // retried with the new token
    }
}

// ---------------------------------------------------------------------------
// Persistence across "runs"
// ---------------------------------------------------------------------------

public class PersistenceTests
{
    [Fact]
    public async Task Session_PersistsAndReloads()
    {
        string store = Path.GetTempFileName();
        try
        {
            // Run 1: log in, which saves the refresh token to disk.
            var h1 = new Harness(
                new[]
                {
                    Http.Json(HttpStatusCode.OK,
                        "{\"access_token\":\"a1\",\"refresh_token\":\"r1\",\"expires_in\":3600}"),
                },
                storePath: store);
            await h1.Session.LoginAsync("me@x.com", "pw");

            // Run 2: a brand-new session with the same store loads the refresh
            // token, so it can refresh without a password.
            var h2 = new Harness(
                new[] { Http.Json(HttpStatusCode.OK, "{\"access_token\":\"a2\",\"refresh_token\":\"r2\"}") },
                storePath: store);
            Assert.Equal("r1", h2.Session.RefreshToken); // loaded from disk
            await h2.Session.RefreshAsync();
            Assert.Equal("a2", h2.Session.AccessToken);
            Assert.DoesNotContain("password", h2.Posts[0].Body);
        }
        finally { File.Delete(store); }
    }
}

// ---------------------------------------------------------------------------
// Errors + config
// ---------------------------------------------------------------------------

public class ErrorAndConfigTests
{
    [Fact]
    public async Task Login_BadCredentials_ThrowsAuthException()
    {
        var h = new Harness(new[] { Http.Json(HttpStatusCode.Unauthorized, "no") });
        await Assert.ThrowsAsync<AuthException>(() => h.Session.LoginAsync("u", "p"));
    }

    [Fact]
    public void Config_ReadsRefreshTokenEnvVar()
    {
        string? saved = Environment.GetEnvironmentVariable("NX_CLOUD_REFRESH_TOKEN");
        Environment.SetEnvironmentVariable("NX_CLOUD_REFRESH_TOKEN", "env-rt");
        try
        {
            var cfg = Config.Resolve(new CliArgs(), new Dictionary<string, string>());
            Assert.Equal("env-rt", cfg.RefreshToken);
        }
        finally
        {
            Environment.SetEnvironmentVariable("NX_CLOUD_REFRESH_TOKEN", saved);
        }
    }
}

// ---------------------------------------------------------------------------
// Token response parsing + .env reader + arg parser
// ---------------------------------------------------------------------------

public class TokenResponseTests
{
    [Fact]
    public void Parse_ReadsAccessRefreshAndExpiry()
    {
        var r = TokenResponse.Parse("{\"access_token\":\"nxcdb-abc\",\"refresh_token\":\"r1\",\"expires_in\":3600}");
        Assert.Equal("nxcdb-abc", r.AccessToken);
        Assert.Equal("r1", r.RefreshToken);
        Assert.Equal(3600, r.ExpiresInSeconds);
    }

    [Fact]
    public void Parse_MissingAccessToken_Throws()
        => Assert.Throws<ApiException>(() => TokenResponse.Parse("{\"nope\":true}"));

    [Fact]
    public void Parse_InvalidJson_Throws()
        => Assert.Throws<ApiException>(() => TokenResponse.Parse("not json"));
}

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

public class ConfigParseTests
{
    [Fact]
    public void ParsesValueAndBooleanFlags_BothForms()
    {
        var a = Config.ParseArgs(new[]
        {
            "--host", "https://h", "--refresh-token=r1", "--store", "s.json",
            "--force-refresh", "--insecure", "--debug",
        });
        Assert.Equal("https://h", a.Host);
        Assert.Equal("r1", a.RefreshToken);
        Assert.Equal("s.json", a.Store);
        Assert.True(a.ForceRefresh);
        Assert.True(a.Insecure);
        Assert.True(a.Debug);
    }

    [Fact]
    public void UnknownArgThrows()
        => Assert.Throws<ArgumentException>(() => Config.ParseArgs(new[] { "--nope" }));

    [Fact]
    public void ResolveCliBeatsEnvFile()
    {
        var args = new CliArgs { Host = "https://from-cli" };
        var cfg = Config.Resolve(args, new Dictionary<string, string> { ["NX_CLOUD_HOST"] = "https://from-file" });
        Assert.Equal("https://from-cli", cfg.Host);
    }
}
