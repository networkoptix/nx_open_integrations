// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Nx Cloud CDB API sample (OAuth2 bearer-token flow): log in and list your Sites.
//
// C# port of ../../python/cdb-oauth2-list-systems and
// ../../node/cdb-oauth2-list-systems. Uses the built-in HttpClient and
// System.Text.Json — no third-party packages (xUnit is the only dependency, and
// only for the test project).
//
// This project uses bearer-token authentication only (no HTTP Basic). The flow:
//
//   1. Log in once: POST /cdb/oauth2/token  ->  receive a short-lived bearer token.
//   2. Use that token (Authorization: Bearer ...) for the actual work.
//   3. List your Sites:  GET /cdb/systems.
//
// Notes:
//   - Works with accounts that have 2FA enabled (pass --mfa-code).
//   - The password is sent once (to get the token), not on every request.
//   - This is the natural second step after ../cdb-get-token (which only gets
//     the token).
//
// The token body fields (grant_type / response_type / client_id) come straight
// from Network Optix's official cloud authentication example. The response's
// access_token begins with "nxcdb-".
//
// Reference: https://nxvms.com/cdb/docs/api/v1/swagger/index.html
//            https://support.networkoptix.com/hc/en-us/articles/32895719318935

using System.Net;
using System.Text;
using System.Text.Json;

namespace NxOauth2ListSystems;

/// <summary>Raised when the cloud rejects the login (bad credentials / 2FA).</summary>
public sealed class AuthException : Exception
{
    public AuthException(string message) : base(message) { }
}

/// <summary>Raised for any other unexpected API / network failure.</summary>
public sealed class ApiException : Exception
{
    public ApiException(string message) : base(message) { }
}

/// <summary>
/// Pulls the list of Sites out of a /cdb/systems response, whatever its shape.
/// The CDB may return a bare JSON array OR wrap it in an object (e.g.
/// {"sites": [...]}), so we don't silently report zero Sites because of an
/// envelope.
/// </summary>
public static class SystemList
{
    // Keys the CDB might use if it wraps the Sites array inside an object.
    private static readonly string[] WrapperKeys = { "sites", "reply", "results", "items", "data" };

    /// <summary>
    /// Accepts a bare array, or an object that wraps the array under a known key
    /// (including one level of nesting). Falls back to the first list-of-objects
    /// value found in the object. Returns an empty list only when there is
    /// genuinely no list. Returned elements are cloned so they outlive the
    /// source JsonDocument.
    /// </summary>
    public static List<JsonElement> Extract(JsonElement data)
    {
        if (data.ValueKind == JsonValueKind.Array)
        {
            return CloneArray(data);
        }
        if (data.ValueKind == JsonValueKind.Object)
        {
            // Try the known wrapper keys first (including a nested object).
            foreach (string key in WrapperKeys)
            {
                if (!data.TryGetProperty(key, out JsonElement value))
                {
                    continue;
                }
                if (value.ValueKind == JsonValueKind.Array)
                {
                    return CloneArray(value);
                }
                if (value.ValueKind == JsonValueKind.Object)
                {
                    List<JsonElement> nested = Extract(value);
                    if (nested.Count > 0)
                    {
                        return nested;
                    }
                }
            }
            // Last resort: any value that looks like a list of Site objects
            // (an empty array also qualifies, matching the Python fallback).
            foreach (JsonProperty prop in data.EnumerateObject())
            {
                if (prop.Value.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }
                JsonElement.ArrayEnumerator items = prop.Value.EnumerateArray();
                if (!items.MoveNext() || items.Current.ValueKind == JsonValueKind.Object)
                {
                    return CloneArray(prop.Value);
                }
            }
        }
        return new List<JsonElement>();
    }

    /// <summary>Convenience overload: parse JSON text and extract the Sites.</summary>
    public static List<JsonElement> Extract(string json)
    {
        using JsonDocument doc = JsonDocument.Parse(json);
        return Extract(doc.RootElement);
    }

    private static List<JsonElement> CloneArray(JsonElement array)
    {
        var list = new List<JsonElement>();
        foreach (JsonElement item in array.EnumerateArray())
        {
            list.Add(item.Clone());
        }
        return list;
    }
}

/// <summary>Cloud CDB client that authenticates with an OAuth2 bearer token.</summary>
public sealed class NxCloudOAuthClient
{
    // A fixed client id Nx uses for third-party integrations in their examples.
    public const string ClientId = "3rdParty";

    private readonly HttpClient _http;
    private readonly string _host;

    /// <summary>The bearer token, filled in by <see cref="LoginAsync"/>.</summary>
    public string? Token { get; private set; }

    /// <summary>Raw JSON text of the last /cdb/systems response (for --debug).</summary>
    public string? LastRaw { get; private set; }

    /// <param name="http">
    /// The HttpClient to use. The CLI builds one (with optional TLS bypass); the
    /// tests inject one backed by a fake handler so they run fully offline.
    /// </param>
    /// <param name="host">Cloud host, e.g. https://nxvms.com (trailing slash trimmed).</param>
    public NxCloudOAuthClient(HttpClient http, string host)
    {
        _http = http;
        _host = (host ?? "").TrimEnd('/');
    }

