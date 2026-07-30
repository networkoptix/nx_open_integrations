// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// List cameras on a SPECIFIC site using a CLOUD account (C#).
//
// C# port of ../../python/rest-list-cameras-cloud-user and
// ../../node/rest-list-cameras-cloud-user, on the latest /rest/v4 API. Uses the
// built-in HttpClient + System.Text.Json — no third-party packages.
//
// The key idea is the token scope:
//   - A cloud-wide token (no scope) is NOT accepted by an individual site.
//   - To call a site's API you need a token SCOPED to that site, obtained from
//     the cloud with  scope = "cloudSystemId=<your-site-id>".
//
// Flow:
//   1. Get a site-scoped token:
//        POST {cloud}/cdb/oauth2/token
//        { grant_type:"password", response_type:"token", client_id:"3rdParty",
//          username, password, scope:"cloudSystemId=<id>" }
//   2. Reach the site through the Cloud relay:
//        https://<site-id>.relay.vmsproxy.com
//   3. List cameras:
//        GET /rest/v4/devices   (Authorization: Bearer <site-token>)
//   4. Delete the token on the cloud when done:
//        DELETE {cloud}/cdb/oauth2/token/<site-token>
//
// Relay 307: the relay answers with a 307 redirect to the node that serves the
// request. .NET's HttpClient (like browsers) drops the Authorization header on a
// cross-host redirect, so we disable auto-redirect and follow it ourselves,
// re-attaching the bearer on each hop. See GetFollowingRedirectsAsync.

using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace NxListCamerasCloud;

public sealed class AuthException : Exception
{
    public AuthException(string message) : base(message) { }
}

public sealed class ApiException : Exception
{
    public ApiException(string message) : base(message) { }
}

/// <summary>One camera, trimmed to the fields the table shows.</summary>
public sealed record Camera(string Name, string Status, string Model, string Id);

public sealed class NxCloudSiteClient
{
    public const string ClientId = "3rdParty";
    public const string RelaySuffix = ".relay.vmsproxy.com";
    public const string Api = "/rest/v4";
    private const int MaxRedirects = 5;

    private readonly HttpClient _http;
    private readonly string _cloudHost;
    private readonly string _siteId;

    public string? Token { get; private set; }

    public NxCloudSiteClient(HttpClient http, string cloudHost, string siteId)
    {
        _http = http;
        _cloudHost = cloudHost.TrimEnd('/');
        _siteId = siteId;
    }

    /// <summary>The Cloud relay address for this specific site.</summary>
    public string RelayUrl => $"https://{_siteId}{RelaySuffix}";

    public async Task<string> LoginAsync(
        string user, string password, string? mfaCode = null, CancellationToken cancellationToken = default)
    {
        string url = $"{_cloudHost}/cdb/oauth2/token";
        var body = new Dictionary<string, string>
        {
            ["grant_type"] = "password",
            ["response_type"] = "token",
            ["client_id"] = ClientId,
            ["username"] = user,
            ["password"] = password,
            // THIS scope is what makes the token usable against the site.
            ["scope"] = $"cloudSystemId={_siteId}",
        };
        if (!string.IsNullOrEmpty(mfaCode)) body["mfaCode"] = mfaCode;

        using var content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

        HttpResponseMessage response;
        try
        {
            response = await _http.PostAsync(url, content, cancellationToken);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            throw new ApiException($"Could not reach {url}: {ex.Message}");
        }

        using (response)
        {
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            {
                throw new AuthException(
                    $"Login rejected (HTTP {(int)response.StatusCode}). Check credentials, the "
                    + "site id, and access; add --mfa-code for a 2FA account.");
            }
            if (!response.IsSuccessStatusCode)
            {
                string text = await SafeReadAsync(response);
                throw new ApiException(
                    $"Token request failed: HTTP {(int)response.StatusCode} {Truncate(text, 200)}");
            }
            string json = await response.Content.ReadAsStringAsync(cancellationToken);
            Token = ExtractAccessToken(json);
            return Token;
        }
    }

    /// <summary>Use a scoped bearer token obtained elsewhere (skip login).</summary>
    public void UseToken(string token) => Token = token;

    public async Task<IReadOnlyList<Camera>> ListCamerasAsync(CancellationToken cancellationToken = default)
    {
        string url = $"{RelayUrl}{Api}/devices";
        using HttpResponseMessage response = await GetFollowingRedirectsAsync(url, cancellationToken);

        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new AuthException(
                "The site rejected the token. Make sure it was scoped with cloudSystemId for THIS site.");
        }
        if (!response.IsSuccessStatusCode)
        {
            string text = await SafeReadAsync(response);
            throw new ApiException(
                $"Listing devices failed: HTTP {(int)response.StatusCode} {Truncate(text, 200)}");
        }

