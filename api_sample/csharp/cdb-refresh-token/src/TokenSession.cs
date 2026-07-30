// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Nx Cloud CDB API sample: keep a token-based session alive with refresh tokens.
//
// C# port of ../../python/cdb-refresh-token and ../../node/cdb-refresh-token.
// Uses the built-in HttpClient and System.Text.Json — no third-party packages
// (xUnit is the only dependency, and only for the test project).
//
// THE IDEA (read this if you are new to token auth)
// -------------------------------------------------
// With token-based auth you do NOT send your password on every request. Instead:
//
//   * You log in once and receive two things:
//       - an ACCESS token  -> short-lived. Sent on every API call as
//                             "Authorization: Bearer <access token>".
//       - a REFRESH token  -> long-lived. Used ONLY to get new access tokens.
//   * When the access token is about to expire, you call the token endpoint again
//     with grant_type=refresh_token to get a fresh access token -- no password.
//   * Some servers ROTATE the refresh token: the refresh response contains a NEW
//     refresh token, and the old one stops working. You must store the new one.
//
// So "the session" is really {access_token, refresh_token, expiry}. TokenSession
// wraps that state and shows the three things you must do to keep it healthy:
//
//   1. PROACTIVE refresh  - refresh shortly BEFORE the access token expires.
//   2. REACTIVE refresh   - if a call still returns 401, refresh once and retry.
//   3. ROTATION + STORAGE - always keep the latest refresh token (and optionally
//                           persist it to disk so the session survives a restart).
//
// The calls themselves:
//
//   Login:    POST {cloud}/cdb/oauth2/token
//             { grant_type:"password", response_type:"token", client_id:"3rdParty",
//               username, password }
//   Refresh:  POST {cloud}/cdb/oauth2/token
//             { grant_type:"refresh_token", response_type:"token",
//               client_id:"3rdParty", refresh_token:"<latest refresh token>" }
//
// The response contains "access_token" (it begins with "nxcdb-").
//
// Reference: https://nxvms.com/cdb/docs/api/v1/swagger/index.html  (RFC 6749 §6)

using System.Net;
using System.Text;
using System.Text.Json;

namespace NxRefreshToken;

/// <summary>Raised when the cloud rejects the login or the refresh token.</summary>
public sealed class AuthException : Exception
{
    public AuthException(string message) : base(message) { }
}

/// <summary>Raised for any other unexpected API / network failure.</summary>
public sealed class ApiException : Exception
{
    public ApiException(string message) : base(message) { }
}

/// <summary>A parsed token response: access token, optional rotated refresh token, expiry.</summary>
public sealed record TokenResponse(string AccessToken, string? RefreshToken, long? ExpiresInSeconds)
{
    /// <summary>Parse the JSON body of POST /cdb/oauth2/token.</summary>
    public static TokenResponse Parse(string json)
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

            string? refresh = null;
            if (root.TryGetProperty("refresh_token", out JsonElement refEl)
                && refEl.ValueKind == JsonValueKind.String)
            {
                refresh = refEl.GetString();
            }

            long? expires = null;
            if (root.TryGetProperty("expires_in", out JsonElement expEl)
                && expEl.ValueKind == JsonValueKind.Number
                && expEl.TryGetInt64(out long v))
            {
                expires = v;
            }

            return new TokenResponse(tokenEl.GetString()!, refresh, expires);
        }
    }
}

/// <summary>
/// A token-based session: access token + refresh token + expiry. Inject an
/// <see cref="HttpClient"/> (for tests) and a clock (to make expiry testable).
/// Pass a store path to persist the refresh token across program runs.
/// </summary>
public sealed class TokenSession
{
    // A fixed client id Nx uses for third-party integrations in their examples.
    public const string ClientId = "3rdParty";

    // If the server doesn't tell us a lifetime, assume this many seconds.
    public const long DefaultExpiresInSeconds = 3600;

    // Refresh this many seconds BEFORE the access token actually expires, so we
    // never hand a request a token that dies mid-flight.
    public const long RefreshSafetyMarginSeconds = 60;

    private readonly HttpClient _http;
    private readonly string _host;
    private readonly string? _storePath;
    private readonly Func<double> _now; // epoch seconds

    public string? AccessToken { get; set; }
    public string? RefreshToken { get; set; }
    public double ExpiresAt { get; set; }  // epoch seconds when the access token expires
    public string? LastRaw { get; private set; } // raw JSON of the last token response (for --debug)

    /// <param name="http">
    /// The HttpClient to use. The CLI builds one (with optional TLS bypass); the
    /// tests inject one backed by a fake handler so they run fully offline.
    /// </param>
    /// <param name="now">Epoch-seconds clock; injectable so expiry is deterministic in tests.</param>
    public TokenSession(HttpClient http, string host, string? storePath = null, Func<double>? now = null)
    {
        _http = http;
        _host = (host ?? "").TrimEnd('/');
        _storePath = storePath;
        _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0);