    /// <summary>
    /// Build the exact JSON body sent to POST /cdb/oauth2/token. Pure and easy
    /// to test. Returns an ordered dictionary so serialization is deterministic.
    /// </summary>
    public static Dictionary<string, string> BuildTokenBody(
        string user, string password, string? mfaCode = null, string? cloudSiteId = null)
    {
        var body = new Dictionary<string, string>
        {
            ["grant_type"] = "password",
            ["response_type"] = "token",
            ["client_id"] = ClientId,
            ["username"] = user,
            ["password"] = password,
        };
        // If the account uses 2FA, the one-time code goes in the body too.
        if (!string.IsNullOrEmpty(mfaCode))
        {
            body["mfaCode"] = mfaCode;
        }
        // Adding a scope ties the token to ONE site. Omit it for a cloud-wide
        // (cdb) token — which is what listing Sites needs.
        if (!string.IsNullOrEmpty(cloudSiteId))
        {
            body["scope"] = $"cloudSystemId={cloudSiteId}";
        }
        return body;
    }

    /// <summary>
    /// Exchange email + password (+ optional 2FA code) for a bearer token. Also
    /// stores it on <see cref="Token"/> so <see cref="ListSystemsAsync"/> can
    /// send it automatically. Returns the access token string.
    /// </summary>
    public async Task<string> LoginAsync(
        string user, string password,
        string? mfaCode = null, string? cloudSiteId = null,
        CancellationToken cancellationToken = default)
    {
        string url = $"{_host}/cdb/oauth2/token";
        Dictionary<string, string> body = BuildTokenBody(user, password, mfaCode, cloudSiteId);
        string json = JsonSerializer.Serialize(body);

        using var content = new StringContent(json, Encoding.UTF8, "application/json");

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
                    $"Login rejected (HTTP {(int)response.StatusCode}). Check your credentials; "
                    + "if 2FA is enabled, pass --mfa-code.");
            }
            if (!response.IsSuccessStatusCode)
            {
                string text = await SafeReadAsync(response);
                throw new ApiException(
                    $"Token request failed: HTTP {(int)response.StatusCode} {Truncate(text, 200)}");
            }

            string responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
            Token = ParseAccessToken(responseBody);
            return Token;
        }
    }

    /// <summary>Return the account's Sites using the bearer token.</summary>
    public async Task<List<JsonElement>> ListSystemsAsync(CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(Token))
        {
            throw new ApiException("Not logged in. Call LoginAsync() first.");
        }

        // NOTE: "systems" is the wire endpoint name; the data it returns are Sites.
        string url = $"{_host}/cdb/systems";

        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {Token}");

        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(request, cancellationToken);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            throw new ApiException($"Could not reach {url}: {ex.Message}");
        }

        using (response)
        {
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            {
                throw new AuthException("Token was rejected. It may have expired; log in again.");
            }
            if (!response.IsSuccessStatusCode)
            {
                string text = await SafeReadAsync(response);
                throw new ApiException(
                    $"Listing Sites failed: HTTP {(int)response.StatusCode} {Truncate(text, 200)}");
            }

            string responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
            // Keep the raw payload around so --debug can print it.
            LastRaw = responseBody;

            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(responseBody);
            }
            catch (JsonException)
            {
                throw new ApiException("Sites response was not valid JSON.");
            }
            using (doc)
            {
                // The CDB may return a bare array OR wrap it in an object (e.g.
                // {"sites": [...]}). SystemList.Extract handles either shape.
                return SystemList.Extract(doc.RootElement);
            }
        }
    }

    private static string ParseAccessToken(string json)
    {
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(json);
        }
        catch (JsonException)
        {
            throw new ApiException("Token response was not valid JSON.");
        }
        using (doc)
        {
            JsonElement root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("access_token", out JsonElement tokenEl)
                || tokenEl.ValueKind != JsonValueKind.String)
            {
                throw new ApiException("Token response did not contain an access_token.");
            }
            return tokenEl.GetString()!;
        }
    }

    private static async Task<string> SafeReadAsync(HttpResponseMessage response)
    {
        try { return await response.Content.ReadAsStringAsync(); }
        catch { return string.Empty; }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}

/// <summary>Renders the Sites as a fixed-width text table for the CLI.</summary>
public static class SystemsTable
{
    /// <summary>
    /// Format the Sites with NAME / STATUS / VERSION / ID columns, mirroring the
    /// Python sample. Returns a friendly message when the list is empty.
    /// </summary>
    public static string Format(IReadOnlyList<JsonElement> sites)
    {
        if (sites.Count == 0)
        {
            return "No Sites found on this account.";
        }

        var rows = new List<string[]> { new[] { "NAME", "STATUS", "VERSION", "ID" } };
        foreach (JsonElement site in sites)
        {
            rows.Add(new[]
            {
                Field(site, "name"),
                Field(site, "status"),
                Field(site, "version"),
                Field(site, "id"),
            });
        }

        int columns = rows[0].Length;
        var widths = new int[columns];
        foreach (string[] row in rows)
        {
            for (int col = 0; col < columns; col++)
            {
                widths[col] = Math.Max(widths[col], row[col].Length);
            }
        }

        return string.Join("\n", rows.Select(row =>
            string.Join("  ", row.Select((cell, col) => cell.PadRight(widths[col])))));
    }

    private static string Field(JsonElement site, string name)
    {
        if (site.ValueKind != JsonValueKind.Object || !site.TryGetProperty(name, out JsonElement v))
        {
            return "";
        }
        return v.ValueKind switch
        {
            JsonValueKind.String => v.GetString() ?? "",
            JsonValueKind.Null => "",
            JsonValueKind.Undefined => "",
            _ => v.GetRawText(),
        };
    }
}
