// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Config plumbing: a tiny .env reader, a dependency-free argument parser, and
// the CLI > env var > .env precedence rule. Kept apart from the API logic and
// the CLI wiring so each piece is easy to read and to unit-test.

namespace NxCopyDeviceAgentSettings;

public sealed class CliArgs
{
    public string? Command { get; set; }
    public string? File { get; set; }
    public string? Host { get; set; }
    public string? User { get; set; }
    public string? Password { get; set; }
    public string? DeviceId { get; set; }
    public string? EngineId { get; set; }
    public string EnvFile { get; set; } = ".env";
    public bool Insecure { get; set; }
    public string? Out { get; set; }
    public bool Force { get; set; }
    public bool Yes { get; set; }
}

public sealed record AppConfig(string Host, string User, string Password, string DeviceId, string EngineId);

public static class DotEnv
{
    /// <summary>Read a simple KEY=VALUE .env file into a dictionary. Missing file -> {}.</summary>
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
        ["--host"] = (a, v) => a.Host = v,
        ["--user"] = (a, v) => a.User = v,
        ["--password"] = (a, v) => a.Password = v,
        ["--device-id"] = (a, v) => a.DeviceId = v,
        ["--engine-id"] = (a, v) => a.EngineId = v,
        ["--env-file"] = (a, v) => a.EnvFile = v,
        ["--out"] = (a, v) => a.Out = v,
    };

    private static readonly Dictionary<string, Action<CliArgs>> BoolFlags = new()
    {
        ["--insecure"] = a => a.Insecure = true,
        ["--force"] = a => a.Force = true,
        ["--yes"] = a => a.Yes = true,
    };

    /// <summary>
    /// The first bare token is the subcommand ("download"/"apply"), the second
    /// (apply only) is the settings file. Everything else is a --flag.
    /// </summary>
    public static CliArgs ParseArgs(string[] argv)
    {
        var args = new CliArgs();
        for (int i = 0; i < argv.Length; i++)
        {
            string flag = argv[i];
            string? inlineValue = null;
            if (flag.StartsWith("--"))
            {
                int eq = flag.IndexOf('=');
                if (eq >= 0)
                {
                    inlineValue = flag[(eq + 1)..];
                    flag = flag[..eq];
                }
            }

            if (BoolFlags.TryGetValue(flag, out var setBool))
            {
                // --yes=no must not mean yes: a boolean flag takes no value at all.
                if (inlineValue is not null) throw new ArgumentException($"{flag} takes no value");
                setBool(args);
            }
            else if (ValueFlags.TryGetValue(flag, out var setValue))
            {
                // "--out --force" or "--host=" would otherwise swallow the next
                // flag, or quietly mean "not given".
                string? value = inlineValue
                    ?? (i + 1 < argv.Length && !argv[i + 1].StartsWith("--") ? argv[++i] : null);
                if (string.IsNullOrEmpty(value)) throw new ArgumentException($"Missing value for {flag}");
                setValue(args, value);
            }
            else if (flag.StartsWith('-') && flag != "-")
            {
                throw new ArgumentException($"Unknown argument: {flag}");
            }
            else if (args.Command is null)
            {
                args.Command = flag;
            }
            else if (args.File is null)
            {
                args.File = flag;
            }
            else
            {
                throw new ArgumentException($"Unexpected argument: {flag}");
            }
        }
        return args;
    }

    /// <summary>
    /// Apply the house precedence: CLI flag > environment variable > .env file.
    /// <paramref name="getEnvVar"/> defaults to the real process environment; tests
    /// inject a fake lookup instead of mutating real environment variables.
    /// </summary>
    public static AppConfig Resolve(
        CliArgs args, IReadOnlyDictionary<string, string> envFile, Func<string, string?>? getEnvVar = null)
    {
        getEnvVar ??= Environment.GetEnvironmentVariable;

        string Pick(string? cliValue, string envKey)
        {
            if (!string.IsNullOrEmpty(cliValue)) return cliValue;
            string? fromEnv = getEnvVar(envKey);
            if (!string.IsNullOrEmpty(fromEnv)) return fromEnv;
            return envFile.TryGetValue(envKey, out string? v) ? v : "";
        }

        return new AppConfig(
            Host: Pick(args.Host, "NX_SERVER_HOST").TrimEnd('/'),
            User: Pick(args.User, "NX_SERVER_USER"),
            Password: Pick(args.Password, "NX_SERVER_PASSWORD"),
            DeviceId: Pick(args.DeviceId, "NX_DEVICE_ID"),
            EngineId: Pick(args.EngineId, "NX_ANALYTICS_ENGINE_ID"));
    }

    /// <summary>Resolve, then fail with a ConfigException (exit code 2) if anything is missing.</summary>
    public static AppConfig ResolveOrFail(
        CliArgs args, IReadOnlyDictionary<string, string> envFile, Func<string, string?>? getEnvVar = null)
    {
        AppConfig config = Resolve(args, envFile, getEnvVar);
        var missing = new List<string>();
        if (string.IsNullOrEmpty(config.Host)) missing.Add("host");
        if (string.IsNullOrEmpty(config.User)) missing.Add("user");
        if (string.IsNullOrEmpty(config.Password)) missing.Add("password");
        if (string.IsNullOrEmpty(config.DeviceId)) missing.Add("deviceId");
        if (string.IsNullOrEmpty(config.EngineId)) missing.Add("engineId");
        if (missing.Count > 0)
        {
            throw new ConfigException(
                $"missing configuration: {string.Join(", ", missing)}. Set it with a flag, an NX_* "
                + $"environment variable, or in {args.EnvFile}.");
        }
        return config;
    }
}
