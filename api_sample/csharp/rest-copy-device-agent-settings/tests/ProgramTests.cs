// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the CLI: the guards, the exit codes, the messages, and the
// session handling on every path. Program.RunAsync takes its HTTP handler, its
// output writers and its cancellation token as arguments, so these run the
// whole CLI with no server, no network and no console.

using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using NxCopyDeviceAgentSettings;
using Xunit;

namespace NxCopyDeviceAgentSettings.Tests;

internal sealed record RunResult(int ExitCode, string Out, string Err);

public abstract class TempDirTest : IDisposable
{
    protected string Dir { get; } =
        Directory.CreateTempSubdirectory("nx-copy-device-agent-settings-test-").FullName;

    protected string PathIn(string name) => Path.Combine(Dir, name);

    public void Dispose() => Directory.Delete(Dir, recursive: true);
}

internal static class Cli
{
    public static readonly string[] Creds =
    {
        "--host", "https://server:7001",
        "--user", "admin",
        "--password", "secret",
        "--device-id", "device-1",
        "--engine-id", "engine-1",
        "--env-file", "/nonexistent/.env",
    };

    public const string LogoutUrl = "https://server:7001/rest/v4/login/sessions/tok-1";

    public static ScriptedHandler LoginOk(
        params (string Method, string Suffix, HttpStatusCode Status, string Json)[] more)
        => new(new[] { Fixtures.LoginOk }.Concat(more).ToArray());

    public static async Task<RunResult> Run(
        ScriptedHandler handler, string[] argv, CancellationToken cancellationToken = default)
    {
        var @out = new StringWriter();
        var err = new StringWriter();
        int rc = await Program.RunAsync([.. argv, .. Creds], handler, @out, err, cancellationToken);
        return new RunResult(rc, @out.ToString(), err.ToString());
    }

    public static HttpResponseMessage Text(HttpStatusCode status, string body)
        => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    public static HttpResponseMessage Redirect()
    {
        var response = new HttpResponseMessage(HttpStatusCode.Found) { Content = new StringContent("") };
        response.Headers.Location = new Uri("https://elsewhere/");
        return response;
    }

    public static string[] Deletes(ScriptedHandler handler)
        => handler.Calls.Where(c => c.Method == "DELETE").Select(c => c.Url).ToArray();
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

public class ApplyCommandTests : TempDirTest
{
    private string SettingsFile(string json)
    {
        string path = PathIn("settings.json");
        File.WriteAllText(path, json);
        return path;
    }

    private Task<RunResult> Apply(ScriptedHandler handler, CancellationToken cancellationToken = default)
        => Cli.Run(handler, ["apply", SettingsFile(Fixtures.BareSettingsJson), "--yes"], cancellationToken);

