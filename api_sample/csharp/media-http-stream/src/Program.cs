// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// CLI wiring only: parse args, resolve config (mode-aware), build an HttpClient
// (auto-redirect OFF so the client can follow the relay's 307 itself), log in,
// stream the clip to a file, log out. The API logic lives in NxMediaClient.cs.

namespace NxMediaHttpStream;

public static class Program
{
    public static async Task<int> Main(string[] argv)
    {
        CliArgs args;
        try
        {
            args = Config.ParseArgs(argv);
        }
        catch (ArgumentException ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 2;
        }

        AppConfig config;
        try
        {
            config = Config.Resolve(args, DotEnv.Load(args.EnvFile));
        }
        catch (ApiException ex)
        {
            // bad --format / --pos / --duration
            Console.Error.WriteLine(ex.Message);
            return 2;
        }

        IReadOnlyList<string> missing = Config.MissingFields(config);
        if (missing.Count > 0)
        {
            Console.Error.WriteLine($"Missing config: {string.Join(", ", missing)}.");
            Console.Error.WriteLine("Provide via flags or .env (copy .env.example). See the README.");
            return 2;
        }

        string outPath = string.IsNullOrEmpty(config.Out)
            ? Config.DefaultOutName(config.DeviceId!, config.Format)
            : config.Out;

        using HttpClient http = BuildHttpClient(args.Insecure);
        var client = new NxMediaClient(
            http, config.Mode, config.User!, config.Password!,
            serverHost: config.ServerHost,
            cloudHost: config.CloudHost,
            siteId: config.SiteId,
            mfaCode: config.MfaCode);

        string liveOrArchive = config.PositionMs is null ? "live" : $"archive @ {config.PositionMs}ms";
        try
        {
            await client.LoginAsync();
            Console.WriteLine(
                $"Saving {config.DurationMs / 1000.0}s {liveOrArchive} clip of device {config.DeviceId} "
                + $"({config.Format}) to {outPath} ...");

            var requestSpec = new ClipRequest(config.DeviceId!, config.Format, config.PositionMs, config.DurationMs);

            long bytes;
            await using (var file = new FileStream(
                outPath, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                bytes = await client.SaveClipAsync(file, requestSpec);
            }
            Console.WriteLine($"Done. Wrote {bytes} bytes to {outPath}");
            return 0;
        }
        catch (AuthException ex)
        {
            Console.Error.WriteLine($"Login failed: {ex.Message}");
            return 1;
        }
        catch (ApiException ex)
        {
            Console.Error.WriteLine($"Error: {ex.Message}");
            return 1;
        }
        finally
        {
            await client.LogoutAsync();
        }
    }

    private static HttpClient BuildHttpClient(bool insecure)
    {
        // AllowAutoRedirect = false: we follow the relay's 307 ourselves so the
        // Authorization header is re-attached across the cross-host hop. No
        // Timeout is set here: SaveClipAsync bounds the request itself with a
        // CancellationToken (durationMs + grace) so a long clip is not cut off.
        var handler = new HttpClientHandler { AllowAutoRedirect = false };
        if (insecure)
        {
            handler.ServerCertificateCustomValidationCallback =
                HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;
        }
        return new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
    }
}
