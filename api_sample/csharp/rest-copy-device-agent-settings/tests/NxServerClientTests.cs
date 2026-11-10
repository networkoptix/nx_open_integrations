// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for rest-copy-device-agent-settings. No account, no network:
// every HTTP call goes through a fake HttpMessageHandler that records the
// request and returns a scripted response. That is a hard requirement, a test
// that needs a live server cannot run in CI, so it does not get written.
//
// What is worth testing in a sample:
//   - the auth flow sends what the API expects, and stores the token
//   - each documented failure mode raises the right error
//   - response shapes the server really returns are all handled (v4 envelopes!)
//   - config precedence: CLI > env > .env
//   - the PUT body keeps only the fields that are really configuration
//   - the CLI guards (--force, --yes) and exit codes (the full CLI paths are
//     in ProgramTests.cs)

using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using NxCopyDeviceAgentSettings;
using Xunit;

namespace NxCopyDeviceAgentSettings.Tests;

// ---------------------------------------------------------------------------
// Fake HTTP plumbing
// ---------------------------------------------------------------------------

internal sealed record Call(string Method, string Url, string? Auth, string Body);

/// <summary>
/// Records every request; replies are matched by method + a suffix of the URL,
/// so a test says what it means rather than counting calls. Unmatched requests
/// get a bare 200 {}.
/// </summary>
internal sealed class ScriptedHandler : HttpMessageHandler
{
    private readonly List<(string Method, string Suffix, HttpStatusCode Status, string Json)> _replies;
    public List<Call> Calls { get; } = new();

    // Scripted behaviours (throw, hang, act mid-request) are tried before the
    // plain replies.
    private readonly List<(string Method, string Suffix, Func<CancellationToken, Task<HttpResponseMessage>> Respond)>
        _behaviours = new();

    public ScriptedHandler(params (string Method, string Suffix, HttpStatusCode Status, string Json)[] replies)
        => _replies = replies.ToList();

    public ScriptedHandler On(string method, string suffix, Func<CancellationToken, Task<HttpResponseMessage>> respond)
    {
        _behaviours.Add((method, suffix, respond));
        return this;
    }

    public ScriptedHandler On(string method, string suffix, Func<HttpResponseMessage> respond)
        => On(method, suffix, _ => Task.FromResult(respond()));

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        string body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
        string method = request.Method.Method;
        string url = request.RequestUri!.ToString();
        Calls.Add(new Call(method, url, request.Headers.Authorization?.ToString(), body));

        foreach (var behaviour in _behaviours)
        {
            if (behaviour.Method == method && url.EndsWith(behaviour.Suffix, StringComparison.Ordinal))
            {
                return await behaviour.Respond(cancellationToken);
            }
        }

        foreach (var reply in _replies)
        {
            if (reply.Method == method && url.EndsWith(reply.Suffix, StringComparison.Ordinal))
            {
                return new HttpResponseMessage(reply.Status)
                {
                    Content = new StringContent(reply.Json, Encoding.UTF8, "application/json"),
                };
            }
        }
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json"),
        };
    }
}

internal static class Fixtures
{
    public static (string Method, string Suffix, HttpStatusCode Status, string Json) Reply(
        string method, string suffix, HttpStatusCode status = HttpStatusCode.OK, string json = "{}")
        => (method, suffix, status, json);

    public static readonly (string, string, HttpStatusCode, string) LoginOk =
        Reply("POST", "/login/sessions", HttpStatusCode.OK, "{\"token\":\"tok-1\"}");

    public const string SettingsUrl = "/analytics/engines/engine-1/deviceAgents/device-1/settings";

    public static JsonObject BareSettings() => new()
    {
        ["deviceId"] = JsonValue.Create("device-1"),
        ["engineId"] = JsonValue.Create("engine-1"),
        ["values"] = new JsonObject { ["sensitivity"] = JsonValue.Create(50) },
        ["model"] = new JsonObject
        {
            ["sensitivity"] = new JsonObject { ["type"] = JsonValue.Create("SpinBox") },
        },
        ["_error"] = new JsonObject(),
        ["analyzedStream"] = JsonValue.Create("primary"),
        ["disableStreamSelection"] = JsonValue.Create(false),
    };

    public static string BareSettingsJson => BareSettings().ToJsonString();

