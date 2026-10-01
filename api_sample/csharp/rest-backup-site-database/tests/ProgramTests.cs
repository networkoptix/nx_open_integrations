// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the CLI: the guards, the exit codes, which stream each line
// goes to, and the order of the calls. Program.RunAsync takes its HTTP handler
// and its output streams as arguments, so these run the whole CLI with no
// server, no network and no console.

using System.Net;
using System.Text;
using NxBackupSiteDatabase;
using Xunit;

namespace NxBackupSiteDatabase.Tests;

internal sealed record RunResult(int ExitCode, byte[] StdoutBytes, string Out, string Err);

internal static class Cli
{
    public static readonly string[] Creds =
    {
        "--host", "https://server:7001", "--user", "admin",
        "--password", "secret", "--env-file", "/nonexistent",
    };

    public static RecordingHandler LoginOk() =>
        new RecordingHandler().On("POST", "/login/sessions", () => Responses.LoginOk());

    public static async Task<RunResult> Run(RecordingHandler handler, params string[] argv)
    {
        var stdout = new MemoryStream();
        var @out = new StringWriter();
        var err = new StringWriter();
        int rc = await Program.RunAsync([.. argv, .. Creds], handler, stdout, @out, err);
        return new RunResult(rc, stdout.ToArray(), @out.ToString(), err.ToString());
    }
}

// ---------------------------------------------------------------------------
// The backup command
// ---------------------------------------------------------------------------

public class BackupCommandTests : TempDirTest
{
    [Fact]
    public async Task Backup_refuses_to_overwrite_without_force()
    {
        string target = PathIn("already.db");
        File.WriteAllBytes(target, "previous backup"u8.ToArray());
        var handler = Cli.LoginOk();

        RunResult result = await Cli.Run(handler, "backup", "--out", target);

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("Refusing to overwrite", result.Err);
        // The guard runs before anything is sent, including the login.
        Assert.Empty(handler.Calls);
        Assert.Equal("previous backup"u8.ToArray(), File.ReadAllBytes(target));
    }

    [Fact]
    public async Task Backup_force_overwrites_an_existing_file()
    {
        string target = PathIn("already.db");
        File.WriteAllBytes(target, "previous backup"u8.ToArray());
        var handler = Cli.LoginOk().On("GET", "/site/database",
            () => Responses.Bytes(HttpStatusCode.OK, "fresh dump"u8.ToArray()));

        RunResult result = await Cli.Run(handler, "backup", "--out", target, "--force");

        Assert.Equal(0, result.ExitCode);
        Assert.Equal("fresh dump"u8.ToArray(), File.ReadAllBytes(target));
    }

    [Fact]
    public async Task Backup_cut_off_midway_exits_1_and_keeps_the_previous_backup()
    {
        // Used to escape as an unhandled HttpIOException, exit 134 and a stack
        // trace, after --force had already emptied the old backup.
        string target = PathIn("already.db");
        File.WriteAllBytes(target, "previous backup"u8.ToArray());
        var handler = Cli.LoginOk().On("GET", "/site/database",
            () => Responses.Dropping("half"u8.ToArray()));

        RunResult result = await Cli.Run(handler, "backup", "--out", target, "--force");

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("the transfer failed", result.Err);
        Assert.Equal("previous backup"u8.ToArray(), File.ReadAllBytes(target));
        Assert.Equal(new[] { target }, Directory.GetFiles(Dir));
    }

    [Fact]
    public async Task An_unwritable_out_exits_1_and_blames_the_file()
    {
        var handler = Cli.LoginOk().On("GET", "/site/database",
            () => Responses.Bytes(HttpStatusCode.OK, "dump"u8.ToArray()));

        RunResult result = await Cli.Run(handler, "backup", "--out", PathIn(Path.Combine("no-such-folder", "out.db")));

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("could not use the file", result.Err);
        Assert.DoesNotContain("transfer failed", result.Err);
    }

    [Fact]
    public async Task Backup_refuses_to_write_the_dump_to_a_terminal()
    {
        var handler = Cli.LoginOk();
        var err = new StringWriter();

        int rc = await Program.RunAsync(
            ["backup", "--out", "-", .. Cli.Creds], handler, new MemoryStream(), new StringWriter(), err,
            stdoutIsTerminal: true);

        Assert.Equal(1, rc);
        Assert.Contains("terminal", err.ToString());
        Assert.Empty(handler.Calls);
    }

    [Fact]
    public async Task Backup_refuses_a_directory_as_out_before_logging_in()
    {
        string folder = PathIn("adir");
        Directory.CreateDirectory(folder);
        var handler = Cli.LoginOk();

        RunResult result = await Cli.Run(handler, "backup", "--out", folder, "--force");

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("is a directory", result.Err);
        Assert.Empty(handler.Calls);
        Assert.Empty(Directory.GetFiles(Dir));
    }

