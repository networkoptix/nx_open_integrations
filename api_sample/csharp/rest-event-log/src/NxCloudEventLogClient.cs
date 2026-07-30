// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Read ONE site's event log using a CLOUD account (C#).
//
// C# port of ../../python/rest-event-log and ../../node/rest-event-log, on the
// latest /rest/v4 API. Uses the built-in HttpClient + System.Text.Json — no
// third-party packages.
//
// This reads the event history of one site the way the cloud routes API calls
// to a server:
//   1. Get a token from the cloud, SCOPED to the target site:
//        POST {cloud}/cdb/oauth2/token
//        { grant_type:"password", response_type:"token", client_id:"3rdParty",
//          username, password, scope:"cloudSystemId=<site id>" }
//      (or pass an existing scoped token with --token)
//   2. Reach the site through the Cloud relay:
//        https://<site-id>.relay.vmsproxy.com
//   3. Read the event log (the v4 endpoint):
//        GET /rest/v4/events/log?startTimeMs=<ms>&durationMs=<ms>[&eventType=...]
//        (Authorization: Bearer <site-token>)
//   4. Optionally fetch the event-type manifest to label/filter events:
//        GET /rest/v4/events/manifest/events
//
// Relay 307: the relay answers with a 307 redirect to the node that serves the
// request. .NET's HttpClient (like browsers) drops the Authorization header on a
// cross-host redirect, so we disable auto-redirect and follow it ourselves,
// re-attaching the bearer on each hop. See GetFollowingRedirectsAsync.
//
// v4 contract:
//   - The window is startTimeMs + durationMs (milliseconds), NOT from/to.
//   - eventType / actionType are LISTS (repeatable query params).
//   - Each record is { timestampMs, eventData{}, actionData{}, ruleId, flags }
//     where eventData / actionData are maps keyed by manifest field names.
//   - The manifest (/rest/v4/events/manifest/events) is an OBJECT MAP keyed by
//     event-type id; each value has { id, displayName, ... }.

using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace NxEventLog;

public sealed class AuthException : Exception
{
    public AuthException(string message) : base(message) { }
}

public sealed class ApiException : Exception
{
    public ApiException(string message) : base(message) { }
}

/// <summary>One event-log record, flattened to the fields the table shows.</summary>
public sealed record EventRecord(string Time, string EventType, string ActionType, string Resource);

/// <summary>One event type from the manifest, used to label/filter events.</summary>
public sealed record EventTypeInfo(string Id, string DisplayName);

public sealed class NxCloudEventLogClient
{
    public const string ClientId = "3rdParty";
    public const string RelaySuffix = ".relay.vmsproxy.com";
    public const string Api = "/rest/v4";
    public const string EventsPath = "/rest/v4/events/log";
    public const string ManifestPath = "/rest/v4/events/manifest/events";
    private const int MaxRedirects = 5;

    private readonly HttpClient _http;
    private readonly string _cloudHost;
    private readonly string _siteId;

    public string? Token { get; private set; }

    public NxCloudEventLogClient(HttpClient http, string cloudHost, string siteId)
    {
        _http = http;
        _cloudHost = cloudHost.TrimEnd('/');
        _siteId = siteId;
    }

    /// <summary>The Cloud relay address for this specific site.</summary>
    public string RelayUrl => $"https://{_siteId}{RelaySuffix}";

    /// <summary>Get a token from the cloud SCOPED to this site.</summary>
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
            // The wire literal stays "cloudSystemId" even though we say "site".
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

