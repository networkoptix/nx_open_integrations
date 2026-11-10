// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// CLI wiring only: parse args, dispatch to "download"/"apply", build an
// HttpClient, log in, do the one call, log out. The API logic lives in
// NxServerClient.cs.

using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NxCopyDeviceAgentSettings;

public static class Program
{
    private const string Usage =
        "Usage:\n"
        + "  nx-copy-device-agent-settings download [--out PATH] [--force] [options]\n"
        + "  nx-copy-device-agent-settings apply <file> --yes [options]\n\n"
        + "Options: --host --user --password --device-id --engine-id --env-file --insecure\n";

    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(10);

    /// <summary>After Ctrl-C the cleanup logout gets this long, then the run ends anyway.</summary>
    public static readonly TimeSpan InterruptedLogoutTimeout = TimeSpan.FromSeconds(3);

    public static async Task<int> Main(string[] argv)
    {
        using var interrupted = new CancellationTokenSource();
        // Ctrl-C would end the process before the finally blocks that remove the
        // side file and log out. The first one cancels instead and lets them run;
        // a second one is not cancelled, so the process ends at once.
        Console.CancelKeyPress += (_, e) => e.Cancel = OnInterrupt(interrupted);
        return await RunAsync(argv, handler: null, Console.Out, Console.Error, interrupted.Token);
    }

    /// <summary>
    /// One Ctrl-C: true (keep the process alive) the first time, after starting
    /// the graceful path; false on every later one, so the process ends.
    /// </summary>
    public static bool OnInterrupt(CancellationTokenSource interrupted)
    {
        if (interrupted.IsCancellationRequested) return false;
        interrupted.Cancel();
        return true;
    }

