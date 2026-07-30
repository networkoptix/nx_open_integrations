// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the cdb-get-token sample. No account, no network: the HTTP
// layer is replaced with a fake HttpMessageHandler, and the pure helpers
// (BuildTokenBody, TokenResult.Parse, DotEnv, Config) are tested directly.

using System.Net;
using System.Text;
using NxGetToken;
using Xunit;

namespace NxGetToken.Tests;

/// <summary>A fake transport: records the request and returns a canned response.</summary>
internal sealed class FakeHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, string, HttpResponseMessage> _responder;
    public string? LastUrl { get; private set; }
    public string LastBody { get; private set; } = "";

    public FakeHandler(Func<HttpRequestMessage, string, HttpResponseMessage> responder)
        => _responder = responder;

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        LastUrl = request.RequestUri?.ToString();
        LastBody = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
        return _responder(request, LastBody);
    }
}

public class BuildTokenBodyTests
{
    [Fact]
    public void IncludesGrantAndClientId_OmitsOptionalsByDefault()
    {
        var body = NxCloudTokenClient.BuildTokenBody("me@x.com", "pw");
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
        var body = NxCloudTokenClient.BuildTokenBody("u", "p", mfaCode: "123456", cloudSiteId: "SITE-1");
        Assert.Equal("123456", body["mfaCode"]);
        Assert.Equal("cloudSystemId=SITE-1", body["scope"]);
    }
}

public class TokenResultTests
{
    [Fact]
    public void ParsesAccessTokenAndExpiry()
    {
        var r = TokenResult.Parse("{\"access_token\":\"nxcdb-abc\",\"expires_in\":3600}");
        Assert.Equal("nxcdb-abc", r.AccessToken);
        Assert.Equal(3600, r.ExpiresInSeconds);
    }

    [Fact]
    public void MissingAccessTokenThrowsApiException()
        => Assert.Throws<ApiException>(() => TokenResult.Parse("{\"nope\":true}"));

    [Fact]
    public void InvalidJsonThrowsApiException()
        => Assert.Throws<ApiException>(() => TokenResult.Parse("not json"));
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

public class ConfigTests
{
    [Fact]
    public void ParsesValueAndBooleanFlags_BothForms()
    {
        var a = Config.ParseArgs(new[] { "--host", "https://h", "--user=me@x.com", "--insecure", "--token-only" });
        Assert.Equal("https://h", a.Host);
        Assert.Equal("me@x.com", a.User);
        Assert.True(a.Insecure);
        Assert.True(a.TokenOnly);
    }

    [Fact]
    public void UnknownArgThrows()
        => Assert.Throws<ArgumentException>(() => Config.ParseArgs(new[] { "--nope" }));

    [Fact]
    public void ResolveUsesEnvFileWhenNoCliOrEnvVar()
    {
        // Clear the real env var so the test isn't affected by the shell.
        string? saved = Environment.GetEnvironmentVariable("NX_CLOUD_HOST");
        Environment.SetEnvironmentVariable("NX_CLOUD_HOST", null);
        try
        {
            var cfg = Config.Resolve(new CliArgs(), new Dictionary<string, string> { ["NX_CLOUD_HOST"] = "https://from-file" });
            Assert.Equal("https://from-file", cfg.Host);
        }
        finally
        {
            Environment.SetEnvironmentVariable("NX_CLOUD_HOST", saved);
        }
    }

    [Fact]
    public void ResolveCliBeatsEnvFile()
    {
        var args = new CliArgs { Host = "https://from-cli" };
        var cfg = Config.Resolve(args, new Dictionary<string, string> { ["NX_CLOUD_HOST"] = "https://from-file" });
        Assert.Equal("https://from-cli", cfg.Host);
    }
}

public class GetTokenAsyncTests
{
    private static HttpResponseMessage Json(HttpStatusCode status, string body)
        => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    [Fact]
    public async Task PostsToTokenEndpointAndReturnsToken()
    {
        var fake = new FakeHandler((_, _) => Json(HttpStatusCode.OK, "{\"access_token\":\"nxcdb-t\"}"));
        var client = new NxCloudTokenClient(new HttpClient(fake));

        var result = await client.GetTokenAsync("https://nxvms.com/", "me@x.com", "pw", cloudSiteId: "SITE-9");

        Assert.Equal("nxcdb-t", result.AccessToken);
        Assert.Equal("https://nxvms.com/cdb/oauth2/token", fake.LastUrl);
        Assert.Contains("\"client_id\":\"3rdParty\"", fake.LastBody);
        Assert.Contains("cloudSystemId=SITE-9", fake.LastBody);
    }

    [Fact]
    public async Task Rejected401ThrowsAuthException()
    {
        var fake = new FakeHandler((_, _) => Json(HttpStatusCode.Unauthorized, "no"));
        var client = new NxCloudTokenClient(new HttpClient(fake));
        await Assert.ThrowsAsync<AuthException>(
            () => client.GetTokenAsync("https://nxvms.com", "u", "p"));
    }

    [Fact]
    public async Task ServerErrorThrowsApiException()
    {
        var fake = new FakeHandler((_, _) => Json(HttpStatusCode.InternalServerError, "boom"));
        var client = new NxCloudTokenClient(new HttpClient(fake));
        await Assert.ThrowsAsync<ApiException>(
            () => client.GetTokenAsync("https://nxvms.com", "u", "p"));
    }
}
