// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Set the SCHEDULE of an Nx event rule (C#) — the v4 modernization of Network
// Optix's python/examples/setup_rule_schedule.py.
//
// C# port of ../../typescript/rest-rule-schedule, on the latest /rest/v4 API.
// Uses the built-in HttpClient + System.Text.Json — no third-party packages.
//
// The original example used the legacy /ec2/getEventRules + /ec2/saveEventRule
// transactional API, where a rule's schedule was a packed HEX BITSTREAM that had
// to be serialized/deserialized by hand (1-hour resolution). The latest
// /rest/v4 API replaces all of that:
//
//   - List rules:    GET   /rest/v4/events/rules            -> [ Rule, ... ]
//   - Modify a rule: PATCH /rest/v4/events/rules/{id}       (partial body)
//
//   The schedule is now a STRUCTURED ARRAY (no bit-twiddling):
//     schedule: [ { dayOfWeek, startTime, endTime }, ... ]
//       dayOfWeek : 1=Mon .. 7=Sun
//       startTime : seconds since 00:00 (0..endTime)
//       endTime   : seconds since 00:00 (startTime..86400)
//     An EMPTY array means "always enabled".
//
// BOTH auth modes, exactly like the TypeScript sample:
//
//   --mode direct  Local login to ONE server with a LOCAL server account.
//                    NX_SERVER_HOST / NX_SERVER_USER / NX_SERVER_PASSWORD
//                  Login:  POST {server}/rest/v4/login/sessions
//                          { username, password, setCookie:false }  ->  { token }
//   --mode cloud   Cloud account reaching the site over the relay (token scoped
//                  with cloudSystemId, the relay 307 followed manually with the
//                  bearer re-attached).
//                    NX_CLOUD_HOST / NX_CLOUD_USER / NX_CLOUD_PASSWORD / NX_CLOUD_SITE_ID
//                  Login:  POST {cloud}/cdb/oauth2/token
//                          { grant_type:"password", response_type:"token",
//                            client_id:"3rdParty", username, password,
//                            scope:"cloudSystemId=<site id>" }  ->  { access_token }
//
// Relay 307: the relay answers with a 307 redirect to the node that serves the
// request. .NET's HttpClient (like browsers) drops the Authorization header on a
// cross-host redirect, so we disable auto-redirect and follow it ourselves,
// re-attaching the bearer on each hop. A 307 also PRESERVES the method + body, so
// the helper rebuilds a fresh HttpRequestMessage per hop and re-attaches the JSON
// body — critical for the PATCH. See SendFollowingRedirectsAsync.

using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace NxRuleSchedule;

public sealed class AuthException : Exception
{
    public AuthException(string message) : base(message) { }
}

public sealed class ApiException : Exception
{
    public ApiException(string message) : base(message) { }
}

/// <summary>The two auth modes this sample supports (same names as the TypeScript sample).</summary>
public enum Mode
{
    Direct,
    Cloud,
}

/// <summary>One schedule task on a rule (v4 structured form).</summary>
public sealed record ScheduleTask(int DayOfWeek, int StartTime, int EndTime);

/// <summary>
/// An event rule (lenient — the API returns more fields than we touch). Only the
/// fields the sample reads are modeled; everything else is ignored.
/// </summary>
public sealed record Rule(string Id, string? Comment, bool? Enabled, IReadOnlyList<ScheduleTask> Schedule);

public sealed class NxRuleClient
{
    public const string ClientId = "3rdParty";
    public const string RelaySuffix = ".relay.vmsproxy.com";
    public const string Api = "/rest/v4";
    public const string RulesPath = "/rest/v4/events/rules";

    public const int SecondsPerHour = 3600;
    public const int SecondsPerDay = 86400;

    // Most redirects we will follow when chasing the relay 307.
    private const int MaxRedirects = 5;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly HttpClient _http;
    private readonly Mode _mode;
    private readonly string _user;
    private readonly string _password;
    private readonly string _serverHost;
    private readonly string _cloudHost;
    private readonly string _siteId;
    private readonly string? _mfaCode;

    public string? Token { get; private set; }

    public NxRuleClient(
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

    /// <summary>Where rule requests go: the server directly, or the site relay.</summary>
    public string ApiBase => _mode == Mode.Cloud ? RelayUrl : _serverHost;

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
    // ListRulesAsync(): GET every event rule.
    // -----------------------------------------------------------------------

    /// <summary>GET every event rule. Unwraps a { reply: [...] } envelope if present.</summary>
    public async Task<IReadOnlyList<Rule>> ListRulesAsync(CancellationToken cancellationToken = default)
    {
        string url = $"{ApiBase}{RulesPath}";
        using HttpResponseMessage response =
            await SendFollowingRedirectsAsync(HttpMethod.Get, url, body: null, cancellationToken);
        await CheckAuthOkAsync(response, "Listing rules");

        string json = await response.Content.ReadAsStringAsync(cancellationToken);
        return ParseRules(json);
    }

    // -----------------------------------------------------------------------
    // PatchScheduleAsync(): PATCH one rule's schedule.
    // -----------------------------------------------------------------------

    /// <summary>
    /// PATCH one rule's schedule with a partial { "schedule": [...] } body.
    /// Returns the modified rule (or a synthesized one if the API answers 200
    /// with an empty body, which some servers do).
    /// </summary>
    public async Task<Rule> PatchScheduleAsync(
        string ruleId, IReadOnlyList<ScheduleTask> schedule, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(ruleId))
        {
            throw new ApiException("A rule id is required to PATCH a schedule.");
        }
        string url = $"{ApiBase}{RulesPath}/{Uri.EscapeDataString(ruleId)}";
        string body = JsonSerializer.Serialize(new { schedule }, JsonOptions);

        using HttpResponseMessage response =
            await SendFollowingRedirectsAsync(new HttpMethod("PATCH"), url, body, cancellationToken);
        await CheckAuthOkAsync(response, "Patching rule");

        string json = await response.Content.ReadAsStringAsync(cancellationToken);
        if (string.IsNullOrWhiteSpace(json))
        {
            // Some servers answer 200 with an empty body; treat as success.
            return new Rule(ruleId, Comment: null, Enabled: null, Schedule: schedule);
        }
        try
        {
            return ParseRule(json) ?? new Rule(ruleId, Comment: null, Enabled: null, Schedule: schedule);
        }
        catch (ApiException)
        {
            return new Rule(ruleId, Comment: null, Enabled: null, Schedule: schedule);
        }
    }

