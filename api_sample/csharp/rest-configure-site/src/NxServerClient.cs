// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Nx VMS REST Server API sample: set up a new site and optionally connect it to the Cloud (C#).
//
// Uses the latest /rest/v4 API and the built-in HttpClient, no third-party packages.
//
// This is the very first thing done to a factory-default server. It names the site,
// sets the password of the local "admin" account, applies three site settings, and,
// if you ask, connects the site to the Nx Cloud. The Cloud account you connect with
// becomes the site owner, or the organization does if you name one.
//
//   1. Check:     GET /rest/v4/site/info  (no login) -> localId, cloudId, name
//                 A server whose reply has a localId already belongs to a site, and
//                 the run stops there unless --yes is given.
//   2. Set up (new server only):
//        POST /rest/v4/login/sessions  {admin, admin}  (the factory account)
//        POST /rest/v4/site/setup      {name, local.password, settings}
//        With the Cloud, setup is a single call instead, after the Cloud
//        registration in step 4: {name, settings, cloud: {authKey, owner, siteId
//        [, organizationId]}}. The server binds the site as part of the setup and
//        disables the local admin, so steps 3 to 5 are skipped.
//   3. Log in:    POST /rest/v4/login/sessions  {username: admin, password}  -> {"token": ...}
//   4. Cloud (only if NX_CONNECT_TO_CLOUD is true and the site is not bound yet):
//        POST {cloud}/cdb/oauth2/token   -> Cloud bearer token
//        POST {cloud}/cdb/systems/bind   -> site id and auth key (Cloud account)
//        POST {cloud}/partners/api/v3/cloud_systems/
//                                        -> site id and auth key (organization)
//        POST /rest/v4/cloud/bind        {authKey, owner, siteId[, organizationId]}
//   5. Settings:  PATCH /rest/v4/site/settings  (only what differs from now)
//   6. Log out:   DELETE /rest/v4/login/sessions/<token>
//                 DELETE {cloud}/cdb/oauth2/token/<token>  (when the Cloud was used)
//
// This file holds the server client. The Cloud client is in NxCloudClient.cs, the
// flow in SiteFlow.cs and the command line in Program.cs.

using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace NxConfigureSite;

/// <summary>Login was rejected: wrong credentials, or an account that may not do this.</summary>
public sealed class AuthException : Exception
{
    public AuthException(string message) : base(message) { }
}

/// <summary>The server answered, but not with what the API contract promises.</summary>
public sealed class ApiException : Exception
{
    public ApiException(string message) : base(message) { }
}

/// <summary>
/// What site/info says about the server's site. LocalId is null while the server
/// is factory-default and set once it belongs to a site. CloudId is set once the
/// site is bound to the Cloud. Name is the site's real name.
/// </summary>
public sealed record SiteInfo(
    string? LocalId, string? CloudId, string? Name,
    string? CloudHost, string? Customization);

/// <summary>The "cloud" object of site/setup, built by SiteFlow.CloudAuthFor.</summary>
public sealed record CloudAuth(string AuthKey, string Owner, string SiteId, string? OrganizationId = null);

/// <summary>What the server calls for the flow, so the tests can stand in for it.</summary>
public interface IServerApi
{
    Task<SiteInfo> GetSiteInfoAsync(CancellationToken cancellationToken = default);
    Task SetupAsync(
        string siteName, string? adminPassword, IReadOnlyDictionary<string, bool> settings,
        CloudAuth? cloud = null, CancellationToken cancellationToken = default);
    Task<string> LoginAsync(string username, string password, CancellationToken cancellationToken = default);
    Task CloudBindAsync(
        string authKey, string owner, string siteId, string? organizationId = null,
        CancellationToken cancellationToken = default);
    Task<Dictionary<string, bool>> ApplySettingsAsync(
        IReadOnlyDictionary<string, bool> wanted, CancellationToken cancellationToken = default);
    Task LogoutAsync(CancellationToken cancellationToken = default);
}

/// <summary>
/// What the server and the Cloud client share: one HttpClient and one token.
/// Deliberately small, with no retry logic. The point is to show the calls, not
/// to be a library.
/// </summary>
public abstract class BearerClient
{
    protected readonly HttpClient Http;
    protected readonly string Host;

    public string? Token { get; protected set; }

    protected BearerClient(HttpClient http, string host)
    {
        Http = http;
        Host = host.TrimEnd('/');
    }

