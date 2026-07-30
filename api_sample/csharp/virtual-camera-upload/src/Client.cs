// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Create a VIRTUAL camera on an Nx VMS server and UPLOAD a local video file into
// its archive as recorded footage. A virtual camera has no real RTSP source; you
// push it pre-recorded media and the server ingests it as if it had been captured
// at the given time.
//
// C# port of ../../python/virtual-camera-upload on the latest /rest/v4 API. Uses
// the built-in HttpClient + System.Text.Json — no third-party packages. The file
// is read in chunks, so a large clip is never slurped into memory all at once.
//
// Auth is DIRECT to ONE server with a LOCAL server account, exactly like
// ../rest-list-cameras: NX_SERVER_HOST / NX_SERVER_USER / NX_SERVER_PASSWORD.
//
// THE VIRTUAL-CAMERA UPLOAD FLOW:
//
//   1. Log in:    POST   {host}/rest/v4/login/sessions  { username, password, setCookie:false }
//                   -> { "token": ... }
//   2. Create:    POST   {host}/rest/v4/devices/*/virtual  { "name": ... }
//                   -> the new device (read its "id")          [skip with --device-id]
//   3. Lock:      PATCH  {host}/rest/v4/devices/{id}/virtual/lock  { "ttlMs": ... }
//                   -> token at lockInfo.token ({id, lockInfo:{token, ...}})
//   4. Create upload: POST {host}/rest/v4/devices/{id}/virtual/uploads
//                   { "items": [{filename, sizeB, md5, startTimeMs, chunkSizeB}] }
//                   -> per-item info incl. the chunkSizeB the server wants
//                   (startTimeMs is declared HERE, not at a consume step)
//   5. Upload bytes:  PUT  {host}/rest/v4/devices/{id}/virtual/uploads/{uploadId}?chunk=<n>
//                   raw chunk bytes, Content-Type: application/octet-stream
//   6. Status:    GET    {host}/rest/v4/devices/{id}/virtual/uploads/{uploadId}
//                   -> the import auto-starts once all chunks arrive; this reports it
//                   (PATCH .../virtual/consume is DEPRECATED -- not used)
//   7. Release:   PATCH  {host}/rest/v4/devices/{id}/virtual/release  { "token": <lock> }
//                   (always run, even on error, so the lock is freed)
//   + Log out:    DELETE {host}/rest/v4/login/sessions/<token>
//
// The `/*/` in step 2 is the current-server wildcard -- it is part of the path,
// not a placeholder. The uploadId used in steps 5/6 is the server-returned
// uploadId, or the file's name if none is echoed.

using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace NxVirtualCameraUpload;

public sealed class AuthException : Exception
{
    public AuthException(string message) : base(message) { }
}

public sealed class ApiException : Exception
{
    public ApiException(string message) : base(message) { }
}

/// <summary>One zero-based piece of the file: (Index, Offset, Length).</summary>
public readonly record struct ChunkSpec(int Index, long Offset, int Length);

/// <summary>What create-upload resolved to: the id to PUT against and the chunk size to use.</summary>
public readonly record struct UploadInfo(string UploadId, int ChunkSizeB);

/// <summary>Summary of a completed upload run.</summary>
public sealed record UploadResult(
    string DeviceId,
    string UploadId,
    int ChunkCount,
    int ChunkSizeB,
    long SizeB,
    long StartTimeMs,
    string? Status);

public sealed class NxVirtualCameraClient
{
    public const string Api = "/rest/v4";

    private readonly HttpClient _http;
    private readonly string _host;

    public string? Token { get; private set; }

    public NxVirtualCameraClient(HttpClient http, string host)
    {
        _http = http;
        _host = host.TrimEnd('/');
    }

    /// <summary>Use a bearer token obtained elsewhere (skip login).</summary>
    public void UseToken(string token) => Token = token;

    // -- 1. login / logout ---------------------------------------------------

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
            string json = await CheckAsync(response, "Login", cancellationToken);
            Token = ExtractToken(json);
            return Token;
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

    // -- 2. create virtual device -------------------------------------------

