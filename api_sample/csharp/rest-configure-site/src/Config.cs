// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Configuration: a tiny .env reader, a dependency-free argument parser, the
// precedence rule, and the site settings file. Kept apart from the API logic and
// the CLI wiring so each piece is easy to read and to unit-test.
//
// The server address and password can be given as a flag. Everything else comes
// from the environment or the .env file only, so the order is
// CLI flag > environment variable > .env file for those two and
// environment variable > .env file for the rest.

using System.Text.Json;

namespace NxConfigureSite;

/// <summary>The configuration is missing or wrong. The run stops with exit code 2.</summary>
public sealed class ConfigException : Exception
{
    public ConfigException(string message) : base(message) { }
}

public sealed class CliArgs
{
    public string? Host { get; set; }
    public string? Password { get; set; }
    public string EnvFile { get; set; } = ".env";
    // Looked up next to the program, so the sample runs from any directory.
    public string SettingsFile { get; set; } = SiteSettings.DefaultFile;
    public bool Insecure { get; set; }
    // The one-time code for a Cloud account with two-factor authentication. Never
    // read from .env: a code is only valid for about 30 seconds.
    public string? MfaCode { get; set; }
    // Also change a server that already belongs to a site.
    public bool Yes { get; set; }
    public bool Help { get; set; }
}

public sealed record AppConfig
{
    public string Host { get; init; } = "";
    public string Password { get; init; } = "";
    public string SiteName { get; init; } = "";
    public bool ConnectToCloud { get; init; }
    // Optional. The server says which Cloud it belongs to; this is only a check
    // that it is the Cloud you expect.
    public string? CloudHost { get; init; }
    public string CloudUser { get; init; } = "";
    public string CloudPassword { get; init; } = "";
    // Set: the organization owns the site. Unset: the Cloud account does.
    public string? OrganizationId { get; init; }
}

public static class ConfigFile
{
    /// <summary>
    /// The text of a configuration file, or null when nothing exists at the path.
    /// A path that exists but cannot be read (a directory, or a file this user may
    /// not open) is a mistake worth stopping for, so it is a ConfigException.
    /// </summary>
    public static string? ReadOrNull(string path)
    {
        if (Directory.Exists(path)) throw new ConfigException($"Cannot read {path}: it is a directory.");
        if (!File.Exists(path)) return null;
        try
        {
            return File.ReadAllText(path);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new ConfigException($"Cannot read {path}: {error.Message.TrimEnd('.')}.");
        }
    }
}

public static class DotEnv
{
    /// <summary>Read a simple KEY=VALUE .env file into a dictionary. Missing file gives an empty one.</summary>
    public static Dictionary<string, string> Load(string? path)
    {
        var values = new Dictionary<string, string>();
        string? text = string.IsNullOrEmpty(path) ? null : ConfigFile.ReadOrNull(path);
        if (text is null) return values;
        foreach (string raw in text.Split('\n'))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#') || !line.Contains('=')) continue;
            int idx = line.IndexOf('=');
            string key = line[..idx].Trim();
            string value = line[(idx + 1)..].Trim().Trim('"').Trim('\'');
            values[key] = value;
        }
        return values;
    }
}

public static class Config
{
    public const string Usage = """
        Set up a new site and optionally connect it to the Cloud.

        usage:
          nx-configure-site [--host <url>] [--password <pw>] [--env-file <path>]
                            [--settings-file <path>] [--insecure]
                            [--mfa-code <code>] [--yes]

          --host <url>             https://<server>:7001 of a factory-default server
          --password <pw>          the local admin password to set
          --env-file <path>        path to the shared .env (default: ./.env)
          --settings-file <path>   JSON file with the site settings
                                   (default: site_settings.json next to the program)
          --insecure               skip TLS verification (normal for a lab server's
                                   self-signed certificate)
          --mfa-code <code>        the one-time code from your authenticator app, for
                                   a Cloud account with two-factor authentication.
                                   Without it, the sample asks for one when it runs
                                   in a terminal
          --yes                    also change a server that already belongs to a
                                   site (its settings, and its Cloud connection if
                                   it has none)
        """;

