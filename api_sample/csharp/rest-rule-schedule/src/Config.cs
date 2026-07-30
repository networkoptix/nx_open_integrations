// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Config plumbing: a tiny .env reader, a dependency-free argument parser, the
// schedule helpers (the heart of the sample — preset building, summaries), and
// the CLI > env var > .env precedence rule. Kept apart from the API logic and the
// CLI wiring so each piece is easy to read and to unit-test.

using System.Globalization;
using System.Text;

namespace NxRuleSchedule;

public sealed class CliArgs
{
    public string? Mode { get; set; }
    public string? ServerHost { get; set; }
    public string? CloudHost { get; set; }
    public string? User { get; set; }
    public string? Password { get; set; }
    public string? SiteId { get; set; }
    public string? MfaCode { get; set; }
    public bool List { get; set; }
    public string? RuleId { get; set; }
    public string? Preset { get; set; }
    public string? Start { get; set; }
    public string? End { get; set; }
    public string EnvFile { get; set; } = ".env";
    public bool Insecure { get; set; }
}

public sealed record AppConfig(
    Mode Mode,
    string? ServerHost,
    string? CloudHost,
    string? User,
    string? Password,
    string? SiteId,
    string? MfaCode);

public static class DotEnv
{
    public static Dictionary<string, string> Load(string? path)
    {
        var values = new Dictionary<string, string>();
        if (string.IsNullOrEmpty(path) || !File.Exists(path)) return values;
        foreach (string raw in File.ReadAllLines(path))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#') || !line.Contains('=')) continue;
            int idx = line.IndexOf('=');
            string key = line[..idx].Trim();
            string value = line[(idx + 1)..].Trim();
            if (value.Length >= 2
                && ((value[0] == '"' && value[^1] == '"') || (value[0] == '\'' && value[^1] == '\'')))
            {
                value = value[1..^1];
            }
            values[key] = value;
        }
        return values;
    }
}

public static class Config
{
    public const string ModeDirect = "direct";
    public const string ModeCloud = "cloud";

    // Schedule presets the CLI offers.
    public static readonly IReadOnlyList<string> Presets = new[] { "always", "weekdays", "weekend", "24x7" };

