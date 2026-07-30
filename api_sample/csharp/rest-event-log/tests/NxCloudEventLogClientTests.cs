// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the rest-event-log sample. No account, no network: the HTTP
// layer is a fake handler that records each request and returns scripted
// responses, so we can prove the 307 + bearer-reattach path, the v4 query
// params, the manifest object-map parsing, and the record normalization.

using System.Net;
using System.Text;
using NxEventLog;
using Xunit;

namespace NxEventLog.Tests;

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

// A v4 record: details live inside eventData / actionData; timestamp in ms.
internal static class Fixtures
{
    public const string Site = "11111111-2222-3333-4444-555555555555";

    public const string RawRecord =
        "{\"timestampMs\":1781247975053," +
        "\"eventData\":{\"eventType\":\"cameraDisconnectEvent\",\"caption\":\"Lobby Cam\"}," +
        "\"actionData\":{\"actionType\":\"sendMailAction\"}," +
        "\"ruleId\":\"rule-1\",\"flags\":\"noFlags\"}";

    public const string RawArray = "[" + RawRecord + "]";
}

public class NormalizeTests
{
    [Fact]
    public void NormalizeV4Record()
    {
        var events = NxCloudEventLogClient.NormalizeEvents(Fixtures.RawArray);
        Assert.Single(events);
        Assert.Equal("cameraDisconnectEvent", events[0].EventType);
        Assert.Equal("sendMailAction", events[0].ActionType);
        Assert.Equal("Lobby Cam", events[0].Resource);
        Assert.StartsWith("2026-06-", events[0].Time); // ms -> readable UTC
    }

    [Fact]
    public void NormalizeHandlesMissingData()
    {
        var events = NxCloudEventLogClient.NormalizeEvents("[{\"timestampMs\":null}]");
        Assert.Single(events);
        Assert.Equal("", events[0].EventType);
        Assert.Equal("", events[0].ActionType);
    }

    [Fact]
    public void NormalizeNonArrayReturnsEmpty()
        => Assert.Empty(NxCloudEventLogClient.NormalizeEvents("{\"nope\":true}"));

    [Fact]
    public void NormalizeInvalidJsonThrows()
        => Assert.Throws<ApiException>(() => NxCloudEventLogClient.NormalizeEvents("not json"));

    [Fact]
    public void FormatTable()
    {
        Assert.Contains("No events", NxCloudEventLogClient.FormatEventsTable(Array.Empty<EventRecord>()));
        string table = NxCloudEventLogClient.FormatEventsTable(
            NxCloudEventLogClient.NormalizeEvents(Fixtures.RawArray));
        Assert.Contains("EVENT", table);
        Assert.Contains("cameraDisconnectEvent", table);
    }
}

public class BuildEventQueryTests
{
    [Fact]
    public void UsesStartAndDuration()
    {
        string q = NxCloudEventLogClient.BuildEventQuery(1000, 2000);
        Assert.Contains("startTimeMs=1000", q);
        Assert.Contains("durationMs=2000", q);
        Assert.Contains("order=desc", q);
        Assert.DoesNotContain("eventType=", q);
    }

    [Fact]
    public void RepeatsArrayParams()
    {
        string q = NxCloudEventLogClient.BuildEventQuery(
            0, 1, eventType: new[] { "motionEvent" }, actionType: new[] { "a", "b" });
        Assert.Contains("eventType=motionEvent", q);
        Assert.Contains("actionType=a", q);
        Assert.Contains("actionType=b", q);
    }
}

public class ManifestTests
{
    [Fact]
    public void ParsesObjectMapKeyedById()
    {
        const string json =
            "{\"motionEvent\":{\"id\":\"motionEvent\",\"displayName\":\"Motion Detected\"}," +
            "\"cameraDisconnectEvent\":{\"id\":\"cameraDisconnectEvent\",\"displayName\":\"Camera Disconnected\"}}";
        var manifest = NxCloudEventLogClient.ParseManifest(json);

        Assert.Equal(2, manifest.Count);
        Assert.Equal("motionEvent", manifest["motionEvent"].Id);
        Assert.Equal("Motion Detected", manifest["motionEvent"].DisplayName);
        Assert.Equal("Camera Disconnected", manifest["cameraDisconnectEvent"].DisplayName);
    }

