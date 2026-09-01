// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the rest-get-token sample. No account, no network: the HTTP
// layer is a fake handler that records each request and returns scripted
// responses, so we can prove the whole four-step session lifecycle.

using System.Net;
using System.Text;
using NxGetToken;
using Xunit;

namespace NxGetToken.Tests;

internal sealed record Call(string Method, string Url, string? Auth, string Body);

/// <summary>Records every request; returns a scripted response per call index.</summary>
internal sealed class RecordingHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, int, HttpResponseMessage> _responder;
    private int _index;
    public List<Call> Calls { get; } = new();

    public RecordingHandler(Func<HttpRequestMessage, int, HttpResponseMessage> responder)
        => _responder = responder;

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        string body = request.Content is null
            ? ""
            : await request.Content.ReadAsStringAsync(cancellationToken);
        Calls.Add(new Call(
            request.Method.Method, request.RequestUri!.ToString(),
            request.Headers.Authorization?.ToString(), body));
        return _responder(request, _index++);
    }
}

/// <summary>A handler that always throws, standing in for an unreachable server.</summary>
internal sealed class ThrowingHandler : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
        => throw new HttpRequestException("boom");
}

internal static class Responses
{
    public const string SessionJson =
        "{\"id\":\"{aaaa-bbbb}\",\"username\":\"admin\",\"token\":\"abc123\","
        + "\"ageS\":0,\"expiresInS\":600}";

    public static HttpResponseMessage Ok(string json)
        => new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    public static HttpResponseMessage Status(HttpStatusCode code, string body = "")
        => new(code) { Content = new StringContent(body) };
}

// ---------------------------------------------------------------------------
// Parsing + formatting (pure functions)
// ---------------------------------------------------------------------------

public class ParsingTests
{
    [Fact]
    public void ParseSession_ReadsAllFiveFields()
    {
        LoginSession s = NxLoginClient.ParseSession(Responses.SessionJson);
        Assert.Equal("abc123", s.Token);
        Assert.Equal("{aaaa-bbbb}", s.Id);
        Assert.Equal("admin", s.Username);
        Assert.Equal(0L, s.AgeS);
        Assert.Equal(600L, s.ExpiresInS);
    }

    [Fact]
    public void ParseSession_MissingTokenThrows()
        => Assert.Throws<ApiException>(
            () => NxLoginClient.ParseSession("{\"id\":\"x\",\"username\":\"admin\"}"));

    [Fact]
    public void ParseSession_InvalidJsonThrows()
        => Assert.Throws<ApiException>(() => NxLoginClient.ParseSession("not json"));

    [Fact]
    public void ParseSession_ToleratesMissingOptionalFields()
    {
        LoginSession s = NxLoginClient.ParseSession("{\"token\":\"t\"}");
        Assert.Equal("t", s.Token);
        Assert.Equal("", s.Id);
        Assert.Null(s.AgeS);
        Assert.Null(s.ExpiresInS);
    }

    [Fact]
    public void FormatSession_ShowsLifetimeFields()
    {
        string text = NxLoginClient.FormatSession(
            NxLoginClient.ParseSession(Responses.SessionJson));
        Assert.Contains("abc123", text);
        Assert.Contains("{aaaa-bbbb}", text);
        Assert.Contains("600 seconds", text);
    }

    [Fact]
    public void FormatSession_OmitsAbsentLifetimeFields()
    {
        string text = NxLoginClient.FormatSession(NxLoginClient.ParseSession("{\"token\":\"t\"}"));
        Assert.DoesNotContain("expires in", text);
        Assert.DoesNotContain("age", text);
    }
}

// ---------------------------------------------------------------------------
// Step 1 — LoginAsync
// ---------------------------------------------------------------------------

