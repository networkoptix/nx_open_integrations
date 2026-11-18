// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the configuration: the .env reader, the CLI > environment >
// .env precedence, and the site settings file.

using NxConfigureSite;
using Xunit;

namespace NxConfigureSite.Tests;

internal static class Env
{
    public static readonly Dictionary<string, string> Server = new()
    {
        ["NX_SERVER_HOST"] = "https://server:7001",
        ["NX_SERVER_PASSWORD"] = "admin-pass",
        ["NX_SITE_NAME"] = "My Site",
    };

    public static Dictionary<string, string> Cloud => new(Server)
    {
        ["NX_CONNECT_TO_CLOUD"] = "true",
        ["NX_CLOUD_HOST"] = "https://cloud.example.com/",
        ["NX_CLOUD_USER"] = "owner@example.com",
        ["NX_CLOUD_PASSWORD"] = "cloud-pass",
    };

    public static Dictionary<string, string> With(Dictionary<string, string> from, string key, string value)
        => new(from) { [key] = value };

    public static Dictionary<string, string> Without(Dictionary<string, string> from, string key)
    {
        var copy = new Dictionary<string, string>(from);
        copy.Remove(key);
        return copy;
    }

    /// <summary>Tests must not pick up NX_* variables from the machine they run on.</summary>
    public static readonly Func<string, string?> None = _ => null;

    public static Func<string, string?> Only(string name, string value)
        => key => key == name ? value : null;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

public class ConfigTests : TempDirTest
{
    private static AppConfig Resolve(
        CliArgs args, Dictionary<string, string> dotenv, Func<string, string?>? env = null)
        => Config.Resolve(args, dotenv, env ?? Env.None);

    [Fact]
    public void Load_env_file_reads_pairs_and_skips_comments_blanks_and_quotes()
    {
        string path = PathIn("alt.env");
        File.WriteAllText(path,
            "# a comment\n\nNX_SITE_NAME=\"Quoted Name\"\nNX_SERVER_HOST=https://h:7001\n"
            + "NX_ORGANIZATION_ID = org-1\nnot a pair\n");

        Assert.Equal(new Dictionary<string, string>
        {
            ["NX_SITE_NAME"] = "Quoted Name",
            ["NX_SERVER_HOST"] = "https://h:7001",
            ["NX_ORGANIZATION_ID"] = "org-1",
        }, DotEnv.Load(path));
    }

    [Fact]
    public void Load_env_file_of_a_missing_file_is_empty()
    {
        Assert.Empty(DotEnv.Load(PathIn("missing.env")));
    }

    // A file that is there but cannot be read is a mistake to report, not a
    // missing file to pass over.

    [Fact]
    public void Load_env_file_of_a_directory_is_a_config_error()
    {
        var error = Assert.Throws<ConfigException>(() => DotEnv.Load(Dir));
        Assert.Equal($"Cannot read {Dir}: it is a directory.", error.Message);
    }

    [Fact]
    public void Load_env_file_of_a_file_that_cannot_be_read_is_a_config_error()
    {
        // A directory stands in for any unreadable file: unlike a file with no
        // permissions, it cannot be read even by root.
        string path = PathIn("locked.env");
        Directory.CreateDirectory(path);

        var error = Assert.Throws<ConfigException>(() => DotEnv.Load(path));
        Assert.StartsWith($"Cannot read {path}: ", error.Message);
        Assert.EndsWith(".", error.Message);
        Assert.False(error.Message.EndsWith(".."), error.Message);
    }

    [Fact]
    public void Config_reads_the_server_and_site_variables()
    {
        AppConfig config = Resolve(new CliArgs(), Env.Server);

        Assert.Equal("https://server:7001", config.Host);
        Assert.Equal("admin-pass", config.Password);
        Assert.Equal("My Site", config.SiteName);
    }