    [Fact]
    public void FallsBackToKeyWhenIdMissing()
    {
        var manifest = NxCloudEventLogClient.ParseManifest("{\"someEvent\":{\"displayName\":\"Some Event\"}}");
        Assert.Equal("someEvent", manifest["someEvent"].Id);
        Assert.Equal("Some Event", manifest["someEvent"].DisplayName);
    }

    [Fact]
    public void NonObjectReturnsEmpty()
        => Assert.Empty(NxCloudEventLogClient.ParseManifest("[1,2,3]"));

    [Fact]
    public void FormatManifestTableEmpty()
        => Assert.Contains("No event types",
            NxCloudEventLogClient.FormatManifestTable(
                new Dictionary<string, EventTypeInfo>()));

    [Fact]
    public void FormatManifestTableHeaderAndSortedById()
    {
        var manifest = new Dictionary<string, EventTypeInfo>
        {
            ["motionEvent"] = new EventTypeInfo("motionEvent", "Motion Detected"),
            ["cameraDisconnectEvent"] = new EventTypeInfo("cameraDisconnectEvent", "Camera Disconnected"),
        };
        string table = NxCloudEventLogClient.FormatManifestTable(manifest);

        Assert.Contains("ID", table);
        Assert.Contains("DISPLAY NAME", table);
        Assert.Contains("motionEvent", table);
        Assert.Contains("Camera Disconnected", table);
        // Sorted by id (ordinal): cameraDisconnectEvent before motionEvent.
        Assert.True(table.IndexOf("cameraDisconnectEvent", StringComparison.Ordinal)
            < table.IndexOf("motionEvent", StringComparison.Ordinal));
    }
}

public class TokenTests
{
    [Fact]
    public void ExtractAccessTokenValid()
        => Assert.Equal("nxcdb-x", NxCloudEventLogClient.ExtractAccessToken("{\"access_token\":\"nxcdb-x\"}"));

    [Fact]
    public void ExtractAccessTokenMissingThrows()
        => Assert.Throws<ApiException>(() => NxCloudEventLogClient.ExtractAccessToken("{\"x\":1}"));
}

public class LoginTests
{
    [Fact]
    public async Task PostsSiteScopedTokenRequest()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("{\"access_token\":\"nxcdb-t\"}"));
        var client = new NxCloudEventLogClient(new HttpClient(handler), "https://nxvms.com/", Fixtures.Site);

        string token = await client.LoginAsync("me@x.com", "pw");

        Assert.Equal("nxcdb-t", token);
        Assert.Equal("https://nxvms.com/cdb/oauth2/token", handler.Calls[0].Url);
        // Wire literal stays "cloudSystemId" even though we say "site" in prose.
        Assert.Contains($"cloudSystemId={Fixtures.Site}", handler.Calls[0].Body);
        Assert.Contains("\"client_id\":\"3rdParty\"", handler.Calls[0].Body);
    }

    [Fact]
    public async Task Rejected403ThrowsAuthException()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.Forbidden, "no"));
        var client = new NxCloudEventLogClient(new HttpClient(handler), "https://nxvms.com", Fixtures.Site);
        await Assert.ThrowsAsync<AuthException>(() => client.LoginAsync("me@x.com", "pw"));
    }
}

public class EventLogTests
{
    [Fact]
    public void RelayUrl()
    {
        var client = new NxCloudEventLogClient(new HttpClient(), "https://nxvms.com", Fixtures.Site);
        Assert.Equal($"https://{Fixtures.Site}.relay.vmsproxy.com", client.RelayUrl);
    }