    [Fact]
    public async Task An_empty_out_writes_the_auto_named_file()
    {
        // Used to write ".partial" into the working directory, then crash with an
        // unhandled ArgumentException moving it to "".
        var handler = Cli.LoginOk().On("GET", "/site/database",
            () => Responses.Bytes(HttpStatusCode.OK, "dump"u8.ToArray()));
        string cwd = Environment.CurrentDirectory;
        string[] before = Directory.GetFiles(cwd, "nx-site-database-server-7001-*.db");

        RunResult result = await Cli.Run(handler, "backup", "--out=");

        string[] made = Directory.GetFiles(cwd, "nx-site-database-server-7001-*.db").Except(before).ToArray();
        try
        {
            Assert.Equal(0, result.ExitCode);
            Assert.Single(made);
            Assert.False(File.Exists(Path.Combine(cwd, ".partial")));
        }
        finally
        {
            foreach (string f in made) File.Delete(f);
        }
    }

    [Fact]
    public async Task Ctrl_c_mid_backup_removes_the_side_file_and_logs_out()
    {
        // Main turns Ctrl-C into this cancellation instead of letting it end the
        // process before the catch blocks run.
        string target = PathIn("out.db");
        var handler = Cli.LoginOk().On("GET", "/site/database",
            () => Responses.Paced(TimeSpan.Zero, hangAtEnd: true, new byte[100000]));
        using var interrupted = new CancellationTokenSource();
        var err = new StringWriter();

        Task<int> run = Program.RunAsync(
            ["backup", "--out", target, .. Cli.Creds], handler, new MemoryStream(), new StringWriter(), err,
            cancellationToken: interrupted.Token);
        while (!Directory.GetFiles(Dir, "*.partial").Any()) await Task.Delay(5);
        interrupted.Cancel();

        Assert.Equal(130, await run);
        Assert.Empty(Directory.GetFiles(Dir));
        Assert.Contains(handler.Calls, c => c.Method == "DELETE");
    }

    [Fact]
    public async Task A_failed_backup_still_logs_out()
    {
        // The session is an administrator's. A dump that fails is no reason to
        // leave it valid on the server.
        var handler = Cli.LoginOk().On("GET", "/site/database", HttpStatusCode.InternalServerError);

        RunResult result = await Cli.Run(handler, "backup", "--out", PathIn("out.db"));

        Assert.Equal(1, result.ExitCode);
        Assert.Equal(
            new[] { "https://server:7001/rest/v4/login/sessions/tok-1" },
            handler.Calls.Where(c => c.Method == "DELETE").Select(c => c.Url).ToArray());
    }

    [Fact]
    public async Task Backup_to_stdout_writes_bytes_and_keeps_progress_off_stdout()
    {
        // --out - has to stay pipeable, so nothing but the dump goes to stdout.
        var handler = Cli.LoginOk().On("GET", "/site/database",
            () => Responses.Chunks([0x00, 0xFF], [0xFE, 0x01]));

        RunResult result = await Cli.Run(handler, "backup", "--out", "-");

        Assert.Equal(0, result.ExitCode);
        Assert.Equal(new byte[] { 0x00, 0xFF, 0xFE, 0x01 }, result.StdoutBytes);
        Assert.Equal("", result.Out);
        Assert.Contains("Logged in", result.Err);
    }
}

// ---------------------------------------------------------------------------
// The restore command and its guards
// ---------------------------------------------------------------------------

public class RestoreCommandTests : TempDirTest
{
    private string Dump(byte[] bytes)
    {
        string path = PathIn("in.db");
        File.WriteAllBytes(path, bytes);
        return path;
    }

    [Fact]
    public async Task Restore_refuses_a_missing_file()
    {
        var handler = Cli.LoginOk();

        RunResult result = await Cli.Run(handler, "restore", PathIn("nope.db"), "--yes");

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("No such dump", result.Err);
        Assert.Empty(handler.Calls);
    }

    [Fact]
    public async Task Restore_refuses_a_zero_byte_file()
    {
        // A zero byte file is not a dump, and finding that out from the server
        // would mean having already asked it to replace the site.
        var handler = Cli.LoginOk();

        RunResult result = await Cli.Run(handler, "restore", Dump(Array.Empty<byte>()), "--yes");

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("empty", result.Err.ToLowerInvariant());
        Assert.Empty(handler.Calls);
    }

