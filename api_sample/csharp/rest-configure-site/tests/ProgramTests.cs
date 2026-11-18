// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the CLI: exit codes, which stream each line goes to, and the
// clean-up. Program.RunAsync takes its client factory, its environment and its
// output writers as arguments, so these run the whole CLI with no server, no
// network and no console.

using System.Security.Authentication;
using NxConfigureSite;
using Xunit;

namespace NxConfigureSite.Tests;

public class ProgramTests : TempDirTest
{
    /// <summary>Swaps the real clients for fakes that share one call log.</summary>
    private sealed class Fakes
    {
        public List<Call> Log { get; } = new();
        public FakeServer? Server { get; private set; }
        public FakeCloud? Cloud { get; private set; }
        public string? ServerFail { get; set; }
        public string? CloudFail { get; set; }
        public SiteInfo Info { get; set; } = FakeServer.New;
        public Exception? ServerInfoError { get; set; }
        public Exception? ServerLoginError { get; set; }
        public Exception? ServerLogoutError { get; set; }

        public ClientFactory Factory => new(
            (host, verifyTls) =>
            {
                Server = new FakeServer(Log)
                {
                    Info = Info,
                    Fail = ServerFail,
                    InfoError = ServerInfoError,
                    LoginError = ServerLoginError,
                    LogoutError = ServerLogoutError,
                    Host = host,
                    VerifyTls = verifyTls,
                };
                return Server;
            },
            (url, verifyTls) =>
            {
                Cloud = new FakeCloud(Log) { Fail = CloudFail };
                return Cloud.Make(url, verifyTls);
            });
    }

    private string WriteEnvFile(Dictionary<string, string> values)
    {
        string path = PathIn(".env");
        File.WriteAllText(path, string.Join("\n", values.Select(pair => $"{pair.Key}={pair.Value}")));
        return path;
    }

    private string WriteSettingsFile(string text)
    {
        string path = PathIn("site_settings.json");
        File.WriteAllText(path, text);
        return path;
    }

    private string None => PathIn("none.json");

    private string StatisticsOff => WriteSettingsFile("{\"statisticsAllowed\": false}");

    private static async Task<(int Code, string Out, string Err)> RunMain(Fakes fakes, params string[] argv)
    {
        var @out = new StringWriter();
        var err = new StringWriter();
        int code = await Program.RunAsync(argv, @out, err, fakes.Factory, Env.None);
        return (code, @out.ToString(), err.ToString());
    }

    [Fact]
    public async Task Main_runs_the_flow_prints_a_summary_and_exits_0()
    {
        var fakes = new Fakes();

        var (code, output, _) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", StatisticsOff);

        Assert.Equal(0, code);
        Assert.Contains("My Site", output);
        Assert.Contains("statisticsAllowed", output);
        Assert.True(fakes.Server!.LoggedOut);
        Assert.Equal("https://server:7001", fakes.Server.Host);
    }

