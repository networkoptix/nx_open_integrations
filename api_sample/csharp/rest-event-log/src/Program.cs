// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// CLI wiring only: parse args, build an HttpClient (auto-redirect OFF so the
// client can follow the relay's 307 itself), get a site-scoped token (or use a
// supplied one), resolve the time window, then read the event log via the relay.
// The API logic lives in NxCloudEventLogClient.cs.

namespace NxEventLog;

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

        AppConfig config = Config.Resolve(args, DotEnv.Load(args.EnvFile));

        var missing = new List<string>();
        if (string.IsNullOrEmpty(config.CloudHost)) missing.Add("cloud-host");
        if (string.IsNullOrEmpty(config.SiteId)) missing.Add("site-id");
        if (missing.Count > 0)
        {
            Console.Error.WriteLine($"Missing config: {string.Join(", ", missing)}.");
            Console.Error.WriteLine("Provide via flags or .env (copy .env.example). See the README.");
            return 2;
        }

        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        long startMs, durationMs;
        try
        {
            (startMs, durationMs) = TimeWindow.Resolve(nowMs, args.Since, args.Start, args.End);
        }
        catch (FormatException ex)
        {
            Console.Error.WriteLine($"Error: {ex.Message}");
            return 2;
        }

        using HttpClient http = BuildHttpClient(args.Insecure);
        var client = new NxCloudEventLogClient(http, config.CloudHost!, config.SiteId!);

        try
        {
            if (!string.IsNullOrEmpty(config.Token))
            {
                client.UseToken(config.Token);
            }
            else if (!string.IsNullOrEmpty(config.User) && !string.IsNullOrEmpty(config.Password))
            {
                await client.LoginAsync(config.User!, config.Password!, config.MfaCode);
            }
            else
            {
                Console.Error.WriteLine("Provide --user/--password to log in, or --token.");
                return 2;
            }

            // Discovery mode: list what event types THIS site reports, then exit
            // without reading the log.
            if (args.ListEventTypes)
            {
                IReadOnlyDictionary<string, EventTypeInfo> manifest = await client.GetEventManifestAsync();
                Console.WriteLine($"Event types for {config.SiteId}   ({manifest.Count} types)");
                Console.WriteLine();
                Console.WriteLine(NxCloudEventLogClient.FormatManifestTable(manifest));
                return 0;
            }

            IReadOnlyList<EventRecord> events = await client.GetEventLogAsync(
                startMs, durationMs, args.EventType, args.ActionType, args.Order, args.Limit);

            if (args.Debug)
            {
                Console.Error.WriteLine("--- query window ---");
                Console.Error.WriteLine(NxCloudEventLogClient.BuildEventQuery(
                    startMs, durationMs, args.EventType, args.ActionType, args.Order, args.Limit));
                Console.Error.WriteLine("--- end ---");
            }

            string windowStart = ToIso(startMs);
            string windowEnd = ToIso(startMs + durationMs);
            Console.WriteLine($"Events for {config.SiteId}");
            Console.WriteLine($"window: {windowStart} -> {windowEnd} UTC   ({events.Count} events)");
            Console.WriteLine();
            Console.WriteLine(NxCloudEventLogClient.FormatEventsTable(events));
            return 0;
        }
        catch (AuthException ex)
        {
            Console.Error.WriteLine($"Auth failed: {ex.Message}");
            return 1;
        }
        catch (ApiException ex)
        {
            Console.Error.WriteLine($"Error: {ex.Message}");
            return 1;
        }
    }

    private static string ToIso(long ms)
        => DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss");

    private static HttpClient BuildHttpClient(bool insecure)
    {
        // AllowAutoRedirect = false: we follow the relay's 307 ourselves so the
        // Authorization header is re-attached across the cross-host hop.
        var handler = new HttpClientHandler { AllowAutoRedirect = false };
        if (insecure)
        {
            handler.ServerCertificateCustomValidationCallback =
                HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;
        }
        return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(15) };
    }
}
