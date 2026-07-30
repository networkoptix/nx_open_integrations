// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Save a short video CLIP from an Nx camera to a FILE (C#) — the command-line
// counterpart of the browser ../../web/media-http-stream sample. A CLI can't
// render a <video>, so instead it fetches the media stream and writes it to a
// file you can play in VLC / ffplay / a browser.
//
// C# port of ../../typescript/media-http-stream, on the latest /rest/v4 API.
// Uses the built-in HttpClient + System.Text.Json — no third-party packages.
//
// BOTH auth modes, exactly like the browser/TypeScript sample:
//
//   --mode direct  Direct to Media Server: connect to ONE media server by
//                  IP:port with a LOCAL server account.
//                    NX_SERVER_HOST / NX_SERVER_USER / NX_SERVER_PASSWORD
//                  Login:  POST {server}/rest/v4/login/sessions
//                          { username, password, setCookie:false }  ->  { token }
//   --mode cloud   Pull Stream via Cloud Relay: a cloud account reaches the
//                  site over the relay (token scoped with cloudSystemId, the
//                  relay 307 followed manually with the bearer re-attached).
//                    NX_CLOUD_HOST / NX_CLOUD_USER / NX_CLOUD_PASSWORD / NX_CLOUD_SITE_ID
//                  Login:  POST {cloud}/cdb/oauth2/token
//                          { grant_type:"password", response_type:"token",
//                            client_id:"3rdParty", username, password,
//                            scope:"cloudSystemId=<site id>" }  ->  { access_token }
//
// THE MEDIA ENDPOINT (from the v4 spec):
//
//   GET /rest/v4/devices/{id}/media.{format}   (Authorization: Bearer <token>)
//     ?positionMs=<ms>     archive start time; OMIT this for LIVE
//     &durationMs=<ms>     how much footage to pull (bounds the clip)
//
//   format is one of the containers the v4 spec allows for this endpoint (see
//   Formats, taken verbatim from docs/v4_api_spec.json):
//     webm, mpegts, mpjpeg, mp4, mkv, _3gp, rtp, flv, f4v
//
// LIVE vs ARCHIVE:
//   - No --pos            -> LIVE: save the next --duration seconds.
//   - --pos <ISO|epochMs> -> ARCHIVE: save --duration seconds starting there.
//
// Because a CLI must terminate, the clip is always bounded by --duration
// (seconds, default 10). durationMs is sent to the server AND, via a
// CancellationToken with a timeout of durationMs + grace, used as a client-side
// safety stop so the program can never hang on an endless live stream.
//
// Streaming: the response is read with HttpCompletionOption.ResponseHeadersRead
// and copied straight from response.Content to a destination Stream, so the
// whole clip is never buffered in memory. The destination is injectable (any
// Stream) so tests don't need disk; a real FileStream is used by the CLI.
//
// Relay 307: the relay answers with a 307 redirect to the node that serves the
// request. .NET's HttpClient (like browsers) drops the Authorization header on a
// cross-host redirect, so we disable auto-redirect and follow it ourselves,
// re-attaching the bearer on each hop. See GetFollowingRedirectsAsync.

using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace NxMediaHttpStream;

public sealed class AuthException : Exception
{
    public AuthException(string message) : base(message) { }
}

public sealed class ApiException : Exception
{
    public ApiException(string message) : base(message) { }
}

/// <summary>The two auth modes this sample supports (same names as the web sample).</summary>
public enum Mode
{
    Direct,
    Cloud,
}

/// <summary>What a single saveClip call needs to know about the media request.</summary>
public sealed record ClipRequest(string DeviceId, string Format, long? PositionMs, long? DurationMs);

public sealed class NxMediaClient
{
    public const string ClientId = "3rdParty";
    public const string RelaySuffix = ".relay.vmsproxy.com";
    public const string Api = "/rest/v4";

    // Container formats the v4 media.{format} endpoint supports, copied verbatim
    // from the `format` enum in docs/v4_api_spec.json. Don't invent others.
    public static readonly IReadOnlyList<string> Formats = new[]
    {
        "webm", "mpegts", "mpjpeg", "mp4", "mkv", "_3gp", "rtp", "flv", "f4v",
    };
    public const string DefaultFormat = "webm";

    // Clip length when --duration is not given (seconds).
    public const int DefaultDurationSeconds = 10;
    // Extra wall-clock grace beyond durationMs before the client-side abort fires.
    private const int AbortGraceMs = 10000;
    // Most redirects we will follow when chasing the relay 307.
    private const int MaxRedirects = 5;