    [Fact]
    public void Cli_beats_environment_beats_dotenv_for_host_and_password()
    {
        Assert.Equal("https://from-env:7001",
            Resolve(new CliArgs(), Env.Server, Env.Only("NX_SERVER_HOST", "https://from-env:7001")).Host);
        Assert.Equal("https://from-cli:7001",
            Resolve(new CliArgs { Host = "https://from-cli:7001" }, Env.Server,
                Env.Only("NX_SERVER_HOST", "https://from-env:7001")).Host);
        Assert.Equal("https://server:7001", Resolve(new CliArgs(), Env.Server).Host);

        var envPassword = Env.Only("NX_SERVER_PASSWORD", "env-pass");
        Assert.Equal("env-pass", Resolve(new CliArgs(), Env.Server, envPassword).Password);
        Assert.Equal("cli-pass",
            Resolve(new CliArgs { Password = "cli-pass" }, Env.Server, envPassword).Password);
    }

    [Fact]
    public void The_site_name_has_no_flag_so_the_environment_beats_dotenv()
    {
        AppConfig config = Resolve(new CliArgs(), Env.Server, Env.Only("NX_SITE_NAME", "From Env"));
        Assert.Equal("From Env", config.SiteName);
    }

    [Fact]
    public void Trailing_slash_is_stripped_from_the_host()
    {
        var env = Env.With(Env.Server, "NX_SERVER_HOST", "https://server:7001/");
        Assert.Equal("https://server:7001", Resolve(new CliArgs(), env).Host);
    }

    [Fact]
    public void Connecting_to_the_cloud_is_off_by_default_and_needs_no_cloud_values()
    {
        Assert.False(Resolve(new CliArgs(), Env.Server).ConnectToCloud);
    }

    [Theory]
    [InlineData("true", true)]
    [InlineData("TRUE", true)]
    [InlineData("1", true)]
    [InlineData("false", false)]
    [InlineData("False", false)]
    [InlineData("0", false)]
    public void Connect_to_cloud_accepts_true_false_1_and_0(string text, bool expected)
    {
        var env = Env.With(Env.Cloud, "NX_CONNECT_TO_CLOUD", text);
        Assert.Equal(expected, Resolve(new CliArgs(), env).ConnectToCloud);
    }

    [Theory]
    [InlineData("yes")]
    [InlineData("on")]
    [InlineData("maybe")]
    [InlineData("2")]
    public void Connect_to_cloud_rejects_anything_else(string text)
    {
        var env = Env.With(Env.Cloud, "NX_CONNECT_TO_CLOUD", text);
        var error = Assert.Throws<ConfigException>(() => Resolve(new CliArgs(), env));
        Assert.Contains("NX_CONNECT_TO_CLOUD", error.Message);
    }

    [Theory]
    [InlineData("NX_CLOUD_USER")]
    [InlineData("NX_CLOUD_PASSWORD")]
    public void Connecting_without_a_cloud_value_is_a_config_error_naming_it(string missing)
    {
        var error = Assert.Throws<ConfigException>(
            () => Resolve(new CliArgs(), Env.Without(Env.Cloud, missing)));
        Assert.Contains(missing, error.Message);
    }

    [Fact]
    public void Cloud_values_are_read_when_connecting()
    {
        var env = Env.With(Env.Cloud, "NX_ORGANIZATION_ID", "org-1");

        AppConfig config = Resolve(new CliArgs(), env);

        Assert.Equal("https://cloud.example.com", config.CloudHost);
        Assert.Equal("owner@example.com", config.CloudUser);
        Assert.Equal("cloud-pass", config.CloudPassword);
        Assert.Equal("org-1", config.OrganizationId);
    }

    [Fact]
    public void The_cloud_host_is_optional_and_the_organization_defaults_to_none()
    {
        AppConfig config = Resolve(new CliArgs(), Env.Without(Env.Cloud, "NX_CLOUD_HOST"));
        Assert.Null(config.CloudHost);
        Assert.Null(config.OrganizationId);
    }