    public static (NxServerClient Client, ScriptedHandler Handler) MakeClient(
        params (string Method, string Suffix, HttpStatusCode Status, string Json)[] replies)
    {
        var handler = new ScriptedHandler(replies);
        var client = new NxServerClient(new HttpClient(handler), "https://server:7001");
        return (client, handler);
    }
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

public class LoginTests
{
    [Fact]
    public async Task PostsCredentialsAndStoresToken()
    {
        var (client, handler) = Fixtures.MakeClient(Fixtures.LoginOk);

        string token = await client.LoginAsync("admin", "secret");

        Assert.Equal("tok-1", token);
        Assert.Equal("tok-1", client.Token);
        Call call = handler.Calls[0];
        Assert.Equal("POST", call.Method);
        Assert.EndsWith("/rest/v4/login/sessions", call.Url);
        Assert.Contains("\"username\":\"admin\"", call.Body);
        Assert.Contains("\"password\":\"secret\"", call.Body);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden)]
    public async Task UnauthorizedThrowsAuthException(HttpStatusCode status)
    {
        var (client, _) = Fixtures.MakeClient(Fixtures.Reply("POST", "/login/sessions", status, ""));
        await Assert.ThrowsAsync<AuthException>(() => client.LoginAsync("admin", "wrong"));
    }

    [Fact]
    public async Task WithoutTokenInResponseThrowsApiException()
    {
        var (client, _) = Fixtures.MakeClient(Fixtures.Reply("POST", "/login/sessions", HttpStatusCode.OK, "{}"));
        await Assert.ThrowsAsync<ApiException>(() => client.LoginAsync("admin", "secret"));
    }
}

// ---------------------------------------------------------------------------
// DownloadSettingsAsync(): GET .../settings
// ---------------------------------------------------------------------------

public class DownloadSettingsTests
{
    [Fact]
    public async Task SendsGetToTheEngineAndDevicePath()
    {
        var (client, handler) = Fixtures.MakeClient(
            Fixtures.LoginOk,
            Fixtures.Reply("GET", Fixtures.SettingsUrl, HttpStatusCode.OK, Fixtures.BareSettingsJson));
        await client.LoginAsync("admin", "secret");

        JsonObject result = await client.DownloadSettingsAsync("engine-1", "device-1");

        Assert.True(JsonNode.DeepEquals(result, Fixtures.BareSettings()));
        Call last = handler.Calls[^1];
        Assert.Equal("GET", last.Method);
        Assert.EndsWith(Fixtures.SettingsUrl, last.Url);
        Assert.Equal("Bearer tok-1", last.Auth);
    }

    [Fact]
    public async Task UnwrapsTheV4ReplyEnvelope()
    {
        // v4 can wrap a single object in {"reply": {...}} as it does for arrays.
        var wrapped = new JsonObject { ["reply"] = Fixtures.BareSettings() };
        var (client, _) = Fixtures.MakeClient(
            Fixtures.LoginOk,
            Fixtures.Reply("GET", Fixtures.SettingsUrl, HttpStatusCode.OK, wrapped.ToJsonString()));
        await client.LoginAsync("admin", "secret");

        JsonObject result = await client.DownloadSettingsAsync("engine-1", "device-1");

        Assert.True(JsonNode.DeepEquals(result, Fixtures.BareSettings()));
    }

    [Fact]
    public async Task LeavesANonObjectReplyFieldAsIs()
    {
        var (client, _) = Fixtures.MakeClient(
            Fixtures.LoginOk,
            Fixtures.Reply("GET", Fixtures.SettingsUrl, HttpStatusCode.OK, "{\"reply\":5,\"values\":{}}"));
        await client.LoginAsync("admin", "secret");

        JsonObject result = await client.DownloadSettingsAsync("engine-1", "device-1");

        Assert.True(JsonNode.DeepEquals(result, JsonNode.Parse("{\"reply\":5,\"values\":{}}")));
    }

    [Fact]
    public void EngineErrorsAreReadThroughTheSameReplyEnvelope()
    {
        Assert.Single(NxServerClient.ExtractEngineErrors("{\"reply\":{\"_error\":{\"zone\":\"bad\"}}}"));
        Assert.Empty(NxServerClient.ExtractEngineErrors("{\"reply\":5}"));
    }

    [Fact]
    public async Task WithoutLoginThrowsApiException()
    {
        var (client, _) = Fixtures.MakeClient();
        await Assert.ThrowsAsync<ApiException>(() => client.DownloadSettingsAsync("engine-1", "device-1"));
    }
}

// ---------------------------------------------------------------------------
// BuildApplyBody(): the PUT request body the spec defines
// ---------------------------------------------------------------------------