    /// <summary>Keep the token and send it as a bearer header from now on.</summary>
    protected void StoreToken(string token)
    {
        Token = token;
        Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
    }

    protected void RequireLogin()
    {
        if (string.IsNullOrEmpty(Token)) throw new ApiException("Not logged in. Call LoginAsync() first.");
    }

    protected static StringContent JsonBody(object body)
        => new(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

    /// <summary>
    /// Send one request and return the reply.
    /// </summary>
    protected async Task<HttpResponseMessage> SendAsync(
        HttpMethod method, string url, HttpContent? content, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, url) { Content = content };
        HttpResponseMessage response;
        try
        {
            response = await Http.SendAsync(request, cancellationToken);
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
            error.Data[OriginKey] = Origin;
            throw;
        }
        int status = (int)response.StatusCode;
        if (status is >= 300 and < 400)
        {
            // Only origins are named: the path and query can hold a session
            // token, the Cloud token or a two-factor code.
            var requestUri = new Uri(url);
            string location = response.Headers.Location?.OriginalString ?? "";
            string target = "";
            if (location.Length > 0 && Uri.TryCreate(requestUri, location, out Uri? locationUri)
                && locationUri.Host.Length > 0)
            {
                target = UrlOrigin(locationUri);
            }
            response.Dispose();
            throw new ApiException(
                $"{UrlOrigin(requestUri)} answered with a redirect (HTTP {status}{(target.Length > 0 ? " to " + target : "")}). "
                + "Check the address: it must be the server or the Cloud itself, with the right "
                + "scheme and port.");
        }
        return response;
    }

    /// <summary>
    /// Like EnsureSuccessStatusCode, but the message is "HTTP &lt;status&gt; &lt;reason
    /// phrase&gt;" plus the reason the server or the Cloud gives in its JSON error
    /// body, for example "HTTP 422 Unprocessable Entity: Site is already bound.".
    /// It never includes the URL. The exception also says which host answered, so
    /// the CLI can name the server or the Cloud (see RequestOrigin).
    /// </summary>
    protected async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode) return;
        string text = $"HTTP {(int)response.StatusCode}";
        string reason = await ErrorTextAsync(response, cancellationToken);
        var error = new HttpRequestException(
            reason.Length > 0 ? $"{text}: {reason}" : text, null, response.StatusCode);
        error.Data[OriginKey] = Origin;
        throw error;
    }

    /// <summary>
    /// The reason the server or the Cloud gives in its JSON error body
    /// ("errorString" from the server, "errorText" from the Cloud, and "detail" or
    /// {"errors": [{"detail": ...}]} from the Channel Partners API), if any.
    /// </summary>
    private static async Task<string> ErrorTextAsync(
        HttpResponseMessage response, CancellationToken cancellationToken)
    {
        string body = await response.Content.ReadAsStringAsync(cancellationToken);
        try
        {
            using JsonDocument document = JsonDocument.Parse(body);
            if (document.RootElement.ValueKind != JsonValueKind.Object) return "";
            foreach (string key in new[] { "errorString", "errorText", "detail" })
            {
                string? value = StringProperty(document.RootElement, key);
                if (value is not null)
                {
                    return value.Length > NxServerClient.MaxDetailChars
                        ? value[..NxServerClient.MaxDetailChars]
                        : value;
                }
            }
            // The Channel Partners API: {"errors": [{"detail": ...}]}.
            if (document.RootElement.TryGetProperty("errors", out JsonElement errors)
                && errors.ValueKind == JsonValueKind.Array && errors.GetArrayLength() > 0
                && errors[0].ValueKind == JsonValueKind.Object
                && StringProperty(errors[0], "detail") is string detail)
            {
                return detail.Length > NxServerClient.MaxDetailChars
                    ? detail[..NxServerClient.MaxDetailChars]
                    : detail;
            }
            return "";
        }
        catch (JsonException)
        {
            return "";
        }
    }

    /// <summary>
    /// scheme://host:port of the request that failed (the server or the Cloud),
    /// or null when the failure did not come from one of these clients.
    /// </summary>
    public static string? RequestOrigin(Exception error) => error.Data[OriginKey] as string;

    private const string OriginKey = "NxConfigureSite.RequestOrigin";

    // scheme://host[:port] of an absolute URL, without user info, path or query.
    // The port is left out when it is the scheme's default.
    private static string UrlOrigin(Uri uri) => $"{uri.Scheme}://{uri.Authority}";

    // scheme://host[:port] of Host, without the path.
    private string Origin
        => Uri.TryCreate(Host, UriKind.Absolute, out Uri? uri) ? uri.GetLeftPart(UriPartial.Authority) : Host;

    /// <summary>
    /// The reply as a JSON object. A body that is not JSON at all (an HTML error
    /// page from a proxy, say) or is JSON but not an object (null, an array, a
    /// string, a number) is an ApiException that starts with "what", for example
    /// "Login response was not valid JSON." or "Login response was not a JSON object.".
    /// </summary>
    protected static async Task<JsonElement> ReadObjectAsync(
        HttpResponseMessage response, string what, CancellationToken cancellationToken)
    {
        string text = await response.Content.ReadAsStringAsync(cancellationToken);
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(text);
        }
        catch (JsonException)
        {
            throw new ApiException($"{what} was not valid JSON.");
        }
        using (document)
        {
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                throw new ApiException($"{what} was not a JSON object.");
            }
            return document.RootElement.Clone();
        }
    }

    /// <summary>The named property when it is a non-empty JSON string, else null.</summary>
    protected static string? StringProperty(JsonElement reply, string name)
        => reply.TryGetProperty(name, out JsonElement value)
           && value.ValueKind == JsonValueKind.String
           && !string.IsNullOrEmpty(value.GetString())
            ? value.GetString()
            : null;
}