    public static CliArgs ParseArgs(string[] argv)
    {
        var args = new CliArgs();
        for (int i = 0; i < argv.Length; i++)
        {
            string flag = argv[i];
            string? inlineValue = null;
            int eq = flag.IndexOf('=');
            if (flag.StartsWith("--") && eq >= 0)
            {
                inlineValue = flag[(eq + 1)..];
                flag = flag[..eq];
            }

            switch (flag)
            {
                case "--insecure":
                    // --insecure=no must not mean yes: a boolean flag takes no value.
                    if (inlineValue is not null) throw new ArgumentException($"{flag} takes no value");
                    args.Insecure = true;
                    break;
                case "--yes":
                    if (inlineValue is not null) throw new ArgumentException($"{flag} takes no value");
                    args.Yes = true;
                    break;
                case "--help" or "-h":
                    args.Help = true;
                    break;
                case "--host":
                    args.Host = ValueOf(argv, ref i, flag, inlineValue);
                    break;
                case "--password":
                    args.Password = ValueOf(argv, ref i, flag, inlineValue);
                    break;
                case "--env-file":
                    args.EnvFile = ValueOf(argv, ref i, flag, inlineValue);
                    break;
                case "--settings-file":
                    args.SettingsFile = ValueOf(argv, ref i, flag, inlineValue);
                    break;
                case "--mfa-code":
                    args.MfaCode = ValueOf(argv, ref i, flag, inlineValue);
                    break;
                default:
                    // This sample takes flags only, so a bare word is a stray one.
                    throw new ArgumentException(argv[i].StartsWith('-')
                        ? $"Unknown argument: {argv[i]}"
                        : $"Unexpected argument: {argv[i]}");
            }
        }
        return args;
    }

    private static string ValueOf(string[] argv, ref int i, string flag, string? inlineValue)
    {
        if (inlineValue is not null) return inlineValue;
        if (i + 1 < argv.Length) return argv[++i];
        throw new ArgumentException($"Missing value for {flag}");
    }

    /// <summary>
    /// Collect the run's configuration from flags, the environment and .env. The
    /// environment is a parameter so the tests never read the machine's own.
    /// </summary>
    public static AppConfig Resolve(
        CliArgs args, IReadOnlyDictionary<string, string> envFile, Func<string, string?>? env = null)
    {
        env ??= Environment.GetEnvironmentVariable;

        string Pick(string envName, string? cliValue = null)
        {
            if (!string.IsNullOrEmpty(cliValue)) return cliValue;
            string? fromEnv = env(envName);
            if (!string.IsNullOrEmpty(fromEnv)) return fromEnv;
            return envFile.TryGetValue(envName, out string? value) ? value : "";
        }

        string host = Pick("NX_SERVER_HOST", args.Host);
        var config = new AppConfig
        {
            Host = host.TrimEnd('/'),
            Password = Pick("NX_SERVER_PASSWORD", args.Password),
            SiteName = Pick("NX_SITE_NAME"),
        };
        Require(("NX_SERVER_HOST", config.Host),
                ("NX_SERVER_PASSWORD", config.Password),
                ("NX_SITE_NAME", config.SiteName));
        if (!IsHttpUrl(host))
        {
            throw new ConfigException(
                "The server address must be a full URL such as https://192.168.1.10:7001, "
                + $"not {JsonText(host)} (NX_SERVER_HOST or --host).");
        }
        // The server serves its login over plain http too, so the admin password
        // would go out in cleartext, and then refuses every Bearer call on http.
        if (!host.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            throw new ConfigException(
                "The server address must be an https:// address, because the admin "
                + $"password is sent there, not {JsonText(host)} (NX_SERVER_HOST or --host).");
        }

        string connect = Pick("NX_CONNECT_TO_CLOUD");
        config = config with { ConnectToCloud = ParseBool("NX_CONNECT_TO_CLOUD", connect.Length > 0 ? connect : "false") };
        if (config.ConnectToCloud)
        {
            string organization = Pick("NX_ORGANIZATION_ID");
            string cloudHost = Pick("NX_CLOUD_HOST");
            config = config with
            {
                CloudHost = cloudHost.TrimEnd('/') is { Length: > 0 } trimmed ? trimmed : null,
                CloudUser = Pick("NX_CLOUD_USER"),
                CloudPassword = Pick("NX_CLOUD_PASSWORD"),
                OrganizationId = organization.Length > 0 ? organization : null,
            };
            Require(("NX_CLOUD_USER", config.CloudUser),
                    ("NX_CLOUD_PASSWORD", config.CloudPassword));
            if (cloudHost.Length > 0 && !IsHttpUrl(cloudHost))
            {
                throw new ConfigException(
                    $"NX_CLOUD_HOST must be a full URL such as https://nxvms.com, not {JsonText(cloudHost)}.");
            }
            if (cloudHost.Length > 0 && !cloudHost.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                throw new ConfigException(
                    "NX_CLOUD_HOST must be an https:// address, because the Cloud password is sent "
                    + $"there, not {JsonText(cloudHost)}.");
            }
            if (config.CloudHost is null && args.Insecure)
            {
                // With --insecure nothing proves the server is the real one, so the
                // Cloud it names cannot be trusted with the Cloud password.
                throw new ConfigException(
                    "With --insecure, set NX_CLOUD_HOST to the Cloud the server belongs to, for "
                    + "example https://nxvms.com. The server's certificate is not checked, so the "
                    + "sample will not send the Cloud password to a Cloud address that only the "
                    + "server reported.");
            }
        }
        return config;
    }

