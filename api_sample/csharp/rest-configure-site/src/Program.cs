// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// CLI wiring only: parse args, build the clients, run the flow, turn failures into
// exit codes. The API logic lives in NxServerClient.cs and NxCloudClient.cs, the
// flow in SiteFlow.cs.

namespace NxConfigureSite;

/// <summary>
/// How the CLI makes its two clients, each from a host and whether to verify TLS.
/// The tests hand it fakes.
/// </summary>
public sealed record ClientFactory(
    Func<string, bool, IServerApi> Server, Func<string, bool, ICloudApi> Cloud);

public static class Program
{
    public static async Task<int> Main(string[] argv)
        => await RunAsync(argv, Console.Out, Console.Error);

    /// <summary>
    /// The whole CLI, with its outside world passed in: the client factory, the
    /// environment lookup and the two text writers. Main hands it the real ones;
    /// the tests hand it fakes. Returns the exit code: 0, 1 when a step failed or
    /// an existing site was refused without --yes, 2 when the configuration is
    /// missing or wrong.
    /// </summary>
    public static async Task<int> RunAsync(
        string[] argv, TextWriter @out, TextWriter err,
        ClientFactory? factory = null, Func<string, string?>? env = null,
        CancellationToken cancellationToken = default)
    {
        factory ??= RealClients;

        CliArgs args;
        try
        {
            args = Config.ParseArgs(argv);
        }
        catch (ArgumentException ex)
        {
            // A bad command line gets the usage too.
            err.WriteLine($"ERROR: {ex.Message}");
            err.WriteLine(Config.Usage);
            return 2;
        }
        if (args.Help)
        {
            @out.WriteLine(Config.Usage);
            return 0;
        }

        AppConfig config;
        Dictionary<string, bool> settings;
        try
        {
            config = Config.Resolve(args, DotEnv.Load(args.EnvFile), env);
            settings = SiteSettings.Load(args.SettingsFile);
        }
        catch (ConfigException ex)
        {
            err.WriteLine($"ERROR: {ex.Message}");
            return 2;
        }

        if (!File.Exists(args.SettingsFile))
        {
            // Not an error: a new site gets the defaults, and an existing one keeps
            // its settings. But a mistyped path would otherwise be ignored without
            // a word.
            err.WriteLine($"Note: {args.SettingsFile} not found. A new site gets the default "
                + "settings, an existing one keeps its own.");
        }

        IServerApi server = factory.Server(config.Host, !args.Insecure);
        var clouds = new List<ICloudApi>();   // the Cloud client, once the flow has made it
        try
        {
            Func<Task<string?>>? getMfaCode = MfaCodeSource(
                args, config, isTty: !Console.IsInputRedirected,
                ask: prompt =>
                {
                    @out.Write(prompt);
                    @out.Flush();
                    return Console.ReadLine();
                });
            SiteSummary summary = await SiteFlow.ConfigureSiteAsync(
                config, settings, server,
                // The Cloud password is never sent unchecked: --insecure is for the
                // server only.
                url =>
                {
                    ICloudApi cloud = factory.Cloud(url, true);
                    clouds.Add(cloud);
                    return cloud;
                },
                args.Yes, getMfaCode, cancellationToken);
            @out.WriteLine(SiteFlow.FormatSummary(config, summary));
        }
        catch (Exception ex) when (ex is AuthException or ApiException or ExistingSiteException)
        {
            err.WriteLine($"ERROR: {ex.Message}");
            return 1;
        }
        catch (HttpRequestException ex) when (IsCertificateFailure(ex))
        {
            string where = BearerClient.RequestOrigin(ex) ?? config.Host;
            err.WriteLine("ERROR: " + CertificateMessage(where, config.Host));
            return 1;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            // Name the host of the request that failed: the server or the Cloud.
            string where = BearerClient.RequestOrigin(ex) ?? config.Host;
            err.WriteLine($"ERROR: could not complete a request to {where}: {ex.Message}");
            return 1;
        }
        finally
        {
            // Always release the server session and revoke the Cloud token, even
            // when a step failed.
            var logouts = new List<Func<Task>> { () => server.LogoutAsync() };
            logouts.AddRange(clouds.Select(cloud => (Func<Task>)(() => cloud.LogoutAsync())));
            foreach (Func<Task> logout in logouts)
            {
                try
                {
                    await logout();
                }
                // A logout that cannot be delivered (or is answered with a redirect)
                // is not a reason to report failure.
                catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or ApiException)
                {
                }
            }
        }
        return 0;
    }

    /// <summary>
    /// Where a two-factor code comes from, if the Cloud asks for one: the
    /// --mfa-code flag, else a prompt when the sample runs in a terminal, else
    /// nowhere (null). It is only called when the account needs it.
    /// </summary>
    public static Func<Task<string?>>? MfaCodeSource(
        CliArgs args, AppConfig config, bool isTty, Func<string, string?> ask)
    {
        if (!string.IsNullOrEmpty(args.MfaCode))
        {
            string code = args.MfaCode;
            return () => Task.FromResult<string?>(code);
        }
        if (isTty)
        {
            return () => Task.FromResult<string?>(
                (ask($"Two-factor code for {config.CloudUser}: ") ?? "").Trim());
        }
        return null;
    }

    /// <summary>
    /// True when TLS failed because the certificate could not be verified, not
    /// for other TLS errors such as https pointed at an http port. .NET says
    /// "The remote certificate is invalid ..." or "... rejected by the provided
    /// RemoteCertificateValidationCallback" for those.
    /// </summary>
    public static bool IsCertificateFailure(HttpRequestException error)
    {
        for (Exception? inner = error.InnerException; inner is not null; inner = inner.InnerException)
        {
            if (inner is System.Security.Authentication.AuthenticationException
                && (inner.Message.Contains("remote certificate", StringComparison.OrdinalIgnoreCase)
                    || inner.Message.Contains("RemoteCertificate", StringComparison.Ordinal)))
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// What to do about a certificate that could not be verified: --insecure for
    /// the server, nothing the sample can skip for the Cloud.
    /// </summary>
    public static string CertificateMessage(string where, string serverHost)
    {
        if (SiteFlow.HostAndPort(where) == SiteFlow.HostAndPort(serverHost))
        {
            return $"certificate verification failed for {where}. A local server uses a "
                + "self-signed certificate, so add --insecure.";
        }
        return $"certificate verification failed for {where}. --insecure applies to the "
            + "server only; the Cloud's certificate is always checked. A proxy that "
            + "inspects TLS traffic can cause this.";
    }

    private static readonly ClientFactory RealClients = new(
        (host, verifyTls) => new NxServerClient(BuildHttpClient(verifyTls), host),
        (host, verifyTls) => new NxCloudClient(BuildHttpClient(verifyTls), host));

    /// <summary>
    /// The HttpClient both clients use.
    /// </summary>
    public static HttpClient BuildHttpClient(bool verifyTls)
    {
        var handler = new HttpClientHandler { AllowAutoRedirect = false };
        if (!verifyTls)
        {
            // Lab/self-signed servers: skip TLS verification.
            handler.ServerCertificateCustomValidationCallback =
                HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;
        }
        // Each request gets 30 seconds.
        return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(30) };
    }
}
