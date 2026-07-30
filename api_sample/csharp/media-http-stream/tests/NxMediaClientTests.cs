// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the media-http-stream sample. No network, no account, no
// live camera: the HTTP layer is a fake handler that records each request and
// returns scripted responses. The "video" is a fake byte stream; SaveClipAsync
// writes it to an in-memory MemoryStream (and, in one test, a real temp file),
// so nothing touches a real disk except that one explicit case.

using System.Globalization;
using System.Net;
using System.Text;
using NxMediaHttpStream;
using Xunit;

namespace NxMediaHttpStream.Tests;

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

    /// <summary>A media response whose body is the given raw bytes.</summary>
    public static HttpResponseMessage Body(byte[] bytes)
        => new(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) };
}

public class FormatTests
{
    [Fact]
    public void FormatsMatchesV4SpecEnumExactly()
        => Assert.Equal(
            new[] { "webm", "mpegts", "mpjpeg", "mp4", "mkv", "_3gp", "rtp", "flv", "f4v" },
            NxMediaClient.Formats);

    [Fact]
    public void NormalizeFormatAcceptsEverySpecFormatStripsDotAndCase()
    {
        foreach (string fmt in NxMediaClient.Formats)
        {
            Assert.Equal(fmt, Config.NormalizeFormat(fmt));
            Assert.Equal(fmt, Config.NormalizeFormat("." + fmt));
            Assert.Equal(fmt, Config.NormalizeFormat(fmt.ToUpperInvariant()));
        }
        Assert.Equal(NxMediaClient.DefaultFormat, Config.NormalizeFormat(null));
    }

    [Fact]
    public void NormalizeFormatRejectsUnsupportedContainer()
    {
        Assert.Throws<ApiException>(() => Config.NormalizeFormat("avi"));
        Assert.Throws<ApiException>(() => Config.NormalizeFormat("m3u8")); // HLS not on this endpoint
    }
}

public class PositionAndDurationTests
{
    [Fact]
    public void ParsePositionMsBlankIsLive()
    {
        Assert.Null(Config.ParsePositionMs(""));
        Assert.Null(Config.ParsePositionMs(null));
    }

    [Fact]
    public void ParsePositionMsDigitsAreEpoch()
        => Assert.Equal(1700000000000L, Config.ParsePositionMs("1700000000000"));

    [Fact]
    public void ParsePositionMsIsoParsesToEpoch()
    {
        long expected = DateTimeOffset.Parse(
            "2026-06-15T12:00:00Z", CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal)
            .ToUnixTimeMilliseconds();
        Assert.Equal(expected, Config.ParsePositionMs("2026-06-15T12:00:00Z"));
    }

    [Fact]
    public void ParsePositionMsJunkThrows()
        => Assert.Throws<ApiException>(() => Config.ParsePositionMs("not-a-time"));

    [Fact]
    public void DurationToMsDefaultAndValues()
    {
        Assert.Equal(10000L, Config.DurationToMs(null));
        Assert.Equal(5000L, Config.DurationToMs("5"));
        Assert.Equal(2500L, Config.DurationToMs("2.5"));
    }

    [Fact]
    public void DurationToMsRejectsNonPositive()
    {
        Assert.Throws<ApiException>(() => Config.DurationToMs("0"));
        Assert.Throws<ApiException>(() => Config.DurationToMs("-3"));
        Assert.Throws<ApiException>(() => Config.DurationToMs("abc"));
    }

    [Fact]
    public void DefaultOutNameIsFilesystemSafeAndEndsWithFormat()
    {
        string name = Config.DefaultOutName(
            "cam/01:02", "mp4", DateTimeOffset.Parse("2026-06-15T12:00:00Z", CultureInfo.InvariantCulture));
        Assert.StartsWith("clip-cam_01_02-", name);
        Assert.EndsWith(".mp4", name);
        Assert.DoesNotContain(":", name);
        Assert.DoesNotContain("/", name);
    }
}

public class ConfigTests
{
    private const string Site = "11111111-2222-3333-4444-555555555555";
    private const string Server = "https://192.168.1.10:7001";

    [Fact]
    public void ParsesFlagsBothFormsAndBoolean()
    {
        var a = Config.ParseArgs(new[]
        {
            "--mode", "cloud", "--site-id=" + Site, "--device-id", "cam1",
            "--format=mkv", "--pos", "2026-06-15T12:00:00Z", "--duration", "8",
            "--out=/tmp/clip.mkv", "--insecure",
        });
        Assert.Equal("cloud", a.Mode);
        Assert.Equal(Site, a.SiteId);
        Assert.Equal("cam1", a.DeviceId);
        Assert.Equal("mkv", a.Format);
        Assert.Equal("2026-06-15T12:00:00Z", a.Pos);
        Assert.Equal("8", a.Duration);
        Assert.Equal("/tmp/clip.mkv", a.Out);
        Assert.True(a.Insecure);
    }