public class LoginTests
{
    [Fact]
    public async Task Login_PostsCredentialsToV4AndStoresToken()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok(Responses.SessionJson));
        using var http = new HttpClient(handler);
        var client = new NxLoginClient(http, "https://srv:7001");

        LoginSession session = await client.LoginAsync("admin", "pw");

        Assert.Equal("abc123", client.Token);
        Assert.Equal(600L, session.ExpiresInS);
        Call call = Assert.Single(handler.Calls);
        Assert.Equal("POST", call.Method);
        Assert.Equal("https://srv:7001/rest/v4/login/sessions", call.Url);
        Assert.Contains("\"username\":\"admin\"", call.Body);
        Assert.Contains("\"setCookie\":false", call.Body);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden)]
    public async Task Login_RejectedThrowsAuthException(HttpStatusCode code)
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(code, "bad creds"));
        using var http = new HttpClient(handler);
        var client = new NxLoginClient(http, "https://srv:7001");

        await Assert.ThrowsAsync<AuthException>(() => client.LoginAsync("admin", "wrong"));
    }

    [Fact]
    public async Task Login_ServerErrorThrowsApiException()
    {
        var handler = new RecordingHandler(
            (_, _) => Responses.Status(HttpStatusCode.InternalServerError, "oops"));
        using var http = new HttpClient(handler);
        var client = new NxLoginClient(http, "https://srv:7001");

        await Assert.ThrowsAsync<ApiException>(() => client.LoginAsync("admin", "pw"));
    }

    [Fact]
    public async Task Login_UnreachableServerThrowsApiException()
    {
        using var http = new HttpClient(new ThrowingHandler());
        var client = new NxLoginClient(http, "https://srv:7001");

        await Assert.ThrowsAsync<ApiException>(() => client.LoginAsync("admin", "pw"));
    }

    [Fact]
    public async Task Host_TrailingSlashesAreTrimmed()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok(Responses.SessionJson));
        using var http = new HttpClient(handler);
        var client = new NxLoginClient(http, "https://srv:7001///");

        await client.LoginAsync("admin", "pw");

        // Without trimming this would be ".../7001///rest/v4/login/sessions".
        Assert.Equal("https://srv:7001/rest/v4/login/sessions", Assert.Single(handler.Calls).Url);
    }
}

// ---------------------------------------------------------------------------
// Step 2 — GetCurrentSessionAsync
// ---------------------------------------------------------------------------

public class CurrentSessionTests
{
    [Fact]
    public async Task CurrentSession_UsesBearerHeaderOnCurrentPath()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok(Responses.SessionJson));
        using var http = new HttpClient(handler);
        var client = new NxLoginClient(http, "https://srv:7001");
        client.UseToken("abc123");

        LoginSession session = await client.GetCurrentSessionAsync();

        Assert.Equal("admin", session.Username);
        Call call = Assert.Single(handler.Calls);
        Assert.Equal("GET", call.Method);
        Assert.Equal("https://srv:7001/rest/v4/login/sessions/current", call.Url);
        // The path uses the sentinel; the header carries the token.
        Assert.Equal("Bearer abc123", call.Auth);
        Assert.DoesNotContain("abc123", call.Url);
    }

    [Fact]
    public async Task CurrentSession_WithoutLoginThrows()
    {
        using var http = new HttpClient(new RecordingHandler((_, _) => Responses.Ok("{}")));
        var client = new NxLoginClient(http, "https://srv:7001");

        await Assert.ThrowsAsync<ApiException>(() => client.GetCurrentSessionAsync());
    }

    [Fact]
    public async Task CurrentSession_RejectedThrowsAuthException()
    {
        var handler = new RecordingHandler(
            (_, _) => Responses.Status(HttpStatusCode.Unauthorized, "expired"));
        using var http = new HttpClient(handler);
        var client = new NxLoginClient(http, "https://srv:7001");
        client.UseToken("abc123");

        await Assert.ThrowsAsync<AuthException>(() => client.GetCurrentSessionAsync());
    }
}

// ---------------------------------------------------------------------------
// Step 4 — TokenStillWorksAsync must NOT throw: a 401 here is the good outcome
// ---------------------------------------------------------------------------