    [Fact]
    public async Task Main_with_a_missing_required_value_exits_2_and_runs_nothing()
    {
        var fakes = new Fakes();

        var (code, _, err) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Without(Env.Server, "NX_SITE_NAME")));

        Assert.Equal(2, code);
        Assert.Contains("NX_SITE_NAME", err);
        Assert.Empty(fakes.Log);
    }

    [Theory]
    [InlineData("NX_SERVER_HOST", "not-a-url")]
    [InlineData("NX_SERVER_HOST", "http://bad host:7001")]
    [InlineData("NX_CLOUD_HOST", "not-a-url")]
    public async Task Main_with_an_address_that_is_not_a_url_exits_2_and_builds_no_client(
        string name, string value)
    {
        var fakes = new Fakes();

        var (code, _, err) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.With(Env.Cloud, name, value)), "--settings-file", None);

        Assert.Equal(2, code);
        Assert.StartsWith("ERROR: ", err);
        Assert.Contains("must be a full URL", err);
        Assert.Contains(name, err);
        Assert.Null(fakes.Server);
        Assert.Null(fakes.Cloud);
        Assert.Empty(fakes.Log);
    }

    [Fact]
    public async Task Main_with_an_unsupported_setting_exits_2_and_runs_nothing()
    {
        var fakes = new Fakes();
        string settings = WriteSettingsFile("{\"auditTrailEnabled\": true}");

        var (code, _, err) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", settings);

        Assert.Equal(2, code);
        Assert.Contains("auditTrailEnabled", err);
        Assert.Empty(fakes.Log);
    }

    [Fact]
    public async Task Main_says_so_when_the_settings_file_is_not_found()
    {
        var (_, _, err) = await RunMain(new Fakes(),
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", PathIn("typo.json"));

        Assert.Contains(
            $"Note: {PathIn("typo.json")} not found. A new site gets the default settings, "
            + "an existing one keeps its own.", err);
    }

    [Fact]
    public async Task Main_with_an_env_file_that_is_a_directory_exits_2_and_runs_nothing()
    {
        var fakes = new Fakes();

        var (code, _, err) = await RunMain(fakes, "--env-file", Dir, "--settings-file", None);

        Assert.Equal(2, code);
        Assert.Equal($"ERROR: Cannot read {Dir}: it is a directory.\n", err.ReplaceLineEndings("\n"));
        Assert.Empty(fakes.Log);
    }

    [Fact]
    public async Task Main_with_a_settings_file_that_is_a_directory_exits_2_and_runs_nothing()
    {
        var fakes = new Fakes();

        var (code, _, err) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", Dir);

        Assert.Equal(2, code);
        Assert.Equal($"ERROR: Cannot read {Dir}: it is a directory.\n", err.ReplaceLineEndings("\n"));
        Assert.DoesNotContain("not found", err);
        Assert.Empty(fakes.Log);
    }

    [Theory]
    [InlineData("server.get_site_info")]
    [InlineData("server.setup")]
    [InlineData("server.login")]
    [InlineData("server.apply_settings")]
    public async Task Main_exits_1_when_a_server_step_fails_and_still_logs_out(string failing)
    {
        var fakes = new Fakes { ServerFail = failing };

        var (code, _, err) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", StatisticsOff);

        Assert.Equal(1, code);
        Assert.Contains($"{failing} failed", err);
        Assert.True(fakes.Server!.LoggedOut);
    }

    [Theory]
    [InlineData("cloud.login")]
    [InlineData("cloud.register_site")]
    public async Task Main_exits_1_when_a_cloud_step_fails_and_still_logs_out(string failing)
    {
        var fakes = new Fakes { CloudFail = failing };

        var (code, _, _) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Cloud), "--settings-file", None);

        Assert.Equal(1, code);
        Assert.True(fakes.Server!.LoggedOut);
    }

    [Fact]
    public async Task Main_revokes_the_cloud_token_after_a_run()
    {
        var fakes = new Fakes();

        var (code, _, _) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Cloud), "--settings-file", None);

        Assert.Equal(0, code);
        Assert.True(fakes.Cloud!.LoggedOut);
        Assert.Equal(new[] { "server.logout", "cloud.logout" }, fakes.Log.Names().TakeLast(2));
    }

    [Theory]
    [InlineData("cloud.register_site")]
    [InlineData("server.setup")]
    public async Task Main_revokes_the_cloud_token_after_a_failed_run(string failing)
    {
        var fakes = failing.StartsWith("cloud.", StringComparison.Ordinal)
            ? new Fakes { CloudFail = failing }
            : new Fakes { ServerFail = failing };

        var (code, _, _) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Cloud), "--settings-file", None);

        Assert.Equal(1, code);
        Assert.True(fakes.Cloud!.LoggedOut);
    }

    [Fact]
    public async Task A_run_without_the_cloud_revokes_nothing()
    {
        var fakes = new Fakes();

        await RunMain(fakes, "--env-file", WriteEnvFile(Env.Server), "--settings-file", None);

        Assert.Null(fakes.Cloud);
        Assert.DoesNotContain("cloud.logout", fakes.Log.Names());
    }

    [Fact]
    public async Task Main_exits_1_on_a_rejected_login()
    {
        var fakes = new Fakes
        {
            ServerLoginError = new AuthException("Login forbidden (HTTP 403). This account may not do this."),
        };

        var (code, _, err) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", None);

        Assert.Equal(1, code);
        Assert.Contains("may not do this", err);
    }

    [Fact]
    public async Task Main_exits_1_with_a_hint_when_the_server_is_unreachable()
    {
        var fakes = new Fakes { ServerInfoError = new HttpRequestException("no route") };

        var (code, _, err) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", None);

        Assert.Equal(1, code);
        Assert.Contains("https://server:7001", err);
    }

    [Fact]
    public async Task Main_reports_a_failed_request_with_the_host_and_the_detail()
    {
        var fakes = new Fakes { ServerInfoError = new HttpRequestException("no route") };

        var (code, _, err) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", WriteSettingsFile("{}"));

        Assert.Equal(1, code);
        Assert.Equal(
            "ERROR: could not complete a request to https://server:7001: no route\n",
            err.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task A_failed_cloud_request_names_the_cloud_not_the_server()
    {
        // A real Cloud client over a fake handler, so the failure carries the
        // host it came from, as it does against the real Cloud.
        var fakes = new Fakes();
        var handler = new RecordingHandler()
            .On("POST", "/cdb/oauth2/token", 200, "{\"access_token\":\"nxcdb-1\"}")
            .On("POST", "/cdb/systems/bind", 403, text: "{\"resultCode\":\"forbidden\"}");
        var factory = fakes.Factory with { Cloud = (url, _) => new NxCloudClient(new HttpClient(handler), url) };
        var @out = new StringWriter();
        var err = new StringWriter();

        int code = await Program.RunAsync(
            new[] { "--env-file", WriteEnvFile(Env.Cloud), "--settings-file", None },
            @out, err, factory, Env.None);

        Assert.Equal(1, code);
        Assert.Contains("could not complete a request to https://cloud.example.com:", err.ToString());
        Assert.DoesNotContain("server:7001", err.ToString());
    }

    [Fact]
    public async Task Main_exits_1_on_a_request_timeout()
    {
        var fakes = new Fakes { ServerInfoError = new TaskCanceledException("The request timed out") };

        var (code, _, err) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", WriteSettingsFile("{}"));

        Assert.Equal(1, code);
        Assert.Equal(
            "ERROR: could not complete a request to https://server:7001: The request timed out\n",
            err.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task Main_prints_an_api_error_as_one_ERROR_line_and_exits_1()
    {
        var fakes = new Fakes { ServerLoginError = new ApiException("Login response was not valid JSON.") };

        var (code, _, err) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", WriteSettingsFile("{}"));

        Assert.Equal(1, code);
        Assert.Equal("ERROR: Login response was not valid JSON.\n", err.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task Main_does_not_catch_an_error_it_does_not_know()
    {
        // A bug must show its stack trace, so there is no catch-all. The session is
        // still released on the way out.
        var fakes = new Fakes { ServerInfoError = new InvalidOperationException("a bug") };

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", None));

        Assert.Equal("a bug", error.Message);
        Assert.True(fakes.Server!.LoggedOut);
    }

    [Fact]
    public async Task Main_suggests_insecure_on_a_certificate_error()
    {
        var fakes = new Fakes
        {
            ServerInfoError = new HttpRequestException(
                "The SSL connection could not be established, see inner exception.",
                new AuthenticationException("The remote certificate is invalid because of errors "
                    + "in the certificate chain: UntrustedRoot")),
        };

        var (code, _, err) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", None);

        Assert.Equal(1, code);
        Assert.EndsWith(
            "ERROR: certificate verification failed for https://server:7001. A local "
            + "server uses a self-signed certificate, so add --insecure.\n",
            err.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task A_cloud_certificate_failure_does_not_suggest_insecure()
    {
        // A real Cloud client over a fake handler, so the failure carries the
        // host it came from, as it does against the real Cloud.
        var fakes = new Fakes();
        var handler = new RecordingHandler()
            .On("POST", "/cdb/oauth2/token", () => throw new HttpRequestException(
                "The SSL connection could not be established, see inner exception.",
                new AuthenticationException("The remote certificate is invalid because of errors "
                    + "in the certificate chain: PartialChain")));
        var factory = fakes.Factory with { Cloud = (url, _) => new NxCloudClient(new HttpClient(handler), url) };
        var @out = new StringWriter();
        var err = new StringWriter();

        int code = await Program.RunAsync(
            new[] { "--env-file", WriteEnvFile(Env.Cloud), "--settings-file", None },
            @out, err, factory, Env.None);

        Assert.Equal(1, code);
        Assert.Contains("certificate verification failed for https://cloud.example.com.", err.ToString());
        Assert.Contains("--insecure applies to the server only", err.ToString());
        Assert.DoesNotContain("so add --insecure", err.ToString());
    }

    [Fact]
    public async Task A_tls_error_that_is_not_a_certificate_failure_is_reported_as_it_is()
    {
        // For example https pointed at an http port: --insecure would not help.
        var fakes = new Fakes
        {
            ServerInfoError = new HttpRequestException(
                "The SSL connection could not be established, see inner exception.",
                new AuthenticationException(
                    "Cannot determine the frame size or a corrupted frame was received.")),
        };

        var (code, _, err) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", None);

        Assert.Equal(1, code);
        Assert.Contains("ERROR: could not complete a request to https://server:7001: ", err);
        Assert.Contains("The SSL connection could not be established", err);
        Assert.DoesNotContain("--insecure", err);
    }

    [Fact]
    public async Task A_failed_logout_is_not_fatal()
    {
        // Only the final logout fails, the one RunAsync makes after the run.
        var fakes = new Fakes { ServerLogoutError = new HttpRequestException("gone") };

        var (code, _, _) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", StatisticsOff);

        Assert.Equal(0, code);
        Assert.Contains("server.apply_settings", fakes.Log.Names());
    }

    [Fact]
    public async Task A_logout_answered_with_a_redirect_is_not_fatal()
    {
        var fakes = new Fakes { ServerLogoutError = new ApiException("answered with a redirect") };

        var (code, _, _) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", StatisticsOff);

        Assert.Equal(0, code);
    }

    [Fact]
    public async Task Main_exits_2_for_insecure_cloud_without_a_cloud_host()
    {
        var fakes = new Fakes();

        var (code, _, err) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Without(Env.Cloud, "NX_CLOUD_HOST")), "--insecure",
            "--settings-file", None);

        Assert.Equal(2, code);
        Assert.Contains("NX_CLOUD_HOST", err);
        Assert.Null(fakes.Server);
        Assert.Empty(fakes.Log);
    }

    [Fact]
    public async Task Main_exits_2_for_a_plain_http_cloud_host()
    {
        var fakes = new Fakes();

        var (code, _, err) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.With(Env.Cloud, "NX_CLOUD_HOST", "http://nxvms.com")),
            "--settings-file", None);

        Assert.Equal(2, code);
        Assert.Contains("must be an https:// address", err);
        Assert.Empty(fakes.Log);
    }

    [Fact]
    public async Task Main_refuses_an_existing_site_without_yes_and_exits_1()
    {
        var fakes = new Fakes { Info = FakeServer.Existing };

        var (code, _, err) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", None);

        Assert.Equal(1, code);
        Assert.Contains("ERROR: https://server:7001 already belongs to the site \"Front Office\".", err);
        Assert.Contains("--yes", err);
        Assert.Equal(new[] { "server.get_site_info", "server.logout" }, fakes.Log.Names());
    }

    [Fact]
    public async Task Main_with_yes_updates_an_existing_site()
    {
        var fakes = new Fakes { Info = FakeServer.Existing };

        var (code, output, _) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Server), "--settings-file", StatisticsOff, "--yes");

        Assert.Equal(0, code);
        Assert.Contains("Site name       : Front Office", output);
        Assert.Contains("Set up          : no, the server already belonged to a site", output);
        Assert.Contains("server.apply_settings", fakes.Log.Names());
    }

    [Fact]
    public async Task Main_with_yes_leaves_a_bound_site_in_the_cloud_as_it_was()
    {
        var fakes = new Fakes { Info = FakeServer.ExistingBound };

        var (code, output, _) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Cloud), "--settings-file", None, "--yes");

        Assert.Equal(0, code);
        Assert.Contains("Cloud           : already connected (Cloud id cloud-site-9), left as it was", output);
        Assert.DoesNotContain(fakes.Log.Names(), name => name.StartsWith("cloud."));
    }

    [Fact]
    public async Task Insecure_turns_tls_verification_off_for_the_server_only()
    {
        var fakes = new Fakes();
        string envFile = WriteEnvFile(Env.Server);

        await RunMain(fakes, "--env-file", envFile, "--settings-file", None);
        Assert.True(fakes.Server!.VerifyTls);

        await RunMain(fakes, "--env-file", envFile, "--settings-file", None, "--insecure");
        Assert.False(fakes.Server!.VerifyTls);
    }

    [Fact]
    public async Task Insecure_never_turns_tls_verification_off_for_the_cloud()
    {
        // The Cloud password must never be sent without a certificate check.
        var fakes = new Fakes();

        var (code, _, _) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Cloud), "--settings-file", None, "--insecure");

        Assert.Equal(0, code);
        Assert.False(fakes.Server!.VerifyTls);
        Assert.True(fakes.Cloud!.VerifyTls);
    }

    [Fact]
    public async Task Main_connects_to_the_cloud_only_when_asked()
    {
        var fakes = new Fakes();

        await RunMain(fakes, "--env-file", WriteEnvFile(Env.Server), "--settings-file", None);

        Assert.Null(fakes.Cloud);
    }

    [Fact]
    public async Task Main_with_cloud_prints_the_owner()
    {
        var fakes = new Fakes();

        var (code, output, _) = await RunMain(fakes,
            "--env-file", WriteEnvFile(Env.Cloud), "--settings-file", None);

        Assert.Equal(0, code);
        Assert.Contains("Cloud           : connected to https://cloud.example.com, owned by owner@example.com", output);
        Assert.Equal("https://cloud.example.com", fakes.Cloud!.Url);
    }

    [Fact]
    public async Task Main_with_an_unknown_flag_exits_2_and_runs_nothing()
    {
        var fakes = new Fakes();

        var (code, _, err) = await RunMain(fakes, "--bogus");

        Assert.Equal(2, code);
        Assert.Contains("--bogus", err);
        Assert.Empty(fakes.Log);
    }

    [Theory]
    [InlineData("Unknown argument: --bogus", "--bogus")]
    [InlineData("Unexpected argument: extra", "extra")]
    [InlineData("Missing value for --host", "--host")]
    [InlineData("--insecure takes no value", "--insecure=no")]
    [InlineData("--yes takes no value", "--yes=no")]
    public async Task A_bad_command_line_prints_the_error_then_the_usage_and_exits_2(
        string message, params string[] argv)
    {
        var fakes = new Fakes();

        var (code, output, err) = await RunMain(fakes, argv);

        Assert.Equal(2, code);
        Assert.Equal($"ERROR: {message}\n{Config.Usage}\n", err.ReplaceLineEndings("\n"));
        Assert.Empty(output);
        Assert.Empty(fakes.Log);
    }

    [Fact]
    public async Task Main_help_prints_the_usage_and_exits_0()
    {
        var fakes = new Fakes();

        var (code, output, _) = await RunMain(fakes, "--help");

        Assert.Equal(0, code);
        Assert.Contains("--settings-file", output);
        Assert.Empty(fakes.Log);
    }

    // Where a two-factor code comes from.

    private static readonly AppConfig CloudUserConfig = new() { CloudUser = "owner@example.com" };

    [Fact]
    public async Task The_code_comes_from_the_flag_first()
    {
        var source = Program.MfaCodeSource(
            new CliArgs { MfaCode = "654321" }, CloudUserConfig, isTty: true,
            ask: _ => throw new Xunit.Sdk.XunitException("asked for a code"));

        Assert.NotNull(source);
        Assert.Equal("654321", await source!());
    }

    [Fact]
    public async Task Without_the_flag_a_terminal_is_asked_for_the_code()
    {
        var asked = new List<string>();
        var source = Program.MfaCodeSource(
            new CliArgs(), CloudUserConfig, isTty: true,
            ask: prompt => { asked.Add(prompt); return " 111222 "; });

        Assert.NotNull(source);
        Assert.Empty(asked);
        Assert.Equal("111222", await source!());
        Assert.Equal(new[] { "Two-factor code for owner@example.com: " }, asked);
    }

    [Fact]
    public void Without_the_flag_or_a_terminal_there_is_no_code()
    {
        Assert.Null(Program.MfaCodeSource(
            new CliArgs(), CloudUserConfig, isTty: false,
            ask: _ => throw new Xunit.Sdk.XunitException("asked for a code")));
    }
}
