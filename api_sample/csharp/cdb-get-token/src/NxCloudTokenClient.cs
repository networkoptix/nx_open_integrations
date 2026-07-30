// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Nx Cloud CDB API sample: get an OAuth2 bearer token (and nothing else).
//
// C# port of ../../python/cdb-get-token and ../../node/cdb-get-token. Uses the
// built-in HttpClient and System.Text.Json — no third-party packages (xUnit is
// the only dependency, and only for the test project).
//
// This is the smallest possible "how do I authenticate?" example. It performs
// the single login call and returns the token. Once you have the token, you put
// it in an `Authorization: Bearer <token>` header on any other CDB / site call.
//
// The one call:
//
//     POST {cloud}/cdb/oauth2/token
//     Content-Type: application/json
//     {
//       "grant_type":    "password",
//       "response_type": "token",
//       "client_id":     "3rdParty",
//       "username":      "<your cloud email>",
//       "password":      "<your cloud password>"
//     }
//
// Optional body fields:
//   - "mfaCode": "123456"             -> if your account has 2FA enabled
//   - "scope":   "cloudSystemId=<id>" -> scope the token to ONE site (omit for
//                                        a cloud-wide token)
//
// The response contains "access_token" (it begins with "nxcdb-").
//
// Reference: https://nxvms.com/cdb/docs/api/v1/swagger/index.html

using System.Net;
using System.Text;
using System.Text.Json;

namespace NxGetToken;

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

/// <summary>The useful parts of a successful token response.</summary>
public sealed record TokenResult(string AccessToken, long? ExpiresInSeconds)
{
    /// <summary>Parse the JSON body of POST /cdb/oauth2/token.</summary>
    public static TokenResult Parse(string json)
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

            long? expires = null;
            if (root.TryGetProperty("expires_in", out JsonElement expEl)
                && expEl.ValueKind == JsonValueKind.Number
                && expEl.TryGetInt64(out long v))
            {
                expires = v;
            }

            return new TokenResult(tokenEl.GetString()!, expires);
        }
    }
}

/// <summary>The single login call, wrapped in a small client.</summary>
public sealed class NxCloudTokenClient
{
    // A fixed client id Nx uses for third-party integrations in their examples.
    public const string ClientId = "3rdParty";

    private readonly HttpClient _http;

    /// <param name="http">
    /// The HttpClient to use. The CLI builds one (with optional TLS bypass); the
    /// tests inject one backed by a fake handler so they run fully offline.
    /// </param>
    public NxCloudTokenClient(HttpClient http) => _http = http;

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
        if (!string.IsNullOrEmpty(mfaCode))
        {
            body["mfaCode"] = mfaCode; // only when the account uses 2FA
        }
        if (!string.IsNullOrEmpty(cloudSiteId))
        {
            // Scope the token to one site. Omit for a cloud-wide token.
            body["scope"] = $"cloudSystemId={cloudSiteId}";
        }
        return body;
    }

    /// <summary>Perform the login and return the token (plus expiry, if given).</summary>
    public async Task<TokenResult> GetTokenAsync(
        string host, string user, string password,
        string? mfaCode = null, string? cloudSiteId = null,
        CancellationToken cancellationToken = default)
    {
        string url = $"{host.TrimEnd('/')}/cdb/oauth2/token";
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
            return TokenResult.Parse(responseBody);
        }
    }

    private static async Task<string> SafeReadAsync(HttpResponseMessage response)
    {
        try { return await response.Content.ReadAsStringAsync(); }
        catch { return string.Empty; }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
