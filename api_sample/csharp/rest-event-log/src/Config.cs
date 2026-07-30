// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Config plumbing: a tiny .env reader, a dependency-free argument parser, the
// CLI > env var > .env precedence rule, and the time-window helpers that turn
// human input (--since / --start / --end) into the v4 startTimeMs + durationMs
// pair. Kept apart from the API logic and the CLI wiring so each piece is easy
// to read and to unit-test.

using System.Globalization;
using System.Text.RegularExpressions;

namespace NxEventLog;

public sealed class CliArgs
{
    public string? CloudHost { get; set; }
    public string? User { get; set; }
    public string? Password { get; set; }
    public string? SiteId { get; set; }
    public string? Token { get; set; }
    public string? MfaCode { get; set; }
    public string Since { get; set; } = "24h";
    public string? Start { get; set; }
    public string? End { get; set; }
    public List<string> EventType { get; } = new();
    public List<string> ActionType { get; } = new();
    public string Order { get; set; } = "desc";
    public int Limit { get; set; } = 50;
    public string EnvFile { get; set; } = ".env";
    public bool Insecure { get; set; }
    public bool Debug { get; set; }
    public bool ListEventTypes { get; set; }
}

public sealed record AppConfig(
    string? CloudHost, string? User, string? Password, string? SiteId, string? Token, string? MfaCode);

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
    private static readonly Dictionary<string, Action<CliArgs, string>> ValueFlags = new()
    {
        ["--cloud-host"] = (a, v) => a.CloudHost = v,
        ["--user"] = (a, v) => a.User = v,
        ["--password"] = (a, v) => a.Password = v,
        ["--site-id"] = (a, v) => a.SiteId = v,
        ["--token"] = (a, v) => a.Token = v,
        ["--mfa-code"] = (a, v) => a.MfaCode = v,
        ["--since"] = (a, v) => a.Since = v,
        ["--start"] = (a, v) => a.Start = v,
        ["--end"] = (a, v) => a.End = v,
        ["--event-type"] = (a, v) => a.EventType.Add(v),   // repeatable
        ["--action-type"] = (a, v) => a.ActionType.Add(v), // repeatable
        ["--order"] = (a, v) => a.Order = v,
        ["--limit"] = (a, v) => a.Limit = ParseLimit(v),
        ["--env-file"] = (a, v) => a.EnvFile = v,
    };

    private static readonly Dictionary<string, Action<CliArgs>> BoolFlags = new()
    {
        ["--insecure"] = a => a.Insecure = true,
        ["--debug"] = a => a.Debug = true,
        ["--list-event-types"] = a => a.ListEventTypes = true,
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

    public static AppConfig Resolve(CliArgs args, IReadOnlyDictionary<string, string> envFile)
    {
        string? Pick(string? cliValue, string envKey)
        {
            if (!string.IsNullOrEmpty(cliValue)) return cliValue;
            string? fromEnv = Environment.GetEnvironmentVariable(envKey);
            if (!string.IsNullOrEmpty(fromEnv)) return fromEnv;
            return envFile.TryGetValue(envKey, out string? v) ? v : null;
        }

        return new AppConfig(
            CloudHost: Pick(args.CloudHost, "NX_CLOUD_HOST"),
            User: Pick(args.User, "NX_CLOUD_USER"),
            Password: Pick(args.Password, "NX_CLOUD_PASSWORD"),
            SiteId: Pick(args.SiteId, "NX_CLOUD_SITE_ID"),
            Token: args.Token,
            MfaCode: args.MfaCode);
    }

    private static int ParseLimit(string value)
    {
        if (int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out int n)) return n;
        throw new ArgumentException($"Invalid --limit value: {value}");
    }
}

// ---------------------------------------------------------------------------
// Time window: turn human input into the v4 startTimeMs + durationMs pair.
//   * --since <duration>   e.g. 30m, 24h, 7d, 2w  -> window = [now - dur, now]
//   * --start / --end       absolute bounds (ISO 8601 or epoch)
// ---------------------------------------------------------------------------

public static class TimeWindow
{
    private static readonly Regex DurationRe =
        new(@"^\s*(\d+(?:\.\d+)?)\s*([smhdw])\s*$", RegexOptions.IgnoreCase);

    private static readonly Dictionary<char, long> UnitMs = new()
    {
        ['s'] = 1000L,
        ['m'] = 60_000L,
        ['h'] = 3_600_000L,
        ['d'] = 86_400_000L,
        ['w'] = 604_800_000L,
    };

    /// <summary>
    /// Parse a duration like '30m', '24h', '7d', '2w' into milliseconds. A unit
    /// suffix is required (s/m/h/d/w) so a bare number can't be misread.
    /// </summary>
    public static long ParseDuration(string text)
    {
        Match m = DurationRe.Match(text ?? "");
        if (!m.Success)
        {
            throw new FormatException(
                $"Invalid duration '{text}'. Use a number + unit (s, m, h, d, w), e.g. 30m, 24h, 7d, 2w.");
        }
        double value = double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        char unit = char.ToLowerInvariant(m.Groups[2].Value[0]);
        return (long)(value * UnitMs[unit]);
    }

    /// <summary>
    /// Parse an absolute time into epoch milliseconds. Accepts epoch
    /// milliseconds, epoch seconds, or ISO 8601 (e.g. '2026-06-10' or
    /// '2026-06-10T14:30:00Z'). Naive times are treated as UTC.
    /// </summary>
    public static long ParseTime(string text)
    {
        text = (text ?? "").Trim();
        if (text.Length > 0 && text.All(char.IsDigit))
        {
            long number = long.Parse(text, CultureInfo.InvariantCulture);
            return text.Length >= 13 ? number : number * 1000; // 13+ digits = ms
        }
        // Treat a bare date/time as UTC (matching Python's behaviour).
        if (DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out DateTimeOffset when))
        {
            return when.ToUnixTimeMilliseconds();
        }
        throw new FormatException(
            $"Invalid time '{text}'. Use ISO 8601 (e.g. 2026-06-10T14:00:00Z) or an epoch timestamp.");
    }

    /// <summary>
    /// Return (startMs, durationMs) from --since OR --start/--end. If --start is
    /// given it wins (with --end defaulting to now); otherwise the window is the
    /// last &lt;since&gt; ending now. Both forms feed startTimeMs + durationMs.
    /// </summary>
    public static (long StartMs, long DurationMs) Resolve(
        long nowMs, string since = "24h", string? start = null, string? end = null)
    {
        if (!string.IsNullOrEmpty(start))
        {
            long startMs = ParseTime(start);
            long endMs = !string.IsNullOrEmpty(end) ? ParseTime(end) : nowMs;
            if (endMs < startMs) throw new FormatException("--end is before --start.");
            return (startMs, endMs - startMs);
        }
        long durationMs = ParseDuration(since);
        return (nowMs - durationMs, durationMs);
    }
}
