// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// CLI wiring only: parse args, build an HttpClient, log in to one VMS server,
// create a virtual camera and upload a video file into its archive, log out.
// The API logic lives in Client.cs and the orchestration in Orchestrator.cs.

namespace NxVirtualCameraUpload;

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

        if (string.IsNullOrEmpty(args.File))
        {
            Console.Error.WriteLine("Missing required --file. See the README.");
            return 2;
        }

        AppConfig config = Config.Resolve(args, DotEnv.Load(args.EnvFile));

        var missing = new List<string>();
        if (string.IsNullOrEmpty(config.Host)) missing.Add("host");
        if (string.IsNullOrEmpty(config.User)) missing.Add("user");
        if (string.IsNullOrEmpty(config.Password)) missing.Add("password");
        if (missing.Count > 0)
        {
            Console.Error.WriteLine($"Missing config: {string.Join(", ", missing)}.");
            Console.Error.WriteLine("Provide via flags or .env (copy .env.example). See the README.");
            return 2;
        }

        if (!File.Exists(args.File))
        {
            Console.Error.WriteLine($"File not found: {args.File}");
            return 2;
        }

        long startTimeMs;
        try
        {
            startTimeMs = NxVirtualCameraClient.ParseStartTimeMs(args.StartTime);
        }
        catch (ApiException ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 2;
        }

        long ttlMs = (args.Ttl ?? NxVirtualCameraClient.DefaultTtlSeconds) * 1000;
        int chunkSize = args.ChunkSize ?? NxVirtualCameraClient.DefaultChunkSize;
        if (chunkSize <= 0)
        {
            Console.Error.WriteLine("--chunk-size must be a positive number of bytes.");
            return 2;
        }

        // durationMs is OPTIONAL: pass --duration-ms if you know the clip length.
        // If omitted, the server derives the duration from the video file's own
        // metadata. Only if that metadata is missing/unreadable does the archive
        // period come back as zero, meaning the footage won't appear on the
        // timeline (see the README's troubleshooting section).
        if (args.DurationMs is long d && d <= 0)
        {
            Console.Error.WriteLine("--duration-ms must be a positive number of milliseconds.");
            return 2;
        }

        using HttpClient http = BuildHttpClient(args.Insecure, args.Debug);
        var client = new NxVirtualCameraClient(http, config.Host!);

        try
        {
            await client.LoginAsync(config.User!, config.Password!);
            Console.WriteLine($"Logged in to {config.Host} as {config.User}");

            UploadResult result = await Orchestrator.UploadVideoAsync(
                client, args.File!, args.Name, startTimeMs, ttlMs, chunkSize,
                durationMs: args.DurationMs,
                deviceId: args.DeviceId,
                onProgress: m => Console.WriteLine($"  {m}"));

            Console.WriteLine(
                $"Done. Uploaded {result.SizeB} bytes to device {result.DeviceId} "
                + $"as archive starting {startTimeMs}ms.");
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
            // Always try to release the session token, even on error.
            await client.LogoutAsync();
        }
    }

    private static HttpClient BuildHttpClient(bool insecure, bool debug)
    {
        var handler = new HttpClientHandler();
        if (insecure)
        {
            // Lab/self-signed servers: skip TLS verification.
            handler.ServerCertificateCustomValidationCallback =
                HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;
        }
        // With --debug, wrap the handler so every request/response is printed to stderr.
        HttpMessageHandler pipeline = debug ? new LoggingHandler(handler) : handler;
        // Uploading footage can take a while; give it more headroom than a list call.
        return new HttpClient(pipeline) { Timeout = TimeSpan.FromSeconds(120) };
    }
}
