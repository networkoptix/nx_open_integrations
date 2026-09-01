// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// The login session lifecycle on ONE Nx mediaserver (C#).
//
// C# port of ../../python/rest-get-token (and the Node/TypeScript ports), on the
// latest /rest/v4 API. Uses the built-in HttpClient + System.Text.Json — no
// third-party packages.
//
// This is the smallest possible "how do I authenticate?" sample. It gets a bearer
// token from the mediaserver, uses it on a real authenticated request, gives it
// back, and then proves the token is dead. Nothing else — no cameras, no events.
//
// The flow:
//
//   1. Log in:   POST   /rest/v4/login/sessions  { username, password, setCookie:false }
//                -> { "id", "username", "token", "ageS", "expiresInS" }
//   2. Use it:   GET    /rest/v4/login/sessions/current   (Authorization: Bearer <token>)
//                The literal "current" (or "-") means "the token in my auth
//                header", so this call both proves the token works AND shows
//                what a session is.
//   3. Log out:  DELETE /rest/v4/login/sessions/current   (release the session)
//   4. Re-check: GET    /rest/v4/login/sessions/current    -> now fails, as it should.
//
// Step 4 exists so logout is something you can see rather than take on faith.
//
// The token goes in the Authorization: Bearer <token> header. All three calls
// that need it address the session with the "current" sentinel, so the header
// is what identifies the session.
//
// Connecting: the host is the mediaserver, e.g. https://192.168.1.10:7001 (note
// the https + port). Local servers usually present a self-signed certificate, so
// for a lab server you will typically need --insecure.

using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace NxGetToken;

public sealed class AuthException : Exception
{
    public AuthException(string message) : base(message) { }
}

public sealed class ApiException : Exception
{
    public ApiException(string message) : base(message) { }
}

/// <summary>
/// One login session, as returned by POST /rest/v4/login/sessions and by
/// GET /rest/v4/login/sessions/{token}. AgeS and ExpiresInS are SECONDS,
/// matching the wire field names.
/// </summary>
public sealed record LoginSession(
    string Token,
    string Id,
    string Username,
    long? AgeS,
    long? ExpiresInS);

/// <summary>
/// The result of probing a token: whether it is still accepted, and the HTTP
/// status observed. Status is null when the request never landed.
/// </summary>
public sealed record TokenProbe(bool IsLive, int? Status);

public sealed class NxLoginClient
{
    public const string Api = "/rest/v4";

    private readonly HttpClient _http;
    private readonly string _host;

    public string? Token { get; private set; }

    public NxLoginClient(HttpClient http, string host)
    {
        _http = http;
        _host = host.TrimEnd('/');
    }

    /// <summary>Use a bearer token obtained elsewhere (skip login).</summary>
    public void UseToken(string token) => Token = token;

    // -----------------------------------------------------------------------
    // Step 1: get a token
    // -----------------------------------------------------------------------

    /// <summary>
    /// POST credentials, receive a session (incl. its token), remember it.
    ///
    /// Returns the whole session, not just the token, because the other fields
    /// are the interesting part: ExpiresInS is how long you have.
    /// </summary>
    public async Task<LoginSession> LoginAsync(
        string user, string password, CancellationToken cancellationToken = default)
    {
        string url = $"{_host}{Api}/login/sessions";
        var body = new Dictionary<string, object>
        {
            ["username"] = user,
            ["password"] = password,
            ["setCookie"] = false,
        };

        using var content = new StringContent(
            JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

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
            EnsureAuthorized(response, "Login");
            await EnsureSuccessAsync(response, "Login");
            string json = await response.Content.ReadAsStringAsync(cancellationToken);
            LoginSession session = ParseSession(json, "Login");
            Token = session.Token;
            return session;
        }
    }

    // -----------------------------------------------------------------------
    // Step 2: use the token
    // -----------------------------------------------------------------------

    /// <summary>
    /// GET the session that the bearer token in our header belongs to.
    ///
    /// The path literal "current" (the v4 API also accepts "-") means "whatever
    /// token is in the Authorization header", so the request needs no token in
    /// the path.
    ///
    /// A successful call here is the proof that the token works: the server only
    /// answers if it recognises the token we sent.
    /// </summary>
    public async Task<LoginSession> GetCurrentSessionAsync(
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(Token))
        {
            throw new ApiException("Not logged in. Call LoginAsync() or UseToken() first.");
        }

