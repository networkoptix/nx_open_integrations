// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the rest-rule-schedule sample. No network, no account, no
// real site: the HTTP layer is a fake handler that records each request and
// returns scripted responses per hop index. The schedule helpers (the heart of
// the sample) are pure and tested directly.

using System.Net;
using System.Text;
using System.Text.Json;
using NxRuleSchedule;
using Xunit;

namespace NxRuleSchedule.Tests;

internal sealed record Call(string Method, string Url, string? Auth, string ContentType, string Body);

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
        string contentType = request.Content?.Headers.ContentType?.MediaType ?? "";
        Calls.Add(new Call(
            request.Method.Method, request.RequestUri!.ToString(),
            request.Headers.Authorization?.ToString(), contentType, body));
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

internal static class Clients
{
    public const string Site = "11111111-2222-3333-4444-555555555555";
    public const string Server = "https://192.168.1.10:7001";

    public static NxRuleClient Direct(RecordingHandler handler)
        => new(new HttpClient(handler), Mode.Direct, "admin", "pw", serverHost: Server);

    public static NxRuleClient Cloud(RecordingHandler handler, string? mfa = null)
        => new(new HttpClient(handler), Mode.Cloud, "me@x.com", "pw",
            cloudHost: "https://nxvms.com", siteId: Site, mfaCode: mfa);
}

// ---------------------------------------------------------------------------
// Schedule helpers (the core logic)
// ---------------------------------------------------------------------------

public class ScheduleHelperTests
{
    [Fact]
    public void BuildScheduleAlwaysIsEmpty()
        => Assert.Empty(Config.BuildSchedule("always"));

    [Fact]
    public void BuildSchedule24x7IsSevenFullDays()
    {
        IReadOnlyList<ScheduleTask> s = Config.BuildSchedule("24x7");
        Assert.Equal(7, s.Count);
        Assert.Equal(new[] { 1, 2, 3, 4, 5, 6, 7 }, s.Select(t => t.DayOfWeek).ToArray());
        Assert.All(s, t =>
        {
            Assert.Equal(0, t.StartTime);
            Assert.Equal(NxRuleClient.SecondsPerDay, t.EndTime);
        });
    }

    [Fact]
    public void BuildScheduleWeekdaysWithHourWindow()
    {
        IReadOnlyList<ScheduleTask> s = Config.BuildSchedule("weekdays", 9, 18);
        Assert.Equal(Config.Weekdays.ToArray(), s.Select(t => t.DayOfWeek).ToArray());
        Assert.Equal(9 * 3600, s[0].StartTime);
        Assert.Equal(18 * 3600, s[0].EndTime);
    }

    [Fact]
    public void BuildScheduleWeekendSatSun()
    {
        IReadOnlyList<ScheduleTask> s = Config.BuildSchedule("weekend", 0, 12);
        Assert.Equal(Config.Weekend.ToArray(), s.Select(t => t.DayOfWeek).ToArray());
        Assert.Equal(12 * 3600, s[0].EndTime);
    }

    [Fact]
    public void BuildScheduleRejectsBadHourWindow()
    {
        Assert.Throws<ApiException>(() => Config.BuildSchedule("weekdays", 18, 9));
        Assert.Throws<ApiException>(() => Config.BuildSchedule("weekdays", -1, 9));
        Assert.Throws<ApiException>(() => Config.BuildSchedule("weekdays", 0, 25));
    }

    [Fact]
    public void NormalizePresetAcceptsEnumAndRejectsOthers()
    {
        foreach (string p in Config.Presets) Assert.Equal(p, Config.NormalizePreset(p));
        Assert.Equal("weekdays", Config.NormalizePreset("WEEKDAYS"));
        Assert.Throws<ApiException>(() => Config.NormalizePreset("sometimes"));
    }

    [Fact]
    public void SummarizeScheduleEmptyIsAlwaysTasksRenderReadably()
    {
        Assert.Equal("always", Config.SummarizeSchedule(Array.Empty<ScheduleTask>()));
        Assert.Equal("always", Config.SummarizeSchedule(null));
        Assert.Equal(
            "Mon 09:00-18:00",
            Config.SummarizeSchedule(new[] { new ScheduleTask(1, 9 * 3600, 18 * 3600) }));
    }

    [Fact]
    public void FormatRulesTableRendersRowsAndEmptyCase()
    {
        Assert.Contains("Weekdays", Config.FormatRulesTable(new[]
        {
            new Rule("r1", "Weekdays", true, Array.Empty<ScheduleTask>()),
        }));
        Assert.Contains("No event rules", Config.FormatRulesTable(Array.Empty<Rule>()));
    }
}