    /// <summary>Read the event log through the relay; returns normalized events.</summary>
    public async Task<IReadOnlyList<EventRecord>> GetEventLogAsync(
        long startMs, long durationMs, IReadOnlyList<string>? eventType = null,
        IReadOnlyList<string>? actionType = null, string order = "desc", int limit = 50,
        CancellationToken cancellationToken = default)
    {
        string query = BuildEventQuery(startMs, durationMs, eventType, actionType, order, limit);
        string url = $"{RelayUrl}{EventsPath}?{query}";
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
                $"Reading events failed: HTTP {(int)response.StatusCode} {Truncate(text, 200)}");
        }

        string json = await response.Content.ReadAsStringAsync(cancellationToken);
        return NormalizeEvents(json);
    }

    /// <summary>
    /// Fetch the event-type manifest (id -> displayName) used to label/filter
    /// events. Returns a map keyed by event-type id.
    /// </summary>
    public async Task<IReadOnlyDictionary<string, EventTypeInfo>> GetEventManifestAsync(
        CancellationToken cancellationToken = default)
    {
        string url = $"{RelayUrl}{ManifestPath}";
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
                $"Reading the event manifest failed: HTTP {(int)response.StatusCode} {Truncate(text, 200)}");
        }

        string json = await response.Content.ReadAsStringAsync(cancellationToken);
        return ParseManifest(json);
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
            throw new ApiException("No token. Call LoginAsync() or UseToken() first.");
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
    /// Assemble the v4 query string. eventType / actionType are repeatable array
    /// params (?eventType=a&amp;eventType=b). Everything is URL-encoded.
    /// </summary>
    public static string BuildEventQuery(
        long startMs, long durationMs, IReadOnlyList<string>? eventType = null,
        IReadOnlyList<string>? actionType = null, string order = "desc", int limit = 50)
    {
        var parts = new List<string>
        {
            $"startTimeMs={Uri.EscapeDataString(startMs.ToString())}",
            $"durationMs={Uri.EscapeDataString(durationMs.ToString())}",
            $"order={Uri.EscapeDataString(order)}",
            $"limit={Uri.EscapeDataString(limit.ToString())}",
        };
        if (eventType is not null)
        {
            foreach (string t in eventType) parts.Add($"eventType={Uri.EscapeDataString(t)}");
        }
        if (actionType is not null)
        {
            foreach (string t in actionType) parts.Add($"actionType={Uri.EscapeDataString(t)}");
        }
        return string.Join("&", parts);
    }

    /// <summary>
    /// The /rest/v4/events/log body is an array of records. Flatten each into an
    /// EventRecord, looking up the common keys inside eventData / actionData.
    /// </summary>
    public static IReadOnlyList<EventRecord> NormalizeEvents(string json)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException) { throw new ApiException("Events response was not valid JSON."); }

        using (doc)
        {
            JsonElement root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Array) return Array.Empty<EventRecord>();

            var events = new List<EventRecord>();
            foreach (JsonElement record in root.EnumerateArray())
            {
                events.Add(NormalizeEvent(record));
            }
            return events;
        }
    }

    private static EventRecord NormalizeEvent(JsonElement record)
    {
        JsonElement eventData = GetObject(record, "eventData");
        JsonElement actionData = GetObject(record, "actionData");
        return new EventRecord(
            Time: MsToIso(record),
            EventType: First(eventData, "eventType", "type"),
            ActionType: First(actionData, "actionType", "type"),
            Resource: First(eventData, "caption", "resourceName", "eventResourceId", "source"));
    }

    /// <summary>
    /// The manifest (/rest/v4/events/manifest/events) is an OBJECT MAP keyed by
    /// event-type id; each value has { id, displayName }. Parse into a map.
    /// </summary>
    public static IReadOnlyDictionary<string, EventTypeInfo> ParseManifest(string json)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException) { throw new ApiException("Manifest response was not valid JSON."); }

        using (doc)
        {
            JsonElement root = doc.RootElement;
            var manifest = new Dictionary<string, EventTypeInfo>();
            if (root.ValueKind != JsonValueKind.Object) return manifest;

            foreach (JsonProperty entry in root.EnumerateObject())
            {
                JsonElement value = entry.Value;
                // Each value carries its own id (pass back as eventType) + displayName.
                string id = First(value, "id");
                if (string.IsNullOrEmpty(id)) id = entry.Name;
                string displayName = First(value, "displayName", "name");
                manifest[id] = new EventTypeInfo(id, displayName);
            }
            return manifest;
        }
    }

    /// <summary>Render the events as a simple aligned text table.</summary>
    public static string FormatEventsTable(IReadOnlyList<EventRecord> events)
    {
        if (events.Count == 0) return "No events in this time range.";

        var rows = new List<string[]> { new[] { "TIME (UTC)", "EVENT", "ACTION", "RESOURCE" } };
        foreach (EventRecord e in events)
        {
            rows.Add(new[] { e.Time, e.EventType, e.ActionType, e.Resource });
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

    /// <summary>
    /// Render the manifest as a simple aligned text table (ID + DISPLAY NAME),
    /// sorted by id. Mirrors FormatEventsTable so the two outputs read alike.
    /// </summary>
    public static string FormatManifestTable(IReadOnlyDictionary<string, EventTypeInfo> manifest)
    {
        if (manifest.Count == 0) return "No event types reported by this site.";

        var rows = new List<string[]> { new[] { "ID", "DISPLAY NAME" } };
        foreach (EventTypeInfo info in manifest.Values.OrderBy(e => e.Id, StringComparer.Ordinal))
        {
            rows.Add(new[] { info.Id, info.DisplayName });
        }
        int[] widths = new int[2];
        foreach (string[] row in rows)
        {
            for (int i = 0; i < 2; i++) widths[i] = Math.Max(widths[i], row[i].Length);
        }
        var sb = new StringBuilder();
        foreach (string[] row in rows)
        {
            var cells = new string[2];
            for (int i = 0; i < 2; i++) cells[i] = row[i].PadRight(widths[i]);
            sb.AppendLine(string.Join("  ", cells).TrimEnd());
        }
        return sb.ToString().TrimEnd('\n', '\r');
    }

    /// <summary>Convert an epoch-millisecond "timestampMs" field to a readable UTC string.</summary>
    public static string MsToIso(JsonElement record)
    {
        if (record.ValueKind != JsonValueKind.Object
            || !record.TryGetProperty("timestampMs", out JsonElement el))
        {
            return "";
        }
        long ms;
        if (el.ValueKind == JsonValueKind.Number && el.TryGetInt64(out long n)) ms = n;
        else if (el.ValueKind == JsonValueKind.String && long.TryParse(el.GetString(), out long s)) ms = s;
        else return el.ToString();
        return DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss");
    }

    /// <summary>Return the first present, non-empty string among keys in a JSON object.</summary>
    private static string First(JsonElement obj, params string[] keys)
    {
        if (obj.ValueKind != JsonValueKind.Object) return "";
        foreach (string key in keys)
        {
            if (obj.TryGetProperty(key, out JsonElement el))
            {
                string v = el.ValueKind == JsonValueKind.String ? el.GetString() ?? "" : el.ToString();
                if (!string.IsNullOrEmpty(v)) return v;
            }
        }
        return "";
    }

    private static JsonElement GetObject(JsonElement parent, string prop)
    {
        if (parent.ValueKind == JsonValueKind.Object
            && parent.TryGetProperty(prop, out JsonElement el)
            && el.ValueKind == JsonValueKind.Object)
        {
            return el;
        }
        return default;
    }

    private static async Task<string> SafeReadAsync(HttpResponseMessage response)
    {
        try { return await response.Content.ReadAsStringAsync(); }
        catch { return string.Empty; }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