    [Fact]
    public async Task HitsRelayV4PathWithBearer()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok(Fixtures.RawArray));
        var client = new NxCloudEventLogClient(new HttpClient(handler), "https://nxvms.com", Fixtures.Site);
        client.UseToken("nxcdb-t");

        var events = await client.GetEventLogAsync(1000, 2000);

        Call call = handler.Calls[0];
        Assert.StartsWith($"https://{Fixtures.Site}.relay.vmsproxy.com/rest/v4/events/log?", call.Url);
        Assert.Contains("startTimeMs=1000", call.Url);
        Assert.Equal("Bearer nxcdb-t", call.Auth);
        Assert.Equal("cameraDisconnectEvent", events[0].EventType);
    }

    [Fact]
    public async Task Follows307RedirectWithBearerPreserved()
    {
        // First GET -> 307 to the serving node; second GET -> the data.
        const string node = "https://node7.relay.vmsproxy.com/rest/v4/events/log";
        var handler = new RecordingHandler((_, hop) => hop == 0
            ? Responses.Redirect(node)
            : Responses.Ok(Fixtures.RawArray));
        var client = new NxCloudEventLogClient(new HttpClient(handler), "https://nxvms.com", Fixtures.Site);
        client.UseToken("nxcdb-t");

        var events = await client.GetEventLogAsync(1000, 2000);

        Assert.Equal(2, handler.Calls.Count);
        Assert.Equal(node, handler.Calls[1].Url);
        // Crucially, the bearer is re-attached on BOTH hops — the whole point.
        Assert.Equal("Bearer nxcdb-t", handler.Calls[0].Auth);
        Assert.Equal("Bearer nxcdb-t", handler.Calls[1].Auth);
        Assert.Equal("Lobby Cam", events[0].Resource);
    }

    [Fact]
    public async Task RedirectWithoutLocationThrows()
    {
        var handler = new RecordingHandler((_, _) =>
            new HttpResponseMessage(HttpStatusCode.TemporaryRedirect) { Content = new StringContent("") });
        var client = new NxCloudEventLogClient(new HttpClient(handler), "https://nxvms.com", Fixtures.Site);
        client.UseToken("t");
        await Assert.ThrowsAsync<ApiException>(() => client.GetEventLogAsync(1, 2));
    }

    [Fact]
    public async Task TokenRejectedThrowsAuthException()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.Forbidden, "no"));
        var client = new NxCloudEventLogClient(new HttpClient(handler), "https://nxvms.com", Fixtures.Site);
        client.UseToken("t");
        await Assert.ThrowsAsync<AuthException>(() => client.GetEventLogAsync(1, 2));
    }

    [Fact]
    public async Task WithoutTokenThrowsApiException()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("[]"));
        var client = new NxCloudEventLogClient(new HttpClient(handler), "https://nxvms.com", Fixtures.Site);
        await Assert.ThrowsAsync<ApiException>(() => client.GetEventLogAsync(1, 2));
    }

    [Fact]
    public async Task ManifestFetchedThroughRelayWithBearer()
    {
        var handler = new RecordingHandler((_, _) =>
            Responses.Ok("{\"motionEvent\":{\"id\":\"motionEvent\",\"displayName\":\"Motion Detected\"}}"));
        var client = new NxCloudEventLogClient(new HttpClient(handler), "https://nxvms.com", Fixtures.Site);
        client.UseToken("nxcdb-t");

        var manifest = await client.GetEventManifestAsync();

        Assert.Equal($"https://{Fixtures.Site}.relay.vmsproxy.com/rest/v4/events/manifest/events",
            handler.Calls[0].Url);
        Assert.Equal("Bearer nxcdb-t", handler.Calls[0].Auth);
        Assert.Equal("Motion Detected", manifest["motionEvent"].DisplayName);
    }
}