    [Fact]
    public async Task Restore_refuses_without_yes()
    {
        // Loading a dump replaces the whole site and restarts the server, so it
        // never happens by accident.
        var handler = Cli.LoginOk();

        RunResult result = await Cli.Run(handler, "restore", Dump("a dump"u8.ToArray()));

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("--yes", result.Err);
        Assert.Empty(handler.Calls);
    }

    [Fact]
    public async Task A_rejected_restore_exits_1_and_never_says_accepted()
    {
        string dump = PathIn("in.db");
        File.WriteAllBytes(dump, "a dump"u8.ToArray());
        var handler = Cli.LoginOk().On("POST", "/site/database", HttpStatusCode.InternalServerError);

        RunResult result = await Cli.Run(handler, "restore", dump, "--yes");

        Assert.Equal(1, result.ExitCode);
        Assert.DoesNotContain("Accepted", result.Out);
        Assert.Contains("HTTP 500", result.Err);
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest)]
    [InlineData(HttpStatusCode.InternalServerError)]
    public async Task A_refused_restore_logs_out(HttpStatusCode status)
    {
        // No restart follows a refused load, so the session would stay valid.
        string dump = PathIn("in.db");
        File.WriteAllBytes(dump, "a dump"u8.ToArray());
        var handler = Cli.LoginOk().On("POST", "/site/database", status);

        RunResult result = await Cli.Run(handler, "restore", dump, "--yes");

        Assert.Equal(1, result.ExitCode);
        Assert.Equal(
            new[] { "https://server:7001/rest/v4/login/sessions/tok-1" },
            handler.Calls.Where(c => c.Method == "DELETE").Select(c => c.Url).ToArray());
    }

    [Fact]
    public async Task Restore_refuses_a_directory_before_logging_in()
    {
        string folder = PathIn("adir");
        Directory.CreateDirectory(folder);
        var handler = Cli.LoginOk();

        RunResult result = await Cli.Run(handler, "restore", folder, "--yes");

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("is a directory", result.Err);
        Assert.Empty(handler.Calls);
    }

    [Theory]
    [InlineData("--yes=no")]
    [InlineData("--yes=false")]
    [InlineData("--force=no")]
    [InlineData("--insecure=false")]
    public void A_boolean_flag_given_a_value_is_an_error(string flag)
    {
        // Otherwise --yes=no would confirm the restore it was meant to refuse.
        var caught = Assert.Throws<ArgumentException>(() => Config.ParseArgs(["restore", "x.db", flag]));
        Assert.Contains("takes no value", caught.Message);
    }

    [Fact]
    public async Task Restore_does_not_log_out_afterwards()
    {
        // The restart ends the session by itself; a DELETE would only produce a
        // confusing connection error after a successful restore.
        var handler = Cli.LoginOk().On("POST", "/site/database", HttpStatusCode.OK);

        RunResult result = await Cli.Run(handler, "restore", Dump("a dump"u8.ToArray()), "--yes");

        Assert.Equal(0, result.ExitCode);
        Assert.DoesNotContain(handler.Calls, c => c.Method == "DELETE");
        Assert.Contains("restarting", result.Out);
    }
}

// ---------------------------------------------------------------------------
// Session handling and error paths
// ---------------------------------------------------------------------------

public class SessionTests : TempDirTest
{
    private static List<(string Method, string Path)> Steps(RecordingHandler handler)
        => handler.Calls.Select(c => (c.Method, c.Url[(c.Url.IndexOf("/rest/v4") + 8)..])).ToList();

    [Fact]
    public async Task Every_run_logs_in_immediately_before_its_own_call()
    {
        // "Administrator with a fresh session" is the spec's own permission line,
        // so the login must be the call right before the database call, and there
        // must be no way to hand the sample a token minted earlier.
        var backup = Cli.LoginOk().On("GET", "/site/database",
            () => Responses.Bytes(HttpStatusCode.OK, "dump"u8.ToArray()));
        await Cli.Run(backup, "backup", "--out", PathIn("out.db"));
        Assert.Equal(("POST", "/login/sessions"), Steps(backup)[0]);
        Assert.Equal(("GET", "/site/database"), Steps(backup)[1]);

        string dump = PathIn("in.db");
        File.WriteAllBytes(dump, "a dump"u8.ToArray());
        var restore = Cli.LoginOk().On("POST", "/site/database", HttpStatusCode.OK);
        await Cli.Run(restore, "restore", dump, "--yes");
        Assert.Equal(("POST", "/login/sessions"), Steps(restore)[0]);
        Assert.Equal(("POST", "/site/database"), Steps(restore)[1]);

        // No token can be supplied: not by flag on either command, and not by config.
        foreach (string[] argv in new[]
        {
            new[] { "backup", "--token", "stale-token" },
            new[] { "restore", "x", "--token", "stale-token" },
        })
        {
            var caught = Assert.Throws<ArgumentException>(() => Config.ParseArgs(argv));
            Assert.Contains("--token", caught.Message);
        }
        Assert.Null(typeof(AppConfig).GetProperty("Token"));
    }