    [Fact]
    public async Task A_redirect_is_a_failure_and_still_logs_out()
    {
        var handler = Cli.LoginOk().On("PUT", Fixtures.SettingsUrl, Cli.Redirect);

        RunResult result = await Apply(handler);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("HTTP 302 (redirect not followed)", result.Err);
        Assert.DoesNotContain("Applied", result.Out);
        Assert.Equal(new[] { Cli.LogoutUrl }, Cli.Deletes(handler));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json at all")]
    [InlineData("{\"values\":{},\"_error\":{}}")]
    public async Task A_2xx_without_engine_errors_is_applied(string responseBody)
    {
        var handler = Cli.LoginOk().On("PUT", Fixtures.SettingsUrl, () => Cli.Text(HttpStatusCode.OK, responseBody));

        RunResult result = await Apply(handler);

        Assert.Equal(0, result.ExitCode);
        Assert.Contains("Applied Device Agent settings to device device-1", result.Out);
        Assert.Equal("", result.Err);
        Assert.Equal(new[] { Cli.LogoutUrl }, Cli.Deletes(handler));
    }

    [Fact]
    public async Task Engine_errors_in_a_2xx_are_reported_and_exit_1()
    {
        const string reply = "{\"values\":{},\"_error\":{\"sensitivity\":\"out of range\",\"zone\":\"bad polygon\"}}";
        var handler = Cli.LoginOk().On("PUT", Fixtures.SettingsUrl, () => Cli.Text(HttpStatusCode.OK, reply));

        RunResult result = await Apply(handler);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("The server took the settings but the Engine reported errors:", result.Err);
        Assert.Contains("sensitivity: out of range", result.Err);
        Assert.Contains("zone: bad polygon", result.Err);
        Assert.DoesNotContain("Applied", result.Out);
        Assert.Equal(new[] { Cli.LogoutUrl }, Cli.Deletes(handler));
    }

    private const string EngineErrorsReply = "{\"values\":{},\"_error\":{\"zone\":\"bad polygon\"}}";
    private const string EngineErrorsBlock =
        "ERROR: The server took the settings but the Engine reported errors:\n  zone: bad polygon\n";

    [Fact]
    public async Task Engine_errors_are_printed_before_the_logout_starts()
    {
        var err = new StringWriter();
        string? errWhenLogoutStarted = null;
        var handler = Cli.LoginOk()
            .On("PUT", Fixtures.SettingsUrl, () => Cli.Text(HttpStatusCode.OK, EngineErrorsReply))
            .On("DELETE", "/login/sessions/tok-1", () =>
            {
                errWhenLogoutStarted = err.ToString();
                return Cli.Text(HttpStatusCode.NoContent, "");
            });

        int rc = await Program.RunAsync(
            ["apply", SettingsFile(Fixtures.BareSettingsJson), "--yes", .. Cli.Creds], handler, new StringWriter(), err);

        Assert.Equal(1, rc);
        Assert.Equal(EngineErrorsBlock, errWhenLogoutStarted?.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task A_logout_refused_after_engine_errors_is_a_warning_and_keeps_exit_1()
    {
        var handler = Cli.LoginOk(Fixtures.Reply("DELETE", "/login/sessions/tok-1", HttpStatusCode.InternalServerError))
            .On("PUT", Fixtures.SettingsUrl, () => Cli.Text(HttpStatusCode.OK, EngineErrorsReply));

        RunResult result = await Apply(handler);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal(EngineErrorsBlock + "WARNING: could not log out: Logout failed: HTTP 500.\n",
            result.Err.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task Ctrl_c_during_the_logout_after_engine_errors_is_a_warning_and_keeps_exit_1()
    {
        using var interrupted = new CancellationTokenSource();
        var handler = Cli.LoginOk()
            .On("PUT", Fixtures.SettingsUrl, () => Cli.Text(HttpStatusCode.OK, EngineErrorsReply))
            .On("DELETE", "/login/sessions/tok-1", async token =>
            {
                interrupted.Cancel();
                await Task.Delay(Timeout.Infinite, token);
                throw new InvalidOperationException("unreachable");
            });

        RunResult result = await Apply(handler, interrupted.Token);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal(EngineErrorsBlock + "WARNING: could not log out: interrupted.\n",
            result.Err.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task A_null_engine_error_message_reads_null()
    {
        var handler = Cli.LoginOk().On("PUT", Fixtures.SettingsUrl,
            () => Cli.Text(HttpStatusCode.OK, "{\"_error\":{\"zone\":null}}"));

        RunResult result = await Apply(handler);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("  zone: null\n", result.Err.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task A_logout_timeout_after_success_names_the_timeout_not_httpclient()
    {
        var handler = Cli.LoginOk().On("DELETE", "/login/sessions/tok-1", () => throw new TaskCanceledException(
            "The request was canceled due to the configured HttpClient.Timeout of 30 seconds elapsing.",
            new TimeoutException()));

        RunResult result = await Apply(handler);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal("WARNING: could not log out: no answer within 30 s.\n", result.Err.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task A_failed_apply_with_a_failing_logout_shows_only_the_apply_error()
    {
        var handler = Cli.LoginOk(
            Fixtures.Reply("PUT", Fixtures.SettingsUrl, HttpStatusCode.NotFound, ""),
            Fixtures.Reply("DELETE", "/login/sessions/tok-1", HttpStatusCode.InternalServerError));

        RunResult result = await Apply(handler);

        Assert.Equal(1, result.ExitCode);
        Assert.DoesNotContain("WARNING", result.Err);
    }

    [Fact]
    public async Task The_source_error_map_is_not_sent_back()
    {
        JsonObject settings = Fixtures.BareSettings();
        settings["_error"] = new JsonObject { ["sensitivity"] = JsonValue.Create("old error") };
        var handler = Cli.LoginOk();

        RunResult result = await Cli.Run(handler, ["apply", SettingsFile(settings.ToJsonString()), "--yes"]);

        Assert.Equal(0, result.ExitCode);
        var sent = (JsonObject)JsonNode.Parse(handler.Calls.Single(c => c.Method == "PUT").Body)!;
        Assert.False(sent.ContainsKey("_error"));
        Assert.False(sent.ContainsKey("deviceId"));
        Assert.False(sent.ContainsKey("engineId"));
        Assert.Equal("primary", sent["analyzedStream"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("[1, 2]")]
    [InlineData("\"just a string\"")]
    [InlineData("null")]
    [InlineData("42")]
    public async Task A_file_that_is_not_a_json_object_is_refused_before_login(string json)
    {
        var handler = Cli.LoginOk();

        RunResult result = await Cli.Run(handler, ["apply", SettingsFile(json), "--yes"]);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal($"ERROR: {PathIn("settings.json")} does not hold a JSON object.\n",
            result.Err.ReplaceLineEndings("\n"));
        Assert.Empty(handler.Calls);
    }

    [Fact]
    public async Task A_file_that_is_not_json_is_refused_before_login()
    {
        var handler = Cli.LoginOk();

        RunResult result = await Cli.Run(handler, ["apply", SettingsFile("{not json"), "--yes"]);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("is not valid JSON:", result.Err);
        // The parser's reason, then exactly one final period.
        Assert.EndsWith(".\n", result.Err.ReplaceLineEndings("\n"));
        Assert.DoesNotContain("..\n", result.Err.ReplaceLineEndings("\n"));
        Assert.DoesNotContain("   at ", result.Err);
        Assert.Empty(handler.Calls);
    }

    [Fact]
    public async Task A_directory_is_refused_before_login()
    {
        var handler = Cli.LoginOk();

        RunResult result = await Cli.Run(handler, ["apply", Dir, "--yes"]);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("is a directory", result.Err);
        Assert.Empty(handler.Calls);
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest)]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.Forbidden)]
    public async Task A_failed_apply_still_logs_out(HttpStatusCode status)
    {
        var handler = Cli.LoginOk(Fixtures.Reply("PUT", Fixtures.SettingsUrl, status, ""));

        RunResult result = await Apply(handler);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains($"HTTP {(int)status}", result.Err);
        Assert.Equal(new[] { Cli.LogoutUrl }, Cli.Deletes(handler));
    }

    [Fact]
    public async Task A_redirect_says_not_applied_without_the_engine_hint()
    {
        var handler = Cli.LoginOk().On("PUT", Fixtures.SettingsUrl, Cli.Redirect);

        RunResult result = await Apply(handler);

        Assert.Equal(
            "ERROR: Applying settings failed: HTTP 302 (redirect not followed). The settings were not applied.\n",
            result.Err.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task A_4xx_says_not_applied_with_the_engine_hint()
    {
        var handler = Cli.LoginOk(Fixtures.Reply("PUT", Fixtures.SettingsUrl, HttpStatusCode.NotFound, ""));

        RunResult result = await Apply(handler);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal(
            "ERROR: Applying settings failed: HTTP 404. The settings were not applied. "
            + "The target device may not be running this Engine.\n",
            result.Err.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task A_5xx_says_some_settings_may_have_been_applied()
    {
        var handler = Cli.LoginOk(Fixtures.Reply("PUT", Fixtures.SettingsUrl, HttpStatusCode.InternalServerError, ""));

        RunResult result = await Apply(handler);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal(
            "ERROR: Applying settings failed: HTTP 500. The server may have applied some of them; "
            + "download the device's settings to check.\n",
            result.Err.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task A_failing_logout_after_success_is_only_a_warning()
    {
        var handler = Cli.LoginOk().On("DELETE", "/login/sessions/tok-1", () => throw new HttpRequestException(
            "An error occurred while sending the request.", new IOException("Connection reset by peer")));

        RunResult result = await Apply(handler);

        Assert.Equal(0, result.ExitCode);
        Assert.Contains("Applied Device Agent settings", result.Out);
        Assert.Contains("WARNING: could not log out", result.Err);
        Assert.DoesNotContain("ERROR", result.Err);
    }

    [Fact]
    public async Task A_logout_refused_after_success_is_only_a_warning()
    {
        var handler = Cli.LoginOk(Fixtures.Reply("DELETE", "/login/sessions/tok-1", HttpStatusCode.InternalServerError));

        RunResult result = await Apply(handler);

        Assert.Equal(0, result.ExitCode);
        Assert.Contains("Applied Device Agent settings", result.Out);
        Assert.Equal("WARNING: could not log out: Logout failed: HTTP 500.\n", result.Err.ReplaceLineEndings("\n"));
    }

    public static IEnumerable<object[]> DropsAfterSending() => new[]
    {
        new object[] { new HttpRequestException(
            "An error occurred while sending the request.", new IOException("Connection reset by peer")) },
        new object[] { new HttpRequestException(
            HttpRequestError.ResponseEnded, "The response ended prematurely.") },
        new object[] { new TaskCanceledException("The request was canceled due to the configured HttpClient.Timeout",
            new TimeoutException()) },
        new object[] { new HttpIOException(HttpRequestError.ResponseEnded, "The response ended prematurely.") },
    };

    [Theory]
    [MemberData(nameof(DropsAfterSending))]
    public async Task A_connection_lost_after_sending_gives_an_unknown_outcome(Exception drop)
    {
        var handler = Cli.LoginOk().On("PUT", Fixtures.SettingsUrl, () => throw drop);

        RunResult result = await Apply(handler);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains(
            "Outcome unknown: the connection was lost after the settings were sent. "
            + "Download the device's settings to check.", result.Err);
        Assert.DoesNotContain("not applied", result.Err);
        Assert.Equal(new[] { Cli.LogoutUrl }, Cli.Deletes(handler));
    }

    [Fact]
    public async Task A_connection_never_made_says_not_applied()
    {
        var handler = new ScriptedHandler().On("POST", "/login/sessions", () => throw new HttpRequestException(
            HttpRequestError.ConnectionError, "Connection refused (server:7001)", new SocketException(61)));

        RunResult result = await Apply(handler);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("could not reach the server", result.Err);
        Assert.Contains("not applied", result.Err);
        Assert.DoesNotContain("Outcome unknown", result.Err);
    }

    [Fact]
    public async Task A_refused_connect_on_the_put_itself_says_not_applied()
    {
        var handler = Cli.LoginOk().On("PUT", Fixtures.SettingsUrl, () => throw new HttpRequestException(
            HttpRequestError.ConnectionError, "Connection refused (server:7001)", new SocketException(61)));

        RunResult result = await Apply(handler);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("could not reach the server", result.Err);
        Assert.Contains("not applied", result.Err);
    }

    [Fact]
    public async Task Ctrl_c_mid_apply_logs_out_and_exits_130()
    {
        using var interrupted = new CancellationTokenSource();
        var handler = Cli.LoginOk().On("PUT", Fixtures.SettingsUrl, async token =>
        {
            interrupted.Cancel();
            await Task.Delay(Timeout.Infinite, token);
            throw new InvalidOperationException("unreachable");
        });

        RunResult result = await Apply(handler, interrupted.Token);

        Assert.Equal(130, result.ExitCode);
        Assert.Contains("Interrupted. Outcome unknown", result.Err);
        Assert.Equal(new[] { Cli.LogoutUrl }, Cli.Deletes(handler));
    }

    [Fact]
    public async Task After_ctrl_c_a_hanging_logout_is_given_up_after_3_s()
    {
        using var interrupted = new CancellationTokenSource();
        var handler = Cli.LoginOk()
            .On("PUT", Fixtures.SettingsUrl, async token =>
            {
                interrupted.Cancel();
                await Task.Delay(Timeout.Infinite, token);
                throw new InvalidOperationException("unreachable");
            })
            .On("DELETE", "/login/sessions/tok-1", async token =>
            {
                await Task.Delay(Timeout.Infinite, token);
                throw new InvalidOperationException("unreachable");
            });

        var clock = System.Diagnostics.Stopwatch.StartNew();
        RunResult result = await Apply(handler, interrupted.Token);

        Assert.Equal(130, result.ExitCode);
        Assert.InRange(clock.Elapsed, Program.InterruptedLogoutTimeout, TimeSpan.FromSeconds(10));
        Assert.Equal(new[] { Cli.LogoutUrl }, Cli.Deletes(handler));
    }

    [Fact]
    public async Task Ctrl_c_during_the_final_logout_is_only_a_warning_and_keeps_exit_0()
    {
        // The settings are applied once "Applied ..." is printed: Ctrl-C after that
        // only cuts the logout short (after its 3 s cap) and does not make it a failure.
        using var interrupted = new CancellationTokenSource();
        var handler = Cli.LoginOk().On("DELETE", "/login/sessions/tok-1", async token =>
        {
            interrupted.Cancel();
            await Task.Delay(Timeout.Infinite, token);
            throw new InvalidOperationException("unreachable");
        });

        RunResult result = await Apply(handler, interrupted.Token);

        Assert.Equal(0, result.ExitCode);
        Assert.Contains("Applied Device Agent settings to device device-1", result.Out);
        Assert.Equal("WARNING: could not log out: interrupted.\n", result.Err.ReplaceLineEndings("\n"));
    }

    [Fact]
    public void Only_the_first_ctrl_c_is_cancelled()
    {
        using var interrupted = new CancellationTokenSource();

        Assert.True(Program.OnInterrupt(interrupted));
        Assert.True(interrupted.IsCancellationRequested);
        // The second one is let through, so the process ends at once.
        Assert.False(Program.OnInterrupt(interrupted));
    }
}

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

public class DownloadCommandTests : TempDirTest
{
    [Fact]
    public async Task A_directory_as_out_is_refused_before_login()
    {
        var handler = Cli.LoginOk();

        RunResult result = await Cli.Run(handler, ["download", "--out", Dir, "--force"]);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("is a directory", result.Err);
        Assert.Empty(handler.Calls);
    }

    [Fact]
    public async Task A_redirect_is_a_failure_and_still_logs_out()
    {
        var handler = Cli.LoginOk().On("GET", Fixtures.SettingsUrl, Cli.Redirect);

        RunResult result = await Cli.Run(handler, ["download", "--out", PathIn("out.json")]);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("HTTP 302 (redirect not followed)", result.Err);
        Assert.Empty(Directory.GetFileSystemEntries(Dir));
        Assert.Equal(new[] { Cli.LogoutUrl }, Cli.Deletes(handler));
    }

    [Theory]
    [InlineData("[1, 2]")]
    [InlineData("not json")]
    [InlineData("")]
    public async Task A_body_that_is_not_a_json_object_fails(string body)
    {
        var handler = Cli.LoginOk().On("GET", Fixtures.SettingsUrl, () => Cli.Text(HttpStatusCode.OK, body));

        RunResult result = await Cli.Run(handler, ["download", "--out", PathIn("out.json")]);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("the server did not return a JSON object", result.Err);
        Assert.Empty(Directory.GetFileSystemEntries(Dir));
        Assert.Equal(new[] { Cli.LogoutUrl }, Cli.Deletes(handler));
    }

    [Fact]
    public async Task A_file_that_appears_during_the_download_is_not_overwritten()
    {
        string target = PathIn("out.json");
        var handler = Cli.LoginOk().On("GET", Fixtures.SettingsUrl, () =>
        {
            File.WriteAllText(target, "theirs");
            return Cli.Text(HttpStatusCode.OK, Fixtures.BareSettingsJson);
        });

        RunResult result = await Cli.Run(handler, ["download", "--out", target]);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains($"ERROR: {target} already exists; use --force", result.Err);
        Assert.Equal("theirs", File.ReadAllText(target));
        // The side file is gone too.
        Assert.Equal(new[] { target }, Directory.GetFiles(Dir));
        Assert.Equal(new[] { Cli.LogoutUrl }, Cli.Deletes(handler));
    }

    [Fact]
    public async Task With_force_a_file_that_appeared_is_replaced()
    {
        string target = PathIn("out.json");
        var handler = Cli.LoginOk().On("GET", Fixtures.SettingsUrl, () =>
        {
            File.WriteAllText(target, "theirs");
            return Cli.Text(HttpStatusCode.OK, Fixtures.BareSettingsJson);
        });

        RunResult result = await Cli.Run(handler, ["download", "--out", target, "--force"]);

        Assert.Equal(0, result.ExitCode);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(File.ReadAllText(target)), Fixtures.BareSettings()));
        Assert.Equal(new[] { target }, Directory.GetFiles(Dir));
    }

    [Fact]
    public async Task The_auto_named_file_is_not_overwritten_either()
    {
        // The auto name carries a timestamp to the second, so a file can still
        // appear under it during the download; it must not be clobbered.
        string cwd = Environment.CurrentDirectory;
        var planted = new List<string>();
        var handler = Cli.LoginOk().On("GET", Fixtures.SettingsUrl, () =>
        {
            DateTime now = DateTime.UtcNow;
            for (int s = -5; s <= 0; s++)
            {
                string name = Path.Combine(cwd, NxServerClient.DefaultOutputName("device-1", now.AddSeconds(s)));
                if (!File.Exists(name))
                {
                    File.WriteAllText(name, "theirs");
                    planted.Add(name);
                }
            }
            return Cli.Text(HttpStatusCode.OK, Fixtures.BareSettingsJson);
        });

        try
        {
            RunResult result = await Cli.Run(handler, ["download"]);

            Assert.Equal(1, result.ExitCode);
            Assert.Contains("already exists; use --force", result.Err);
            Assert.All(planted, f => Assert.Equal("theirs", File.ReadAllText(f)));
            Assert.Empty(Directory.GetFiles(cwd, "nx-device-agent-settings-device-1-*.partial"));
        }
        finally
        {
            foreach (string f in planted) File.Delete(f);
        }
    }

    [Fact]
    public void The_saved_file_is_owner_only_and_no_side_file_remains()
    {
        if (OperatingSystem.IsWindows()) return;
        string target = PathIn("out.json");

        NxServerClient.SaveSettingsFile(target, Fixtures.BareSettings());

        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(target));
        Assert.Equal(new[] { target }, Directory.GetFiles(Dir));
    }

    [Fact]
    public async Task A_failed_download_still_logs_out()
    {
        var handler = Cli.LoginOk(Fixtures.Reply("GET", Fixtures.SettingsUrl, HttpStatusCode.InternalServerError, ""));

        RunResult result = await Cli.Run(handler, ["download", "--out", PathIn("out.json")]);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal("ERROR: Reading settings failed: HTTP 500.\n", result.Err.ReplaceLineEndings("\n"));
        Assert.Equal(new[] { Cli.LogoutUrl }, Cli.Deletes(handler));
    }

    [Fact]
    public async Task A_failing_logout_after_a_download_is_only_a_warning()
    {
        string target = PathIn("out.json");
        var handler = Cli.LoginOk(Fixtures.Reply("GET", Fixtures.SettingsUrl, HttpStatusCode.OK, Fixtures.BareSettingsJson))
            .On("DELETE", "/login/sessions/tok-1", () => throw new HttpRequestException("reset"));

        RunResult result = await Cli.Run(handler, ["download", "--out", target]);

        Assert.Equal(0, result.ExitCode);
        Assert.Contains("Downloaded Device Agent settings", result.Out);
        // The reason gets exactly one final period.
        Assert.Equal("WARNING: could not log out: reset.\n", result.Err.ReplaceLineEndings("\n"));
        Assert.True(File.Exists(target));
    }

    [Fact]
    public async Task A_failed_download_with_a_failing_logout_shows_only_the_get_error()
    {
        var handler = Cli.LoginOk(
            Fixtures.Reply("GET", Fixtures.SettingsUrl, HttpStatusCode.InternalServerError, ""),
            Fixtures.Reply("DELETE", "/login/sessions/tok-1", HttpStatusCode.InternalServerError));

        RunResult result = await Cli.Run(handler, ["download", "--out", PathIn("out.json")]);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal("ERROR: Reading settings failed: HTTP 500.\n", result.Err.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task A_dangling_symlink_as_out_is_refused_before_login()
    {
        if (OperatingSystem.IsWindows()) return;
        string link = PathIn("out.json");
        File.CreateSymbolicLink(link, PathIn("missing-target.json"));
        var handler = Cli.LoginOk();

        RunResult result = await Cli.Run(handler, ["download", "--out", link]);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal($"ERROR: {link} already exists; use --force\n", result.Err.ReplaceLineEndings("\n"));
        Assert.Empty(handler.Calls);
    }

    [Fact]
    public async Task Ctrl_c_mid_download_logs_out_leaves_no_file_and_exits_130()
    {
        using var interrupted = new CancellationTokenSource();
        var handler = Cli.LoginOk().On("GET", Fixtures.SettingsUrl, async token =>
        {
            interrupted.Cancel();
            await Task.Delay(Timeout.Infinite, token);
            throw new InvalidOperationException("unreachable");
        });

        RunResult result = await Cli.Run(handler, ["download", "--out", PathIn("out.json")], interrupted.Token);

        Assert.Equal(130, result.ExitCode);
        Assert.Contains("Interrupted.", result.Err);
        Assert.Empty(Directory.GetFileSystemEntries(Dir));
        Assert.Equal(new[] { Cli.LogoutUrl }, Cli.Deletes(handler));
    }
}

// ---------------------------------------------------------------------------
// Login wording, the command line, and the transport errors
// ---------------------------------------------------------------------------

public class LoginAndCliTests : TempDirTest
{
    [Theory]
    [InlineData(HttpStatusCode.InternalServerError, "{}", "Login failed: HTTP 500.")]
    [InlineData(HttpStatusCode.OK, "<html>not json</html>", "Login failed: the response was not valid JSON.")]
    [InlineData(HttpStatusCode.OK, "{}", "Login failed: the response did not contain a token.")]
    [InlineData(HttpStatusCode.OK, "[{\"token\":\"tok-1\"}]", "Login failed: the response did not contain a token.")]
    [InlineData(HttpStatusCode.OK, "{\"token\":42}", "Login failed: the response did not contain a token.")]
    public async Task Login_failures_say_what_went_wrong(HttpStatusCode status, string body, string expected)
    {
        var handler = new ScriptedHandler(Fixtures.Reply("POST", "/login/sessions", status, body));

        RunResult result = await Cli.Run(handler, ["download", "--out", PathIn("out.json")]);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal($"ERROR: {expected}\n", result.Err.ReplaceLineEndings("\n"));
        Assert.DoesNotContain("could not reach the server", result.Err);
    }

    [Fact]
    public async Task A_login_redirect_is_not_followed()
    {
        var handler = new ScriptedHandler().On("POST", "/login/sessions", Cli.Redirect);

        RunResult result = await Cli.Run(handler, ["download", "--out", PathIn("out.json")]);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("Login failed: HTTP 302 (redirect not followed)", result.Err);
        Assert.Single(handler.Calls);
    }

    [Theory]
    [InlineData("--yes=no")]
    [InlineData("--yes=false")]
    [InlineData("--force=no")]
    [InlineData("--insecure=false")]
    public async Task A_boolean_flag_given_a_value_is_a_usage_error(string flag)
    {
        // Otherwise --yes=no would confirm the apply it was meant to refuse.
        string file = PathIn("settings.json");
        File.WriteAllText(file, Fixtures.BareSettingsJson);
        var handler = Cli.LoginOk();

        RunResult result = await Cli.Run(handler, ["apply", file, flag]);

        Assert.Equal(2, result.ExitCode);
        Assert.Equal($"ERROR: {flag[..flag.IndexOf('=')]} takes no value\n", result.Err.ReplaceLineEndings("\n"));
        Assert.Empty(handler.Calls);
    }

    [Theory]
    [InlineData("download", "--out")]
    [InlineData("download", "--out", "--force")]
    [InlineData("download", "--out=")]
    [InlineData("download", "--device-id=")]
    public async Task A_value_flag_without_a_value_is_a_usage_error(params string[] argv)
    {
        var handler = Cli.LoginOk();
        var err = new StringWriter();

        // Flags first, then the value flag last, so "--out" really is at the end.
        int rc = await Program.RunAsync([.. Cli.Creds, .. argv], handler, new StringWriter(), err);

        Assert.Equal(2, rc);
        string flag = argv[1].Split('=')[0];
        Assert.Equal($"ERROR: Missing value for {flag}\n", err.ToString().ReplaceLineEndings("\n"));
        Assert.Empty(handler.Calls);
    }

    [Fact]
    public async Task A_tls_failure_points_at_insecure()
    {
        var handler = new ScriptedHandler().On("POST", "/login/sessions", () => throw new HttpRequestException(
            HttpRequestError.SecureConnectionError,
            "The SSL connection could not be established, see inner exception.",
            new System.Security.Authentication.AuthenticationException(
                "The remote certificate is invalid according to the validation procedure.")));

        RunResult result = await Cli.Run(handler, ["download", "--out", PathIn("out.json")]);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("ERROR: certificate verification failed", result.Err);
        Assert.Contains("--insecure", result.Err);
    }

    [Fact]
    public async Task A_login_timeout_exits_1_without_a_stack_trace()
    {
        var handler = new ScriptedHandler().On("POST", "/login/sessions",
            () => throw new TaskCanceledException("timeout", new TimeoutException()));

        RunResult result = await Cli.Run(handler, ["download", "--out", PathIn("out.json")]);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("ERROR: could not reach the server", result.Err);
        Assert.DoesNotContain("   at ", result.Err);
    }

    [Fact]
    public async Task An_unwritable_out_blames_the_file()
    {
        var handler = Cli.LoginOk(Fixtures.Reply("GET", Fixtures.SettingsUrl, HttpStatusCode.OK, Fixtures.BareSettingsJson));

        string outPath = PathIn(Path.Combine("no-such-folder", "out.json"));

        RunResult result = await Cli.Run(handler, ["download", "--out", outPath]);

        Assert.Equal(1, result.ExitCode);
        // The --out path the user gave, never the side file; the OS reason, no path in it.
        Assert.Equal($"ERROR: could not use {outPath}: No such file or directory.\n",
            result.Err.ReplaceLineEndings("\n"));
        Assert.DoesNotContain(".partial", result.Err);
        Assert.Equal(new[] { Cli.LogoutUrl }, Cli.Deletes(handler));
    }

    [Fact]
    public void A_local_file_reason_has_no_path_in_it()
    {
        Assert.Equal("No such file or directory",
            LocalPath.Reason(new DirectoryNotFoundException("Could not find a part of the path '/x/y.partial'.")));
        Assert.Equal("Permission denied",
            LocalPath.Reason(new UnauthorizedAccessException("Access to the path '/x/y.partial' is denied.")));
        Assert.Equal("The process cannot access the file because it is being used by another process",
            LocalPath.Reason(new IOException(
                "The process cannot access the file '/x/y.partial' because it is being used by another process.")));
    }

    [Fact]
    public void A_dangling_symlink_counts_as_an_existing_path()
    {
        if (OperatingSystem.IsWindows()) return;
        string link = PathIn("dangling.json");
        File.CreateSymbolicLink(link, PathIn("missing-target.json"));

        Assert.True(LocalPath.Exists(link));
        Assert.False(LocalPath.Exists(PathIn("nothing-here.json")));
    }
}

// ---------------------------------------------------------------------------
// Connect timeout vs request timeout, through a real SocketsHttpHandler
// ---------------------------------------------------------------------------

/// <summary>Answers login and logout itself; everything else goes to the real handler.</summary>
internal sealed class LoginLocally : DelegatingHandler
{
    public LoginLocally(HttpMessageHandler inner) : base(inner) { }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (request.RequestUri!.AbsolutePath.Contains("/login/sessions"))
        {
            return Task.FromResult(Cli.Text(HttpStatusCode.OK, "{\"token\":\"tok-1\"}"));
        }
        return base.SendAsync(request, cancellationToken);
    }
}

public class ConnectTimeoutTests : TempDirTest
{
    private static readonly TimeSpan ShortConnect = TimeSpan.FromMilliseconds(200);

    /// <summary>A connect that never completes, like a host that drops SYNs.</summary>
    private static async ValueTask<Stream> HangInConnect(DnsEndPoint _, CancellationToken token)
    {
        await Task.Delay(Timeout.Infinite, token);
        throw new InvalidOperationException("unreachable");
    }

    private static SocketsHttpHandler HangingConnectHandler() => new()
    {
        AllowAutoRedirect = false,
        ConnectCallback = Program.ConnectWithTimeout(ShortConnect, HangInConnect),
    };

    private static async Task<RunResult> Run(HttpMessageHandler handler, string[] argv)
    {
        var @out = new StringWriter();
        var err = new StringWriter();
        int rc = await Program.RunAsync([.. argv, .. Cli.Creds], handler, @out, err);
        return new RunResult(rc, @out.ToString(), err.ToString());
    }

    [Fact]
    public async Task A_connect_timeout_on_login_could_not_reach_the_server()
    {
        using SocketsHttpHandler handler = HangingConnectHandler();

        RunResult result = await Run(handler, ["download", "--out", PathIn("out.json")]);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal("ERROR: could not reach the server: no connection within 0.2 s (server:7001).\n",
            result.Err.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task A_connect_timeout_on_apply_says_not_applied()
    {
        string file = PathIn("settings.json");
        File.WriteAllText(file, Fixtures.BareSettingsJson);
        using SocketsHttpHandler sockets = HangingConnectHandler();
        using var handler = new LoginLocally(sockets);

        RunResult result = await Run(handler, ["apply", file, "--yes"]);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal(
            "ERROR: could not reach the server: no connection within 0.2 s (server:7001). "
            + "The settings were not applied.\n",
            result.Err.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task A_request_timeout_after_connecting_is_an_unknown_outcome()
    {
        // A listener that accepts the connection and never answers: the PUT goes out.
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var endPoint = (IPEndPoint)listener.LocalEndpoint;
        async ValueTask<Stream> ConnectToListener(DnsEndPoint _, CancellationToken token)
        {
            var socket = new Socket(SocketType.Stream, ProtocolType.Tcp);
            await socket.ConnectAsync(endPoint, token);
            return new NetworkStream(socket, ownsSocket: true);
        }
        using var sockets = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            ConnectCallback = Program.ConnectWithTimeout(TimeSpan.FromSeconds(5), ConnectToListener),
        };
        using var http = new HttpClient(new LoginLocally(sockets)) { Timeout = TimeSpan.FromMilliseconds(500) };
        var client = new NxServerClient(http, "http://server:7001");
        await client.LoginAsync("admin", "secret");

        var error = await Assert.ThrowsAsync<ApiException>(
            () => client.ApplySettingsAsync("engine-1", "device-1", new JsonObject()));

        Assert.Equal(NxServerClient.OutcomeUnknownMessage, error.Message);
    }
}