    // -----------------------------------------------------------------------
    // SendFollowingRedirectsAsync(): the relay 307, followed by hand.
    // -----------------------------------------------------------------------

    /// <summary>
    /// Issue a request following the relay's 307 MANUALLY, re-attaching the bearer
    /// on each hop so it survives the relay's cross-host redirect, and PRESERVING
    /// the method + body (a 307 keeps both — critical for the PATCH). A fresh
    /// HttpRequestMessage is built per hop because a request/StringContent cannot
    /// be re-sent, so the JSON body is serialized once and re-wrapped each hop.
    /// (Requires the HttpClient's handler to have AllowAutoRedirect = false.)
    /// </summary>
    private async Task<HttpResponseMessage> SendFollowingRedirectsAsync(
        HttpMethod method, string url, string? body, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(Token))
        {
            throw new ApiException("Not logged in. Call LoginAsync() or UseToken() first.");
        }

        string current = url;
        for (int hop = 0; hop <= MaxRedirects; hop++)
        {
            using var request = new HttpRequestMessage(method, current);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
            // Recreate the body content for THIS hop — a StringContent can't be
            // reused across requests, and the 307 requires re-sending it intact.
            if (body is not null)
            {
                request.Content = new StringContent(body, Encoding.UTF8, "application/json");
            }

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
                continue; // re-send WITH the bearer header, method, and body
            }
            return response;
        }
        throw new ApiException($"Too many redirects (>{MaxRedirects}) chasing the relay.");
    }

    private async Task CheckAuthOkAsync(HttpResponseMessage response, string what)
    {
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new AuthException(
                $"{what} unauthorized (HTTP {(int)response.StatusCode}). In cloud mode make sure the "
                + "token was scoped with cloudSystemId for THIS site.");
        }
        if (!response.IsSuccessStatusCode)
        {
            string text = await SafeReadAsync(response);
            throw new ApiException(
                $"{what} failed: HTTP {(int)response.StatusCode} {Truncate(text, 200)}");
        }
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

    /// <summary>
    /// Parse the rules response. The body is either a bare array of rules or a
    /// { "reply": [...] } envelope; both are accepted. Anything else -> empty.
    /// </summary>
    public static IReadOnlyList<Rule> ParseRules(string json)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException) { throw new ApiException("Rules response was not valid JSON."); }

        using (doc)
        {
            JsonElement root = doc.RootElement;
            if (root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("reply", out JsonElement reply)
                && reply.ValueKind == JsonValueKind.Array)
            {
                root = reply;
            }
            if (root.ValueKind != JsonValueKind.Array) return Array.Empty<Rule>();

            var rules = new List<Rule>();
            foreach (JsonElement element in root.EnumerateArray())
            {
                Rule? rule = ToRule(element);
                if (rule is not null) rules.Add(rule);
            }
            return rules;
        }
    }

    /// <summary>Parse a single rule object (the body of a PATCH echo).</summary>
    public static Rule? ParseRule(string json)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException) { throw new ApiException("Rule response was not valid JSON."); }
        using (doc)
        {
            return ToRule(doc.RootElement);
        }
    }

    private static Rule? ToRule(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;

        string id = element.TryGetProperty("id", out JsonElement idEl)
            ? (idEl.ValueKind == JsonValueKind.String ? idEl.GetString() ?? "" : idEl.ToString())
            : "";

        string? comment = element.TryGetProperty("comment", out JsonElement commentEl)
            && commentEl.ValueKind == JsonValueKind.String
            ? commentEl.GetString()
            : null;

        bool? enabled = null;
        if (element.TryGetProperty("enabled", out JsonElement enabledEl))
        {
            if (enabledEl.ValueKind == JsonValueKind.True) enabled = true;
            else if (enabledEl.ValueKind == JsonValueKind.False) enabled = false;
        }

        var schedule = new List<ScheduleTask>();
        if (element.TryGetProperty("schedule", out JsonElement scheduleEl)
            && scheduleEl.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement task in scheduleEl.EnumerateArray())
            {
                if (task.ValueKind != JsonValueKind.Object) continue;
                schedule.Add(new ScheduleTask(
                    GetInt(task, "dayOfWeek"),
                    GetInt(task, "startTime"),
                    GetInt(task, "endTime")));
            }
        }

        return new Rule(id, comment, enabled, schedule);
    }

    private static int GetInt(JsonElement obj, string key)
    {
        if (obj.TryGetProperty(key, out JsonElement el))
        {
            if (el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out int n)) return n;
            if (el.ValueKind == JsonValueKind.String && int.TryParse(el.GetString(), out int s)) return s;
        }
        return 0;
    }

    private static async Task<string> SafeReadAsync(HttpResponseMessage response)
    {
        try { return await response.Content.ReadAsStringAsync(); }
        catch { return string.Empty; }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