// ---------------------------------------------------------------------------
// CLI parsing + config
// ---------------------------------------------------------------------------

public class ConfigTests
{
    [Fact]
    public void ParsesActionsFlagsAndBooleans()
    {
        var a = Config.ParseArgs(new[]
        {
            "--mode", "cloud", "--rule-id=r9", "--preset", "weekdays",
            "--start=8", "--end", "20", "--insecure",
        });
        Assert.Equal("cloud", a.Mode);
        Assert.Equal("r9", a.RuleId);
        Assert.Equal("weekdays", a.Preset);
        Assert.Equal("8", a.Start);
        Assert.Equal("20", a.End);
        Assert.True(a.Insecure);
        Assert.True(Config.ParseArgs(new[] { "--list" }).List);
    }

    [Fact]
    public void UsesEnvFileFlagAndRejectsUnknown()
    {
        Assert.Equal("x.env", Config.ParseArgs(new[] { "--env-file", "x.env" }).EnvFile);
        Assert.Throws<ArgumentException>(() => Config.ParseArgs(new[] { "--bogus" }));
    }

    [Fact]
    public void ResolvePicksServerVarsInDirectMode()
    {
        var cfg = Config.Resolve(
            new CliArgs { Mode = "direct" },
            new Dictionary<string, string>
            {
                ["NX_SERVER_HOST"] = Clients.Server,
                ["NX_SERVER_USER"] = "admin",
                ["NX_SERVER_PASSWORD"] = "pw",
                ["NX_CLOUD_USER"] = "should-not-win",
            });
        Assert.Equal(Mode.Direct, cfg.Mode);
        Assert.Equal(Clients.Server, cfg.ServerHost);
        Assert.Equal("admin", cfg.User);
        Assert.Empty(Config.MissingFields(cfg));
    }

    [Fact]
    public void ResolvePicksCloudVarsInCloudModeAndDefaultsCloudHost()
    {
        var cfg = Config.Resolve(
            new CliArgs { Mode = "cloud", SiteId = Clients.Site },
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
            new[] { "password", "server-host", "user" },
            Config.MissingFields(direct).OrderBy(x => x, StringComparer.Ordinal).ToArray());

        // cloud-host defaults to https://nxvms.com, so it is never "missing".
        var cloud = Config.Resolve(new CliArgs { Mode = "cloud" }, new Dictionary<string, string>());
        Assert.Equal(
            new[] { "password", "site-id", "user" },
            Config.MissingFields(cloud).OrderBy(x => x, StringComparer.Ordinal).ToArray());
    }

    [Fact]
    public void CliFlagsBeatEnvFile()
    {
        var cfg = Config.Resolve(
            new CliArgs { Mode = "direct", ServerHost = "https://flag:7001", User = "u", Password = "p" },
            new Dictionary<string, string> { ["NX_SERVER_HOST"] = "https://env:7001" });
        Assert.Equal("https://flag:7001", cfg.ServerHost);
    }
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

public class LoginTests
{
    [Fact]
    public async Task DirectLoginPostsToServerAndStoresToken()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("{\"token\":\"srv\"}"));
        var client = Clients.Direct(handler);

        string token = await client.LoginAsync();

        Assert.Equal("srv", token);
        Assert.Equal($"{Clients.Server}/rest/v4/login/sessions", handler.Calls[0].Url);
        Assert.Contains("\"setCookie\":false", handler.Calls[0].Body);
    }

    [Fact]
    public async Task CloudLoginSendsScopeAndMfaStoresAccessToken()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("{\"access_token\":\"nxcdb-t\"}"));
        var client = Clients.Cloud(handler, mfa: "111222");

        string token = await client.LoginAsync();

        Assert.Equal("nxcdb-t", token);
        Assert.Equal("https://nxvms.com/cdb/oauth2/token", handler.Calls[0].Url);
        Assert.Contains($"cloudSystemId={Clients.Site}", handler.Calls[0].Body);
        Assert.Contains("\"mfaCode\":\"111222\"", handler.Calls[0].Body);
        Assert.Contains("\"client_id\":\"3rdParty\"", handler.Calls[0].Body);
    }

    [Fact]
    public async Task DirectLogin401ThrowsAuthException()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.Unauthorized, "no"));
        await Assert.ThrowsAsync<AuthException>(() => Clients.Direct(handler).LoginAsync());
    }

    [Fact]
    public async Task CloudLogin403ThrowsAuthException()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.Forbidden, "no"));
        await Assert.ThrowsAsync<AuthException>(() => Clients.Cloud(handler).LoginAsync());
    }
}