public class BuildApplyBodyTests
{
    [Fact]
    public void DropsOnlyTheUrlIdentifiedFields()
    {
        // deviceId/engineId are not even in the spec's PUT request body: the
        // URL already identifies the device and engine. _error is the source's
        // error map and must not be echoed back. Everything else (values,
        // model, analyzedStream, disableStreamSelection) is forwarded unchanged.
        JsonObject body = NxServerClient.BuildApplyBody(Fixtures.BareSettings());

        Assert.False(body.ContainsKey("deviceId"));
        Assert.False(body.ContainsKey("engineId"));
        Assert.False(body.ContainsKey("_error"));
        Assert.Equal(50, body["values"]!["sensitivity"]!.GetValue<int>());
        Assert.Equal("SpinBox", body["model"]!["sensitivity"]!["type"]!.GetValue<string>());
        Assert.Equal("primary", body["analyzedStream"]!.GetValue<string>());
        Assert.False(body["disableStreamSelection"]!.GetValue<bool>());
        Assert.Equal(4, body.Count);
    }

    [Fact]
    public void OmitsAFieldAbsentFromTheInput()
    {
        // A partial settings file must not send a field back as null.
        var partial = new JsonObject { ["values"] = new JsonObject { ["sensitivity"] = JsonValue.Create(50) } };

        JsonObject body = NxServerClient.BuildApplyBody(partial);

        Assert.Single(body);
        Assert.False(body.ContainsKey("analyzedStream"));
        Assert.False(body.ContainsKey("disableStreamSelection"));
        Assert.False(body.ContainsKey("model"));
        Assert.False(body.ContainsKey("_error"));
    }
}

// ---------------------------------------------------------------------------
// ApplySettingsAsync(): PUT .../settings
// ---------------------------------------------------------------------------

public class ApplySettingsTests
{
    [Fact]
    public async Task SendsPutWithTheBodyToTheEngineAndDevicePath()
    {
        var (client, handler) = Fixtures.MakeClient(
            Fixtures.LoginOk,
            Fixtures.Reply("PUT", Fixtures.SettingsUrl, HttpStatusCode.OK, Fixtures.BareSettingsJson));
        await client.LoginAsync("admin", "secret");
        var body = new JsonObject { ["values"] = new JsonObject { ["sensitivity"] = JsonValue.Create(50) } };

        await client.ApplySettingsAsync("engine-1", "device-1", body);

        Call last = handler.Calls[^1];
        Assert.Equal("PUT", last.Method);
        Assert.EndsWith(Fixtures.SettingsUrl, last.Url);
        Assert.Equal("Bearer tok-1", last.Auth);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(last.Body), body));
    }

    [Fact]
    public async Task WithoutLoginThrowsApiException()
    {
        var (client, _) = Fixtures.MakeClient();
        await Assert.ThrowsAsync<ApiException>(
            () => client.ApplySettingsAsync("engine-1", "device-1", new JsonObject()));
    }
}

// ---------------------------------------------------------------------------
// DefaultOutputName(): the auto-named download destination
// ---------------------------------------------------------------------------

public class DefaultOutputNameTests
{
    [Fact]
    public void IncludesTheDeviceIdAndAUtcTimestamp()
    {
        var moment = new DateTime(2026, 9, 16, 3, 12, 0, DateTimeKind.Utc);

        string name = NxServerClient.DefaultOutputName("device-1", moment);

        Assert.Equal("nx-device-agent-settings-device-1-20260916T031200Z.json", name);
    }
}

// ---------------------------------------------------------------------------
// LogoutAsync()
// ---------------------------------------------------------------------------

public class LogoutTests
{
    [Fact]
    public async Task DeletesTheSessionAndClearsTheToken()
    {
        var (client, handler) = Fixtures.MakeClient(Fixtures.LoginOk);
        await client.LoginAsync("admin", "secret");

        await client.LogoutAsync();

        Call last = handler.Calls[^1];
        Assert.Equal("DELETE", last.Method);
        Assert.EndsWith("/rest/v4/login/sessions/tok-1", last.Url);
        Assert.Null(client.Token);
    }

    [Fact]
    public async Task WithoutATokenIsANoop()
    {
        var (client, handler) = Fixtures.MakeClient();
        await client.LogoutAsync();
        Assert.Empty(handler.Calls);
    }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

public class ConfigTests
{
    [Fact]
    public void ReadsServerAndSampleEnvVars()
    {
        var env = new Dictionary<string, string>
        {
            ["NX_SERVER_HOST"] = "https://from-env:7001",
            ["NX_SERVER_USER"] = "envuser",
            ["NX_SERVER_PASSWORD"] = "envpass",
            ["NX_DEVICE_ID"] = "device-env",
            ["NX_ANALYTICS_ENGINE_ID"] = "engine-env",
        };

        AppConfig config = Config.Resolve(new CliArgs(), new Dictionary<string, string>(), k => env.GetValueOrDefault(k));

        Assert.Equal("https://from-env:7001", config.Host);
        Assert.Equal("envuser", config.User);
        Assert.Equal("envpass", config.Password);
        Assert.Equal("device-env", config.DeviceId);
        Assert.Equal("engine-env", config.EngineId);
    }

