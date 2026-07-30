// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the rest-list-cameras sample. No account, no network: the
// HTTP layer is a fake handler that records each request and returns scripted
// responses, so we can prove the direct login/list/logout flow.

using System.Net;
using System.Text;
using NxListCameras;
using Xunit;

namespace NxListCameras.Tests;

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
        string body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
        Calls.Add(new Call(
            request.Method.Method, request.RequestUri!.ToString(),
            request.Headers.Authorization?.ToString(), body));
        return _responder(request, _index++);
    }
}

internal static class Responses
{
    public static HttpResponseMessage Ok(string json)
        => new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    public static HttpResponseMessage Status(HttpStatusCode code, string body = "")
        => new(code) { Content = new StringContent(body) };
}

public class ParsingTests
{
    [Fact]
    public void ExtractToken_Valid()
        => Assert.Equal("abc123", NxServerClient.ExtractToken("{\"token\":\"abc123\"}"));

    [Fact]
    public void ExtractToken_MissingThrows()
        => Assert.Throws<ApiException>(() => NxServerClient.ExtractToken("{\"nope\":1}"));

    [Fact]
    public void NormalizeCameras_BareArray()
    {
        var cams = NxServerClient.NormalizeCameras(
            "[{\"id\":\"c1\",\"name\":\"Lobby\",\"status\":\"Online\",\"model\":\"Axis\"}]");
        Assert.Single(cams);
        Assert.Equal("Lobby", cams[0].Name);
        Assert.Equal("c1", cams[0].Id);
    }

    [Fact]
    public void NormalizeCameras_ReplyEnvelope()
    {
        var cams = NxServerClient.NormalizeCameras("{\"reply\":[{\"id\":\"c2\",\"name\":\"Dock\"}]}");
        Assert.Single(cams);
        Assert.Equal("Dock", cams[0].Name);
        Assert.Equal("", cams[0].Model); // missing field -> empty
    }

    [Fact]
    public void NormalizeCameras_JunkReturnsEmpty()
        => Assert.Empty(NxServerClient.NormalizeCameras("{\"nope\":true}"));

    [Fact]
    public void FormatCamerasTable_EmptyAndRows()
    {
        Assert.Contains("No cameras", NxServerClient.FormatCamerasTable(Array.Empty<Camera>()));
        string table = NxServerClient.FormatCamerasTable(new[] { new Camera("Lobby", "Online", "Axis", "c1") });
        Assert.Contains("NAME", table);
        Assert.Contains("Lobby", table);
    }
}

public class ConfigTests
{
    [Fact]
    public void ParsesFlags_BothForms_AndBoolean()
    {
        var a = Config.ParseArgs(new[] { "--host", "https://srv:7001", "--user=admin", "--insecure" });
        Assert.Equal("https://srv:7001", a.Host);
        Assert.Equal("admin", a.User);
        Assert.True(a.Insecure);
    }

    [Fact]
    public void UnknownArgThrows()
        => Assert.Throws<ArgumentException>(() => Config.ParseArgs(new[] { "--nope" }));

    [Fact]
    public void ResolveCliBeatsEnvFile()
    {
        var cfg = Config.Resolve(
            new CliArgs { Host = "https://cli:7001" },
            new Dictionary<string, string> { ["NX_SERVER_HOST"] = "https://file:7001" });
        Assert.Equal("https://cli:7001", cfg.Host);
    }
}

public class LoginTests
{
    [Fact]
    public async Task PostsCredentialsAndStoresToken()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("{\"token\":\"abc123\"}"));
        var client = new NxServerClient(new HttpClient(handler), "https://srv:7001/");

        string token = await client.LoginAsync("admin", "pw");

        Assert.Equal("abc123", token);
        Assert.Equal("https://srv:7001/rest/v4/login/sessions", handler.Calls[0].Url);
        Assert.Contains("\"username\":\"admin\"", handler.Calls[0].Body);
        Assert.Contains("\"setCookie\":false", handler.Calls[0].Body);
    }

    [Fact]
    public async Task Rejected401ThrowsAuthException()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.Unauthorized, "bad"));
        var client = new NxServerClient(new HttpClient(handler), "https://srv:7001");
        await Assert.ThrowsAsync<AuthException>(() => client.LoginAsync("admin", "pw"));
    }

    [Fact]
    public async Task WithoutTokenInResponseThrowsApiException()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("{\"nope\":1}"));
        var client = new NxServerClient(new HttpClient(handler), "https://srv:7001");
        await Assert.ThrowsAsync<ApiException>(() => client.LoginAsync("admin", "pw"));
    }
}

public class ListCamerasTests
{
    [Fact]
    public async Task GetsDevicesWithBearerToken()
    {
        var handler = new RecordingHandler((_, _) =>
            Responses.Ok("[{\"id\":\"c1\",\"name\":\"Lobby\",\"status\":\"Online\",\"model\":\"Axis\"}]"));
        var client = new NxServerClient(new HttpClient(handler), "https://srv:7001");
        client.UseToken("abc123");

        var cams = await client.ListCamerasAsync();

        Assert.Single(cams);
        Assert.Equal("Lobby", cams[0].Name);
        Assert.Equal("https://srv:7001/rest/v4/devices", handler.Calls[0].Url);
        Assert.Equal("Bearer abc123", handler.Calls[0].Auth);
    }

    [Fact]
    public async Task UnwrapsReplyEnvelope()
    {
        var handler = new RecordingHandler((_, _) =>
            Responses.Ok("{\"reply\":[{\"id\":\"c1\",\"name\":\"Lobby\"}]}"));
        var client = new NxServerClient(new HttpClient(handler), "https://srv:7001");
        client.UseToken("abc123");

        var cams = await client.ListCamerasAsync();

        Assert.Single(cams);
        Assert.Equal("Lobby", cams[0].Name);
    }

    [Fact]
    public async Task WithoutTokenThrowsApiException()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("[]"));
        var client = new NxServerClient(new HttpClient(handler), "https://srv:7001");
        await Assert.ThrowsAsync<ApiException>(() => client.ListCamerasAsync());
    }

    [Fact]
    public async Task Site401ThrowsAuthException()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.Unauthorized, "no"));
        var client = new NxServerClient(new HttpClient(handler), "https://srv:7001");
        client.UseToken("abc123");
        await Assert.ThrowsAsync<AuthException>(() => client.ListCamerasAsync());
    }
}

public class LogoutTests
{
    [Fact]
    public async Task DeletesSessionAndClearsToken()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.OK));
        var client = new NxServerClient(new HttpClient(handler), "https://srv:7001");
        client.UseToken("abc123");

        await client.LogoutAsync();

        Assert.Single(handler.Calls);
        Assert.Equal("DELETE", handler.Calls[0].Method);
        Assert.Equal("https://srv:7001/rest/v4/login/sessions/abc123", handler.Calls[0].Url);
        Assert.Equal("Bearer abc123", handler.Calls[0].Auth);
        Assert.Null(client.Token);
    }

    [Fact]
    public async Task WithoutTokenIsNoop()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.OK));
        var client = new NxServerClient(new HttpClient(handler), "https://srv:7001");

        await client.LogoutAsync(); // should not raise or call delete

        Assert.Empty(handler.Calls);
    }
}