    /// <summary>
    /// The whole CLI, minus process exit. <paramref name="handler"/> is
    /// injectable so tests run fully offline with a fake HttpMessageHandler;
    /// stdout/stderr are injectable so tests never have to stub the real
    /// process streams; <paramref name="cancellationToken"/> is what Main
    /// turns Ctrl-C into.
    /// </summary>
    public static async Task<int> RunAsync(
        string[] argv, HttpMessageHandler? handler, TextWriter stdout, TextWriter stderr,
        CancellationToken cancellationToken = default)
    {
        CliArgs args;
        try
        {
            args = Config.ParseArgs(argv);
        }
        catch (ArgumentException ex)
        {
            stderr.WriteLine($"ERROR: {ex.Message}");
            return 2;
        }

        if (args.Command != "download" && args.Command != "apply")
        {
            stderr.Write(Usage);
            return 2;
        }

        bool apply = args.Command == "apply";
        // Anything that fails before the PUT went out leaves the target untouched.
        string notApplied = apply ? " The settings were not applied." : "";
        try
        {
            if (apply) return await RunApplyAsync(args, handler, stdout, stderr, cancellationToken);
            return await RunDownloadAsync(args, handler, stdout, stderr, cancellationToken);
        }
        catch (OperationCanceledException ex) when (cancellationToken.IsCancellationRequested)
        {
            stderr.WriteLine(ex is ApplyInterruptedException
                ? "Interrupted. Outcome unknown: the settings may have been sent. Download the device's settings to check."
                : "Interrupted.");
            return 130;
        }
        catch (ConfigException ex)
        {
            stderr.WriteLine($"ERROR: {ex.Message}");
            return 2;
        }
        catch (Exception ex) when (ex is AuthException or ApiException)
        {
            stderr.WriteLine($"ERROR: {ex.Message}");
            return 1;
        }
        catch (HttpRequestException ex)
            when (ex.InnerException is AuthenticationException
                  || ex.HttpRequestError == HttpRequestError.SecureConnectionError)
        {
            stderr.WriteLine("ERROR: certificate verification failed. Local servers use a "
                + $"self-signed certificate, add --insecure.{notApplied}");
            return 1;
        }
        catch (HttpRequestException ex)
        {
            stderr.WriteLine($"ERROR: could not reach the server: {ex.Message.TrimEnd('.')}.{notApplied}");
            return 1;
        }
        catch (TaskCanceledException)
        {
            // TaskCanceledException without Ctrl-C is HttpClient's own timeout,
            // which only runs out after connecting: a connect that timed out is an
            // HttpRequestException (see ConnectWithTimeout).
            stderr.WriteLine(
                $"ERROR: could not reach the server: no answer within {RequestTimeout.TotalSeconds:0} s.{notApplied}");
            return 1;
        }
        catch (HttpIOException ex)
        {
            // A body cut off mid-transfer surfaces as HttpIOException, which is an
            // IOException and not an HttpRequestException.
            stderr.WriteLine($"ERROR: the transfer failed: {ex.Message}");
            return 1;
        }
        catch (JsonException ex)
        {
            stderr.WriteLine($"ERROR: invalid JSON: {ex.Message}");
            return 1;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Any other local file failure (saving the download has its own
            // message, naming --out): a problem here, not with the server.
            stderr.WriteLine($"ERROR: could not use the file: {ex.Message}");
            return 1;
        }
    }

    private static async Task<int> RunDownloadAsync(
        CliArgs args, HttpMessageHandler? handler, TextWriter stdout, TextWriter stderr,
        CancellationToken cancellationToken)
    {
        string? destination = args.Out;
        if (!string.IsNullOrEmpty(destination) && Directory.Exists(destination))
        {
            stderr.WriteLine($"ERROR: {destination} is a directory. Give --out a file path.");
            return 1;
        }
        if (!string.IsNullOrEmpty(destination) && LocalPath.Exists(destination) && !args.Force)
        {
            stderr.WriteLine(
                $"ERROR: {destination} already exists; use --force");
            return 1;
        }

        AppConfig config = Config.ResolveOrFail(args, DotEnv.Load(args.EnvFile));
        string outPath = destination ?? NxServerClient.DefaultOutputName(config.DeviceId);

        using HttpClient http = BuildHttpClient(args.Insecure, handler);
        var client = new NxServerClient(http, config.Host);
        bool hasResult = false;
        try
        {
            await client.LoginAsync(config.User, config.Password, cancellationToken);
            stdout.WriteLine($"Logged in to {config.Host} as {config.User}");
            stdout.WriteLine();

            JsonObject settings = await client.DownloadSettingsAsync(
                config.EngineId, config.DeviceId, cancellationToken);
            // Without --force the move refuses a file that appeared meanwhile,
            // the auto-generated name included.
            try
            {
                NxServerClient.SaveSettingsFile(outPath, settings, overwrite: args.Force);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // --out in a missing folder, no permission, a full disk: a problem
                // here, not with the server. Named by the path the user knows,
                // never the side file.
                stderr.WriteLine($"ERROR: could not use {outPath}: {LocalPath.Reason(ex)}.");
                return 1;
            }
            stdout.WriteLine(
                $"Downloaded Device Agent settings for device {config.DeviceId} "
                + $"(engine {config.EngineId}) -> {outPath}");
            hasResult = true;
        }
        finally
        {
            await LogoutAsync(client, hasResult, stderr, cancellationToken);
        }
        return 0;
    }

    private static async Task<int> RunApplyAsync(
        CliArgs args, HttpMessageHandler? handler, TextWriter stdout, TextWriter stderr,
        CancellationToken cancellationToken)
    {
        if (!args.Yes)
        {
            stderr.WriteLine(
                "ERROR: Refusing to apply without --yes. This overwrites the target "
                + "device's existing Device Agent settings.");
            return 1;
        }
        string file = args.File ?? "";
        if (Directory.Exists(file))
        {
            stderr.WriteLine($"ERROR: {file} is a directory, not a settings file.");
            return 1;
        }
        if (!File.Exists(file))
        {
            stderr.WriteLine($"ERROR: No such settings file: {file}");
            return 1;
        }

        // Checked before logging in: a file that is not a JSON object is never sent.
        JsonObject settings;
        try
        {
            settings = NxServerClient.LoadSettingsFile(file);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            stderr.WriteLine($"ERROR: could not use {file}: {LocalPath.Reason(ex)}.");
            return 1;
        }
        JsonObject body = NxServerClient.BuildApplyBody(settings);

        AppConfig config = Config.ResolveOrFail(args, DotEnv.Load(args.EnvFile));

        using HttpClient http = BuildHttpClient(args.Insecure, handler);
        var client = new NxServerClient(http, config.Host);
        bool hasResult = false;
        try
        {
            await client.LoginAsync(config.User, config.Password, cancellationToken);
            stdout.WriteLine($"Logged in to {config.Host} as {config.User}");
            stdout.WriteLine();

            try
            {
                await client.ApplySettingsAsync(config.EngineId, config.DeviceId, body, cancellationToken);
            }
            catch (EngineErrorsException ex)
            {
                // Printed now, before the logout (which may take up to 30 s), and
                // the run's result like a success line: a failing logout after it
                // is only a warning.
                stderr.WriteLine($"ERROR: {ex.Message}");
                foreach (var (name, message) in ex.Errors) stderr.WriteLine($"  {name}: {message}");
                hasResult = true;
                return 1;
            }
            stdout.WriteLine(
                $"Applied Device Agent settings to device {config.DeviceId} (engine {config.EngineId}).");
            hasResult = true;
        }
        finally
        {
            await LogoutAsync(client, hasResult, stderr, cancellationToken);
        }
        return 0;
    }

    /// <summary>
    /// End the session on every path. Once the run has a result (its success
    /// line, or the Engine-errors block) a failed logout is only a warning and
    /// the run keeps its exit code; after any other failure it stays quiet so
    /// the real error is the one shown. Not cancelled by Ctrl-C: an interrupted
    /// run still logs out, but only waits <see cref="InterruptedLogoutTimeout"/>
    /// for it, so a dead server cannot hold the process.
    /// </summary>
    private static async Task LogoutAsync(
        NxServerClient client, bool hasResult, TextWriter stderr, CancellationToken interrupted)
    {
        using var cap = new CancellationTokenSource();
        // Runs at once if Ctrl-C came earlier, or when it comes mid-logout.
        using CancellationTokenRegistration _ =
            interrupted.Register(() => cap.CancelAfter(InterruptedLogoutTimeout));
        string reason;
        try
        {
            await client.LogoutAsync(cap.Token);
            return;
        }
        catch (OperationCanceledException) when (interrupted.IsCancellationRequested)
        {
            // Ctrl-C, or its 3 s cap, ended the logout.
            reason = "interrupted.";
        }
        catch (OperationCanceledException)
        {
            // HttpClient's own timeout; its message names HttpClient.Timeout.
            reason = $"no answer within {RequestTimeout.TotalSeconds:0} s.";
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or ApiException)
        {
            reason = $"{ex.Message.TrimEnd('.')}.";
        }
        if (hasResult) stderr.WriteLine($"WARNING: could not log out: {reason}");
    }

    private static HttpClient BuildHttpClient(bool insecure, HttpMessageHandler? handler)
    {
        if (handler is not null)
        {
            // Tests own the handler's lifetime; do not let disposing the
            // HttpClient dispose it too.
            return new HttpClient(handler, disposeHandler: false) { Timeout = RequestTimeout };
        }

        // No redirects: a 3xx is reported as a failure, never silently followed.
        // A separate connect timeout tells "never reached the server" apart
        // from "sent, then no answer".
        var real = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            ConnectCallback = ConnectWithTimeout(ConnectTimeout),
        };
        if (insecure)
        {
            // --insecure is expected for local servers with self-signed certs.
            real.SslOptions = new SslClientAuthenticationOptions
            {
                RemoteCertificateValidationCallback = (_, _, _, _) => true,
            };
        }
        return new HttpClient(real) { Timeout = RequestTimeout };
    }

