// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the flow and the summary text, with both clients faked.

using NxConfigureSite;
using Xunit;

namespace NxConfigureSite.Tests;

internal static class FlowConfigs
{
    public static readonly AppConfig Plain = new()
    {
        Host = "https://server:7001",
        Password = "admin-pass",
        SiteName = "My Site",
        ConnectToCloud = false,
    };

    public static readonly AppConfig Cloud = Plain with
    {
        ConnectToCloud = true,
        CloudHost = "https://cloud.example.com",
        CloudUser = "owner@example.com",
        CloudPassword = "cloud-pass",
        OrganizationId = null,
    };
}

public class SiteFlowTests
{
    [Fact]
    public async Task A_new_server_is_set_up_with_the_factory_login_then_the_new_password()
    {
        var log = new List<Call>();
        var server = new FakeServer(log);

        SiteSummary summary = await SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Plain, Settings.ThreeTrue(), server, makeCloud: null);

        Assert.Equal(new[]
        {
            "server.get_site_info", "server.login", "server.setup",
            "server.logout", "server.login", "server.apply_settings",
        }, log.Names());
        Assert.Equal(new[] { "admin", "admin" }, log[1].Args);
        Assert.Equal(new[] { "My Site", "admin-pass" }, log[2].Args);
        Assert.Equal(Settings.ThreeTrue(), server.SetupSettings);
        Assert.Equal(new[] { "admin", "admin-pass" }, log[4].Args);
        Assert.True(summary.SetUp);
        Assert.Equal("My Site", summary.SiteName);
        Assert.Equal(CloudState.NotConnected, summary.Cloud);
    }

    [Fact]
    public async Task A_new_server_whose_factory_login_is_rejected_is_not_set_up()
    {
        var log = new List<Call>();
        var server = new FakeServer(log) { RejectedPasswords = new[] { "admin" } };

        var error = await Assert.ThrowsAsync<ApiException>(() => SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Plain, Settings.ThreeTrue(), server, makeCloud: null));

        Assert.Contains("factory login (admin/admin)", error.Message);
        Assert.DoesNotContain("server.setup", log.Names());
    }

    [Fact]
    public async Task A_refused_setup_stops_the_run()
    {
        var log = new List<Call>();
        var server = new FakeServer(log) { Fail = "server.setup" };

        await Assert.ThrowsAsync<ApiException>(() => SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Plain, Settings.ThreeTrue(), server, makeCloud: null));

        Assert.DoesNotContain("server.apply_settings", log.Names());
    }

    [Fact]
    public async Task An_existing_site_is_refused_without_yes_and_nothing_is_changed()
    {
        var log = new List<Call>();
        var server = new FakeServer(log) { Info = FakeServer.Existing };

        var error = await Assert.ThrowsAsync<ExistingSiteException>(() => SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Cloud, Settings.ThreeTrue(), server, new FakeCloud(log).Make));

        Assert.Equal(new[] { "server.get_site_info" }, log.Names());
        Assert.Contains("https://server:7001", error.Message);
        Assert.Contains("Front Office", error.Message);
        Assert.Contains("--yes", error.Message);
    }

    [Fact]
    public async Task An_existing_site_with_yes_is_updated_under_its_real_name()
    {
        var log = new List<Call>();
        var server = new FakeServer(log) { Info = FakeServer.Existing };

        SiteSummary summary = await SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Plain, Settings.ThreeTrue(), server, makeCloud: null, allowExisting: true);

        Assert.Equal(new[] { "server.get_site_info", "server.login", "server.apply_settings" }, log.Names());
        Assert.Equal(new[] { "admin", "admin-pass" }, log[1].Args);
        Assert.False(summary.SetUp);
        Assert.Equal("Front Office", summary.SiteName);
    }

    [Fact]
    public async Task An_existing_unbound_site_with_yes_is_registered_under_its_real_name()
    {
        var log = new List<Call>();
        var server = new FakeServer(log) { Info = FakeServer.Existing };

        SiteSummary summary = await SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Cloud, Settings.ThreeTrue(), server, new FakeCloud(log).Make, allowExisting: true);

        Assert.True(log.Has("cloud.register_site", "Front Office", "default", null));
        Assert.Equal(CloudState.Connected, summary.Cloud);
    }

    [Fact]
    public async Task A_site_already_bound_to_the_cloud_is_not_registered_again()
    {
        var log = new List<Call>();
        var server = new FakeServer(log) { Info = FakeServer.ExistingBound };

        SiteSummary summary = await SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Cloud, Settings.ThreeTrue(), server, new FakeCloud(log).Make, allowExisting: true);

        Assert.DoesNotContain(log.Names(), name => name.StartsWith("cloud."));
        Assert.DoesNotContain("server.cloud_bind", log.Names());
        Assert.Equal(CloudState.Already, summary.Cloud);
        Assert.Equal("cloud-site-9", summary.CloudId);
    }

    /// <summary>
    /// site/setup carries "cloud" instead of "local": no local admin password
    /// is set, and the server rolls the setup back if the bind fails.
    /// </summary>
    [Fact]
    public async Task A_new_cloud_site_is_set_up_and_bound_in_one_site_setup()
    {
        var log = new List<Call>();
        var server = new FakeServer(log);

        SiteSummary summary = await SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Cloud, Settings.ThreeTrue(), server, new FakeCloud(log).Make);

        // The Cloud login comes before anything on the server changes.
        Assert.Equal(new[]
        {
            "server.get_site_info", "cloud.login", "server.login",
            "cloud.register_site", "server.setup", "server.logout",
        }, log.Names());
        Assert.True(log.Has("server.login", "admin", "admin"));
        Assert.True(log.Has("cloud.register_site", "My Site", "default", null));
        Assert.True(log.Has("server.setup", "My Site", null, "auth-key-1", "owner@example.com", "site-id-1", null));
        Assert.Equal(new CloudAuth("auth-key-1", "owner@example.com", "site-id-1"), server.SetupCloud);
        Assert.Equal(Settings.ThreeTrue(), server.SetupSettings);
        Assert.Equal(CloudState.Connected, summary.Cloud);
        Assert.True(summary.SetUp);
    }

    [Fact]
    public async Task An_existing_site_with_yes_is_still_bound_with_cloud_bind()
    {
        var log = new List<Call>();
        var server = new FakeServer(log) { Info = FakeServer.Existing };

        await SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Cloud, Settings.ThreeTrue(), server, new FakeCloud(log).Make, allowExisting: true);

        Assert.Equal(new[]
        {
            "server.get_site_info", "cloud.login", "server.login",
            "cloud.register_site", "server.cloud_bind", "server.apply_settings",
        }, log.Names());
        Assert.True(log.Has("server.cloud_bind", "auth-key-1", "owner@example.com", "site-id-1", null));
    }

    [Fact]
    public async Task A_failed_cloud_login_leaves_a_new_server_untouched()
    {
        var log = new List<Call>();

        await Assert.ThrowsAsync<ApiException>(() => SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Cloud, Settings.ThreeTrue(), new FakeServer(log),
            new FakeCloud(log) { Fail = "cloud.login" }.Make));

        Assert.Equal(new[] { "server.get_site_info", "cloud.login" }, log.Names());
    }

    [Fact]
    public async Task An_existing_site_is_refused_before_the_cloud_login()
    {
        var log = new List<Call>();

        await Assert.ThrowsAsync<ExistingSiteException>(() => SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Cloud, Settings.ThreeTrue(), new FakeServer(log) { Info = FakeServer.Existing },
            new FakeCloud(log).Make));

        Assert.Equal(new[] { "server.get_site_info" }, log.Names());
    }

    [Fact]
    public async Task The_flow_passes_the_organization_to_both_cloud_calls()
    {
        var log = new List<Call>();
        AppConfig config = FlowConfigs.Cloud with { OrganizationId = "org-1" };

        var server = new FakeServer(log);

        await SiteFlow.ConfigureSiteAsync(config, Settings.ThreeTrue(), server, new FakeCloud(log).Make);

        Assert.True(log.Has("cloud.register_site", "My Site", "default", "org-1"));
        Assert.Equal(new CloudAuth("auth-key-1", "owner@example.com", "site-id-1", "org-1"), server.SetupCloud);
    }

    [Fact]
    public async Task A_new_site_is_set_up_with_the_defaults_for_what_the_file_leaves_out()
    {
        var server = new FakeServer();
        var fromFile = new Dictionary<string, bool> { ["statisticsAllowed"] = false };

        await SiteFlow.ConfigureSiteAsync(FlowConfigs.Plain, fromFile, server, makeCloud: null);

        Dictionary<string, bool> expected = Settings.ThreeTrue();
        expected["statisticsAllowed"] = false;
        Assert.Equal(expected, server.SetupSettings);
        Assert.Equal(fromFile, server.AppliedSettings);
    }

    [Fact]
    public async Task An_existing_site_is_patched_only_with_what_the_file_names()
    {
        // An administrator turned autoDiscoveryEnabled off. A file that names only
        // statisticsAllowed must not turn it back on.
        var server = new FakeServer { Info = FakeServer.Existing };
        var fromFile = new Dictionary<string, bool> { ["statisticsAllowed"] = false };

        await SiteFlow.ConfigureSiteAsync(FlowConfigs.Plain, fromFile, server, makeCloud: null, allowExisting: true);

        Assert.Equal(fromFile, server.AppliedSettings);
    }

    [Fact]
    public async Task An_existing_site_with_no_settings_named_gets_no_settings_call()
    {
        var log = new List<Call>();
        var server = new FakeServer(log) { Info = FakeServer.Existing };

        SiteSummary summary = await SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Plain, new Dictionary<string, bool>(), server, makeCloud: null, allowExisting: true);

        Assert.DoesNotContain("server.apply_settings", log.Names());
        Assert.Empty(summary.SettingsChanged);
    }

    [Fact]
    public async Task The_cloud_and_customization_come_from_the_server()
    {
        // A white-label server joins its own Cloud under its own customization.
        var log = new List<Call>();
        var cloud = new FakeCloud(log);
        var server = new FakeServer(log)
        {
            Info = FakeServer.New with { CloudHost = "cloud.brand.example", Customization = "brand_x" },
        };
        AppConfig config = FlowConfigs.Cloud with { CloudHost = null };

        SiteSummary summary = await SiteFlow.ConfigureSiteAsync(config, Settings.ThreeTrue(), server, cloud.Make);

        Assert.Equal("https://cloud.brand.example", cloud.Url);
        Assert.True(log.Has("cloud.register_site", "My Site", "brand_x", null));
        Assert.Equal("https://cloud.brand.example", summary.CloudUrl);
    }

    [Fact]
    public async Task Nx_cloud_host_naming_another_cloud_stops_before_anything_changes()
    {
        var log = new List<Call>();
        var server = new FakeServer(log) { Info = FakeServer.New with { CloudHost = "cloud.brand.example" } };
        AppConfig config = FlowConfigs.Cloud with { CloudHost = "https://nxvms.com" };

        var error = await Assert.ThrowsAsync<ApiException>(() => SiteFlow.ConfigureSiteAsync(
            config, Settings.ThreeTrue(), server, new FakeCloud(log).Make));

        Assert.Equal(new[] { "server.get_site_info" }, log.Names());
        Assert.Contains("https://cloud.brand.example", error.Message);
        Assert.Contains("NX_CLOUD_HOST", error.Message);
    }

    [Fact]
    public async Task Nx_cloud_host_naming_the_same_cloud_is_accepted()
    {
        var cloud = new FakeCloud();
        AppConfig config = FlowConfigs.Cloud with { CloudHost = "https://CLOUD.example.com" };

        await SiteFlow.ConfigureSiteAsync(config, Settings.ThreeTrue(), new FakeServer(), cloud.Make);

        Assert.Equal("https://cloud.example.com", cloud.Url);
    }

    [Fact]
    public async Task The_default_port_in_nx_cloud_host_names_the_same_cloud()
    {
        // https://x and https://x:443 are the same Cloud.
        var cloud = new FakeCloud();
        AppConfig config = FlowConfigs.Cloud with { CloudHost = "https://cloud.example.com:443" };

        await SiteFlow.ConfigureSiteAsync(config, Settings.ThreeTrue(), new FakeServer(), cloud.Make);

        Assert.Equal("https://cloud.example.com", cloud.Url);
    }

    [Fact]
    public async Task Another_port_in_nx_cloud_host_names_another_cloud()
    {
        AppConfig config = FlowConfigs.Cloud with { CloudHost = "https://cloud.example.com:8443" };

        var error = await Assert.ThrowsAsync<ApiException>(() => SiteFlow.ConfigureSiteAsync(
            config, Settings.ThreeTrue(), new FakeServer(), new FakeCloud().Make));

        Assert.Contains("NX_CLOUD_HOST", error.Message);
    }

    [Fact]
    public async Task The_default_port_reported_by_the_server_names_the_same_cloud()
    {
        var cloud = new FakeCloud();
        var server = new FakeServer { Info = FakeServer.New with { CloudHost = "https://CLOUD.example.com:443/" } };

        await SiteFlow.ConfigureSiteAsync(FlowConfigs.Cloud, Settings.ThreeTrue(), server, cloud.Make);

        Assert.Equal("https://CLOUD.example.com:443", cloud.Url);
    }

    [Fact]
    public void A_cloud_the_server_reports_as_plain_http_is_refused()
    {
        var error = Assert.Throws<ApiException>(() => SiteFlow.CloudTarget(
            FlowConfigs.Cloud with { CloudHost = null },
            FakeServer.New with { CloudHost = "http://cloud.example.com" }));

        Assert.Equal(
            "The server reports its Cloud as \"http://cloud.example.com\", which is not an https:// "
            + "address, so the sample will not send the Cloud password there.",
            error.Message);
    }

    [Theory]
    [InlineData("[abc")]
    [InlineData("https://cloud example.com")]
    public void A_broken_cloud_host_reported_by_the_server_is_an_ApiException(string reported)
    {
        var error = Assert.Throws<ApiException>(() => SiteFlow.CloudTarget(
            FlowConfigs.Cloud, FakeServer.New with { CloudHost = reported }));
        Assert.Contains("which is not an https:// address", error.Message);
    }

    [Theory]
    [InlineData("cloudHost")]
    [InlineData("customization")]
    public async Task A_server_that_does_not_report_its_cloud_cannot_be_connected(string missing)
    {
        var log = new List<Call>();
        SiteInfo info = missing == "cloudHost"
            ? FakeServer.New with { CloudHost = "" }
            : FakeServer.New with { Customization = "" };
        var server = new FakeServer(log) { Info = info };

        var error = await Assert.ThrowsAsync<ApiException>(() => SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Cloud, Settings.ThreeTrue(), server, new FakeCloud(log).Make));

        Assert.Contains("cloudHost and customization", error.Message);
        Assert.Equal(new[] { "server.get_site_info" }, log.Names());
    }

    [Fact]
    public async Task A_bound_site_needs_no_cloud_host_from_the_server()
    {
        var server = new FakeServer { Info = FakeServer.ExistingBound with { CloudHost = "" } };

        SiteSummary summary = await SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Cloud, Settings.ThreeTrue(), server, new FakeCloud().Make, allowExisting: true);

        Assert.Equal(CloudState.Already, summary.Cloud);
    }

    [Fact]
    public async Task A_rejected_login_with_the_new_password_is_an_auth_error()
    {
        var server = new FakeServer { RejectedPasswords = new[] { "admin-pass" } };
        await Assert.ThrowsAsync<AuthException>(() => SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Plain, Settings.ThreeTrue(), server, makeCloud: null));
    }

    [Fact]
    public async Task The_summary_reports_which_settings_were_changed()
    {
        SiteSummary summary = await SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Plain, Settings.ThreeTrue(), new FakeServer(), makeCloud: null);

        Assert.Equal(new Dictionary<string, bool> { ["statisticsAllowed"] = false }, summary.SettingsChanged);
    }

    [Theory]
    [InlineData("server.get_site_info", "server.login,server.setup,cloud.login")]
    [InlineData("server.setup", "cloud.login,server.apply_settings")]
    [InlineData("server.login", "cloud.login,cloud.register_site,server.apply_settings")]
    [InlineData("cloud.login", "cloud.register_site,server.cloud_bind,server.apply_settings")]
    [InlineData("cloud.register_site", "server.cloud_bind,server.apply_settings")]
    public async Task A_failing_step_stops_the_flow_before_the_next_ones(string failing, string later)
    {
        var log = new List<Call>();
        var server = new FakeServer(log) { Fail = failing.StartsWith("server.") ? failing : null };
        var cloud = new FakeCloud(log) { Fail = failing.StartsWith("cloud.") ? failing : null };

        await Assert.ThrowsAsync<ApiException>(() => SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Cloud, Settings.ThreeTrue(), server, cloud.Make));

        List<string> ran = log.Names();
        Assert.Contains(failing, ran);
        Assert.Empty(later.Split(',').Intersect(ran.Skip(ran.IndexOf(failing) + 1)));
    }

    [Fact]
    public async Task The_flow_hands_the_code_source_to_the_cloud_login()
    {
        var cloud = new FakeCloud();
        Func<Task<string?>> source = () => Task.FromResult<string?>("123456");

        await SiteFlow.ConfigureSiteAsync(
            FlowConfigs.Cloud, Settings.ThreeTrue(), new FakeServer(), cloud.Make, getMfaCode: source);

        Assert.Same(source, cloud.GetMfaCode);
    }
}