    [Fact]
    public void Nx_customization_is_not_read_any_more()
    {
        // The server reports its own customization, see SiteFlow.CloudTarget.
        // AppConfig has no Customization at all, so the check is that a value set
        // here changes nothing.
        AppConfig config = Resolve(new CliArgs(), Env.With(Env.Cloud, "NX_CUSTOMIZATION", "metavms"));
        Assert.Equal(Resolve(new CliArgs(), Env.Cloud), config);
    }

    [Theory]
    [InlineData("NX_SERVER_HOST")]
    [InlineData("NX_SERVER_PASSWORD")]
    [InlineData("NX_SITE_NAME")]
    public void A_missing_required_value_is_a_config_error_naming_it(string missing)
    {
        var error = Assert.Throws<ConfigException>(
            () => Resolve(new CliArgs(), Env.Without(Env.Server, missing)));
        Assert.Contains(missing, error.Message);
    }

    // An address HttpClient cannot use must stop the run here, as a config error,
    // and not later as an unhandled exception from the first request.

    [Theory]
    [InlineData("not-a-url", "\"not-a-url\"")]
    [InlineData("ftp://h", "\"ftp://h\"")]
    [InlineData("https://", "\"https://\"")]
    [InlineData("http://bad host:7001", "\"http://bad host:7001\"")]
    [InlineData("say \"hi\"", "\"say \\\"hi\\\"\"")]
    // A whitespace anywhere, no literal scheme://, and a broken IPv6 address
    // are all "not a URL", never an unhandled exception.
    [InlineData("localhost:7001", "\"localhost:7001\"")]
    [InlineData("https://h:7001/a b", "\"https://h:7001/a b\"")]
    [InlineData(" https://h:7001", "\" https://h:7001\"")]
    [InlineData("https://h:7001\t", "\"https://h:7001\\t\"")]
    [InlineData("http:h", "\"http:h\"")]
    [InlineData("http://[abc", "\"http://[abc\"")]
    [InlineData("https://[::1", "\"https://[::1\"")]
    public void A_server_address_that_is_not_a_full_url_is_a_config_error(string host, string jsonText)
    {
        string expected = "The server address must be a full URL such as https://192.168.1.10:7001, "
            + $"not {jsonText} (NX_SERVER_HOST or --host).";

        var fromEnv = Assert.Throws<ConfigException>(
            () => Resolve(new CliArgs(), Env.With(Env.Server, "NX_SERVER_HOST", host)));
        Assert.Equal(expected, fromEnv.Message);

        var fromFlag = Assert.Throws<ConfigException>(
            () => Resolve(new CliArgs { Host = host }, Env.Server));
        Assert.Equal(expected, fromFlag.Message);
    }

    [Theory]
    [InlineData("https://h")]
    [InlineData("https://192.168.1.10:7001")]
    [InlineData("HTTPS://server")]
    public void A_full_https_server_address_is_accepted(string host)
    {
        Assert.Equal(host, Resolve(new CliArgs { Host = host }, Env.Server).Host);
    }

    // The server's login works over http, so the password would go out in
    // cleartext, and every Bearer call after it is refused with 403.
    [Theory]
    [InlineData("http://h")]
    [InlineData("http://192.168.1.10:7001")]
    [InlineData("HTTP://server:7001")]
    public void A_plain_http_server_address_is_a_config_error(string host)
    {
        string expected = "The server address must be an https:// address, because the admin password "
            + $"is sent there, not \"{host}\" (NX_SERVER_HOST or --host).";

        var fromEnv = Assert.Throws<ConfigException>(
            () => Resolve(new CliArgs(), Env.With(Env.Server, "NX_SERVER_HOST", host)));
        Assert.Equal(expected, fromEnv.Message);

        var fromFlag = Assert.Throws<ConfigException>(
            () => Resolve(new CliArgs { Host = host }, Env.Server));
        Assert.Equal(expected, fromFlag.Message);
    }

