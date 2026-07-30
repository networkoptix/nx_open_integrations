// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the rest-list-cameras-cloud-user sample. No account, no
// network: the HTTP layer is a fake handler that records each request and
// returns scripted responses, so we can prove the 307 + bearer-reattach path.

using System.Net;
using System.Text;
using NxListCamerasCloud;
using Xunit;

namespace NxListCamerasCloud.Tests;

internal sealed record Call(string Method, string Url, string? Auth, string Body);

/// <summary>Records every request; returns a scripted response per hop index.</summary>
internal sealed class RecordingHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, int, HttpResponseMessage> _responder;
    private int _hop;
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
        return _responder(request, _hop++);
    }
}

internal static class Responses
{
    public static HttpResponseMessage Ok(string json)
        => new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    public static HttpResponseMessage Status(HttpStatusCode code, string body = "")
        => new(code) { Content = new StringContent(body) };

    public static HttpResponseMessage Redirect(string location)
    {
        var r = new HttpResponseMessage(HttpStatusCode.TemporaryRedirect);
        r.Headers.Location = new Uri(location);
        return r;
    }
}

public class ParsingTests
{
    [Fact]
    public void ExtractAccessToken_Valid()
        => Assert.Equal("nxcdb-x", NxCloudSiteClient.ExtractAccessToken("{\"access_token\":\"nxcdb-x\"}"));

    [Fact]
    public void ExtractAccessToken_MissingThrows()
        => Assert.Throws<ApiException>(() => NxCloudSiteClient.ExtractAccessToken("{\"x\":1}"));

    [Fact]
    public void NormalizeCameras_BareArray()
    {
        var cams = NxCloudSiteClient.NormalizeCameras(
            "[{\"id\":\"c1\",\"name\":\"Lobby\",\"status\":\"Online\",\"model\":\"Axis\"}]");
        Assert.Single(cams);
        Assert.Equal("Lobby", cams[0].Name);
        Assert.Equal("c1", cams[0].Id);
    }

    [Fact]
    public void NormalizeCameras_ReplyEnvelope()
    {
        var cams = NxCloudSiteClient.NormalizeCameras("{\"reply\":[{\"id\":\"c2\",\"name\":\"Dock\"}]}");
        Assert.Single(cams);
        Assert.Equal("Dock", cams[0].Name);
        Assert.Equal("", cams[0].Model); // missing field -> empty
    }

    [Fact]
    public void NormalizeCameras_JunkReturnsEmpty()
        => Assert.Empty(NxCloudSiteClient.NormalizeCameras("{\"nope\":true}"));

    [Fact]
    public void FormatCamerasTable_EmptyAndRows()
    {
        Assert.Contains("No cameras", NxCloudSiteClient.FormatCamerasTable(Array.Empty<Camera>()));
        string table = NxCloudSiteClient.FormatCamerasTable(new[] { new Camera("Lobby", "Online", "Axis", "c1") });
        Assert.Contains("NAME", table);
        Assert.Contains("Lobby", table);
    }
}

public class ConfigTests
{
    [Fact]
    public void ParsesFlags_BothForms_AndBoolean()
    {
        var a = Config.ParseArgs(new[] { "--cloud-host", "https://h", "--site-id=SITE-1", "--insecure" });
        Assert.Equal("https://h", a.CloudHost);
        Assert.Equal("SITE-1", a.SiteId);
        Assert.True(a.Insecure);
    }

    [Fact]
    public void UnknownArgThrows()
        => Assert.Throws<ArgumentException>(() => Config.ParseArgs(new[] { "--nope" }));

    [Fact]
    public void ResolveCliBeatsEnvFile()
    {
        var cfg = Config.Resolve(
            new CliArgs { SiteId = "from-cli" },
            new Dictionary<string, string> { ["NX_CLOUD_SITE_ID"] = "from-file" });
        Assert.Equal("from-cli", cfg.SiteId);
    }
}

public class LoginTests
{
    private const string Site = "11111111-2222-3333-4444-555555555555";

    [Fact]
    public async Task PostsScopedTokenRequest()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("{\"access_token\":\"nxcdb-tok\"}"));
        var client = new NxCloudSiteClient(new HttpClient(handler), "https://nxvms.com/", Site);

        string token = await client.LoginAsync("me@x.com", "pw");

        Assert.Equal("nxcdb-tok", token);
        Assert.Equal("https://nxvms.com/cdb/oauth2/token", handler.Calls[0].Url);
        Assert.Contains($"cloudSystemId={Site}", handler.Calls[0].Body);
        Assert.Contains("\"client_id\":\"3rdParty\"", handler.Calls[0].Body);
    }

    [Fact]
    public async Task Rejected401ThrowsAuthException()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.Unauthorized, "no"));
        var client = new NxCloudSiteClient(new HttpClient(handler), "https://nxvms.com", Site);
        await Assert.ThrowsAsync<AuthException>(() => client.LoginAsync("u", "p"));
    }
}

public class ListCamerasTests
{
    private const string Site = "11111111-2222-3333-4444-555555555555";

    [Fact]
    public async Task FollowsRelay307AndReattachesBearer()
    {
        const string redirectedTo = "https://node-7.relay.vmsproxy.com/rest/v4/devices";
        var handler = new RecordingHandler((_, hop) => hop == 0
            ? Responses.Redirect(redirectedTo)
            : Responses.Ok("[{\"id\":\"c1\",\"name\":\"Lobby\",\"status\":\"Online\",\"model\":\"Axis\"}]"));
        var client = new NxCloudSiteClient(new HttpClient(handler), "https://nxvms.com", Site);
        client.UseToken("nxcdb-t");

        var cams = await client.ListCamerasAsync();

        Assert.Single(cams);
        Assert.Equal("Lobby", cams[0].Name);
        Assert.Equal(2, handler.Calls.Count);
        Assert.Equal($"https://{Site}.relay.vmsproxy.com/rest/v4/devices", handler.Calls[0].Url);
        Assert.Equal(redirectedTo, handler.Calls[1].Url);
        // The bearer is present on BOTH hops — the whole point of the manual follow.
        Assert.Equal("Bearer nxcdb-t", handler.Calls[0].Auth);
        Assert.Equal("Bearer nxcdb-t", handler.Calls[1].Auth);
    }

    [Fact]
    public async Task WithoutTokenThrowsApiException()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("[]"));
        var client = new NxCloudSiteClient(new HttpClient(handler), "https://nxvms.com", Site);
        await Assert.ThrowsAsync<ApiException>(() => client.ListCamerasAsync());
    }

    [Fact]
    public async Task Site403ThrowsAuthException()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.Forbidden, "denied"));
        var client = new NxCloudSiteClient(new HttpClient(handler), "https://nxvms.com", Site);
        client.UseToken("t");
        await Assert.ThrowsAsync<AuthException>(() => client.ListCamerasAsync());
    }
}

public class LogoutTests
{
    private const string Site = "11111111-2222-3333-4444-555555555555";

    [Fact]
    public async Task DeletesTokenOnCloudAndClearsIt()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.NoContent));
        var client = new NxCloudSiteClient(new HttpClient(handler), "https://nxvms.com", Site);
        client.UseToken("nxcdb-t");

        await client.LogoutAsync();

        Assert.Equal("DELETE", handler.Calls[0].Method);
        Assert.Equal("https://nxvms.com/cdb/oauth2/token/nxcdb-t", handler.Calls[0].Url);
        Assert.Equal("Bearer nxcdb-t", handler.Calls[0].Auth);
        Assert.Null(client.Token);
    }
}