// ---------------------------------------------------------------------------
// The summary text
// ---------------------------------------------------------------------------

public class SummaryTests
{
    private static SiteSummary Summary(
        string siteName = "My Site", bool setUp = true, CloudState cloud = CloudState.NotConnected,
        string? cloudId = null, string? cloudUrl = null, Dictionary<string, bool>? changed = null)
        => new(siteName, setUp, cloud, cloudId, cloudUrl, changed ?? new Dictionary<string, bool>());

    [Fact]
    public void The_summary_names_the_cloud_account_as_owner_for_a_personal_site()
    {
        string text = SiteFlow.FormatSummary(
            FlowConfigs.Cloud, Summary(cloud: CloudState.Connected, cloudUrl: "https://cloud.example.com"));
        Assert.Contains("connected to https://cloud.example.com, owned by owner@example.com", text);
    }

    [Fact]
    public void The_summary_names_the_organization_as_owner_for_an_organization_site()
    {
        AppConfig config = FlowConfigs.Cloud with { OrganizationId = "org-1" };

        string text = SiteFlow.FormatSummary(
            config, Summary(cloud: CloudState.Connected, cloudUrl: "https://cloud.example.com"));

        Assert.Contains("owned by organization org-1", text);
        Assert.DoesNotContain("owner@example.com", text);
    }