public class TokenProbeTests
{
    [Fact]
    public async Task Probe_ReportsLiveWhileSessionIsLive()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok(Responses.SessionJson));
        using var http = new HttpClient(handler);
        var client = new NxLoginClient(http, "https://srv:7001");

        TokenProbe probe = await client.TokenStillWorksAsync("abc123");

        Assert.True(probe.IsLive);
        Assert.Equal(200, probe.Status);
    }

    [Fact]
    public async Task Probe_ReportsDeadAfterLogoutWithoutThrowing()
    {
        var handler = new RecordingHandler(
            (_, _) => Responses.Status(HttpStatusCode.Unauthorized, "unauthorized"));
        using var http = new HttpClient(handler);
        var client = new NxLoginClient(http, "https://srv:7001");

        // The whole point: a rejection here is the expected answer, not an error.
        TokenProbe probe = await client.TokenStillWorksAsync("abc123");

        Assert.False(probe.IsLive);
        Assert.Equal(401, probe.Status);
    }

    [Fact]
    public async Task Probe_ReportsUnknownWhenServerUnreachable()
    {
        using var http = new HttpClient(new ThrowingHandler());
        var client = new NxLoginClient(http, "https://srv:7001");

        TokenProbe probe = await client.TokenStillWorksAsync("abc123");

        Assert.False(probe.IsLive);
        Assert.Null(probe.Status);
    }

    [Fact]
    public async Task Probe_SendsTheSuppliedTokenNotTheRememberedOne()
    {
        var handler = new RecordingHandler(
            (_, _) => Responses.Status(HttpStatusCode.Unauthorized));
        using var http = new HttpClient(handler);
        var client = new NxLoginClient(http, "https://srv:7001");
        client.UseToken("still-remembered");

        await client.TokenStillWorksAsync("the-spent-one");

        Assert.Equal("Bearer the-spent-one", Assert.Single(handler.Calls).Auth);
    }

    [Fact]
    public async Task Probe_WithoutATokenThrows()
    {
        using var http = new HttpClient(new RecordingHandler((_, _) => Responses.Ok("{}")));
        var client = new NxLoginClient(http, "https://srv:7001");

        await Assert.ThrowsAsync<ApiException>(() => client.TokenStillWorksAsync(""));
    }
}

// ---------------------------------------------------------------------------
// Step 3 — LogoutAsync
// ---------------------------------------------------------------------------

public class LogoutTests
{
    [Fact]
    public async Task Logout_DeletesSessionAndClearsToken()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("{}"));
        using var http = new HttpClient(handler);
        var client = new NxLoginClient(http, "https://srv:7001");
        client.UseToken("abc123");

        Assert.True(await client.LogoutAsync());

        Call call = Assert.Single(handler.Calls);
        Assert.Equal("DELETE", call.Method);
        Assert.Equal("https://srv:7001/rest/v4/login/sessions/current", call.Url);
        // The path uses the sentinel; the header carries the token.
        Assert.DoesNotContain("abc123", call.Url);
        Assert.Equal("Bearer abc123", call.Auth);
        Assert.Null(client.Token);
    }

    [Fact]
    public async Task Logout_WithoutATokenIsANoOp()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("{}"));
        using var http = new HttpClient(handler);
        var client = new NxLoginClient(http, "https://srv:7001");

        Assert.False(await client.LogoutAsync());
        Assert.Empty(handler.Calls);
    }

    [Fact]
    public async Task Logout_SwallowsNetworkErrorButStillForgetsToken()
    {
        using var http = new HttpClient(new ThrowingHandler());
        var client = new NxLoginClient(http, "https://srv:7001");
        client.UseToken("abc123");

        Assert.False(await client.LogoutAsync()); // reported, not thrown
        Assert.Null(client.Token);
    }

    [Fact]
    public async Task Logout_ReportsFalseWhenServerRefuses()
    {
        var handler = new RecordingHandler(
            (_, _) => Responses.Status(HttpStatusCode.InternalServerError));
        using var http = new HttpClient(handler);
        var client = new NxLoginClient(http, "https://srv:7001");
        client.UseToken("abc123");

        Assert.False(await client.LogoutAsync());
        Assert.Null(client.Token);
    }
}

// ---------------------------------------------------------------------------
// The full four-step sequence
// ---------------------------------------------------------------------------