    [Fact]
    public void UsesEnvFileFlagAndRejectsUnknown()
    {
        Assert.Equal("x.env", Config.ParseArgs(new[] { "--env-file", "x.env" }).EnvFile);
        Assert.Throws<ArgumentException>(() => Config.ParseArgs(new[] { "--nope" }));
    }

    [Fact]
    public void ResolvePicksServerVarsInDirectMode()
    {
        var cfg = Config.Resolve(
            new CliArgs { Mode = "direct", DeviceId = "cam1" },
            new Dictionary<string, string>
            {
                ["NX_SERVER_HOST"] = Server,
                ["NX_SERVER_USER"] = "admin",
                ["NX_SERVER_PASSWORD"] = "pw",
                ["NX_CLOUD_USER"] = "should-not-win",
            });
        Assert.Equal(Mode.Direct, cfg.Mode);
        Assert.Equal(Server, cfg.ServerHost);
        Assert.Equal("admin", cfg.User);
        Assert.Equal(NxMediaClient.DefaultFormat, cfg.Format);
        Assert.Null(cfg.PositionMs); // live
        Assert.Equal(10000L, cfg.DurationMs); // default
        Assert.Empty(Config.MissingFields(cfg));
    }

    [Fact]
    public void ResolvePicksCloudVarsInCloudModeAndDefaultsCloudHost()
    {
        var cfg = Config.Resolve(
            new CliArgs { Mode = "cloud", DeviceId = "cam1", SiteId = Site },
            new Dictionary<string, string>
            {
                ["NX_CLOUD_USER"] = "me@x.com",
                ["NX_CLOUD_PASSWORD"] = "pw",
            });
        Assert.Equal(Mode.Cloud, cfg.Mode);
        Assert.Equal("https://nxvms.com", cfg.CloudHost);
        Assert.Equal("me@x.com", cfg.User);
        Assert.Empty(Config.MissingFields(cfg));
    }

    [Fact]
    public void MissingFieldsReportsWhatEachModeNeeds()
    {
        var direct = Config.Resolve(new CliArgs { Mode = "direct" }, new Dictionary<string, string>());
        Assert.Equal(
            new[] { "device-id", "password", "server-host", "user" },
            Config.MissingFields(direct).OrderBy(x => x, StringComparer.Ordinal).ToArray());

        // cloud-host defaults to https://nxvms.com (see Resolve), so it is never
        // "missing" — same convention as every other sample.
        var cloud = Config.Resolve(new CliArgs { Mode = "cloud" }, new Dictionary<string, string>());
        Assert.Equal(
            new[] { "device-id", "password", "site-id", "user" },
            Config.MissingFields(cloud).OrderBy(x => x, StringComparer.Ordinal).ToArray());
    }

    [Fact]
    public void CliFlagsBeatEnvFile()
    {
        var cfg = Config.Resolve(
            new CliArgs { Mode = "direct", ServerHost = "https://flag:7001", DeviceId = "cam1", User = "u", Password = "p" },
            new Dictionary<string, string> { ["NX_SERVER_HOST"] = "https://env:7001" });
        Assert.Equal("https://flag:7001", cfg.ServerHost);
    }
}

public class LoginTests
{
    private const string Site = "11111111-2222-3333-4444-555555555555";
    private const string Server = "https://192.168.1.10:7001";

    private static NxMediaClient Direct(RecordingHandler handler)
        => new(new HttpClient(handler), Mode.Direct, "admin", "pw", serverHost: Server);

    private static NxMediaClient Cloud(RecordingHandler handler, string? mfa = null)
        => new(new HttpClient(handler), Mode.Cloud, "me@x.com", "pw", cloudHost: "https://nxvms.com", siteId: Site, mfaCode: mfa);

    [Fact]
    public async Task DirectLoginPostsToServerAndStoresToken()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("{\"token\":\"srv-tok\"}"));
        var client = Direct(handler);

        string token = await client.LoginAsync();

        Assert.Equal("srv-tok", token);
        Assert.Equal($"{Server}/rest/v4/login/sessions", handler.Calls[0].Url);
        Assert.Contains("\"setCookie\":false", handler.Calls[0].Body);
    }

    [Fact]
    public async Task DirectLogin401ThrowsAuthException()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.Unauthorized, "no"));
        await Assert.ThrowsAsync<AuthException>(() => Direct(handler).LoginAsync());
    }

    [Fact]
    public async Task CloudLoginSendsScopeAndMfaStoresAccessToken()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("{\"access_token\":\"nxcdb-t\"}"));
        var client = Cloud(handler, mfa: "123456");

        string token = await client.LoginAsync();

        Assert.Equal("nxcdb-t", token);
        Assert.Equal("https://nxvms.com/cdb/oauth2/token", handler.Calls[0].Url);
        Assert.Contains($"cloudSystemId={Site}", handler.Calls[0].Body);
        Assert.Contains("\"mfaCode\":\"123456\"", handler.Calls[0].Body);
        Assert.Contains("\"client_id\":\"3rdParty\"", handler.Calls[0].Body);
    }

    [Fact]
    public async Task CloudLogin403ThrowsAuthException()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.Forbidden, "no"));
        await Assert.ThrowsAsync<AuthException>(() => Cloud(handler).LoginAsync());
    }
}

