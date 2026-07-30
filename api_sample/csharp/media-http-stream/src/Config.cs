// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Config plumbing: a tiny .env reader, a dependency-free argument parser, the
// media-specific validators (format / position / duration), and the
// CLI > env var > .env precedence rule. Kept apart from the API logic and the
// CLI wiring so each piece is easy to read and to unit-test.

using System.Globalization;
using System.Text;

namespace NxMediaHttpStream;

public sealed class CliArgs
{
    public string? Mode { get; set; }
    public string? ServerHost { get; set; }
    public string? CloudHost { get; set; }
    public string? User { get; set; }
    public string? Password { get; set; }
    public string? SiteId { get; set; }
    public string? MfaCode { get; set; }
    public string? DeviceId { get; set; }
    public string? Format { get; set; }
    public string? Pos { get; set; }
    public string? Duration { get; set; }
    public string? Out { get; set; }
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
    string? MfaCode,
    string? DeviceId,
    string Format,
    long? PositionMs,
    long DurationMs,
    string? Out);

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

    private static readonly Dictionary<string, Action<CliArgs, string>> ValueFlags = new()
    {
        ["--mode"] = (a, v) => a.Mode = v,
        ["--server-host"] = (a, v) => a.ServerHost = v,
        ["--cloud-host"] = (a, v) => a.CloudHost = v,
        ["--user"] = (a, v) => a.User = v,
        ["--password"] = (a, v) => a.Password = v,
        ["--site-id"] = (a, v) => a.SiteId = v,
        ["--mfa-code"] = (a, v) => a.MfaCode = v,
        ["--device-id"] = (a, v) => a.DeviceId = v,
        ["--format"] = (a, v) => a.Format = v,
        ["--pos"] = (a, v) => a.Pos = v,
        ["--duration"] = (a, v) => a.Duration = v,
        ["--out"] = (a, v) => a.Out = v,
        ["--env-file"] = (a, v) => a.EnvFile = v,
    };

    private static readonly Dictionary<string, Action<CliArgs>> BoolFlags = new()
    {
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
    // Media-specific validators (pure = easy to test)
    // -----------------------------------------------------------------------

    /// <summary>Validate/normalize a requested container format.</summary>
    public static string NormalizeFormat(string? value)
    {
        string s = (value ?? NxMediaClient.DefaultFormat).Trim().ToLowerInvariant();
        if (s.StartsWith('.')) s = s[1..];
        if (NxMediaClient.Formats.Contains(s)) return s;
        throw new ApiException(
            $"Unsupported format \"{value}\". Choose one of: {string.Join(", ", NxMediaClient.Formats)}.");
    }

    /// <summary>
    /// Turn the optional archive position into epoch milliseconds, or null for
    /// live. Accepts an ISO 8601 string (2026-06-15T12:00:00Z) or a raw epoch-ms
    /// number. Empty/blank -> null (live).
    /// </summary>
    public static long? ParsePositionMs(string? value)
    {
        string s = (value ?? "").Trim();
        if (s.Length == 0) return null; // live
        if (long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out long epoch)
            && s.All(char.IsDigit))
        {
            return epoch; // already epoch ms
        }
        if (DateTimeOffset.TryParse(
                s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out DateTimeOffset dto))
        {
            return dto.ToUnixTimeMilliseconds();
        }
        throw new ApiException($"Could not parse archive position \"{s}\". Use ISO time or epoch ms.");
    }

    /// <summary>Parse --duration (seconds, may be fractional) into whole milliseconds.</summary>
    public static long DurationToMs(string? seconds)
    {
        if (string.IsNullOrEmpty(seconds))
        {
            return NxMediaClient.DefaultDurationSeconds * 1000L;
        }
        if (!double.TryParse(seconds, NumberStyles.Float, CultureInfo.InvariantCulture, out double n)
            || double.IsNaN(n) || double.IsInfinity(n) || n <= 0)
        {
            throw new ApiException($"--duration must be a positive number of seconds (got \"{seconds}\").");
        }
        return (long)Math.Round(n * 1000);
    }

    /// <summary>Default output filename when --out is not given: clip-&lt;device&gt;-&lt;ts&gt;.&lt;fmt&gt;.</summary>
    public static string DefaultOutName(string deviceId, string format, DateTimeOffset? now = null)
    {
        DateTimeOffset stampTime = now ?? DateTimeOffset.UtcNow;
        string stamp = stampTime.UtcDateTime.ToString("yyyy-MM-ddTHH-mm-ss-fffZ", CultureInfo.InvariantCulture);
        var safe = new StringBuilder(deviceId.Length);
        foreach (char c in deviceId)
        {
            safe.Append(char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-' ? c : '_');
        }
        return $"clip-{safe}-{stamp}.{format}";
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
            MfaCode: args.MfaCode,
            DeviceId: Pick(args.DeviceId, "NX_DEVICE_ID"),
            Format: NormalizeFormat(Pick(args.Format, "NX_MEDIA_FORMAT")),
            PositionMs: ParsePositionMs(args.Pos),
            DurationMs: DurationToMs(args.Duration),
            Out: args.Out);
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
            if (string.IsNullOrEmpty(config.DeviceId)) missing.Add("device-id");
        }
        else
        {
            if (string.IsNullOrEmpty(config.ServerHost)) missing.Add("server-host");
            if (string.IsNullOrEmpty(config.User)) missing.Add("user");
            if (string.IsNullOrEmpty(config.Password)) missing.Add("password");
            if (string.IsNullOrEmpty(config.DeviceId)) missing.Add("device-id");
        }
        return missing;
    }
}