    /// <summary>
    /// True for an absolute http or https URL, written as scheme://, that names a
    /// host and has no whitespace anywhere.
    /// </summary>
    internal static bool IsHttpUrl(string text)
        => !text.Any(char.IsWhiteSpace)
           && (text.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
               || text.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
           && Uri.TryCreate(text, UriKind.Absolute, out Uri? uri)
           && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
           && uri.Host.Length > 0;

    private static readonly JsonSerializerOptions PlainJson = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    internal static string JsonText(string value) => JsonSerializer.Serialize(value, PlainJson);

    private static bool ParseBool(string name, string text)
    {
        switch (text.Trim().ToLowerInvariant())
        {
            case "true" or "1": return true;
            case "false" or "0": return false;
            default: throw new ConfigException($"{name} must be true, false, 1 or 0, not '{text}'.");
        }
    }

    /// <summary>Throw a ConfigException naming every required value that is empty.</summary>
    private static void Require(params (string EnvName, string Value)[] required)
    {
        var missing = required.Where(r => r.Value.Length == 0).Select(r => r.EnvName).ToList();
        if (missing.Count > 0)
        {
            throw new ConfigException(
                $"Missing configuration: {string.Join(", ", missing)}. Set it in the environment "
                + "or in the .env file.");
        }
    }
}

/// <summary>The site settings this sample handles.</summary>
public static class SiteSettings
{
    // The key is the API name, used unchanged in the settings file and on the wire.
    // Each one defaults to on. The site has many more settings than these three, see
    // the README for how to add one.
    public static Dictionary<string, bool> Defaults() => new()
    {
        ["autoDiscoveryEnabled"] = true,
        ["cameraSettingsOptimization"] = true,
        ["statisticsAllowed"] = true,
    };

    // Looked up next to the built program, so the sample runs from any directory.
    public static string DefaultFile => Path.Combine(AppContext.BaseDirectory, "site_settings.json");

    /// <summary>
    /// Read the settings file and return the settings it names, checked.
    ///
    /// Only what the file names is returned. A new site gets Defaults() for the
    /// rest (see SiteFlow.ConfigureSiteAsync), while on an existing site a setting
    /// the file leaves out is left as it is. A file that does not exist names nothing.
    /// </summary>
    public static Dictionary<string, bool> Load(string path)
    {
        var settings = new Dictionary<string, bool>();
        Dictionary<string, bool> known = Defaults();
        string? text = ConfigFile.ReadOrNull(path);
        if (text is null) return settings;

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(text);
        }
        catch (JsonException error)
        {
            throw new ConfigException($"{path} is not valid JSON: {error.Message}");
        }

        using (document)
        {
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                throw new ConfigException(
                    $"{path} must hold a JSON object such as {{\"statisticsAllowed\": false}}.");
            }

            var fromFile = new List<KeyValuePair<string, bool>>();
            foreach (JsonProperty property in document.RootElement.EnumerateObject())
            {
                if (!known.ContainsKey(property.Name))
                {
                    throw new ConfigException(
                        $"{property.Name} is not a setting this sample handles (it handles: "
                        + $"{string.Join(", ", known.Keys)}). The site has many more settings, "
                        + "and the README explains how to add one.");
                }
                if (property.Value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                {
                    throw new ConfigException(
                        $"{property.Name} must be true or false, not {property.Value.GetRawText()}.");
                }
                fromFile.Add(new(property.Name, property.Value.GetBoolean()));
            }
            foreach (var (name, value) in fromFile) settings[name] = value;
        }
        return settings;
    }
}
