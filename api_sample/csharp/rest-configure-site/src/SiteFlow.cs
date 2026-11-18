// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// The flow: the steps in order, and the summary text. No HTTP here, only calls
// on the two clients, so the tests run it with fakes.

namespace NxConfigureSite;

/// <summary>The server already belongs to a site and --yes was not given.</summary>
public sealed class ExistingSiteException : Exception
{
    public ExistingSiteException(string message) : base(message) { }
}

/// <summary>What the run did about the Cloud.</summary>
public enum CloudState
{
    NotConnected,
    Connected,
    // The site was bound to the Cloud before the run, and was left as it was.
    Already,
}

/// <summary>What the run did, for FormatSummary.</summary>
public sealed record SiteSummary(
    string SiteName, bool SetUp, CloudState Cloud, string? CloudId, string? CloudUrl,
    Dictionary<string, bool> SettingsChanged);

public static class SiteFlow
{
    // Setup creates this account, so it is the one to log in with.
    public const string LocalAdmin = "admin";

    // What a factory-default server's local "admin" account logs in with. site/setup
    // needs an administrator, and before setup this is the only account there is.
    public const string FactoryPassword = "admin";

    /// <summary>
    /// The Cloud URL and customization to register the site with, from site/info.
    ///
    /// A server can only be bound to the Cloud it was built for, under its own
    /// customization (a white-label build has its own), so both come from the
    /// server. NX_CLOUD_HOST, when set, must name the same Cloud.
    /// </summary>
    public static (string Url, string Customization) CloudTarget(AppConfig config, SiteInfo info)
    {
        string reported = (info.CloudHost ?? "").Trim().TrimEnd('/');
        string customization = info.Customization ?? "";
        if (reported.Length == 0 || customization.Length == 0)
        {
            throw new ApiException("The server's site/info did not report its cloudHost and "
                + "customization, so the sample cannot tell which Cloud to register the site with.");
        }
        if (!reported.Contains("://")) reported = "https://" + reported;
        if (!reported.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || !Config.IsHttpUrl(reported))
        {
            throw new ApiException(
                $"The server reports its Cloud as {Config.JsonText(reported)}, which is not an https:// "
                + "address, so the sample will not send the Cloud password there.");
        }
        string? wanted = config.CloudHost;
        if (!string.IsNullOrEmpty(wanted) && HostAndPort(wanted) != HostAndPort(reported))
        {
            throw new ApiException(
                $"NX_CLOUD_HOST is {wanted}, but this server belongs to the Cloud at {reported}. A "
                + "server can only be connected to its own Cloud. Remove NX_CLOUD_HOST "
                + $"or set it to {reported}.");
        }
        return (reported, customization);
    }

    /// <summary>
    /// The "cloud" object of site/setup: what the Cloud registration returned,
    /// plus the owner the API requires and the organization, if any.
    /// </summary>
    internal static CloudAuth CloudAuthFor(RegisteredSite registered, AppConfig config)
        => new(registered.AuthKey, config.CloudUser, registered.SiteId,
            string.IsNullOrEmpty(config.OrganizationId) ? null : config.OrganizationId);