    /// <summary>POST {host}/rest/v4/devices/*/virtual {"name": ...} -> device id.
    /// The `*` is the current-server wildcard; it is part of the path.</summary>
    public async Task<string> CreateVirtualDeviceAsync(string name, CancellationToken cancellationToken = default)
    {
        string url = $"{_host}{Api}/devices/*/virtual";
        var body = new Dictionary<string, object> { ["name"] = name };
        string json = await PostJsonAsync(url, body, "Create virtual device", cancellationToken);
        return ParseDeviceId(json);
    }

    // -- 3. lock -------------------------------------------------------------

    /// <summary>PATCH .../virtual/lock {"ttlMs": ...} -> the lock token.</summary>
    public async Task<string> LockDeviceAsync(string deviceId, long ttlMs, CancellationToken cancellationToken = default)
    {
        string url = $"{_host}{Api}/devices/{deviceId}/virtual/lock";
        var body = new Dictionary<string, object> { ["ttlMs"] = ttlMs };
        string json = await PatchJsonAsync(url, body, "Lock virtual device", cancellationToken);
        return ParseLockToken(json);
    }

    // -- 4. create upload ----------------------------------------------------

    /// <summary>POST .../virtual/uploads -> (uploadId, server chunk size in bytes).</summary>
    public async Task<UploadInfo> CreateUploadAsync(
        string deviceId, string filename, long sizeB, string md5Base64,
        long startTimeMs, int requestedChunkSize, long? durationMs = null,
        CancellationToken cancellationToken = default)
    {
        string url = $"{_host}{Api}/devices/{deviceId}/virtual/uploads";
        object body = BuildItemsPayload(filename, sizeB, md5Base64, startTimeMs, requestedChunkSize, durationMs);
        string json = await PostJsonAsync(url, body, "Create upload", cancellationToken);
        return ParseUploadItem(json, requestedChunkSize, filename);
    }

    // -- 5. upload one chunk -------------------------------------------------