// ---------------------------------------------------------------------------
// ListRules
// ---------------------------------------------------------------------------

public class ListRulesTests
{
    private const string RulesJson =
        "[{\"id\":\"r1\",\"enabled\":true,\"comment\":\"Weekdays\",\"schedule\":[{\"dayOfWeek\":6,\"startTime\":0,\"endTime\":3600}]},"
        + "{\"id\":\"r2\",\"enabled\":true,\"comment\":\"Weekend\",\"schedule\":[{\"dayOfWeek\":1,\"startTime\":0,\"endTime\":3600}]},"
        + "{\"id\":\"r3\",\"enabled\":false,\"comment\":\"Other\",\"schedule\":[]}]";

    [Fact]
    public async Task ListRulesGetsV4PathWithBearer()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok(RulesJson));
        var client = Clients.Direct(handler);
        client.UseToken("srv");

        IReadOnlyList<Rule> rules = await client.ListRulesAsync();

        Assert.Equal(3, rules.Count);
        Assert.Equal($"{Clients.Server}/rest/v4/events/rules", handler.Calls[0].Url);
        Assert.Equal("Bearer srv", handler.Calls[0].Auth);
        Assert.Equal("GET", handler.Calls[0].Method);
    }

    [Fact]
    public async Task ListRulesUnwrapsReplyEnvelope()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("{\"reply\":" + RulesJson + "}"));
        var client = Clients.Direct(handler);
        client.UseToken("t");
        Assert.Equal(3, (await client.ListRulesAsync()).Count);
    }

    [Fact]
    public async Task ListRules403ThrowsAuthException()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.Forbidden));
        var client = Clients.Direct(handler);
        client.UseToken("t");
        await Assert.ThrowsAsync<AuthException>(() => client.ListRulesAsync());
    }

    [Fact]
    public async Task ListRulesParsesFieldsLeniently()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok(RulesJson));
        var client = Clients.Direct(handler);
        client.UseToken("t");

        IReadOnlyList<Rule> rules = await client.ListRulesAsync();

        Assert.Equal("r3", rules[2].Id);
        Assert.False(rules[2].Enabled);
        Assert.Equal("Weekdays", rules[0].Comment);
        Assert.Equal(6, rules[0].Schedule[0].DayOfWeek);
    }
}

// ---------------------------------------------------------------------------
// PatchSchedule
// ---------------------------------------------------------------------------

public class PatchScheduleTests
{
    private static IReadOnlyDictionary<string, JsonElement> ParseBody(string body)
        => JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(body)!;