    [Theory]
    [InlineData("not-a-url", "\"not-a-url\"")]
    [InlineData("ftp://h", "\"ftp://h\"")]
    [InlineData("https://", "\"https://\"")]
    [InlineData("https://nx vms.com", "\"https://nx vms.com\"")]
    [InlineData("localhost:7001", "\"localhost:7001\"")]
    [InlineData("https://nxvms.com/a b", "\"https://nxvms.com/a b\"")]
    [InlineData("http://[abc", "\"http://[abc\"")]
    public void A_cloud_address_that_is_not_a_full_url_is_a_config_error(string host, string jsonText)
    {
        var error = Assert.Throws<ConfigException>(
            () => Resolve(new CliArgs(), Env.With(Env.Cloud, "NX_CLOUD_HOST", host)));
        Assert.Equal(
            $"NX_CLOUD_HOST must be a full URL such as https://nxvms.com, not {jsonText}.",
            error.Message);
    }

    [Fact]
    public void Nx_cloud_host_must_be_https()
    {
        var error = Assert.Throws<ConfigException>(
            () => Resolve(new CliArgs(), Env.With(Env.Cloud, "NX_CLOUD_HOST", "http://nxvms.com")));
        Assert.Equal(
            "NX_CLOUD_HOST must be an https:// address, because the Cloud password is sent there, "
            + "not \"http://nxvms.com\".",
            error.Message);
    }

    [Fact]
    public void With_insecure_the_cloud_host_must_be_given()
    {
        // Without a checked certificate the server could be anyone, so the Cloud it
        // names must not receive the Cloud password.
        var env = Env.Without(Env.Cloud, "NX_CLOUD_HOST");

        var error = Assert.Throws<ConfigException>(() => Resolve(new CliArgs { Insecure = true }, env));

        Assert.Equal(
            "With --insecure, set NX_CLOUD_HOST to the Cloud the server belongs to, for example "
            + "https://nxvms.com. The server's certificate is not checked, so the sample will not "
            + "send the Cloud password to a Cloud address that only the server reported.",
            error.Message);
        Assert.Equal("https://cloud.example.com", Resolve(new CliArgs { Insecure = true }, Env.Cloud).CloudHost);
        Assert.Null(Resolve(new CliArgs(), env).CloudHost);
        Assert.False(Resolve(new CliArgs { Insecure = true }, Env.Server).ConnectToCloud);
    }

    [Fact]
    public void The_cloud_address_is_not_checked_when_not_connecting()
    {
        var env = Env.With(Env.Server, "NX_CLOUD_HOST", "not-a-url");
        Assert.False(Resolve(new CliArgs(), env).ConnectToCloud);
    }

    // The command line itself.

    [Fact]
    public void Flags_are_parsed_with_a_space_or_an_equals_sign()
    {
        CliArgs args = Config.ParseArgs(
            ["--host", "https://h:7001", "--password=pw", "--env-file", "x.env",
             "--settings-file=s.json", "--insecure", "--yes"]);

        Assert.Equal("https://h:7001", args.Host);
        Assert.Equal("pw", args.Password);
        Assert.Equal("x.env", args.EnvFile);
        Assert.Equal("s.json", args.SettingsFile);
        Assert.True(args.Insecure);
        Assert.True(args.Yes);
    }

    [Fact]
    public void Defaults_are_dotenv_in_the_current_folder_and_the_settings_file_next_to_the_program()
    {
        CliArgs args = Config.ParseArgs([]);

        Assert.Equal(".env", args.EnvFile);
        Assert.Equal(Path.Combine(AppContext.BaseDirectory, "site_settings.json"), args.SettingsFile);
        Assert.False(args.Insecure);
        Assert.False(args.Yes);
    }

    [Theory]
    [InlineData("--mfa-code", "123456")]
    [InlineData("--mfa-code=123456")]
    public void Mfa_code_is_a_command_line_flag(params string[] argv)
    {
        Assert.Equal("123456", Config.ParseArgs(argv).MfaCode);
        Assert.Null(Config.ParseArgs([]).MfaCode);
    }

    [Fact]
    public void Mfa_code_without_a_value_is_rejected()
    {
        var error = Assert.Throws<ArgumentException>(() => Config.ParseArgs(["--mfa-code"]));
        Assert.Equal("Missing value for --mfa-code", error.Message);
    }

