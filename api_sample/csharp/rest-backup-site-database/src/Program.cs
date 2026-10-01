// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// CLI wiring only: parse args, build an HttpClient, run backup or restore. The
// API logic lives in NxServerClient.cs.

namespace NxBackupSiteDatabase;

public static class Program
{
    private const string Usage = """
        Back up and restore the Nx Site database.

        usage:
          nx-backup-site-database backup  [--out <path>|-] [--force] [common flags]
          nx-backup-site-database restore <dump> --yes              [common flags]

        backup   dump the Site database to a file
          --out      where to write it. Default: an auto-named file in the current
                     directory. Use - for stdout.
          --force    overwrite --out if it already exists
        restore  load a dump back into the site
          --yes      confirm. The load replaces the whole site configuration and
                     restarts the server.

        common flags:
          --host <url>        https://<server>:7001
          --user <name>       a LOCAL administrator account
          --password <pw>     that account's password
          --env-file <path>   path to the shared .env (default: ./.env)
          --insecure          skip TLS verification (normal for a lab server's
                              self-signed certificate)
        """;

    public static async Task<int> Main(string[] argv)
    {
        using var interrupted = new CancellationTokenSource();
        // Ctrl-C would end the process before the catch blocks that remove the
        // side file and log out. Cancel instead, and let them run.
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            interrupted.Cancel();
        };
        return await RunAsync(argv, null, Console.OpenStandardOutput(), Console.Out, Console.Error,
                              stdoutIsTerminal: !Console.IsOutputRedirected,
                              cancellationToken: interrupted.Token);
    }

    /// <summary>
    /// The whole CLI, with its outside world passed in: the HTTP handler, the raw
    /// stdout stream a backup to "-" writes into, and the two text writers. Main
    /// hands it the real console; the tests hand it fakes.
    /// </summary>
    public static async Task<int> RunAsync(
        string[] argv, HttpMessageHandler? handler, Stream stdout, TextWriter @out, TextWriter err,
        bool stdoutIsTerminal = false, CancellationToken cancellationToken = default)
    {
        CliArgs args;
        try
        {
            args = Config.ParseArgs(argv);
        }
        catch (ArgumentException ex)
        {
            err.WriteLine($"ERROR: {ex.Message}");
            return 2;
        }
        if (args.Command is not ("backup" or "restore"))
        {
            err.WriteLine(Usage);
            return 2;
        }
        try
        {
            if (args.Command == "restore") return await RunRestoreAsync(args, handler, @out, err, cancellationToken);
            return await RunBackupAsync(args, handler, stdout, stdoutIsTerminal, @out, err, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            err.WriteLine("Interrupted.");
            return 130;
        }
        catch (Exception ex) when (ex is AuthException or ApiException)
        {
            err.WriteLine($"ERROR: {ex.Message}");
            return 1;
        }
        catch (HttpRequestException ex) when (ex.InnerException is System.Security.Authentication.AuthenticationException)
        {
            err.WriteLine("ERROR: certificate verification failed. Local servers use a "
                + "self-signed certificate, add --insecure.");
            return 1;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            // TaskCanceledException is how HttpClient reports a request timeout.
            err.WriteLine($"ERROR: could not reach the server: {ex.Message}");
            return 1;
        }
        catch (HttpIOException ex)
        {
            // A body cut off mid-transfer surfaces as HttpIOException, which is an
            // IOException and not an HttpRequestException.
            err.WriteLine($"ERROR: the transfer failed: {ex.Message}");
            return 1;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // --out in a missing folder, no permission, a full disk: a problem
            // here, not with the server.
            err.WriteLine($"ERROR: could not use the file: {ex.Message}");
            return 1;
        }
    }

    private static async Task<int> RunRestoreAsync(
        CliArgs args, HttpMessageHandler? handler, TextWriter @out, TextWriter err,
        CancellationToken cancellationToken)
    {
        if (Directory.Exists(args.Dump))
        {
            err.WriteLine($"ERROR: {args.Dump} is a directory, not a dump.");
            return 1;
        }
        if (!File.Exists(args.Dump))
        {
            err.WriteLine($"ERROR: No such dump: {args.Dump}");
            return 1;
        }
        if (new FileInfo(args.Dump!).Length == 0)
        {
            err.WriteLine($"ERROR: {args.Dump} is empty, so it is not a dump.");
            return 1;
        }
        if (!args.Yes)
        {
            err.WriteLine("ERROR: Refusing to restore without --yes. Loading this dump replaces "
                + "the whole site configuration and restarts the server.");
            return 1;
        }

        AppConfig? config = ResolveOrReport(args, err);
        if (config is null) return 2;
        using HttpClient http = BuildHttpClient(handler, args.Insecure);
        var client = new NxServerClient(http, config.Host);
        // Same reason as backup: log in immediately before the call, because the
        // endpoint wants a fresh session.
        await client.LoginAsync(config.User, config.Password, cancellationToken);
        @out.WriteLine($"Logged in to {config.Host} as {config.User}");
        @out.WriteLine();

        @out.WriteLine($"Loading Site database into {config.Host}");
        @out.WriteLine($"  <- {args.Dump}  ({NxServerClient.FormatSize(new FileInfo(args.Dump!).Length)})");
        try
        {
            await client.RestoreAsync(args.Dump!, cancellationToken);
        }
        catch
        {
            // Refused, or the outcome is unknown: the server did not visibly
            // restart, so the administrator session must not be left open.
            await LogoutQuietlyAsync(client);
            throw;
        }
        // No logout after success on purpose: the server restarts on accepting the
        // dump, so the session is already gone and a DELETE would only confuse.
        @out.WriteLine("Accepted. The server is restarting; the session ends with it.");
        return 0;
    }

    private static async Task<int> RunBackupAsync(
        CliArgs args, HttpMessageHandler? handler, Stream stdout, bool stdoutIsTerminal,
        TextWriter @out, TextWriter err, CancellationToken cancellationToken)
    {
        // An empty --out= means no --out at all, as in the Python port.
        string? destination = string.IsNullOrEmpty(args.Out) ? null : args.Out;
        if (destination is not null && destination != "-" && Directory.Exists(destination))
        {
            err.WriteLine($"ERROR: {destination} is a directory. Give --out a file path.");
            return 1;
        }
        if (destination is not null && destination != "-" && File.Exists(destination) && !args.Force)
        {
            err.WriteLine($"ERROR: Refusing to overwrite {destination}. Choose another --out, or pass --force.");
            return 1;
        }

        if (destination == "-" && stdoutIsTerminal)
        {
            err.WriteLine("ERROR: Refusing to write a binary dump to the terminal. Redirect it, "
                + "for example --out - > site.db, or pipe it on.");
            return 1;
        }

        AppConfig? config = ResolveOrReport(args, err);
        if (config is null) return 2;
        destination ??= NxServerClient.DefaultOutputName(config.Host, DateTime.UtcNow);

        // With --out - the dump owns stdout, so progress goes to stderr and the pipe
        // stays clean.
        TextWriter status = destination == "-" ? err : @out;

        using HttpClient http = BuildHttpClient(handler, args.Insecure);
        var client = new NxServerClient(http, config.Host);
        // Log in here, immediately before the dump: the endpoint wants a fresh
        // session, so a token minted earlier is not good enough.
        await client.LoginAsync(config.User, config.Password, cancellationToken);
        status.WriteLine($"Logged in to {config.Host} as {config.User}");
        status.WriteLine();

        status.WriteLine($"Dumping Site database from {config.Host}");
        long written;
        try
        {
            written = await client.BackupAsync(destination, stdout, args.Force, cancellationToken);
        }
        catch
        {
            // A failed (or interrupted) dump must not leave an administrator
            // session open behind it.
            await LogoutQuietlyAsync(client);
            throw;
        }
        status.WriteLine($"  -> {destination}  ({NxServerClient.FormatSize(written)})");

        // The dump is already on disk, so a logout that cannot be delivered is not
        // a reason to report failure.
        try
        {
            await client.LogoutAsync();
            status.WriteLine("Done. Logged out.");
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            status.WriteLine("Done. The dump is written; the logout could not be delivered.");
        }
        return 0;
    }

    /// <summary>Log out on the way out of a failure, without hiding the failure itself.</summary>
    private static async Task LogoutQuietlyAsync(NxServerClient client)
    {
        try { await client.LogoutAsync(); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException) { }
    }

    /// <summary>Resolve the config, or say what is missing and return null (exit code 2).</summary>
    private static AppConfig? ResolveOrReport(CliArgs args, TextWriter err)
    {
        AppConfig config = Config.Resolve(args, DotEnv.Load(args.EnvFile));
        var missing = new List<string>();
        if (config.Host.Length == 0) missing.Add("host");
        if (config.User.Length == 0) missing.Add("user");
        if (config.Password.Length == 0) missing.Add("password");
        if (missing.Count == 0) return config;

        err.WriteLine($"ERROR: missing configuration: {string.Join(", ", missing)}. Set it with a "
            + $"flag, an NX_SERVER_* environment variable, or in {args.EnvFile}.");
        return null;
    }

    private static HttpClient BuildHttpClient(HttpMessageHandler? handler, bool insecure)
    {
        if (handler is null)
        {
            // No redirects: a followed 302 turns the restore POST into a GET of the
            // dump, which answers 200 and would read as an accepted load.
            var real = new HttpClientHandler { AllowAutoRedirect = false };
            if (insecure)
            {
                // Lab/self-signed servers: skip TLS verification.
                real.ServerCertificateCustomValidationCallback =
                    HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;
            }
            handler = real;
        }
        // No client-wide timeout: each request sets its own, because a dump can
        // take minutes where a login takes seconds.
        return new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
    }
}