    /// <summary>PUT raw chunk bytes at ?chunk=&lt;index&gt; with octet-stream content type.</summary>
    public async Task UploadChunkAsync(
        string deviceId, string uploadId, int index, byte[] dataBytes,
        CancellationToken cancellationToken = default)
    {
        string url = $"{_host}{Api}/devices/{deviceId}/virtual/uploads/"
            + $"{Uri.EscapeDataString(uploadId)}?chunk={index}";

        using var request = new HttpRequestMessage(HttpMethod.Put, url);
        AddAuth(request);
        // A fresh ByteArrayContent per chunk so the octet-stream content type is set each time.
        var content = new ByteArrayContent(dataBytes);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        request.Content = content;

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
                throw new AuthException($"Chunk upload unauthorized (HTTP {(int)response.StatusCode}).");
            }
            if (!response.IsSuccessStatusCode)
            {
                string text = await SafeReadAsync(response);
                throw new ApiException(
                    $"Chunk {index} upload failed: HTTP {(int)response.StatusCode} {Truncate(text, 200)}");
            }
        }
    }

    // -- 6. upload status ----------------------------------------------------

    /// <summary>GET .../virtual/uploads/{uploadId} -> the upload/consume status.
    ///
    /// There is NO separate consume call: PATCH .../virtual/consume is deprecated.
    /// Completing the chunk PUTs to .../virtual/uploads/{uploadId} starts the import
    /// automatically (using the startTimeMs given at create). This GET reports progress.</summary>
    public async Task<string> UploadStatusAsync(
        string deviceId, string uploadId, CancellationToken cancellationToken = default)
    {
        string url = $"{_host}{Api}/devices/{deviceId}/virtual/uploads/"
            + Uri.EscapeDataString(uploadId);

        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        AddAuth(request);

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
                throw new AuthException($"Upload status unauthorized (HTTP {(int)response.StatusCode}).");
            }
            if (!response.IsSuccessStatusCode)
            {
                string text = await SafeReadAsync(response);
                throw new ApiException(
                    $"Upload status failed: HTTP {(int)response.StatusCode} {Truncate(text, 200)}");
            }
            return await response.Content.ReadAsStringAsync(cancellationToken);
        }
    }

    // -- 7. release ----------------------------------------------------------

    /// <summary>PATCH .../virtual/release {"token": ...} -> free the lock.</summary>
    public async Task ReleaseAsync(
        string deviceId, string lockToken, CancellationToken cancellationToken = default)
    {
        string url = $"{_host}{Api}/devices/{deviceId}/virtual/release";
        var body = new Dictionary<string, object> { ["token"] = lockToken };
        await PatchJsonAsync(url, body, "Release lock", cancellationToken);
    }

    // -----------------------------------------------------------------------
    // Shared HTTP helpers
    // -----------------------------------------------------------------------

    private void AddAuth(HttpRequestMessage request)
    {
        if (string.IsNullOrEmpty(Token))
        {
            throw new ApiException("Not logged in. Call LoginAsync() or UseToken() first.");
        }
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
    }

    private async Task<string> PostJsonAsync(
        string url, object body, string what, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        AddAuth(request);
        request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        return await SendAndCheckAsync(request, url, what, cancellationToken);
    }

    private async Task<string> PatchJsonAsync(
        string url, object body, string what, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Patch, url);
        AddAuth(request);
        request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        return await SendAndCheckAsync(request, url, what, cancellationToken);
    }

    private async Task<string> SendAndCheckAsync(
        HttpRequestMessage request, string url, string what, CancellationToken cancellationToken)
    {
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
            return await CheckAsync(response, what, cancellationToken);
        }
    }

    /// <summary>Shared response validation -> typed errors + raw body text.</summary>
    private static async Task<string> CheckAsync(
        HttpResponseMessage response, string what, CancellationToken cancellationToken)
    {
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new AuthException(
                $"{what} unauthorized (HTTP {(int)response.StatusCode}). Check the "
                + "username/password, and that you are using a local (not cloud) user.");
        }
        if (!response.IsSuccessStatusCode)
        {
            string text = await SafeReadAsync(response);
            throw new ApiException(
                $"{what} failed: HTTP {(int)response.StatusCode} {Truncate(text, 200)}");
        }
        return await response.Content.ReadAsStringAsync(cancellationToken);
    }

    private static async Task<string> SafeReadAsync(HttpResponseMessage response)
    {
        try { return await response.Content.ReadAsStringAsync(); }
        catch { return string.Empty; }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];

    // -----------------------------------------------------------------------
    // Pure helpers (no I/O over the network = easy to test)
    // -----------------------------------------------------------------------

    public const long DefaultTtlSeconds = 300;
    public const int DefaultChunkSize = 1024 * 1024; // 1 MiB

    /// <summary>Turn the --start-time value into epoch milliseconds.
    ///
    /// Accepts an ISO 8601 string (2026-06-15T12:00:00Z) or a raw epoch-ms number.
    /// Empty/blank/null -> "now". Naive times are treated as UTC.</summary>
    public static long ParseStartTimeMs(string? value, DateTimeOffset? now = null)
    {
        string text = (value ?? string.Empty).Trim();
        if (text.Length == 0)
        {
            DateTimeOffset when = now ?? DateTimeOffset.UtcNow;
            return when.ToUnixTimeMilliseconds();
        }
        if (IsAllDigits(text))
        {
            if (long.TryParse(text, out long epoch))
            {
                return epoch; // already epoch ms
            }
            throw new ApiException(
                $"Could not parse --start-time \"{text}\". Use ISO time or epoch ms.");
        }
        // Treat a naive time as UTC: AssumeUniversal applies when there is no offset.
        if (DateTimeOffset.TryParse(
                text, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AssumeUniversal
                    | System.Globalization.DateTimeStyles.AdjustToUniversal,
                out DateTimeOffset parsed))
        {
            return parsed.ToUnixTimeMilliseconds();
        }
        throw new ApiException(
            $"Could not parse --start-time \"{text}\". Use ISO time or epoch ms.");
    }

    private static bool IsAllDigits(string text)
    {
        if (text.Length == 0) return false;
        foreach (char c in text)
        {
            if (c < '0' || c > '9') return false;
        }
        return true;
    }

    /// <summary>Base64-encoded MD5 of the full file content (what the API expects).</summary>
    public static string FileMd5Base64(string path)
    {
        using var stream = File.OpenRead(path);
        using var md5 = MD5.Create();
        byte[] hash = md5.ComputeHash(stream);
        return Convert.ToBase64String(hash);
    }

    /// <summary>Base64-encoded MD5 of the given bytes (testable without a file).</summary>
    public static string Md5Base64(byte[] data)
    {
        byte[] hash = MD5.HashData(data);
        return Convert.ToBase64String(hash);
    }

    /// <summary>Plan how a file of `totalSize` bytes splits into `chunkSize` pieces.
    ///
    /// Returns a list of (index, offset, length) specs, zero-based, with the last
    /// piece holding the remainder. A zero-byte file yields a single empty chunk so
    /// the server still sees one PUT.</summary>
    public static IReadOnlyList<ChunkSpec> ChunkPlan(long totalSize, int chunkSize)
    {
        if (chunkSize <= 0)
        {
            throw new ApiException("--chunk-size must be a positive number of bytes.");
        }
        if (totalSize <= 0)
        {
            return new[] { new ChunkSpec(0, 0, 0) };
        }
        var plan = new List<ChunkSpec>();
        int index = 0;
        long offset = 0;
        while (offset < totalSize)
        {
            int length = (int)Math.Min(chunkSize, totalSize - offset);
            plan.Add(new ChunkSpec(index, offset, length));
            index += 1;
            offset += length;
        }
        return plan;
    }

    /// <summary>Read each chunk of the file lazily, calling the action with (index, bytes).</summary>
    public static IEnumerable<(int Index, byte[] Data)> IterFileChunks(string path, int chunkSize)
    {
        long totalSize = new FileInfo(path).Length;
        using var stream = File.OpenRead(path);
        foreach (ChunkSpec spec in ChunkPlan(totalSize, chunkSize))
        {
            stream.Seek(spec.Offset, SeekOrigin.Begin);
            var buffer = new byte[spec.Length];
            int read = 0;
            while (read < spec.Length)
            {
                int n = stream.Read(buffer, read, spec.Length - read);
                if (n == 0) break;
                read += n;
            }
            yield return (spec.Index, buffer);
        }
    }

    /// <summary>Build the { "items": [...] } body for the create-upload request.
    ///
    /// startTimeMs is declared HERE (at create-upload), not at a separate consume
    /// step: the modern v4 flow drops the deprecated `.../virtual/consume` call and
    /// starts the import automatically once all chunks reach `.../virtual/uploads/
    /// {uploadId}`.
    ///
    /// durationMs is OPTIONAL: when known, the server uses it to reserve the
    /// archive period; when omitted, the server tries to derive the duration from
    /// the video file's own metadata. If that metadata is missing or unreadable
    /// and no durationMs was sent, the archive period comes back as zero and the
    /// footage will not appear on the timeline, so pass --duration-ms if you know
    /// the clip length.</summary>
    public static object BuildItemsPayload(
        string filename, long sizeB, string md5Base64, long startTimeMs, int chunkSizeB,
        long? durationMs = null)
    {
        var item = new Dictionary<string, object>
        {
            ["filename"] = filename,
            ["sizeB"] = sizeB,
            ["md5"] = md5Base64,
            ["startTimeMs"] = startTimeMs,
            ["chunkSizeB"] = chunkSizeB,
        };
        if (durationMs is long ms && ms > 0)
        {
            item["durationMs"] = ms;
        }
        return new Dictionary<string, object>
        {
            ["items"] = new object[] { item },
        };
    }

    /// <summary>Some Nx versions wrap a reply in { "reply": ... }. Unwrap defensively.</summary>
    private static JsonElement Unwrap(JsonElement data)
    {
        if (data.ValueKind == JsonValueKind.Object
            && data.TryGetProperty("reply", out JsonElement reply))
        {
            return reply;
        }
        return data;
    }

    private static JsonElement ParseRoot(string json, string what)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            // Clone so the element survives the disposal of the JsonDocument.
            return doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            throw new ApiException($"{what} response was not valid JSON.");
        }
    }

    /// <summary>Pull the bearer token from a login response: { "token": ... }.</summary>
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

    /// <summary>Pull the new device id from a create-virtual response, defensively.
    ///
    /// The reply may be a bare object, a { "reply": ... } envelope, or a single-item
    /// list. Returns the "id" field.</summary>
    public static string ParseDeviceId(string json)
    {
        JsonElement data = Unwrap(ParseRoot(json, "Create-virtual"));
        if (data.ValueKind == JsonValueKind.Array)
        {
            data = data.GetArrayLength() > 0 ? data[0] : default;
        }
        if (data.ValueKind == JsonValueKind.Object
            && data.TryGetProperty("id", out JsonElement idEl))
        {
            string? id = idEl.ValueKind == JsonValueKind.String ? idEl.GetString() : idEl.ToString();
            if (!string.IsNullOrEmpty(id))
            {
                return id;
            }
        }
        throw new ApiException("Create-virtual response did not contain a device id.");
    }

    /// <summary>Pull the lock token from a lock response, defensively.
    ///
    /// The v4 lock reply is shaped { "id": ..., "lockInfo": { "token": ..., ... } },
    /// so the token lives under "lockInfo". Older/edge shapes may put it at the top
    /// level, so we check both.</summary>
    public static string ParseLockToken(string json)
    {
        JsonElement data = Unwrap(ParseRoot(json, "Lock"));
        if (data.ValueKind == JsonValueKind.Object)
        {
            if (data.TryGetProperty("lockInfo", out JsonElement lockInfo)
                && lockInfo.ValueKind == JsonValueKind.Object
                && lockInfo.TryGetProperty("token", out JsonElement nested))
            {
                string? token = nested.ValueKind == JsonValueKind.String ? nested.GetString() : nested.ToString();
                if (!string.IsNullOrEmpty(token)) return token;
            }
            if (data.TryGetProperty("token", out JsonElement top))
            {
                string? token = top.ValueKind == JsonValueKind.String ? top.GetString() : top.ToString();
                if (!string.IsNullOrEmpty(token)) return token;
            }
        }
        throw new ApiException("Lock response did not contain a token.");
    }

    /// <summary>Read the create-upload reply -> (uploadId, chunkSizeB), defensively.
    ///
    /// Uses the server's returned chunkSizeB when present, else the requested size.
    /// Uses the server's returned uploadId when present, else the filename.</summary>
    public static UploadInfo ParseUploadItem(string json, int requestedChunkSize, string fallbackUploadId)
    {
        JsonElement data = Unwrap(ParseRoot(json, "Create-upload"));

        JsonElement item = default;
        bool haveItem = false;
        if (data.ValueKind == JsonValueKind.Object
            && data.TryGetProperty("items", out JsonElement items)
            && items.ValueKind == JsonValueKind.Array)
        {
            if (items.GetArrayLength() > 0) { item = items[0]; haveItem = true; }
        }
        else if (data.ValueKind == JsonValueKind.Array)
        {
            if (data.GetArrayLength() > 0) { item = data[0]; haveItem = true; }
        }
        else if (data.ValueKind == JsonValueKind.Object)
        {
            item = data;
            haveItem = true;
        }

        string uploadId = fallbackUploadId;
        int chunkSizeB = requestedChunkSize;

        if (haveItem && item.ValueKind == JsonValueKind.Object)
        {
            if (item.TryGetProperty("uploadId", out JsonElement uidEl))
            {
                string? uid = uidEl.ValueKind == JsonValueKind.String ? uidEl.GetString() : uidEl.ToString();
                if (!string.IsNullOrEmpty(uid)) uploadId = uid;
            }
            if (item.TryGetProperty("chunkSizeB", out JsonElement csEl))
            {
                int parsed = TryReadInt(csEl, requestedChunkSize);
                chunkSizeB = parsed > 0 ? parsed : requestedChunkSize;
            }
        }

        if (chunkSizeB <= 0) chunkSizeB = requestedChunkSize;
        return new UploadInfo(uploadId, chunkSizeB);
    }

    private static int TryReadInt(JsonElement el, int fallback)
    {
        if (el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out int n))
        {
            return n;
        }
        if (el.ValueKind == JsonValueKind.String && int.TryParse(el.GetString(), out int s))
        {
            return s;
        }
        return fallback;
    }
}