        // If we were given a store file, try to load a saved refresh token so we
        // can resume a session without logging in again.
        if (!string.IsNullOrEmpty(_storePath))
        {
            Load();
        }
    }

    // -- request bodies (own methods so the exact payloads are easy to read/test) --

    /// <summary>Body for the initial login that returns access + refresh tokens.</summary>
    public static Dictionary<string, string> BuildPasswordBody(
        string user, string password, string? mfaCode = null)
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
        return body;
    }

    /// <summary>Body for exchanging a refresh token for a fresh access token.</summary>
    public static Dictionary<string, string> BuildRefreshBody(string refreshToken) => new()
    {
        ["grant_type"] = "refresh_token",
        ["response_type"] = "token",
        ["client_id"] = ClientId,
        ["refresh_token"] = refreshToken,
    };

    // -- persistence -------------------------------------------------------

    /// <summary>Load a previously saved session from disk (best-effort).</summary>
    private void Load()
    {
        try
        {
            if (!File.Exists(_storePath))
            {
                return; // no store yet -> start fresh
            }
            using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(_storePath!));
            JsonElement root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return;
            }
            if (root.TryGetProperty("access_token", out JsonElement a) && a.ValueKind == JsonValueKind.String)
            {
                AccessToken = a.GetString();
            }
            if (root.TryGetProperty("refresh_token", out JsonElement r) && r.ValueKind == JsonValueKind.String)
            {
                RefreshToken = r.GetString();
            }
            if (root.TryGetProperty("expires_at", out JsonElement e) && e.ValueKind == JsonValueKind.Number
                && e.TryGetDouble(out double exp))
            {
                ExpiresAt = exp;
            }
        }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            // no/!valid store yet -> start fresh
        }
    }

    /// <summary>Persist the current session. The file holds secrets, so 0600.</summary>
    private void Save()
    {
        if (string.IsNullOrEmpty(_storePath))
        {
            return;
        }
        var data = new Dictionary<string, object?>
        {
            ["access_token"] = AccessToken,
            ["refresh_token"] = RefreshToken,
            ["expires_at"] = ExpiresAt,
        };
        File.WriteAllText(_storePath, JsonSerializer.Serialize(data));

        // Owner read/write only. Unix file modes don't exist on Windows, so the
        // guard keeps this a no-op there (and satisfies the platform analyzer).
        if (!OperatingSystem.IsWindows())
        {
            try
            {
                File.SetUnixFileMode(_storePath,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    // -- core http ---------------------------------------------------------

    private async Task<TokenResponse> PostTokenAsync(
        Dictionary<string, string> body, string what, CancellationToken cancellationToken)
    {
        string url = $"{_host}/cdb/oauth2/token";
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
                    $"{what} rejected (HTTP {(int)response.StatusCode}). "
                    + "Check credentials / refresh token; add --mfa-code for a 2FA login.");
            }
            if (!response.IsSuccessStatusCode)
            {
                string text = await SafeReadAsync(response);
                throw new ApiException(
                    $"{what} failed: HTTP {(int)response.StatusCode} {Truncate(text, 200)}");
            }

            string responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
            LastRaw = responseBody;
            return TokenResponse.Parse(responseBody);
        }
    }

    /// <summary>
    /// Update session state from a token response, then persist it. This is where
    /// ROTATION happens: if the response carries a new refresh token we adopt it,
    /// because the previous one may now be invalid.
    /// </summary>
    private void Absorb(TokenResponse data)
    {
        AccessToken = data.AccessToken;
        long expiresIn = data.ExpiresInSeconds ?? DefaultExpiresInSeconds;
        ExpiresAt = _now() + expiresIn;
        if (!string.IsNullOrEmpty(data.RefreshToken))
        {
            RefreshToken = data.RefreshToken; // <-- keep the latest
        }
        Save();
    }

    // -- public api --------------------------------------------------------

    /// <summary>First login with the password. Returns the raw token response.</summary>
    public async Task<TokenResponse> LoginAsync(
        string user, string password, string? mfaCode = null,
        CancellationToken cancellationToken = default)
    {
        TokenResponse data = await PostTokenAsync(
            BuildPasswordBody(user, password, mfaCode), "Login", cancellationToken);
        Absorb(data);
        return data;
    }

    /// <summary>Exchange the stored refresh token for a fresh access token.</summary>
    public async Task<TokenResponse> RefreshAsync(CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(RefreshToken))
        {
            throw new ApiException("No refresh token available. Log in first.");
        }
        TokenResponse data = await PostTokenAsync(
            BuildRefreshBody(RefreshToken), "Refresh", cancellationToken);
        Absorb(data);
        return data;
    }

    public double SecondsUntilExpiry() => ExpiresAt - _now();

    /// <summary>True if the access token is gone or within <paramref name="margin"/> of expiry.</summary>
    public bool IsExpiring(long margin = RefreshSafetyMarginSeconds) => SecondsUntilExpiry() <= margin;

    /// <summary>
    /// PROACTIVE refresh: get a usable access token, refreshing if needed. Call
    /// this right before you make an API request. It refreshes only when the
    /// token is missing or about to expire, so it is cheap to call often.
    /// </summary>
    public async Task<string?> EnsureValidAsync(CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(AccessToken) && string.IsNullOrEmpty(RefreshToken))
        {
            throw new ApiException("No session yet. Call LoginAsync() first.");
        }
        if (IsExpiring())
        {
            await RefreshAsync(cancellationToken);
        }
        return AccessToken;
    }

    /// <summary>
    /// GET an API path with the bearer token. Demonstrates BOTH refresh strategies:
    /// EnsureValidAsync refreshes proactively before the call, and if the server
    /// still answers 401 (token revoked early, clock skew, rotation elsewhere) we
    /// refresh once and retry.
    /// </summary>
    public async Task<HttpResponseMessage> AuthorizedGetAsync(
        string path, CancellationToken cancellationToken = default)
    {
        await EnsureValidAsync(cancellationToken);
        string url = $"{_host}{path}";

        HttpResponseMessage response = await SendGetAsync(url, cancellationToken);
        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            response.Dispose();
            await RefreshAsync(cancellationToken); // reactive refresh
            response = await SendGetAsync(url, cancellationToken);
        }
        return response;
    }

    private Task<HttpResponseMessage> SendGetAsync(string url, CancellationToken cancellationToken)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {AccessToken}");
        return _http.SendAsync(request, cancellationToken);
    }

    private static async Task<string> SafeReadAsync(HttpResponseMessage response)
    {
        try { return await response.Content.ReadAsStringAsync(); }
        catch { return string.Empty; }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
