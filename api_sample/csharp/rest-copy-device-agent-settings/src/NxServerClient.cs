// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Nx VMS REST Server API sample: copy one device's Device Agent (analytics
// plugin) settings onto another device, on the latest /rest/v4 API. Uses the
// built-in HttpClient + System.Text.Json, no third-party packages.
//
// Downloads the settings an analytics Engine keeps for one Device Agent, then
// applies them to another device running the same (or a compatible) Engine.
// Two subcommands: "download" writes the settings to a JSON file, "apply"
// loads that file and sends it to a target device. Run "apply" once per
// target device; looping over many devices is a shell loop around this
// command, not a flag on it.
//
//   download:
//     1. Log in:  POST /rest/v4/login/sessions  {username, password} -> {"token": ...}
//     2. Get:     GET /rest/v4/analytics/engines/<engineId>/deviceAgents/<deviceId>/settings
//     3. Log out: DELETE /rest/v4/login/sessions/<token>
//
//   apply:
//     1. Log in, as above.
//     2. Set:     PUT /rest/v4/analytics/engines/<engineId>/deviceAgents/<deviceId>/settings
//                 with the downloaded settings, minus deviceId and engineId
//                 (the URL already identifies the device and engine) and
//                 minus _error (the source device's error map, which must not
//                 be echoed back). Everything else (values, model,
//                 analyzedStream, disableStreamSelection) is forwarded
//                 unchanged. A 2xx whose body carries a non-empty _error map
//                 means the server took the settings but the Engine reported
//                 errors, which is a failure.
//     3. Log out, always, also after a failure.
//
// No redirect is ever followed: a 3xx is a failure.
//
// Connecting to the server:
//   --host is the server, e.g. https://192.168.1.10:7001 (https + port).
//   Local servers usually present a self-signed certificate, so for a lab
//   server you will typically need --insecure.
//
// Reference: https://meta.nxvms.com/doc/developers/api-tool/main?type=1

using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace NxCopyDeviceAgentSettings;

public sealed class AuthException : Exception
{
    public AuthException(string message) : base(message) { }
}

public sealed class ApiException : Exception
{
    public ApiException(string message) : base(message) { }
}

/// <summary>Configuration is missing, which is exit code 2 rather than a call failure.</summary>
public sealed class ConfigException : Exception
{
    public ConfigException(string message) : base(message) { }
}

/// <summary>
/// The server answered 2xx to the PUT, but its body carries a non-empty
/// <c>_error</c> map: the settings were taken and the Engine reported errors.
/// </summary>
public sealed class EngineErrorsException : Exception
{
    public IReadOnlyList<KeyValuePair<string, string>> Errors { get; }

    public EngineErrorsException(IReadOnlyList<KeyValuePair<string, string>> errors)
        : base("The server took the settings but the Engine reported errors:")
        => Errors = errors;
}

/// <summary>
/// Ctrl-C while the settings PUT was in flight: it may have reached the server,
/// so the run says the outcome is unknown instead of just "Interrupted.".
/// </summary>
public sealed class ApplyInterruptedException : OperationCanceledException
{
    public ApplyInterruptedException(CancellationToken token) : base(token) { }
}

/// <summary>
/// A minimal bearer-token client for one VMS server.
///
/// Deliberately small: one token, no retry logic. The point is to show the
/// calls, not to be a library.
/// </summary>
public sealed class NxServerClient
{
    public const string Api = "/rest/v4";

    public const string OutcomeUnknownMessage =
        "Outcome unknown: the connection was lost after the settings were sent. "
        + "Download the device's settings to check.";

    // deviceId and engineId are read-only in the response and are not even in
    // the spec's PUT request body schema: the URL identifies the device and
    // engine, not the body. _error is the source device's error map from the
    // last settings operation; sending it back would only echo old errors.
    private static readonly HashSet<string> DroppedSettingsFields = new() { "deviceId", "engineId", "_error" };

    private readonly HttpClient _http;
    private readonly string _host;

    public string? Token { get; private set; }

    public NxServerClient(HttpClient http, string host)
    {
        _http = http;
        _host = host.TrimEnd('/');
    }