    // host[:port] in lower case.
    internal static string HostAndPort(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri)) return url.ToLowerInvariant();
        string host = uri.Host.ToLowerInvariant();
        return uri.IsDefaultPort ? host : $"{host}:{uri.Port}";
    }

    /// <summary>
    /// Run the steps in order and return a summary. Any failure stops the run.
    ///
    /// site/info decides the path. A factory-default server is set up. A server
    /// that already belongs to a site is left alone unless allowExisting (--yes) is
    /// set, because NX_SERVER_HOST and NX_SERVER_PASSWORD are shared with the other
    /// samples and may well point at a site in use. A site that is already bound to
    /// the Cloud is not registered again.
    ///
    /// settings holds only what the settings file names.
    ///
    /// makeCloud(url) returns the Cloud client. It is called only once site/info
    /// has said which Cloud the server belongs to.
    ///
    /// getMfaCode is handed to the Cloud login: it returns the two-factor code
    /// when the Cloud account needs one, and is null when there is no way to get one.
    /// </summary>
    public static async Task<SiteSummary> ConfigureSiteAsync(
        AppConfig config, IReadOnlyDictionary<string, bool> settings,
        IServerApi server, Func<string, ICloudApi>? makeCloud, bool allowExisting = false,
        Func<Task<string?>>? getMfaCode = null, CancellationToken cancellationToken = default)
    {
        SiteInfo info = await server.GetSiteInfoAsync(cancellationToken);
        bool isNew = string.IsNullOrEmpty(info.LocalId);
        string? cloudId = string.IsNullOrEmpty(info.CloudId) ? null : info.CloudId;

        // Worked out before anything changes, so a Cloud mismatch stops the run
        // while the server is still untouched.
        bool connecting = config.ConnectToCloud && cloudId is null;
        string? cloudUrl = null;
        string customization = "";
        if (connecting) (cloudUrl, customization) = CloudTarget(config, info);

        if (!isNew && !allowExisting)
        {
            string name = string.IsNullOrEmpty(info.Name) ? config.SiteName : info.Name;
            string cloudPart = connecting ? " and it is connected to the Cloud" : "";
            throw new ExistingSiteException(
                $"{config.Host} already belongs to the site {Config.JsonText(name)}. Refusing to "
                + $"change it without --yes. With --yes its settings are updated{cloudPart}.");
        }

        // Log in to the Cloud before the server is changed, so a wrong Cloud
        // password (or an account with two-factor authentication) stops the run
        // while the server is still untouched.
        ICloudApi? cloud = null;
        if (connecting)
        {
            cloud = makeCloud!(cloudUrl!);
            await cloud.LoginAsync(config.CloudUser, config.CloudPassword, getMfaCode, cancellationToken);
        }

        string siteName;
        if (isNew)
        {
            siteName = config.SiteName;
            try
            {
                await server.LoginAsync(LocalAdmin, FactoryPassword, cancellationToken);
            }
            catch (AuthException)
            {
                throw new ApiException(
                    "The server has not been set up, but its factory login (admin/admin) was "
                    + "rejected, so the sample cannot set it up.");
            }
            // A new site gets every setting this sample handles: the file's values,
            // and the defaults for what it leaves out.
            Dictionary<string, bool> all = SiteSettings.Defaults();
            foreach (var (name, value) in settings) all[name] = value;
            if (cloud is not null)
            {
                // One site/setup that also binds the site to the Cloud: nothing is
                // left half done if the bind fails, and no local admin password is
                // set (the server disables the local admin of a Cloud site).
                RegisteredSite registered = await cloud.RegisterSiteAsync(
                    siteName, customization, config.OrganizationId, cancellationToken);
                await server.SetupAsync(
                    siteName, null, all, CloudAuthFor(registered, config), cancellationToken);
                await server.LogoutAsync(cancellationToken);
                return new SiteSummary(
                    siteName, true, CloudState.Connected, cloudId, cloudUrl, new Dictionary<string, bool>());
            }
            await server.SetupAsync(siteName, config.Password, all, cancellationToken: cancellationToken);
            // The password just changed, so start a new session with the new one.
            await server.LogoutAsync(cancellationToken);
        }
        else
        {
            siteName = string.IsNullOrEmpty(info.Name) ? config.SiteName : info.Name;
        }

        await server.LoginAsync(LocalAdmin, config.Password, cancellationToken);

        CloudState cloudState;
        if (cloud is not null)
        {
            RegisteredSite registered = await cloud.RegisterSiteAsync(
                siteName, customization, config.OrganizationId, cancellationToken);
            await server.CloudBindAsync(
                registered.AuthKey, config.CloudUser, registered.SiteId, config.OrganizationId,
                cancellationToken);
            cloudState = CloudState.Connected;
        }
        else
        {
            cloudState = cloudId is null ? CloudState.NotConnected : CloudState.Already;
        }

        // Only the settings the file names. On an existing site the others stay as
        // an administrator left them.
        Dictionary<string, bool> changed = settings.Count > 0
            ? await server.ApplySettingsAsync(settings, cancellationToken)
            : new Dictionary<string, bool>();
        return new SiteSummary(siteName, isNew, cloudState, cloudId, cloudUrl, changed);
    }

    /// <summary>Render the outcome as the text to print.</summary>
    public static string FormatSummary(AppConfig config, SiteSummary summary)
    {
        string setupLine = summary.SetUp ? "yes" : "no, the server already belonged to a site";

        string cloudLine;
        switch (summary.Cloud)
        {
            case CloudState.Connected:
                string owner = string.IsNullOrEmpty(config.OrganizationId)
                    ? config.CloudUser
                    : "organization " + config.OrganizationId;
                cloudLine = $"connected to {summary.CloudUrl}, owned by {owner}";
                break;
            case CloudState.Already:
                cloudLine = $"already connected (Cloud id {summary.CloudId}), left as it was";
                break;
            default:
                cloudLine = "not connected";
                break;
        }

        string changedLine = summary.SettingsChanged.Count > 0
            ? string.Join(", ", summary.SettingsChanged.Select(
                pair => $"{pair.Key}={(pair.Value ? "true" : "false")}"))
            : "none, the site already had them";

        return string.Join("\n",
            $"Site name       : {summary.SiteName}",
            $"Set up          : {setupLine}",
            $"Cloud           : {cloudLine}",
            $"Settings changed: {changedLine}");
    }
}
