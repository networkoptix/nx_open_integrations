// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// CLI wiring only: parse args, enforce exactly one action, resolve config
// (mode-aware), build an HttpClient (auto-redirect OFF so the client can follow
// the relay's 307 itself), log in, run the chosen action, log out. The API logic
// lives in NxRuleClient.cs and the schedule helpers in Config.cs.
//
// Exit codes:
//   2  usage / config error (no action or >1 action; bad preset/hours; missing config)
//   1  auth / api error
//   0  success

namespace NxRuleSchedule;

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

        // Exactly one action must be chosen.
        int actions = (args.List ? 1 : 0) + (string.IsNullOrEmpty(args.RuleId) ? 0 : 1);
        if (actions != 1)
        {
            Console.Error.WriteLine(
                "Choose exactly one action: --list, or --rule-id <id> --preset <preset>.");
            return 2;
        }

        AppConfig config = Config.Resolve(args, DotEnv.Load(args.EnvFile));

        IReadOnlyList<string> missing = Config.MissingFields(config);
        if (missing.Count > 0)
        {
            Console.Error.WriteLine($"Missing config: {string.Join(", ", missing)}.");
            Console.Error.WriteLine("Provide via flags or .env (copy .env.example). See the README.");
            return 2;
        }

        // Validate the set-by-id action up front (before any network call).
        string? preset = null;
        int startHour = Config.DefaultStartHour;
        int endHour = Config.DefaultEndHour;
        if (!string.IsNullOrEmpty(args.RuleId))
        {
            try
            {
                preset = Config.NormalizePreset(args.Preset);
                if (args.Start is not null) startHour = ParseHour(args.Start, "--start");
                if (args.End is not null) endHour = ParseHour(args.End, "--end");
                // BuildSchedule validates the hour range; call it once to surface errors.
                Config.BuildSchedule(preset, startHour, endHour);
            }
            catch (ApiException ex)
            {
                Console.Error.WriteLine(ex.Message);
                return 2;
            }
        }

        using HttpClient http = BuildHttpClient(args.Insecure);
        var client = new NxRuleClient(
            http, config.Mode, config.User!, config.Password!,
            serverHost: config.ServerHost,
            cloudHost: config.CloudHost,
            siteId: config.SiteId,
            mfaCode: config.MfaCode);

        try
        {
            await client.LoginAsync();

            if (args.List)
            {
                Console.WriteLine(Config.FormatRulesTable(await client.ListRulesAsync()));
                return 0;
            }

            // Set one rule by id.
            IReadOnlyList<ScheduleTask> schedule = Config.BuildSchedule(preset!, startHour, endHour);
            Rule updated = await client.PatchScheduleAsync(args.RuleId!, schedule);
            IReadOnlyList<ScheduleTask> finalSchedule = updated.Schedule.Count > 0 ? updated.Schedule : schedule;
            Console.WriteLine(
                $"Set rule {args.RuleId} schedule -> {Config.SummarizeSchedule(finalSchedule)}");
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

    private static int ParseHour(string value, string flag)
    {
        if (!int.TryParse(value.Trim(), out int hour))
        {
            throw new ApiException($"{flag} must be a whole hour (got \"{value}\").");
        }
        return hour;
    }

    private static HttpClient BuildHttpClient(bool insecure)
    {
        // AllowAutoRedirect = false: we follow the relay's 307 ourselves so the
        // Authorization header is re-attached across the cross-host hop AND the
        // method + body survive (a 307 keeps both — the PATCH depends on it).
        var handler = new HttpClientHandler { AllowAutoRedirect = false };
        if (insecure)
        {
            handler.ServerCertificateCustomValidationCallback =
                HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;
        }
        return new HttpClient(handler);
    }
}