    [Fact]
    public void The_summary_says_when_the_site_was_already_connected()
    {
        string text = SiteFlow.FormatSummary(
            FlowConfigs.Cloud, Summary(cloud: CloudState.Already, cloudId: "cloud-site-9"));
        Assert.Contains("already connected (Cloud id cloud-site-9), left as it was", text);
    }

    [Fact]
    public void The_summary_uses_the_real_site_name_of_an_existing_site()
    {
        string text = SiteFlow.FormatSummary(FlowConfigs.Plain, Summary(siteName: "Front Office", setUp: false));
        Assert.Contains("Site name       : Front Office", text);
        Assert.DoesNotContain("My Site", text);
        Assert.Contains("no, the server already belonged to a site", text);
    }

    [Fact]
    public void The_summary_says_when_nothing_is_connected_or_changed()
    {
        string text = SiteFlow.FormatSummary(FlowConfigs.Plain, Summary());
        Assert.Contains("not connected", text);
        Assert.Contains("none", text);
    }

    [Fact]
    public void The_summary_lists_changed_settings_with_lowercase_values()
    {
        string text = SiteFlow.FormatSummary(
            FlowConfigs.Plain, Summary(changed: new Dictionary<string, bool> { ["statisticsAllowed"] = false }));
        Assert.Contains("statisticsAllowed=false", text);
    }
}