public class BuildMediaUrlTests
{
    private const string Site = "11111111-2222-3333-4444-555555555555";
    private const string Server = "https://192.168.1.10:7001";

    private static NxMediaClient Direct()
        => new(new HttpClient(new RecordingHandler((_, _) => Responses.Ok("{}"))), Mode.Direct, "admin", "pw", serverHost: Server);

    private static NxMediaClient Cloud()
        => new(new HttpClient(new RecordingHandler((_, _) => Responses.Ok("{}"))), Mode.Cloud, "me@x.com", "pw", cloudHost: "https://nxvms.com", siteId: Site);

    [Fact]
    public void DirectLiveOmitsPositionMsAndHitsServerHost()
    {
        string url = Direct().BuildMediaUrl("cam 1", "webm", positionMs: null, durationMs: 10000);
        Assert.StartsWith($"{Server}/rest/v4/devices/cam%201/media.webm?", url);
        Assert.Contains("durationMs=10000", url);
        Assert.DoesNotContain("positionMs", url);
    }

    [Fact]
    public void CloudArchiveIncludesPositionMsAndHitsRelay()
    {
        string url = Cloud().BuildMediaUrl("cam1", "mkv", positionMs: 1700000000000, durationMs: 5000);
        Assert.StartsWith($"https://{Site}.relay.vmsproxy.com/rest/v4/devices/cam1/media.mkv?", url);
        Assert.Contains("positionMs=1700000000000", url);
        Assert.Contains("durationMs=5000", url);
    }

    [Fact]
    public void NeverLeaksTokenIntoUrl()
    {
        var client = Direct();
        client.UseToken("secret-tok");
        string url = client.BuildMediaUrl("cam1", "mp4");
        Assert.DoesNotContain("secret-tok", url);
        Assert.DoesNotContain("auth=", url.ToLowerInvariant());
    }

    [Fact]
    public void EmptyDeviceIdThrows()
        => Assert.Throws<ApiException>(() => Direct().BuildMediaUrl("", "webm"));
}

public class SaveClipTests
{
    private const string Site = "11111111-2222-3333-4444-555555555555";
    private const string Server = "https://192.168.1.10:7001";
    private static readonly byte[] Bytes = { 1, 2, 3, 4, 5, 6 }; // 6 bytes

    private static NxMediaClient Direct(RecordingHandler handler)
        => new(new HttpClient(handler), Mode.Direct, "admin", "pw", serverHost: Server);

    private static NxMediaClient Cloud(RecordingHandler handler)
        => new(new HttpClient(handler), Mode.Cloud, "me@x.com", "pw", cloudHost: "https://nxvms.com", siteId: Site);

    private static ClipRequest Req()
        => new("cam1", "webm", PositionMs: null, DurationMs: 1000);

    [Fact]
    public async Task StreamsBodyToDestinationAndSendsBearerHeader()
    {
        var handler = new RecordingHandler((_, _) => Responses.Body(Bytes));
        var client = Direct(handler);
        client.UseToken("srv-tok");

        using var sink = new MemoryStream();
        long bytes = await client.SaveClipAsync(sink, Req());

        Assert.Equal(6, bytes);
        Assert.Equal(Bytes, sink.ToArray());
        Assert.Equal("Bearer srv-tok", handler.Calls[0].Auth);
    }

    [Fact]
    public async Task FollowsRelay307AndReattachesBearerOnNewHost()
    {
        const string redirected = "https://node-7.relay.vmsproxy.com/rest/v4/devices/cam1/media.webm";
        string relayUrl = $"https://{Site}.relay.vmsproxy.com/rest/v4/devices/cam1/media.webm";
        var handler = new RecordingHandler((_, hop) => hop == 0
            ? Responses.Redirect(redirected)
            : Responses.Body(Bytes));
        var client = Cloud(handler);
        client.UseToken("nxcdb-t");

        using var sink = new MemoryStream();
        long bytes = await client.SaveClipAsync(sink, Req());

        Assert.Equal(6, bytes);
        Assert.Equal(2, handler.Calls.Count);
        Assert.StartsWith(relayUrl, handler.Calls[0].Url);
        Assert.StartsWith(redirected, handler.Calls[1].Url);
        // The bearer is present on BOTH hops — the whole point of the manual follow.
        Assert.Equal("Bearer nxcdb-t", handler.Calls[0].Auth);
        Assert.Equal("Bearer nxcdb-t", handler.Calls[1].Auth);
    }