        string url = $"{_host}{Api}/login/sessions/current";
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);

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
            EnsureAuthorized(response, "Reading the current session");
            await EnsureSuccessAsync(response, "Reading the current session");
            string json = await response.Content.ReadAsStringAsync(cancellationToken);
            return ParseSession(json, "Reading the current session");
        }
    }

    // -----------------------------------------------------------------------
    // Step 4: confirm the token really is dead
    // -----------------------------------------------------------------------

    /// <summary>
    /// Probe the session endpoint with <paramref name="token"/> and report
    /// whether it is still live.
    ///
    /// Unlike GetCurrentSessionAsync this NEVER throws on a rejection: after
    /// logout a 401 is the expected, correct answer, not a failure. Status is
    /// null when the request never landed.
    /// </summary>
    public async Task<TokenProbe> TokenStillWorksAsync(
        string token, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(token))
        {
            throw new ApiException("TokenStillWorksAsync needs a token to probe with.");
        }

        string url = $"{_host}{Api}/login/sessions/current";
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

        try
        {
            using HttpResponseMessage response = await _http.SendAsync(request, cancellationToken);
            return new TokenProbe(response.IsSuccessStatusCode, (int)response.StatusCode);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            // Can't reach the server, so we can't say. Report "not live".
            return new TokenProbe(false, null);
        }
    }

    // -----------------------------------------------------------------------
    // Step 3: give the token back
    // -----------------------------------------------------------------------

    /// <summary>
    /// DELETE the session so the token cannot be reused.
    ///
    /// Best-effort by design: this is cleanup, and cleanup failing should never
    /// be the thing that crashes the program. Returns true if the server
    /// confirmed it. Clears the remembered token either way.
    /// </summary>
    public async Task<bool> LogoutAsync(CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(Token)) return false;
        // Address the session with the "current" sentinel; the server takes the
        // token from the Authorization header.
        string url = $"{_host}{Api}/login/sessions/current";
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Delete, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
            using HttpResponseMessage response = await _http.SendAsync(request, cancellationToken);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            // Logout is cleanup; never let it crash the program.
            return false;
        }
        finally
        {
            Token = null;
        }
    }

    // -----------------------------------------------------------------------
    // Parsing + formatting helpers (pure = easy to test)
    // -----------------------------------------------------------------------

    /// <summary>
    /// Parse a session body. `token` is required; the rest are best-effort, so a
    /// server that omits one still yields a usable session.
    /// </summary>
    public static LoginSession ParseSession(string json, string what = "Login")
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException) { throw new ApiException($"{what} response was not valid JSON."); }

        using (doc)
        {
            JsonElement root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("token", out JsonElement tokenEl)
                || tokenEl.ValueKind != JsonValueKind.String)
            {
                throw new ApiException($"{what} response did not contain a token.");
            }

            return new LoginSession(
                Token: tokenEl.GetString()!,
                Id: Str(root, "id"),
                Username: Str(root, "username"),
                AgeS: Num(root, "ageS"),
                ExpiresInS: Num(root, "expiresInS"));
        }
    }

    /// <summary>Render a session as an aligned label/value block.</summary>
    public static string FormatSession(LoginSession session)
    {
        var rows = new List<(string Label, string Value)>
        {
            ("token", session.Token),
            ("session id", session.Id),
            ("username", session.Username),
        };
        // AgeS / ExpiresInS are seconds, per the v4 spec field names.
        if (session.AgeS is not null) rows.Add(("age", $"{session.AgeS} seconds"));
        if (session.ExpiresInS is not null) rows.Add(("expires in", $"{session.ExpiresInS} seconds"));

        int width = rows.Max(r => r.Label.Length);
        var sb = new StringBuilder();
        foreach ((string label, string value) in rows)
        {
            sb.AppendLine($"{label.PadRight(width)} : {value}");
        }
        return sb.ToString().TrimEnd('\n', '\r');
    }

    private static void EnsureAuthorized(HttpResponseMessage response, string what)
    {
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new AuthException(
                $"{what} unauthorized (HTTP {(int)response.StatusCode}). Check the "
                + "username/password, and that you are using a local (not cloud) user.");
        }
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, string what)
    {
        if (!response.IsSuccessStatusCode)
        {
            string text = await SafeReadAsync(response);
            throw new ApiException(
                $"{what} failed: HTTP {(int)response.StatusCode} {Truncate(text, 200)}");
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

    private static long? Num(JsonElement obj, string prop)
    {
        if (obj.ValueKind == JsonValueKind.Object
            && obj.TryGetProperty(prop, out JsonElement el)
            && el.ValueKind == JsonValueKind.Number
            && el.TryGetInt64(out long value))
        {
            return value;
        }
        return null;
    }

    private static async Task<string> SafeReadAsync(HttpResponseMessage response)
    {
        try { return await response.Content.ReadAsStringAsync(); }
        catch { return string.Empty; }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