    [Fact]
    public void The_usage_names_the_mfa_code_flag()
    {
        Assert.Contains("--mfa-code <code>", Config.Usage);
    }

    [Theory]
    [InlineData("--bogus")]
    [InlineData("positional")]
    public void An_unknown_argument_is_rejected(string argument)
    {
        Assert.Throws<ArgumentException>(() => Config.ParseArgs([argument]));
    }
}

// ---------------------------------------------------------------------------
// The settings file
// ---------------------------------------------------------------------------

public class SettingsFileTests : TempDirTest
{
    private string WriteSettingsFile(string text)
    {
        string path = PathIn("site_settings.json");
        File.WriteAllText(path, text);
        return path;
    }

    [Fact]
    public void A_missing_settings_file_names_no_settings()
    {
        Assert.Empty(SiteSettings.Load(PathIn("no-such-file.json")));
    }

    [Fact]
    public void A_settings_path_that_is_a_directory_is_a_config_error()
    {
        var error = Assert.Throws<ConfigException>(() => SiteSettings.Load(Dir));
        Assert.Equal($"Cannot read {Dir}: it is a directory.", error.Message);
    }

    [Fact]
    public void A_settings_file_that_cannot_be_read_is_a_config_error()
    {
        // A directory stands in for any unreadable file: unlike a file with no
        // permissions, it cannot be read even by root.
        string path = PathIn("site_settings.json");
        Directory.CreateDirectory(path);

        var error = Assert.Throws<ConfigException>(() => SiteSettings.Load(path));
        Assert.StartsWith($"Cannot read {path}: ", error.Message);
        Assert.EndsWith(".", error.Message);
    }

    [Theory]
    [InlineData("autoDiscoveryEnabled")]
    [InlineData("cameraSettingsOptimization")]
    [InlineData("statisticsAllowed")]
    public void A_false_in_the_file_goes_out_as_false_under_the_same_name(string name)
    {
        // The wire field name is the key in the file, unchanged.
        string path = WriteSettingsFile("{\"" + name + "\": false}");

        Assert.Equal(new Dictionary<string, bool> { [name] = false }, SiteSettings.Load(path));
    }

    [Theory]
    [InlineData("\"false\"")]
    [InlineData("0")]
    [InlineData("1")]
    [InlineData("null")]
    [InlineData("[]")]
    public void A_non_boolean_value_is_a_config_error(string value)
    {
        string path = WriteSettingsFile("{\"autoDiscoveryEnabled\": " + value + "}");
        var error = Assert.Throws<ConfigException>(() => SiteSettings.Load(path));
        Assert.Contains("autoDiscoveryEnabled", error.Message);
    }

    [Theory]
    [InlineData("\"false\"")]
    [InlineData("null")]
    [InlineData("1")]
    [InlineData("[]")]
    public void The_message_for_a_non_boolean_value_shows_it_as_json_text(string value)
    {
        string path = WriteSettingsFile("{\"statisticsAllowed\": " + value + "}");
        var error = Assert.Throws<ConfigException>(() => SiteSettings.Load(path));
        Assert.Equal($"statisticsAllowed must be true or false, not {value}.", error.Message);
    }

    [Fact]
    public void An_unsupported_setting_is_a_config_error_that_points_at_the_readme()
    {
        string path = WriteSettingsFile("{\"auditTrailEnabled\": true}");
        var error = Assert.Throws<ConfigException>(() => SiteSettings.Load(path));
        Assert.Contains("auditTrailEnabled", error.Message);
        Assert.Contains("README", error.Message);
    }

    [Theory]
    [InlineData("{not json")]
    [InlineData("[true, false]")]
    [InlineData("\"text\"")]
    public void A_settings_file_that_is_not_a_json_object_is_a_config_error(string text)
    {
        string path = WriteSettingsFile(text);
        var error = Assert.Throws<ConfigException>(() => SiteSettings.Load(path));
        Assert.Contains("JSON", error.Message);
    }
}