    [Fact]
    public async Task Raises401AsAuthException()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.Unauthorized));
        var client = Direct(handler);
        client.UseToken("t");
        using var sink = new MemoryStream();
        await Assert.ThrowsAsync<AuthException>(() => client.SaveClipAsync(sink, Req()));
    }

    [Fact]
    public async Task RaisesApiExceptionOnNonOkStatus()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.NotFound, "no such device"));
        var client = Direct(handler);
        client.UseToken("t");
        using var sink = new MemoryStream();
        await Assert.ThrowsAsync<ApiException>(() => client.SaveClipAsync(sink, Req()));
    }

    [Fact]
    public async Task EmptyBodyWritesZeroBytes()
    {
        var handler = new RecordingHandler((_, _) => Responses.Body(Array.Empty<byte>()));
        var client = Direct(handler);
        client.UseToken("t");
        using var sink = new MemoryStream();
        long bytes = await client.SaveClipAsync(sink, Req());
        Assert.Equal(0, bytes);
    }

    [Fact]
    public async Task RefusesToRunBeforeLogin()
    {
        var handler = new RecordingHandler((_, _) => Responses.Body(Bytes));
        var client = Direct(handler);
        using var sink = new MemoryStream();
        await Assert.ThrowsAsync<ApiException>(() => client.SaveClipAsync(sink, Req()));
    }

    [Fact]
    public async Task TooManyRedirectsRaisesApiException()
    {
        var handler = new RecordingHandler((req, _) => Responses.Redirect(req.RequestUri!.ToString() + "/x"));
        var client = Cloud(handler);
        client.UseToken("t");
        using var sink = new MemoryStream();
        var ex = await Assert.ThrowsAsync<ApiException>(() => client.SaveClipAsync(sink, Req()));
        Assert.Contains("Too many redirects", ex.Message);
    }

    [Fact]
    public async Task WritesExactBytesToRealTempFile()
    {
        string dir = Directory.CreateTempSubdirectory("nx-clip-").FullName;
        string outPath = Path.Combine(dir, "clip.webm");
        try
        {
            var handler = new RecordingHandler((_, _) => Responses.Body(Bytes));
            var client = Direct(handler);
            client.UseToken("t");

            long bytes;
            await using (var file = new FileStream(outPath, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                bytes = await client.SaveClipAsync(file, Req());
            }

            Assert.Equal(6, bytes);
            Assert.Equal(Bytes, await File.ReadAllBytesAsync(outPath));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}

public class LogoutTests
{
    private const string Site = "11111111-2222-3333-4444-555555555555";
    private const string Server = "https://192.168.1.10:7001";

    [Fact]
    public async Task DirectLogoutDeletesServerSessionAndClearsToken()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.NoContent));
        var client = new NxMediaClient(new HttpClient(handler), Mode.Direct, "admin", "pw", serverHost: Server);
        client.UseToken("srv-tok");

        await client.LogoutAsync();

        Assert.Equal("DELETE", handler.Calls[0].Method);
        Assert.Equal($"{Server}/rest/v4/login/sessions/srv-tok", handler.Calls[0].Url);
        Assert.Equal("Bearer srv-tok", handler.Calls[0].Auth);
        Assert.Null(client.Token);
    }

    [Fact]
    public async Task CloudLogoutDeletesTokenOnCloudAndClearsToken()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.NoContent));
        var client = new NxMediaClient(
            new HttpClient(handler), Mode.Cloud, "me@x.com", "pw", cloudHost: "https://nxvms.com", siteId: Site);
        client.UseToken("nxcdb-t");

        await client.LogoutAsync();

        Assert.Equal("https://nxvms.com/cdb/oauth2/token/nxcdb-t", handler.Calls[0].Url);
        Assert.Equal("Bearer nxcdb-t", handler.Calls[0].Auth);
        Assert.Null(client.Token);
    }
}

public class TokenExtractionTests
{
    [Fact]
    public void ExtractTokenValid()
        => Assert.Equal("srv-x", NxMediaClient.ExtractToken("{\"token\":\"srv-x\"}"));

    [Fact]
    public void ExtractTokenMissingThrows()
        => Assert.Throws<ApiException>(() => NxMediaClient.ExtractToken("{\"x\":1}"));

    [Fact]
    public void ExtractAccessTokenValid()
        => Assert.Equal("nxcdb-x", NxMediaClient.ExtractAccessToken("{\"access_token\":\"nxcdb-x\"}"));

    [Fact]
    public void ExtractAccessTokenInvalidJsonThrows()
        => Assert.Throws<ApiException>(() => NxMediaClient.ExtractAccessToken("not json"));
}