    private readonly HttpClient _http;
    private readonly Mode _mode;
    private readonly string _user;
    private readonly string _password;
    private readonly string _serverHost;
    private readonly string _cloudHost;
    private readonly string _siteId;
    private readonly string? _mfaCode;

    public string? Token { get; private set; }

    public NxMediaClient(
        HttpClient http,
        Mode mode,
        string user,
        string password,
        string? serverHost = null,
        string? cloudHost = null,
        string? siteId = null,
        string? mfaCode = null)
    {
        _http = http;
        _mode = mode;
        _user = user;
        _password = password;
        _serverHost = (serverHost ?? "").TrimEnd('/');
        _cloudHost = (cloudHost ?? "https://nxvms.com").TrimEnd('/');
        _siteId = siteId ?? "";
        _mfaCode = mfaCode;
    }

    /// <summary>The Cloud relay address for this specific site (cloud mode).</summary>
    public string RelayUrl => $"https://{_siteId}{RelaySuffix}";

    /// <summary>Where media requests go: the server directly, or the site relay.</summary>
    public string MediaBase => _mode == Mode.Cloud ? RelayUrl : _serverHost;

    /// <summary>Use a bearer token obtained elsewhere (skip login).</summary>
    public void UseToken(string token) => Token = token;

    // -----------------------------------------------------------------------
    // LoginAsync(): two flows, one method.
    // -----------------------------------------------------------------------

    public Task<string> LoginAsync(CancellationToken cancellationToken = default)
        => _mode == Mode.Cloud ? LoginCloudAsync(cancellationToken) : LoginDirectAsync(cancellationToken);