    /// <summary>
    /// A SocketsHttpHandler.ConnectCallback that gives up after
    /// <paramref name="timeout"/> with a TimeoutException. SocketsHttpHandler's
    /// own ConnectTimeout ends in the same TaskCanceledException as the request
    /// timeout, so a connect that never happened would look like a request that
    /// was sent and never answered. This one surfaces as an HttpRequestException
    /// (ConnectionError), which NxServerClient.NeverConnected recognises.
    /// <paramref name="connect"/> defaults to a plain TCP connect; tests pass one
    /// that hangs.
    /// </summary>
    public static Func<SocketsHttpConnectionContext, CancellationToken, ValueTask<Stream>> ConnectWithTimeout(
        TimeSpan timeout, Func<DnsEndPoint, CancellationToken, ValueTask<Stream>>? connect = null)
    {
        connect ??= ConnectTcpAsync;
        return async (context, cancellationToken) =>
        {
            using var cap = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cap.CancelAfter(timeout);
            try
            {
                return await connect(context.DnsEndPoint, cap.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new TimeoutException($"no connection within {timeout.TotalSeconds:0.#} s");
            }
        };
    }

    private static async ValueTask<Stream> ConnectTcpAsync(DnsEndPoint endPoint, CancellationToken cancellationToken)
    {
        var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(endPoint, cancellationToken);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }
}

/// <summary>Checks and messages about local paths: none of this talks to the server.</summary>
public static class LocalPath
{
    /// <summary>
    /// True when something is at <paramref name="path"/>, a symlink included:
    /// File.Exists follows links, so it says false for one that dangles.
    /// </summary>
    public static bool Exists(string path)
        => File.Exists(path) || new FileInfo(path).LinkTarget is not null;

    /// <summary>
    /// The OS's reason for a local file failure, without a path or a final
    /// period: .NET puts the path (often the side file) into its messages.
    /// </summary>
    public static string Reason(Exception ex) => ex switch
    {
        DirectoryNotFoundException => "No such file or directory",
        FileNotFoundException => "No such file or directory",
        UnauthorizedAccessException => "Permission denied",
        _ => WithoutQuotedPaths(ex.Message),
    };

    private static string WithoutQuotedPaths(string message)
    {
        string text = Regex.Replace(message, @"\s*'[^']*'", "");
        text = Regex.Replace(text, @"\s+", " ").Trim().TrimEnd('.', ' ', ':');
        return text.Length > 0 ? text : "I/O error";
    }
}