    /// <summary>POST login/sessions -> bearer token, stored on this client.</summary>
    public async Task<string> LoginAsync(
        string username, string password, CancellationToken cancellationToken = default)
    {
        string url = $"{_host}{Api}/login/sessions";
        var body = new Dictionary<string, string> { ["username"] = username, ["password"] = password };
        using var content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

        using HttpResponseMessage response = await _http.PostAsync(url, content, cancellationToken);

        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new AuthException(
                $"Login unauthorized (HTTP {(int)response.StatusCode}). Check the password, and note "
                + "that a cloud account cannot log in here. It needs the OAuth2 flow.");
        }
        if (!response.IsSuccessStatusCode)
        {
            throw new ApiException($"Login failed: {DescribeStatus(response)}.");
        }

        string json = await response.Content.ReadAsStringAsync(cancellationToken);
        string? token = ExtractToken(json);
        if (string.IsNullOrEmpty(token))
        {
            throw new ApiException("Login failed: the response did not contain a token.");
        }

        Token = token;
        return token;
    }

    private string SettingsUrl(string engineId, string deviceId)
        => $"{_host}{Api}/analytics/engines/{Uri.EscapeDataString(engineId)}/deviceAgents/{Uri.EscapeDataString(deviceId)}/settings";

    /// <summary>
    /// GET a Device Agent's settings -> the bare settings object.
    ///
    /// Your account needs Power User (or better) on this site.
    /// </summary>
    public async Task<JsonObject> DownloadSettingsAsync(
        string engineId, string deviceId, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(Token)) throw new ApiException("Not logged in. Call LoginAsync() first.");

        using var request = new HttpRequestMessage(HttpMethod.Get, SettingsUrl(engineId, deviceId));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        using HttpResponseMessage response = await _http.SendAsync(request, cancellationToken);

        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new AuthException(
                $"Reading settings was refused (HTTP {(int)response.StatusCode}). This endpoint needs "
                + "Power User or better.");
        }
        if (!response.IsSuccessStatusCode)
        {
            throw new ApiException($"Reading settings failed: {DescribeStatus(response)}.");
        }

        string json = await response.Content.ReadAsStringAsync(cancellationToken);
        const string notAnObject = "Reading settings failed: the server did not return a JSON object.";
        if (TryParseJson(json) is JsonObject obj) return UnwrapReply(obj);
        throw new ApiException(notAnObject);
    }

    /// <summary>
    /// PUT a Device Agent's settings. body should come from BuildApplyBody().
    ///
    /// Returns normally only when the settings were applied: a 2xx with an empty
    /// body, a JSON body without errors, or a body that is not JSON. A 2xx whose
    /// body has a non-empty <c>_error</c> map throws EngineErrorsException. A
    /// connection that could not be made rethrows the HttpRequestException (the
    /// settings were not sent); a connection lost after sending throws
    /// ApiException(OutcomeUnknownMessage).
    /// </summary>
    public async Task ApplySettingsAsync(
        string engineId, string deviceId, JsonObject body, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(Token)) throw new ApiException("Not logged in. Call LoginAsync() first.");

        using var request = new HttpRequestMessage(HttpMethod.Put, SettingsUrl(engineId, deviceId));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");

        HttpResponseMessage response;
        string responseBody;
        try
        {
            response = await _http.SendAsync(request, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw new ApplyInterruptedException(cancellationToken);
        }
        catch (HttpRequestException ex) when (!NeverConnected(ex))
        {
            throw new ApiException(OutcomeUnknownMessage);
        }
        catch (Exception ex) when (ex is IOException && !cancellationToken.IsCancellationRequested)
        {
            throw new ApiException(OutcomeUnknownMessage);
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // HttpClient's own timeout, after connecting (a connect that timed out
            // is an HttpRequestException): the request may well have arrived.
            throw new ApiException(OutcomeUnknownMessage);
        }

        using (response)
        {
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            {
                throw new AuthException(
                    $"Applying settings was refused (HTTP {(int)response.StatusCode}). This endpoint needs "
                    + "Power User or better.");
            }
            if (!response.IsSuccessStatusCode)
            {
                throw new ApiException(DescribeApplyFailure(response));
            }

            try
            {
                responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException
                                       && !cancellationToken.IsCancellationRequested)
            {
                // The status said 2xx, but the body that would carry _error was cut off.
                throw new ApiException(OutcomeUnknownMessage);
            }
            catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new ApiException(OutcomeUnknownMessage);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw new ApplyInterruptedException(cancellationToken);
            }
        }

        IReadOnlyList<KeyValuePair<string, string>> errors = ExtractEngineErrors(responseBody);
        if (errors.Count > 0) throw new EngineErrorsException(errors);
    }

    /// <summary>
    /// The non-empty <c>_error</c> map of a PUT response, as name/message pairs.
    /// An empty, non-JSON or error-free body gives an empty list.
    /// </summary>
    public static IReadOnlyList<KeyValuePair<string, string>> ExtractEngineErrors(string responseBody)
    {
        var errors = new List<KeyValuePair<string, string>>();
        if (string.IsNullOrWhiteSpace(responseBody)) return errors;
        if (TryParseJson(responseBody) is not JsonObject obj) return errors;
        obj = UnwrapReply(obj);
        if (obj["_error"] is not JsonObject errorMap) return errors;
        foreach (KeyValuePair<string, JsonNode?> pair in errorMap)
        {
            string message = pair.Value is JsonValue v && v.TryGetValue(out string? text)
                ? text
                : pair.Value?.ToJsonString() ?? "null";
            errors.Add(new KeyValuePair<string, string>(pair.Key, message));
        }
        return errors;
    }

    /// <summary>DELETE the session so the token is not left valid. Safe to call twice.</summary>
    public async Task LogoutAsync(CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(Token)) return;
        string token = Token;
        Token = null;

        using var request = new HttpRequestMessage(HttpMethod.Delete, $"{_host}{Api}/login/sessions/{token}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using HttpResponseMessage response = await _http.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new ApiException($"Logout failed: {DescribeStatus(response)}.");
        }
    }

    // -------------------------------------------------------------------
    // Parsing helpers (pure = easy to test)
    // -------------------------------------------------------------------

    /// <summary>
    /// True when the request certainly never reached the server: DNS, a refused
    /// or timed-out connect (see Program.ConnectWithTimeout), a failed TLS handshake.
    /// </summary>
    public static bool NeverConnected(HttpRequestException ex)
        => ex.HttpRequestError is HttpRequestError.NameResolutionError
               or HttpRequestError.ConnectionError
               or HttpRequestError.SecureConnectionError
           || ex.InnerException is SocketException or AuthenticationException;

    private static string DescribeStatus(HttpResponseMessage response)
    {
        int code = (int)response.StatusCode;
        return code is >= 300 and < 400 ? $"HTTP {code} (redirect not followed)" : $"HTTP {code}";
    }

    /// <summary>
    /// The message for a non-2xx, non-auth answer to the PUT. A 3xx never reached
    /// the handler and a 4xx was rejected, so neither applied anything; a 5xx may
    /// have failed part-way through.
    /// </summary>
    private static string DescribeApplyFailure(HttpResponseMessage response)
    {
        int code = (int)response.StatusCode;
        string failed = $"Applying settings failed: {DescribeStatus(response)}.";
        if (code is >= 300 and < 400) return $"{failed} The settings were not applied.";
        if (code is >= 400 and < 500)
        {
            return $"{failed} The settings were not applied. The target device may not be running this Engine.";
        }
        return $"{failed} The server may have applied some of them; download the device's settings to check.";
    }

    /// <summary>
    /// Some Nx versions wrap a single-object reply in {"reply": {...}}, the same
    /// way list endpoints wrap an array. Returns the inner object, detached so it
    /// can be reused; anything else (no "reply", or a non-object one) is
    /// returned as-is.
    /// </summary>
    private static JsonObject UnwrapReply(JsonObject obj)
    {
        if (obj["reply"] is not JsonObject reply) return obj;
        obj.Remove("reply");
        return reply;
    }

    private static JsonNode? TryParseJson(string json)
    {
        try
        {
            return JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static string? ExtractToken(string json)
    {
        JsonNode? node;
        try
        {
            node = JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            throw new ApiException("Login failed: the response was not valid JSON.");
        }
        if (node is JsonObject obj
            && obj.TryGetPropertyValue("token", out JsonNode? tokenNode)
            && tokenNode is JsonValue tokenValue
            && tokenValue.TryGetValue(out string? token))
        {
            return token;
        }
        return null;
    }

    // -------------------------------------------------------------------
    // Settings file <-> PUT body
    // -------------------------------------------------------------------

    /// <summary>
    /// Drop deviceId and engineId (the URL identifies them) and _error (the
    /// source's error map must not be echoed back); forward the rest of the
    /// downloaded settings unchanged (values, model, analyzedStream,
    /// disableStreamSelection).
    ///
    /// A field absent from <paramref name="settings"/> (a hand-edited or partial
    /// file) stays absent from the body rather than being sent as null, so it is
    /// not mistaken for "clear this setting".
    /// </summary>
    public static JsonObject BuildApplyBody(JsonObject settings)
    {
        var body = new JsonObject();
        foreach (KeyValuePair<string, JsonNode?> pair in settings)
        {
            if (DroppedSettingsFields.Contains(pair.Key)) continue;
            body[pair.Key] = pair.Value?.DeepClone();
        }
        return body;
    }

    /// <summary>
    /// Read a settings file for apply. Throws ApiException when it is not valid
    /// JSON or its top level is not a JSON object.
    /// </summary>
    public static JsonObject LoadSettingsFile(string path)
    {
        string text = File.ReadAllText(path);
        JsonNode? node;
        try
        {
            node = JsonNode.Parse(text);
        }
        catch (JsonException ex)
        {
            throw new ApiException($"{path} is not valid JSON: {ex.Message.TrimEnd('.')}.");
        }
        return node as JsonObject ?? throw new ApiException($"{path} does not hold a JSON object.");
    }

    /// <summary>
    /// Build a filename that says which device the settings came from, and when.
    ///
    /// The timestamp is UTC so that downloads taken in different time zones
    /// still sort into the order they were taken.
    /// </summary>
    public static string DefaultOutputName(string deviceId, DateTime? now = null)
    {
        DateTime moment = now ?? DateTime.UtcNow;
        string timestamp = moment.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture);
        return $"nx-device-agent-settings-{deviceId}-{timestamp}.json";
    }

    /// <summary>
    /// Write the downloaded settings object as pretty-printed JSON, keys sorted.
    ///
    /// The JSON goes to a side file <c>&lt;path&gt;.&lt;random&gt;.partial</c>,
    /// created exclusively and owner-only, then moved into place. Without
    /// <paramref name="overwrite"/> the move refuses a destination that appeared
    /// meanwhile, so nothing is ever clobbered; with it the replace is atomic.
    /// The side file never outlives a failure.
    /// </summary>
    public static void SaveSettingsFile(string path, JsonObject settings, bool overwrite = false)
    {
        JsonNode sorted = SortKeysDeep(settings) ?? new JsonObject();
        var options = new JsonSerializerOptions { WriteIndented = true };
        byte[] bytes = Encoding.UTF8.GetBytes(sorted.ToJsonString(options) + "\n");

        string partial = $"{path}.{Guid.NewGuid():N}.partial";
        try
        {
            using (FileStream file = CreatePrivate(partial))
            {
                file.Write(bytes);
            }
            try
            {
                File.Move(partial, path, overwrite);
            }
            catch (IOException) when (!overwrite && LocalPath.Exists(path))
            {
                throw new ApiException($"{path} already exists; use --force");
            }
        }
        catch
        {
            // Never let a failed cleanup hide the error that got us here.
            try
            {
                File.Delete(partial);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
            }
            throw;
        }
    }

    /// <summary>Create <paramref name="path"/> for writing, new, readable by the owner only.</summary>
    private static FileStream CreatePrivate(string path)
    {
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }
        return new FileStream(path, options);
    }

    private static JsonNode? SortKeysDeep(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject obj:
                var sortedObj = new JsonObject();
                foreach (string key in obj.Select(pair => pair.Key).OrderBy(k => k, StringComparer.Ordinal))
                {
                    sortedObj[key] = SortKeysDeep(obj[key]);
                }
                return sortedObj;
            case JsonArray arr:
                var sortedArr = new JsonArray();
                foreach (JsonNode? item in arr)
                {
                    sortedArr.Add(SortKeysDeep(item));
                }
                return sortedArr;
            default:
                return node?.DeepClone();
        }
    }
}