public class TimeWindowTests
{
    [Fact]
    public void ParseDurationUnits()
    {
        Assert.Equal(30 * 60_000L, TimeWindow.ParseDuration("30m"));
        Assert.Equal(24 * 3_600_000L, TimeWindow.ParseDuration("24h"));
        Assert.Equal(7 * 86_400_000L, TimeWindow.ParseDuration("7d"));
        Assert.Equal(2 * 604_800_000L, TimeWindow.ParseDuration("2w"));
        Assert.Equal((long)(1.5 * 3_600_000), TimeWindow.ParseDuration("1.5h"));
    }

    [Fact]
    public void ParseDurationRequiresUnit()
    {
        Assert.Throws<FormatException>(() => TimeWindow.ParseDuration("24")); // no unit -> rejected
        Assert.Throws<FormatException>(() => TimeWindow.ParseDuration("soon"));
    }

    [Fact]
    public void ParseTimeEpochAndIso()
    {
        Assert.Equal(1781247975053L, TimeWindow.ParseTime("1781247975053")); // ms
        Assert.Equal(1781247975L * 1000, TimeWindow.ParseTime("1781247975"));  // seconds
        Assert.Equal(1781222400000L, TimeWindow.ParseTime("2026-06-12T00:00:00Z")); // ISO -> UTC
    }

    [Fact]
    public void ParseTimeInvalidThrows()
        => Assert.Throws<FormatException>(() => TimeWindow.ParseTime("not-a-date"));

    [Fact]
    public void ResolveSince()
    {
        long now = 1_000_000_000_000L;
        var (startMs, durationMs) = TimeWindow.Resolve(now, since: "24h");
        Assert.Equal(24 * 3_600_000L, durationMs);
        Assert.Equal(now - durationMs, startMs);
    }

    [Fact]
    public void ResolveAbsoluteStartEnd()
    {
        var (startMs, durationMs) = TimeWindow.Resolve(5_000, start: "1000", end: "4000");
        Assert.Equal(1_000_000L, startMs);   // epoch seconds -> ms
        Assert.Equal(3_000_000L, durationMs);
    }

    [Fact]
    public void ResolveStartDefaultsEndToNow()
    {
        long now = 9_000_000L;
        var (startMs, durationMs) = TimeWindow.Resolve(now, start: "1000");
        Assert.Equal(1_000_000L, startMs);
        Assert.Equal(now - 1_000_000L, durationMs);
    }

    [Fact]
    public void ResolveEndBeforeStartThrows()
        => Assert.Throws<FormatException>(() => TimeWindow.Resolve(0, start: "2000", end: "1000"));
}

public class ConfigTests
{
    [Fact]
    public void ParsesFlagsBothFormsAndRepeatable()
    {
        var a = Config.ParseArgs(new[]
        {
            "--cloud-host", "https://h", "--site-id=SITE-1",
            "--event-type", "motionEvent", "--event-type", "cameraDisconnectEvent",
            "--limit", "100", "--insecure",
        });
        Assert.Equal("https://h", a.CloudHost);
        Assert.Equal("SITE-1", a.SiteId);
        Assert.Equal(new[] { "motionEvent", "cameraDisconnectEvent" }, a.EventType);
        Assert.Equal(100, a.Limit);
        Assert.True(a.Insecure);
    }

    [Fact]
    public void ParsesListEventTypesFlag()
    {
        var a = Config.ParseArgs(new[] { "--list-event-types" });
        Assert.True(a.ListEventTypes);
        // Defaults off when the flag is absent.
        Assert.False(Config.ParseArgs(Array.Empty<string>()).ListEventTypes);
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

    [Fact]
    public void ResolveReadsEnvFileWhenNoCli()
    {
        var cfg = Config.Resolve(
            new CliArgs(),
            new Dictionary<string, string> { ["NX_CLOUD_SITE_ID"] = "file-sys" });
        Assert.Equal("file-sys", cfg.SiteId);
    }
}