    [Fact]
    public async Task PatchSchedulePatchesRuleIdWithScheduleBody()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("{\"id\":\"r1\"}"));
        var client = Clients.Direct(handler);
        client.UseToken("srv");

        IReadOnlyList<ScheduleTask> sched = Config.BuildSchedule("weekdays", 9, 18);
        Rule updated = await client.PatchScheduleAsync("r1", sched);

        Assert.Equal("PATCH", handler.Calls[0].Method);
        Assert.Equal($"{Clients.Server}/rest/v4/events/rules/r1", handler.Calls[0].Url);
        Assert.Equal("application/json", handler.Calls[0].ContentType);
        // The body is { "schedule": [ { dayOfWeek, startTime, endTime }, ... ] }.
        IReadOnlyDictionary<string, JsonElement> body = ParseBody(handler.Calls[0].Body);
        Assert.True(body.ContainsKey("schedule"));
        Assert.Equal(5, body["schedule"].GetArrayLength());
        Assert.Equal(1, body["schedule"][0].GetProperty("dayOfWeek").GetInt32());
        Assert.Equal(9 * 3600, body["schedule"][0].GetProperty("startTime").GetInt32());
        Assert.Equal("r1", updated.Id);
    }

    [Fact]
    public async Task PatchScheduleTreatsEmpty200BodyAsSuccess()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.OK)); // empty body
        var client = Clients.Direct(handler);
        client.UseToken("t");

        Rule updated = await client.PatchScheduleAsync("r5", Array.Empty<ScheduleTask>());

        Assert.Equal("r5", updated.Id);
        Assert.Empty(updated.Schedule);
    }

    [Fact]
    public async Task PatchScheduleWithoutRuleIdRaises()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("{}"));
        var client = Clients.Direct(handler);
        client.UseToken("t");
        await Assert.ThrowsAsync<ApiException>(() => client.PatchScheduleAsync("", Array.Empty<ScheduleTask>()));
    }

    [Fact]
    public async Task PatchScheduleFollowsRelay307PreservingMethodBodyAndBearer()
    {
        string baseUrl = $"https://{Clients.Site}.relay.vmsproxy.com/rest/v4/events/rules/r1";
        const string redirected = "https://node-7.relay.vmsproxy.com/rest/v4/events/rules/r1";
        var handler = new RecordingHandler((_, hop) => hop == 0
            ? Responses.Redirect(redirected)
            : Responses.Ok("{\"id\":\"r1\"}"));
        var client = Clients.Cloud(handler);
        client.UseToken("nxcdb-t");

        await client.PatchScheduleAsync("r1", Config.BuildSchedule("always"));

        Assert.Equal(2, handler.Calls.Count);
        Assert.StartsWith(baseUrl, handler.Calls[0].Url);
        Assert.Equal(redirected, handler.Calls[1].Url.Split('?')[0]);
        // Method + body + bearer preserved across the hop — the whole point.
        Assert.Equal("PATCH", handler.Calls[1].Method);
        IReadOnlyDictionary<string, JsonElement> body = ParseBody(handler.Calls[1].Body);
        Assert.Equal(0, body["schedule"].GetArrayLength());
        Assert.Equal("Bearer nxcdb-t", handler.Calls[1].Auth);
        Assert.Equal("application/json", handler.Calls[1].ContentType);
    }

    [Fact]
    public async Task TooManyRedirectsRaisesApiException()
    {
        var handler = new RecordingHandler((req, _) => Responses.Redirect(req.RequestUri!.ToString() + "/x"));
        var client = Clients.Cloud(handler);
        client.UseToken("t");
        var ex = await Assert.ThrowsAsync<ApiException>(
            () => client.PatchScheduleAsync("r1", Array.Empty<ScheduleTask>()));
        Assert.Contains("Too many redirects", ex.Message);
    }

    [Fact]
    public async Task PatchScheduleRefusesToRunBeforeLogin()
    {
        var handler = new RecordingHandler((_, _) => Responses.Ok("{}"));
        var client = Clients.Direct(handler);
        await Assert.ThrowsAsync<ApiException>(
            () => client.PatchScheduleAsync("r1", Array.Empty<ScheduleTask>()));
    }
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

public class LogoutTests
{
    [Fact]
    public async Task DirectLogoutDeletesServerSessionAndClearsToken()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.NoContent));
        var client = Clients.Direct(handler);
        client.UseToken("srv");

        await client.LogoutAsync();

        Assert.Equal("DELETE", handler.Calls[0].Method);
        Assert.Equal($"{Clients.Server}/rest/v4/login/sessions/srv", handler.Calls[0].Url);
        Assert.Equal("Bearer srv", handler.Calls[0].Auth);
        Assert.Null(client.Token);
    }

    [Fact]
    public async Task CloudLogoutDeletesTokenOnCloudAndClearsToken()
    {
        var handler = new RecordingHandler((_, _) => Responses.Status(HttpStatusCode.NoContent));
        var client = Clients.Cloud(handler);
        client.UseToken("nxcdb-t");

        await client.LogoutAsync();

        Assert.Equal("https://nxvms.com/cdb/oauth2/token/nxcdb-t", handler.Calls[0].Url);
        Assert.Equal("Bearer nxcdb-t", handler.Calls[0].Auth);
        Assert.Null(client.Token);
    }
}

// ---------------------------------------------------------------------------
// Token extraction (pure parsing)
// ---------------------------------------------------------------------------

public class TokenExtractionTests
{
    [Fact]
    public void ExtractTokenValid()
        => Assert.Equal("srv-x", NxRuleClient.ExtractToken("{\"token\":\"srv-x\"}"));

    [Fact]
    public void ExtractTokenMissingThrows()
        => Assert.Throws<ApiException>(() => NxRuleClient.ExtractToken("{\"x\":1}"));

    [Fact]
    public void ExtractAccessTokenValid()
        => Assert.Equal("nxcdb-x", NxRuleClient.ExtractAccessToken("{\"access_token\":\"nxcdb-x\"}"));

    [Fact]
    public void ExtractAccessTokenInvalidJsonThrows()
        => Assert.Throws<ApiException>(() => NxRuleClient.ExtractAccessToken("not json"));
}