        string json = await response.Content.ReadAsStringAsync(cancellationToken);
        return NormalizeCameras(json);
    }

    /// <summary>Delete the scoped token on the cloud. Best-effort cleanup.</summary>
    public async Task LogoutAsync(CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(Token)) return;
        string url = $"{_cloudHost}/cdb/oauth2/token/{Token}";
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Delete, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
            using HttpResponseMessage _ = await _http.SendAsync(request, cancellationToken);
        }
        catch
        {
            // best effort
        }
        finally
        {
            Token = null;
        }
    }

    /// <summary>
    /// GET that follows 307 redirects MANUALLY, re-attaching the bearer on each
    /// hop so it survives the relay's cross-host redirect. (Requires the
    /// HttpClient's handler to have AllowAutoRedirect = false.)
    /// </summary>
    private async Task<HttpResponseMessage> GetFollowingRedirectsAsync(
        string url, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(Token))
        {
            throw new ApiException("Not logged in. Call LoginAsync() or UseToken() first.");
        }

        string current = url;
        for (int hop = 0; hop <= MaxRedirects; hop++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, current);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);

            HttpResponseMessage response;
            try
            {
                response = await _http.SendAsync(request, cancellationToken);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
            {
                throw new ApiException($"Could not reach {current}: {ex.Message}");
            }

            int code = (int)response.StatusCode;
            if (code is 301 or 302 or 303 or 307 or 308)
            {
                Uri? location = response.Headers.Location;
                response.Dispose();
                if (location is null)
                {
                    throw new ApiException($"Redirect {code} without a Location header.");
                }
                current = location.IsAbsoluteUri ? location.ToString() : new Uri(new Uri(current), location).ToString();
                continue; // re-send WITH the bearer header
            }
            return response;
        }
        throw new ApiException("Too many redirects from the relay.");
    }

    // -----------------------------------------------------------------------
    // Parsing helpers (pure = easy to test)
    // -----------------------------------------------------------------------

    public static string ExtractAccessToken(string json)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException) { throw new ApiException("Token response was not valid JSON."); }
        using (doc)
        {
            if (doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("access_token", out JsonElement el)
                && el.ValueKind == JsonValueKind.String)
            {
                return el.GetString()!;
            }
            throw new ApiException("Token response did not contain an access_token.");
        }
    }

    /// <summary>
    /// The /rest/v4/devices body is sometimes a bare array and sometimes an
    /// envelope { "reply": [...] }. Unwrap to a list of Camera records.
    /// </summary>
    public static IReadOnlyList<Camera> NormalizeCameras(string json)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException) { throw new ApiException("Devices response was not valid JSON."); }

        using (doc)
        {
            JsonElement root = doc.RootElement;
            JsonElement array;
            if (root.ValueKind == JsonValueKind.Array)
            {
                array = root;
            }
            else if (root.ValueKind == JsonValueKind.Object
                     && root.TryGetProperty("reply", out JsonElement reply)
                     && reply.ValueKind == JsonValueKind.Array)
            {
                array = reply;
            }
            else
            {
                return Array.Empty<Camera>();
            }

            var cameras = new List<Camera>();
            foreach (JsonElement cam in array.EnumerateArray())
            {
                cameras.Add(new Camera(
                    Str(cam, "name"), Str(cam, "status"), Str(cam, "model"), Str(cam, "id")));
            }
            return cameras;
        }
    }

    private static string Str(JsonElement obj, string prop)
    {
        if (obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(prop, out JsonElement el))
        {
            return el.ValueKind == JsonValueKind.String ? el.GetString() ?? "" : el.ToString();
        }
        return "";
    }

    /// <summary>Render the cameras as a simple aligned text table.</summary>
    public static string FormatCamerasTable(IReadOnlyList<Camera> cameras)
    {
        if (cameras.Count == 0) return "No cameras found on this site.";

        var rows = new List<string[]> { new[] { "NAME", "STATUS", "MODEL", "ID" } };
        foreach (Camera c in cameras)
        {
            rows.Add(new[] { c.Name, c.Status, c.Model, c.Id });
        }
        int[] widths = new int[4];
        foreach (string[] row in rows)
        {
            for (int i = 0; i < 4; i++) widths[i] = Math.Max(widths[i], row[i].Length);
        }
        var sb = new StringBuilder();
        foreach (string[] row in rows)
        {
            var cells = new string[4];
            for (int i = 0; i < 4; i++) cells[i] = row[i].PadRight(widths[i]);
            sb.AppendLine(string.Join("  ", cells).TrimEnd());
        }
        return sb.ToString().TrimEnd('\n', '\r');
    }

    private static async Task<string> SafeReadAsync(HttpResponseMessage response)
    {
        try { return await response.Content.ReadAsStringAsync(); }
        catch { return string.Empty; }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
