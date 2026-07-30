// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Config plumbing: a tiny .env reader, a dependency-free argument parser, and
// the CLI > env var > .env precedence rule. Kept apart from the API logic and
// the CLI wiring so each piece is easy to read and to unit-test.

namespace NxListCamerasCloud;

public sealed class CliArgs
{
    public string? CloudHost { get; set; }
    public string? User { get; set; }
    public string? Password { get; set; }
    public string? SiteId { get; set; }
    public string? MfaCode { get; set; }
    public string EnvFile { get; set; } = ".env";
    public bool Insecure { get; set; }
}

public sealed record AppConfig(
    string? CloudHost, string? User, string? Password, string? SiteId, string? MfaCode);

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
        ["--mfa-code"] = (a, v) => a.MfaCode = v,
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
            MfaCode: args.MfaCode);
    }
}