    [Fact]
    public async Task Backup_logs_out_and_survives_a_failing_logout()
    {
        // The dump is already safely on disk, so a logout that cannot be delivered
        // must not turn a successful backup into a failure.
        string target = PathIn("out.db");
        var handler = Cli.LoginOk().On("GET", "/site/database",
            () => Responses.Bytes(HttpStatusCode.OK, "dump"u8.ToArray()));

        RunResult result = await Cli.Run(handler, "backup", "--out", target);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal(
            new[] { "https://server:7001/rest/v4/login/sessions/tok-1" },
            handler.Calls.Where(c => c.Method == "DELETE").Select(c => c.Url));

        var dropping = Cli.LoginOk()
            .On("GET", "/site/database", () => Responses.Bytes(HttpStatusCode.OK, "dump"u8.ToArray()))
            .On("DELETE", "/login/sessions/tok-1", () => throw new HttpRequestException(
                "An error occurred while sending the request.", new IOException("Connection reset by peer")));

        result = await Cli.Run(dropping, "backup", "--out", target, "--force");

        Assert.Equal(0, result.ExitCode);
        Assert.Equal("dump"u8.ToArray(), File.ReadAllBytes(target));
    }

    [Fact]
    public async Task No_subcommand_prints_usage_and_exits_2()
    {
        var handler = Cli.LoginOk();
        var err = new StringWriter();

        int rc = await Program.RunAsync([], handler, new MemoryStream(), new StringWriter(), err);

        Assert.Equal(2, rc);
        Assert.Contains("backup", err.ToString());
        Assert.Empty(handler.Calls);
    }

    [Fact]
    public async Task Auth_failure_exits_1_without_a_stack_trace()
    {
        var handler = Cli.LoginOk().On("GET", "/site/database", HttpStatusCode.Forbidden);

        RunResult result = await Cli.Run(handler, "backup", "--out", PathIn("out.db"));

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("ERROR:", result.Err);
        Assert.DoesNotContain("   at ", result.Err);
    }

    [Fact]
    public async Task A_tls_failure_points_at_insecure()
    {
        // This is how .NET reports a certificate it will not trust.
        var handler = Cli.LoginOk().On("GET", "/site/database", () => throw new HttpRequestException(
            "The SSL connection could not be established, see inner exception.",
            new System.Security.Authentication.AuthenticationException(
                "The remote certificate is invalid according to the validation procedure.")));

        RunResult result = await Cli.Run(handler, "backup", "--out", PathIn("out.db"));

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("--insecure", result.Err);
    }
}

// ---------------------------------------------------------------------------
// Additions beyond the approved 39: exit codes the plan stated but never
// named a test for.
// ---------------------------------------------------------------------------

[Collection("process environment")]
public class ExitCodeTests : TempDirTest
{
    [Fact]
    public async Task Missing_configuration_exits_2_before_any_call()
    {
        Environment.SetEnvironmentVariable("NX_SERVER_USER", null);
        Environment.SetEnvironmentVariable("NX_SERVER_PASSWORD", null);
        var handler = Cli.LoginOk();
        var err = new StringWriter();

        int rc = await Program.RunAsync(
            ["backup", "--out", PathIn("out.db"), "--env-file", "/nonexistent", "--host", "https://server:7001"],
            handler, new MemoryStream(), new StringWriter(), err);

        Assert.Equal(2, rc);
        Assert.Contains("user", err.ToString());
        Assert.Empty(handler.Calls);
    }

    [Fact]
    public async Task An_unknown_flag_exits_2_with_its_name()
    {
        var handler = Cli.LoginOk();

        RunResult result = await Cli.Run(handler, "backup", "--token", "stale-token");

        Assert.Equal(2, result.ExitCode);
        Assert.Contains("--token", result.Err);
        Assert.Empty(handler.Calls);
    }

    [Fact]
    public async Task An_unreachable_server_exits_1_and_says_so()
    {
        var handler = new RecordingHandler().On("POST", "/login/sessions", () => throw new HttpRequestException(
            "Connection refused (server:7001)", new System.Net.Sockets.SocketException(61)));

        RunResult result = await Cli.Run(handler, "backup", "--out", PathIn("out.db"));

        Assert.Equal(1, result.ExitCode);
        Assert.Contains("could not reach the server", result.Err);
    }
}