/// <summary>A client for one VMS server.</summary>
public sealed class NxServerClient : BearerClient, IServerApi
{
    // API version path segment. v4 is the latest Nx REST API.
    public const string Api = "/rest/v4";

    // How much of an error response body is kept for a message.
    public const int MaxDetailChars = 300;

    public NxServerClient(HttpClient http, string host) : base(http, host) { }

    /// <summary>
    /// GET site/info -> what the server says about its site. No login needed.
    ///
    /// The fields this sample reads: "localId" is absent while the server is
    /// factory-default and present once it belongs to a site, and "cloudId" is
    /// present once the site is bound to the Cloud. "name" is the site's real name.
    /// "cloudHost" and "customization" say which Cloud the server belongs to and
    /// which brand it is (see SiteFlow.CloudTarget).
    /// </summary>
    public async Task<SiteInfo> GetSiteInfoAsync(CancellationToken cancellationToken = default)
    {
        using HttpResponseMessage response = await SendAsync(
            HttpMethod.Get, $"{Host}{Api}/site/info", null, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        JsonElement info = await ReadObjectAsync(response, "Site info response", cancellationToken);
        return new SiteInfo(
            StringProperty(info, "localId"), StringProperty(info, "cloudId"), StringProperty(info, "name"),
            StringProperty(info, "cloudHost"), StringProperty(info, "customization"));
    }

    /// <summary>
    /// POST site/setup: turn a factory-default server into a new site.
    ///
    /// Needs an administrator on a fresh session, which on a factory-default
    /// server means logging in as admin with the factory password first.
    ///
    /// Local site: the body sets the site name, the new password of the local
    /// "admin" account and the initial settings.
    ///
    /// Cloud site: instead of "local" the body carries "cloud", the auth key,
    /// owner, site id (and organization id) from the Cloud registration. The
    /// server binds the site to the Cloud as part of the setup, rolls the setup
    /// back if the bind fails, and disables the local "admin" account, so the
    /// site is used through the Cloud only.
    /// </summary>
    public async Task SetupAsync(
        string siteName, string? adminPassword, IReadOnlyDictionary<string, bool> settings,
        CloudAuth? cloud = null, CancellationToken cancellationToken = default)
    {
        RequireLogin();
        var body = new Dictionary<string, object>
        {
            ["name"] = siteName,
            ["settings"] = settings,
        };
        if (cloud is not null)
        {
            var auth = new Dictionary<string, string>
            {
                ["authKey"] = cloud.AuthKey,
                ["owner"] = cloud.Owner,
                ["siteId"] = cloud.SiteId,
            };
            if (!string.IsNullOrEmpty(cloud.OrganizationId)) auth["organizationId"] = cloud.OrganizationId;
            body["cloud"] = auth;
        }
        else
        {
            body["local"] = new Dictionary<string, string?> { ["password"] = adminPassword };
        }
        using StringContent content = JsonBody(body);
        using HttpResponseMessage response = await SendAsync(
            HttpMethod.Post, $"{Host}{Api}/site/setup", content, cancellationToken);

        // Only a 2xx means the site was set up.
        int status = (int)response.StatusCode;
        if (status is < 200 or >= 300)
        {
            string text = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new ApiException(
                $"Site setup was refused (HTTP {status}: {(text.Length > MaxDetailChars ? text[..MaxDetailChars] : text)}).");
        }
    }

    /// <summary>POST login/sessions -> bearer token, stored on this client.</summary>
    public async Task<string> LoginAsync(
        string username, string password, CancellationToken cancellationToken = default)
    {
        using StringContent content = JsonBody(new Dictionary<string, string>
        {
            ["username"] = username,
            ["password"] = password,
        });
        using HttpResponseMessage response = await SendAsync(
            HttpMethod.Post, $"{Host}{Api}/login/sessions", content, cancellationToken);

        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            throw new AuthException(
                "Login rejected (HTTP 401). Check the user name and password. "
                + "A Cloud account cannot log in to a server here.");
        }
        if (response.StatusCode == HttpStatusCode.Forbidden)
        {
            throw new AuthException(
                "Login forbidden (HTTP 403). This account may not do this. "
                + "Changing site settings needs an administrator.");
        }
        await EnsureSuccessAsync(response, cancellationToken);

        string? token = StringProperty(
            await ReadObjectAsync(response, "Login response", cancellationToken), "token");
        if (token is null) throw new ApiException("Login response did not contain a token.");

        StoreToken(token);
        return token;
    }