    /// <summary>Direct: POST {server}/rest/v4/login/sessions -> { token }.</summary>
    private async Task<string> LoginDirectAsync(CancellationToken cancellationToken)
    {
        string url = $"{_serverHost}{Api}/login/sessions";
        var body = new Dictionary<string, object>
        {
            ["username"] = _user,
            ["password"] = _password,
            ["setCookie"] = false,
        };

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
                    $"Login rejected (HTTP {(int)response.StatusCode}). Check the username/password, "
                    + "and that it is a LOCAL server account (cloud users use --mode cloud).");
            }
            if (!response.IsSuccessStatusCode)
            {
                string text = await SafeReadAsync(response);
                throw new ApiException(
                    $"Login failed: HTTP {(int)response.StatusCode} {Truncate(text, 200)}");
            }
            string json = await response.Content.ReadAsStringAsync(cancellationToken);
            Token = ExtractToken(json);
            return Token;
        }
    }

    /// <summary>Cloud: POST {cloud}/cdb/oauth2/token with cloudSystemId scope -> { access_token }.</summary>
    private async Task<string> LoginCloudAsync(CancellationToken cancellationToken)
    {
        string url = $"{_cloudHost}/cdb/oauth2/token";
        var body = new Dictionary<string, string>
        {
            ["grant_type"] = "password",
            ["response_type"] = "token",
            ["client_id"] = ClientId,
            ["username"] = _user,
            ["password"] = _password,
            // THIS scope is what makes the token usable against the site relay.
            ["scope"] = $"cloudSystemId={_siteId}",
        };
        if (!string.IsNullOrEmpty(_mfaCode)) body["mfaCode"] = _mfaCode;

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
                    $"Login rejected (HTTP {(int)response.StatusCode}). Check the cloud email/password, "
                    + "the site id, and that the account has access to that site. Add --mfa-code for 2FA.");
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

    // -----------------------------------------------------------------------
    // BuildMediaUrl(): the upstream media URL (header auth — no token in the URL).
    // -----------------------------------------------------------------------

    public string BuildMediaUrl(string deviceId, string format, long? positionMs = null, long? durationMs = null)
    {
        if (string.IsNullOrEmpty(deviceId))
        {
            throw new ApiException("A deviceId is required to build the media URL.");
        }
        string path = $"{MediaBase}{Api}/devices/{Uri.EscapeDataString(deviceId)}/media.{format}";
        var parts = new List<string>();
        // positionMs present == archive; absent == live.
        if (positionMs is not null)
        {
            parts.Add($"positionMs={Uri.EscapeDataString(positionMs.Value.ToString(CultureInfo.InvariantCulture))}");
        }
        if (durationMs is not null)
        {
            parts.Add($"durationMs={Uri.EscapeDataString(durationMs.Value.ToString(CultureInfo.InvariantCulture))}");
        }
        return parts.Count == 0 ? path : $"{path}?{string.Join("&", parts)}";
    }

    // -----------------------------------------------------------------------
    // SaveClipAsync(): fetch the media stream and copy it to `destination`.
    // -----------------------------------------------------------------------

    /// <summary>
    /// Fetch the clip and STREAM the response body into <paramref name="destination"/>,
    /// returning the number of bytes written. Uses
    /// HttpCompletionOption.ResponseHeadersRead and copies the content stream
    /// directly, so the whole clip is never buffered in memory. A
    /// CancellationToken with a timeout of durationMs + grace stops an endless
    /// live stream so the CLI can never hang.
    /// </summary>
    public async Task<long> SaveClipAsync(
        Stream destination, ClipRequest request, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(Token))
        {
            throw new ApiException("Not logged in. Call LoginAsync() or UseToken() first.");
        }

        string url = BuildMediaUrl(request.DeviceId, request.Format, request.PositionMs, request.DurationMs);

        using var timeoutCts = new CancellationTokenSource();
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);
        if (request.DurationMs is > 0)
        {
            // Client-side safety stop: never wait forever on an endless stream.
            timeoutCts.CancelAfter(TimeSpan.FromMilliseconds(request.DurationMs.Value + AbortGraceMs));
        }

        using HttpResponseMessage response = await GetFollowingRedirectsAsync(url, linked.Token);

        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new AuthException(
                $"The server rejected the token (HTTP {(int)response.StatusCode}). In cloud mode make "
                + "sure it was scoped with cloudSystemId for THIS site.");
        }
        if (!response.IsSuccessStatusCode)
        {
            string text = await SafeReadAsync(response);
            throw new ApiException(
                $"Media request failed: HTTP {(int)response.StatusCode} {Truncate(text, 200)}");
        }

        return await CopyToCountingAsync(response, destination, linked.Token);
    }

    /// <summary>
    /// Copy the response content stream to <paramref name="destination"/> without
    /// buffering the whole clip, returning the byte count.
    /// </summary>
    private static async Task<long> CopyToCountingAsync(
        HttpResponseMessage response, Stream destination, CancellationToken cancellationToken)
    {
        Stream source;
        try
        {
            source = await response.Content.ReadAsStreamAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException)
        {
            throw new ApiException($"Media response had no body to save: {ex.Message}");
        }

        long total = 0;
        var buffer = new byte[81920];
        int read;
        while ((read = await source.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken)) > 0)
        {
            await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            total += read;
        }
        await destination.FlushAsync(cancellationToken);
        return total;
    }

    // -----------------------------------------------------------------------
    // GetFollowingRedirectsAsync(): the relay 307, followed by hand.
    // -----------------------------------------------------------------------

    /// <summary>
    /// GET that follows 307 redirects MANUALLY, re-attaching the bearer on each
    /// hop so it survives the relay's cross-host redirect, and reads only the
    /// response headers (ResponseHeadersRead) so the body is streamed, not
    /// buffered. (Requires the HttpClient's handler to have AllowAutoRedirect = false.)
    /// </summary>
    private async Task<HttpResponseMessage> GetFollowingRedirectsAsync(
        string url, CancellationToken cancellationToken)
    {
        string current = url;
        for (int hop = 0; hop <= MaxRedirects; hop++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, current);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);

            HttpResponseMessage response;
            try
            {
                response = await _http.SendAsync(
                    request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
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
        throw new ApiException($"Too many redirects (>{MaxRedirects}) chasing the relay.");
    }

    // -----------------------------------------------------------------------
    // LogoutAsync(): revoke the token. Best-effort cleanup.
    // -----------------------------------------------------------------------

    public async Task LogoutAsync(CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(Token)) return;
        string url = _mode == Mode.Cloud
            ? $"{_cloudHost}/cdb/oauth2/token/{Token}"
            : $"{_serverHost}{Api}/login/sessions/{Token}";
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

    // -----------------------------------------------------------------------
    // Parsing helpers (pure = easy to test)
    // -----------------------------------------------------------------------

    public static string ExtractToken(string json)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException) { throw new ApiException("Login response was not valid JSON."); }
        using (doc)
        {
            if (doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("token", out JsonElement el)
                && el.ValueKind == JsonValueKind.String)
            {
                return el.GetString()!;
            }
            throw new ApiException("Login response did not contain a token.");
        }
    }

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

    private static async Task<string> SafeReadAsync(HttpResponseMessage response)
    {
        try { return await response.Content.ReadAsStringAsync(); }
        catch { return string.Empty; }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