    [Fact]
    public void CliFlagBeatsEnvWhichBeatsDotenv()
    {
        var env = new Dictionary<string, string> { ["NX_ANALYTICS_ENGINE_ID"] = "engine-env" };
        var dotenv = new Dictionary<string, string> { ["NX_ANALYTICS_ENGINE_ID"] = "engine-dotenv" };

        Assert.Equal(
            "engine-cli",
            Config.Resolve(new CliArgs { EngineId = "engine-cli" }, dotenv, k => env.GetValueOrDefault(k)).EngineId);
        Assert.Equal(
            "engine-env", Config.Resolve(new CliArgs(), dotenv, k => env.GetValueOrDefault(k)).EngineId);
        Assert.Equal(
            "engine-dotenv", Config.Resolve(new CliArgs(), dotenv, _ => null).EngineId);
    }

    [Fact]
    public void TrailingSlashIsStrippedFromHost()
    {
        AppConfig config = Config.Resolve(
            new CliArgs { Host = "https://server:7001/" }, new Dictionary<string, string>(), _ => null);
        Assert.Equal("https://server:7001", config.Host);
    }

    [Fact]
    public void ParseArgsUnknownFlagThrows()
        => Assert.Throws<ArgumentException>(() => Config.ParseArgs(new[] { "download", "--nope" }));

    [Fact]
    public void DotEnvLoadMissingFileReturnsEmpty()
        => Assert.Empty(DotEnv.Load("/nonexistent/.env"));
}

// ---------------------------------------------------------------------------
// Program.RunAsync(): shared CLI behaviour
// ---------------------------------------------------------------------------

public class MainTests
{
    private static readonly string[] Creds =
    {
        "--host", "https://server:7001",
        "--user", "admin",
        "--password", "secret",
        "--device-id", "device-1",
        "--engine-id", "engine-1",
        "--env-file", "/nonexistent/.env",
    };

    [Fact]
    public async Task NoSubcommandPrintsUsageAndExits2()
    {
        var stderr = new StringWriter();
        int rc = await Program.RunAsync(Array.Empty<string>(), null, new StringWriter(), stderr);
        Assert.Equal(2, rc);
        Assert.Contains("download", stderr.ToString());
    }

    // -----------------------------------------------------------------
    // download
    // -----------------------------------------------------------------