    /// <summary>GET site/settings -> every site setting and its current value.</summary>
    public async Task<JsonElement> GetSettingsAsync(CancellationToken cancellationToken = default)
    {
        RequireLogin();
        using HttpResponseMessage response = await SendAsync(
            HttpMethod.Get, $"{Host}{Api}/site/settings", null, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return await ReadObjectAsync(response, "Settings response", cancellationToken);
    }

    /// <summary>
    /// PATCH site/settings with the settings that differ from the current ones.
    ///
    /// Setup already sent these on a new site, so this is what makes a re-run on an
    /// existing site converge. Returns what was sent, which is empty when nothing
    /// needed to change (no PATCH is made then).
    /// </summary>
    public async Task<Dictionary<string, bool>> ApplySettingsAsync(
        IReadOnlyDictionary<string, bool> wanted, CancellationToken cancellationToken = default)
    {
        JsonElement current = await GetSettingsAsync(cancellationToken);
        var changes = new Dictionary<string, bool>();
        foreach (var (name, value) in wanted)
        {
            bool same = current.TryGetProperty(name, out JsonElement now)
                        && now.ValueKind is JsonValueKind.True or JsonValueKind.False
                        && now.GetBoolean() == value;
            if (!same) changes[name] = value;
        }
        if (changes.Count > 0)
        {
            using StringContent content = JsonBody(changes);
            using HttpResponseMessage response = await SendAsync(
                HttpMethod.Patch, $"{Host}{Api}/site/settings", content, cancellationToken);
            await EnsureSuccessAsync(response, cancellationToken);
        }
        return changes;
    }

    /// <summary>
    /// POST cloud/bind: tell the server it now belongs to a Cloud site record.
    ///
    /// authKey and siteId come from the Cloud's own bind call (see
    /// NxCloudClient.RegisterSiteAsync). owner is the e-mail of the Cloud account
    /// that registered the site; the server requires it, also for a site bound
    /// to an organization, and adds that account as a local administrator.
    /// organizationId is sent for a site bound to an organization.
    /// </summary>
    public async Task CloudBindAsync(
        string authKey, string owner, string siteId, string? organizationId = null,
        CancellationToken cancellationToken = default)
    {
        RequireLogin();
        var body = new Dictionary<string, string>
        {
            ["authKey"] = authKey,
            ["owner"] = owner,
            ["siteId"] = siteId,
        };
        if (!string.IsNullOrEmpty(organizationId)) body["organizationId"] = organizationId;
        using StringContent content = JsonBody(body);
        using HttpResponseMessage response = await SendAsync(
            HttpMethod.Post, $"{Host}{Api}/cloud/bind", content, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    /// <summary>DELETE the session so the token is not left valid. Safe to call twice.</summary>
    public async Task LogoutAsync(CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(Token)) return;
        using HttpResponseMessage _ = await SendAsync(
            HttpMethod.Delete, $"{Host}{Api}/login/sessions/{Token}", null, cancellationToken);
        Token = null;
        Http.DefaultRequestHeaders.Authorization = null;
    }
}