public class LifecycleTests
{
    [Fact]
    public async Task FourSteps_IssueOnePostTwoGetsAndOneDelete()
    {
        // 0: POST login, 1: GET current (ok), 2: DELETE logout, 3: GET current (401)
        var handler = new RecordingHandler((_, index) => index switch
        {
            0 => Responses.Ok(Responses.SessionJson),
            1 => Responses.Ok(Responses.SessionJson),
            2 => Responses.Ok("{}"),
            _ => Responses.Status(HttpStatusCode.Unauthorized, "gone"),
        });
        using var http = new HttpClient(handler);
        var client = new NxLoginClient(http, "https://srv:7001");

        await client.LoginAsync("admin", "pw");
        await client.GetCurrentSessionAsync();
        string spent = client.Token!;
        Assert.True(await client.LogoutAsync());
        TokenProbe probe = await client.TokenStillWorksAsync(spent);

        Assert.Equal(4, handler.Calls.Count);
        Assert.Equal("POST", handler.Calls[0].Method);
        Assert.Equal("GET", handler.Calls[1].Method);
        Assert.Equal("DELETE", handler.Calls[2].Method);
        Assert.Equal("GET", handler.Calls[3].Method);
        Assert.False(probe.IsLive);
        Assert.Equal(401, probe.Status);
    }
}

// ---------------------------------------------------------------------------
// Config: flags and precedence
// ---------------------------------------------------------------------------

public class ConfigTests
{
    [Fact]
    public void ParseArgs_ReadsAllFlags()
    {
        CliArgs args = Config.ParseArgs(new[]
        {
            "--host", "https://h:7001", "--user", "admin", "--password", "pw",
            "--env-file", "../../.env", "--insecure",
        });

        Assert.Equal("https://h:7001", args.Host);
        Assert.Equal("admin", args.User);
        Assert.Equal("pw", args.Password);
        Assert.Equal("../../.env", args.EnvFile);
        Assert.True(args.Insecure);
    }

    [Fact]
    public void ParseArgs_AcceptsInlineValues()
    {
        CliArgs args = Config.ParseArgs(new[] { "--host=https://h:7001" });
        Assert.Equal("https://h:7001", args.Host);
    }

    [Fact]
    public void ParseArgs_UnknownFlagThrows()
        => Assert.Throws<ArgumentException>(() => Config.ParseArgs(new[] { "--bogus" }));

    [Fact]
    public void ParseArgs_MissingValueThrows()
        => Assert.Throws<ArgumentException>(() => Config.ParseArgs(new[] { "--host" }));

    [Fact]
    public void Resolve_CliFlagBeatsEnvFile()
    {
        var args = new CliArgs { Host = "https://cli:7001" };
        AppConfig config = Config.Resolve(
            args, new Dictionary<string, string> { ["NX_SERVER_HOST"] = "https://file:7001" });
        Assert.Equal("https://cli:7001", config.Host);
    }

    [Fact]
    public void Resolve_FallsBackToEnvFile()
    {
        AppConfig config = Config.Resolve(
            new CliArgs(),
            new Dictionary<string, string> { ["NX_SERVER_USER"] = "fileuser" });
        Assert.Equal("fileuser", config.User);
    }

    [Fact]
    public void DotEnv_MissingFileYieldsEmpty()
        => Assert.Empty(DotEnv.Load("/nonexistent/.env"));

    [Fact]
    public void DotEnv_ParsesKeyValuePairsAndStripsQuotes()
    {
        string path = Path.GetTempFileName();
        try
        {
            File.WriteAllLines(path, new[]
            {
                "# a comment",
                "",
                "NX_SERVER_HOST=https://192.168.1.10:7001",
                "NX_SERVER_USER=\"admin\"",
                "NX_SERVER_PASSWORD='secret'",
            });

            Dictionary<string, string> values = DotEnv.Load(path);

            Assert.Equal("https://192.168.1.10:7001", values["NX_SERVER_HOST"]);
            Assert.Equal("admin", values["NX_SERVER_USER"]);
            Assert.Equal("secret", values["NX_SERVER_PASSWORD"]);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
