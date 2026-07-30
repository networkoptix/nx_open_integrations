// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Config plumbing: a tiny .env reader, a dependency-free argument parser, and
// the CLI > env var > .env precedence rule. Kept apart from the API logic and
// the CLI wiring so each piece is easy to read and to unit-test.

namespace NxVirtualCameraUpload;

public sealed class CliArgs
{
    public string? File { get; set; }
    public string Name { get; set; } = "Virtual Camera";
    public string? DeviceId { get; set; }
    public string? StartTime { get; set; }
    public long? DurationMs { get; set; }       // milliseconds (clip length; optional)
    public long? Ttl { get; set; }              // seconds
    public int? ChunkSize { get; set; }         // bytes
    public string? Host { get; set; }
    public string? User { get; set; }
    public string? Password { get; set; }
    public string EnvFile { get; set; } = ".env";
    public bool Insecure { get; set; }
    public bool Debug { get; set; }
}

public sealed record AppConfig(string? Host, string? User, string? Password);

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
        ["--file"] = (a, v) => a.File = v,
        ["--name"] = (a, v) => a.Name = v,
        ["--device-id"] = (a, v) => a.DeviceId = v,
        ["--start-time"] = (a, v) => a.StartTime = v,
        ["--duration-ms"] = (a, v) => a.DurationMs = ParseLong("--duration-ms", v),
        ["--ttl"] = (a, v) => a.Ttl = ParseLong("--ttl", v),
        ["--chunk-size"] = (a, v) => a.ChunkSize = ParseInt("--chunk-size", v),
        ["--server-host"] = (a, v) => a.Host = v,
        ["--user"] = (a, v) => a.User = v,
        ["--password"] = (a, v) => a.Password = v,
        ["--env-file"] = (a, v) => a.EnvFile = v,
    };

    private static readonly Dictionary<string, Action<CliArgs>> BoolFlags = new()
    {
        ["--insecure"] = a => a.Insecure = true,
        ["--debug"] = a => a.Debug = true,
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
            Host: Pick(args.Host, "NX_SERVER_HOST"),
            User: Pick(args.User, "NX_SERVER_USER"),
            Password: Pick(args.Password, "NX_SERVER_PASSWORD"));
    }

    private static long ParseLong(string flag, string value)
    {
        if (long.TryParse(value, out long n)) return n;
        throw new ArgumentException($"{flag} must be an integer, got \"{value}\".");
    }

    private static int ParseInt(string flag, string value)
    {
        if (int.TryParse(value, out int n)) return n;
        throw new ArgumentException($"{flag} must be an integer, got \"{value}\".");
    }
}
