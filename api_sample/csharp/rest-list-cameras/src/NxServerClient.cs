// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Log in to ONE Nx VMS server/site and list its cameras (C#).
//
// C# port of ../../python/rest-list-cameras and ../../node/rest-list-cameras, on
// the latest /rest/v4 API. Uses the built-in HttpClient + System.Text.Json — no
// third-party packages.
//
// This talks DIRECTLY to a single VMS server/site (not via the cloud). It is the
// step that actually lists cameras, which the Cloud CDB cannot do. The flow
// follows Network Optix's recommended bearer-token authentication:
//
//   1. Log in:   POST   /rest/v4/login/sessions  { username, password, setCookie:false }
//                -> { "token": ... }
//   2. List:     GET    /rest/v4/devices          (Authorization: Bearer <token>)
//   3. Log out:  DELETE /rest/v4/login/sessions/<token>   (release the session)
//
// "Devices" are the cameras (and other media devices) attached to the site.
//
// Connecting: the host is the server, e.g. https://192.168.1.10:7001 (note the
// https + port), or a cloud relay address like https://<siteId>.relay.vmsproxy.com.
// Local servers usually present a self-signed certificate, so for a lab server you
// will typically need --insecure.

using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace NxListCameras;

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

public sealed class NxServerClient
{
    public const string Api = "/rest/v4";

    private readonly HttpClient _http;
    private readonly string _host;

    public string? Token { get; private set; }

    public NxServerClient(HttpClient http, string host)
    {
        _http = http;
        _host = host.TrimEnd('/');
    }

    public async Task<string> LoginAsync(
        string user, string password, CancellationToken cancellationToken = default)
    {
        string url = $"{_host}{Api}/login/sessions";
        var body = new Dictionary<string, object>
        {
            ["username"] = user,
            ["password"] = password,
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
                    $"Login unauthorized (HTTP {(int)response.StatusCode}). Check the "
                    + "username/password, and that you are using a local (not cloud) user.");
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

    /// <summary>Use a bearer token obtained elsewhere (skip login).</summary>
    public void UseToken(string token) => Token = token;

    public async Task<IReadOnlyList<Camera>> ListCamerasAsync(CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(Token))
        {
            throw new ApiException("Not logged in. Call LoginAsync() or UseToken() first.");
        }

        string url = $"{_host}{Api}/devices";
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
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            {
                throw new AuthException(
                    $"Listing devices unauthorized (HTTP {(int)response.StatusCode}). Check the "
                    + "username/password, and that you are using a local (not cloud) user.");
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
    }

    /// <summary>DELETE the session so the token cannot be reused. Best-effort.</summary>
    public async Task LogoutAsync(CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(Token)) return;
        string url = $"{_host}{Api}/login/sessions/{Token}";
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Delete, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
            using HttpResponseMessage _ = await _http.SendAsync(request, cancellationToken);
        }
        catch
        {
            // Logout is cleanup; never let it crash the program.
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