    [Fact]
    public async Task DownloadRefusesToOverwriteWithoutForce()
    {
        string dir = Directory.CreateTempSubdirectory("nx-copy-device-agent-settings-test-").FullName;
        try
        {
            string target = Path.Combine(dir, "already.json");
            File.WriteAllText(target, "{\"previous\": true}");
            var handler = new ScriptedHandler(Fixtures.LoginOk);
            var stderr = new StringWriter();
            var argv = new[] { "download", "--out", target }.Concat(Creds).ToArray();

            int rc = await Program.RunAsync(argv, handler, new StringWriter(), stderr);

            Assert.Equal(1, rc);
            Assert.Contains("already exists; use --force", stderr.ToString());
            // The guard runs before anything is sent, including the login.
            Assert.Empty(handler.Calls);
            Assert.Equal("{\"previous\": true}", File.ReadAllText(target));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task DownloadWritesTheSettingsFileAndSucceeds()
    {
        string dir = Directory.CreateTempSubdirectory("nx-copy-device-agent-settings-test-").FullName;
        try
        {
            string target = Path.Combine(dir, "settings.json");
            var handler = new ScriptedHandler(
                Fixtures.LoginOk,
                Fixtures.Reply("GET", Fixtures.SettingsUrl, HttpStatusCode.OK, Fixtures.BareSettingsJson));
            var stdout = new StringWriter();
            var argv = new[] { "download", "--out", target }.Concat(Creds).ToArray();

            int rc = await Program.RunAsync(argv, handler, stdout, new StringWriter());

            Assert.Equal(0, rc);
            JsonNode? written = JsonNode.Parse(File.ReadAllText(target));
            Assert.True(JsonNode.DeepEquals(written, Fixtures.BareSettings()));
            Assert.Contains("device-1", stdout.ToString());
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    // -----------------------------------------------------------------
    // apply
    // -----------------------------------------------------------------

    [Fact]
    public async Task ApplyRefusesWithoutYes()
    {
        string dir = Directory.CreateTempSubdirectory("nx-copy-device-agent-settings-test-").FullName;
        try
        {
            string settingsFile = Path.Combine(dir, "settings.json");
            File.WriteAllText(settingsFile, Fixtures.BareSettingsJson);
            var handler = new ScriptedHandler(Fixtures.LoginOk);
            var stderr = new StringWriter();
            var argv = new[] { "apply", settingsFile }.Concat(Creds).ToArray();

            int rc = await Program.RunAsync(argv, handler, new StringWriter(), stderr);

            Assert.Equal(1, rc);
            Assert.Contains("--yes", stderr.ToString());
            Assert.Empty(handler.Calls);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task ApplySucceedsAndSendsThePutBodyTheSpecDefines()
    {
        string dir = Directory.CreateTempSubdirectory("nx-copy-device-agent-settings-test-").FullName;
        try
        {
            string settingsFile = Path.Combine(dir, "settings.json");
            File.WriteAllText(settingsFile, Fixtures.BareSettingsJson);
            var handler = new ScriptedHandler(
                Fixtures.LoginOk,
                Fixtures.Reply("PUT", Fixtures.SettingsUrl, HttpStatusCode.OK, Fixtures.BareSettingsJson));
            var stdout = new StringWriter();
            var argv = new[] { "apply", settingsFile, "--yes" }.Concat(Creds).ToArray();

            int rc = await Program.RunAsync(argv, handler, stdout, new StringWriter());

            Assert.Equal(0, rc);
            Call put = handler.Calls.First(c => c.Method == "PUT");
            JsonNode? sentBody = JsonNode.Parse(put.Body);
            Assert.False(((JsonObject)sentBody!).ContainsKey("deviceId"));
            Assert.False(((JsonObject)sentBody!).ContainsKey("engineId"));
            Assert.Equal(50, sentBody["values"]!["sensitivity"]!.GetValue<int>());
            Assert.Contains("device-1", stdout.ToString());
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task ApplyReportsFailureWhenThePutIsRejected()
    {
        string dir = Directory.CreateTempSubdirectory("nx-copy-device-agent-settings-test-").FullName;
        try
        {
            string settingsFile = Path.Combine(dir, "settings.json");
            File.WriteAllText(settingsFile, Fixtures.BareSettingsJson);
            var handler = new ScriptedHandler(
                Fixtures.LoginOk, Fixtures.Reply("PUT", Fixtures.SettingsUrl, HttpStatusCode.Forbidden, ""));
            var stderr = new StringWriter();
            var argv = new[] { "apply", settingsFile, "--yes" }.Concat(Creds).ToArray();

            int rc = await Program.RunAsync(argv, handler, new StringWriter(), stderr);

            Assert.Equal(1, rc);
            Assert.Contains("ERROR", stderr.ToString());
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task ApplyRefusesAMissingFile()
    {
        string dir = Directory.CreateTempSubdirectory("nx-copy-device-agent-settings-test-").FullName;
        try
        {
            string missing = Path.Combine(dir, "nope.json");
            var handler = new ScriptedHandler(Fixtures.LoginOk);
            var stderr = new StringWriter();
            var argv = new[] { "apply", missing, "--yes" }.Concat(Creds).ToArray();

            int rc = await Program.RunAsync(argv, handler, new StringWriter(), stderr);

            Assert.Equal(1, rc);
            Assert.Contains("No such settings file", stderr.ToString());
            Assert.Empty(handler.Calls);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task ApplyNamesAnUnreadableFileWithoutAStackTrace()
    {
        if (OperatingSystem.IsWindows()) return; // no chmod 000 there
        string dir = Directory.CreateTempSubdirectory("nx-copy-device-agent-settings-test-").FullName;
        string file = Path.Combine(dir, "locked.json");
        File.WriteAllText(file, Fixtures.BareSettingsJson);
        File.SetUnixFileMode(file, UnixFileMode.None);
        try
        {
            var handler = new ScriptedHandler(Fixtures.LoginOk);
            var stderr = new StringWriter();
            var argv = new[] { "apply", file, "--yes" }.Concat(Creds).ToArray();

            int rc = await Program.RunAsync(argv, handler, new StringWriter(), stderr);

            Assert.Equal(1, rc);
            Assert.Equal($"ERROR: could not use {file}: Permission denied.", stderr.ToString().Trim());
            Assert.Empty(handler.Calls);
        }
        finally
        {
            File.SetUnixFileMode(file, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            Directory.Delete(dir, recursive: true);
        }
    }
}