    // dayOfWeek: 1=Mon .. 7=Sun. Index 0 is unused (kept blank).
    public static readonly IReadOnlyList<string> DayNames =
        new[] { "", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun" };
    public static readonly IReadOnlyList<int> Weekdays = new[] { 1, 2, 3, 4, 5 };
    public static readonly IReadOnlyList<int> Weekend = new[] { 6, 7 };

    public const int DefaultStartHour = 9;
    public const int DefaultEndHour = 18;

    private static readonly Dictionary<string, Action<CliArgs, string>> ValueFlags = new()
    {
        ["--mode"] = (a, v) => a.Mode = v,
        ["--server-host"] = (a, v) => a.ServerHost = v,
        ["--cloud-host"] = (a, v) => a.CloudHost = v,
        ["--user"] = (a, v) => a.User = v,
        ["--password"] = (a, v) => a.Password = v,
        ["--site-id"] = (a, v) => a.SiteId = v,
        ["--mfa-code"] = (a, v) => a.MfaCode = v,
        ["--rule-id"] = (a, v) => a.RuleId = v,
        ["--preset"] = (a, v) => a.Preset = v,
        ["--start"] = (a, v) => a.Start = v,
        ["--end"] = (a, v) => a.End = v,
        ["--env-file"] = (a, v) => a.EnvFile = v,
    };

    private static readonly Dictionary<string, Action<CliArgs>> BoolFlags = new()
    {
        ["--list"] = a => a.List = true,
        ["--insecure"] = a => a.Insecure = true,
    };

    public static CliArgs ParseArgs(string[] argv)
    {
        var args = new CliArgs();
        for (int i = 0; i < argv.Length; i++)
        {
            string flag = argv[i];
            string? inlineValue = null;
            int eq = flag.IndexOf('=');
            if (eq >= 0)
            {
                inlineValue = flag[(eq + 1)..];
                flag = flag[..eq];
            }

            if (BoolFlags.TryGetValue(flag, out var setBool))
            {
                setBool(args);
            }
            else if (ValueFlags.TryGetValue(flag, out var setValue))
            {
                string value = inlineValue ?? (i + 1 < argv.Length ? argv[++i] : throw new ArgumentException($"Missing value for {flag}"));
                setValue(args, value);
            }
            else
            {
                throw new ArgumentException($"Unknown argument: {flag}");
            }
        }
        return args;
    }

    // -----------------------------------------------------------------------
    // Schedule helpers (pure — the heart of the sample)
    // -----------------------------------------------------------------------

    /// <summary>
    /// Build a v4 schedule array from a preset.
    ///   always   -> []                      (always enabled)
    ///   24x7     -> all 7 days, full day
    ///   weekdays -> Mon-Fri, startHour..endHour
    ///   weekend  -> Sat-Sun, startHour..endHour
    /// startHour/endHour are whole hours in [0..24], startHour &lt; endHour. They
    /// are ignored for "always" and "24x7".
    /// </summary>
    public static IReadOnlyList<ScheduleTask> BuildSchedule(
        string preset, int startHour = DefaultStartHour, int endHour = DefaultEndHour)
    {
        if (preset == "always") return Array.Empty<ScheduleTask>();
        if (preset == "24x7")
        {
            var full = new List<ScheduleTask>();
            for (int d = 1; d <= 7; d++)
            {
                full.Add(new ScheduleTask(d, 0, NxRuleClient.SecondsPerDay));
            }
            return full;
        }
        if (startHour < 0 || endHour > 24 || startHour >= endHour)
        {
            throw new ApiException(
                $"Invalid hours: --start {startHour} --end {endHour} (need 0 <= start < end <= 24).");
        }
        IReadOnlyList<int> days = preset == "weekdays" ? Weekdays : Weekend;
        var tasks = new List<ScheduleTask>();
        foreach (int d in days)
        {
            tasks.Add(new ScheduleTask(
                d, startHour * NxRuleClient.SecondsPerHour, endHour * NxRuleClient.SecondsPerHour));
        }
        return tasks;
    }

    private static List<ScheduleTask> Normalize(IReadOnlyList<ScheduleTask> s)
        => s.OrderBy(t => t.DayOfWeek).ThenBy(t => t.StartTime).ToList();

    private static string HhMm(int seconds)
    {
        int h = seconds / NxRuleClient.SecondsPerHour;
        int m = (seconds % NxRuleClient.SecondsPerHour) / 60;
        return $"{h:D2}:{m:D2}";
    }

    /// <summary>Human summary of a schedule for the --list table.</summary>
    public static string SummarizeSchedule(IReadOnlyList<ScheduleTask>? schedule)
    {
        IReadOnlyList<ScheduleTask> tasks = schedule ?? Array.Empty<ScheduleTask>();
        if (tasks.Count == 0) return "always";
        return string.Join(", ", Normalize(tasks).Select(t =>
        {
            string day = t.DayOfWeek >= 0 && t.DayOfWeek < DayNames.Count
                ? DayNames[t.DayOfWeek]
                : t.DayOfWeek.ToString(CultureInfo.InvariantCulture);
            if (string.IsNullOrEmpty(day)) day = t.DayOfWeek.ToString(CultureInfo.InvariantCulture);
            return $"{day} {HhMm(t.StartTime)}-{HhMm(t.EndTime)}";
        }));
    }

    /// <summary>Validate the requested preset string.</summary>
    public static string NormalizePreset(string? value)
    {
        string s = (value ?? "").Trim().ToLowerInvariant();
        if (Presets.Contains(s)) return s;
        throw new ApiException(
            $"Unknown --preset \"{value}\". Choose one of: {string.Join(", ", Presets)}.");
    }

    /// <summary>Render the rules as a simple aligned text table.</summary>
    public static string FormatRulesTable(IReadOnlyList<Rule> rules)
    {
        if (rules.Count == 0) return "No event rules found on this site.";

        var rows = new List<string[]> { new[] { "ID", "ENABLED", "COMMENT", "SCHEDULE" } };
        foreach (Rule r in rules)
        {
            rows.Add(new[]
            {
                r.Id,
                r.Enabled == false ? "no" : "yes",
                r.Comment ?? "",
                SummarizeSchedule(r.Schedule),
            });
        }
        int[] widths = new int[4];
        foreach (string[] row in rows)
        {
            for (int i = 0; i < 4; i++) widths[i] = Math.Max(widths[i], row[i].Length);
        }
        var sb = new StringBuilder();
        foreach (string[] row in rows)
        {
            var cells = new string[4];
            for (int i = 0; i < 4; i++) cells[i] = row[i].PadRight(widths[i]);
            sb.AppendLine(string.Join("  ", cells).TrimEnd());
        }
        return sb.ToString().TrimEnd('\n', '\r');
    }

    // -----------------------------------------------------------------------
    // Resolve (CLI > env var > .env), mode-aware.
    // -----------------------------------------------------------------------

    public static AppConfig Resolve(CliArgs args, IReadOnlyDictionary<string, string> envFile)
    {
        string? Pick(string? cliValue, string envKey)
        {
            if (!string.IsNullOrEmpty(cliValue)) return cliValue;
            string? fromEnv = Environment.GetEnvironmentVariable(envKey);
            if (!string.IsNullOrEmpty(fromEnv)) return fromEnv;
            return envFile.TryGetValue(envKey, out string? v) ? v : null;
        }

        string? modeRaw = Pick(args.Mode, "NX_MODE");
        Mode mode = string.Equals(modeRaw, ModeCloud, StringComparison.OrdinalIgnoreCase)
            ? Mode.Cloud
            : Mode.Direct;

        return new AppConfig(
            Mode: mode,
            ServerHost: Pick(args.ServerHost, "NX_SERVER_HOST"),
            CloudHost: Pick(args.CloudHost, "NX_CLOUD_HOST") ?? "https://nxvms.com",
            User: Pick(args.User, mode == Mode.Cloud ? "NX_CLOUD_USER" : "NX_SERVER_USER"),
            Password: Pick(args.Password, mode == Mode.Cloud ? "NX_CLOUD_PASSWORD" : "NX_SERVER_PASSWORD"),
            SiteId: Pick(args.SiteId, "NX_CLOUD_SITE_ID"),
            MfaCode: args.MfaCode);
    }

    /// <summary>Which required fields are missing for the chosen mode.</summary>
    public static IReadOnlyList<string> MissingFields(AppConfig config)
    {
        var missing = new List<string>();
        if (config.Mode == Mode.Cloud)
        {
            if (string.IsNullOrEmpty(config.CloudHost)) missing.Add("cloud-host");
            if (string.IsNullOrEmpty(config.User)) missing.Add("user");
            if (string.IsNullOrEmpty(config.Password)) missing.Add("password");
            if (string.IsNullOrEmpty(config.SiteId)) missing.Add("site-id");
        }
        else
        {
            if (string.IsNullOrEmpty(config.ServerHost)) missing.Add("server-host");
            if (string.IsNullOrEmpty(config.User)) missing.Add("user");
            if (string.IsNullOrEmpty(config.Password)) missing.Add("password");
        }
        return missing;
    }
}
