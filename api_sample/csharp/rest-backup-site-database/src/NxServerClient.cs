// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Nx VMS REST Server API sample: back up and restore the Site database (C#).
//
// C# port of ../../python/rest-backup-site-database, on the latest /rest/v4 API.
// Uses the built-in HttpClient, no third-party packages.
//
// The Site database is shared by every server in the site, so one dump is a
// snapshot of the whole site configuration: servers, cameras, users, groups,
// layouts, rules, licences and storage settings.
//
//   backup
//   1. Log in:    POST   /rest/v4/login/sessions  {username, password, setCookie:false} -> {"token": ...}
//   2. Dump:      GET    /rest/v4/site/database   (Authorization: Bearer <token>)
//   3. Log out:   DELETE /rest/v4/login/sessions/<token>
//
//   restore
//   1. Log in:    POST   /rest/v4/login/sessions
//   2. Load:      POST   /rest/v4/site/database   (Content-Type: application/octet-stream)
//   3. No log out. The server restarts as soon as it accepts the dump, so the
//      session ends with it.
//
// Both database calls want an administrator on a fresh session, which is why this
// sample always logs in immediately before the call and never takes a token you
// already hold.

using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace NxBackupSiteDatabase;

/// <summary>Login was rejected: wrong credentials, or a cloud user on a local login.</summary>
public sealed class AuthException : Exception
{
    public AuthException(string message) : base(message) { }
}

/// <summary>The server answered, but not with what the API contract promises.</summary>
public sealed class ApiException : Exception
{
    public ApiException(string message) : base(message) { }
}

/// <summary>
/// A minimal bearer-token client for one VMS server. Deliberately small: one
/// session, one token, no retry logic. The point is to show the calls, not to
/// be a library.
/// </summary>
public sealed class NxServerClient
{
    // API version path segment. v4 is the latest Nx REST API.
    public const string Api = "/rest/v4";

    // Login is quick. The database calls move tens of megabytes, so they get far
    // longer. Each request carries its own limit, so the HttpClient has none.
    public static readonly TimeSpan LoginTimeout = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan DefaultDatabaseTimeout = TimeSpan.FromSeconds(300);

    // Read the dump in 1 MiB pieces. A site dump runs to tens of megabytes, so it
    // is streamed to disk rather than held in memory.
    public const int ChunkSize = 1024 * 1024;

    private readonly HttpClient _http;
    private readonly string _host;
    private readonly TimeSpan _databaseTimeout;

    public string? Token { get; private set; }

    public NxServerClient(HttpClient http, string host, TimeSpan? databaseTimeout = null)
    {
        _http = http;
        _host = host.TrimEnd('/');
        _databaseTimeout = databaseTimeout ?? DefaultDatabaseTimeout;
    }

    /// <summary>POST login/sessions -> bearer token, stored on this client.</summary>
    public async Task<string> LoginAsync(
        string user, string password, CancellationToken cancellationToken = default)
    {
        var body = new Dictionary<string, object>
        {
            ["username"] = user,
            ["password"] = password,
            ["setCookie"] = false,
        };
        using var content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(LoginTimeout);

        using HttpResponseMessage response = await _http.PostAsync(
            $"{_host}{Api}/login/sessions", content, timeout.Token);

        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new AuthException(
                $"Login unauthorized (HTTP {(int)response.StatusCode}). Check the password, and "
                + "note that a cloud account cannot log in here. It needs the OAuth2 flow.");
        }
        if (!response.IsSuccessStatusCode)
        {
            throw new ApiException($"Login failed (HTTP {(int)response.StatusCode}).");
        }

        Token = ExtractToken(await response.Content.ReadAsStringAsync(timeout.Token));
        return Token;
    }

    /// <summary>
    /// GET site/database -> the binary dump, written to destination ("-" means the
    /// given stdout stream). Returns the number of bytes written.
    /// </summary>
    /// <remarks>
    /// An existing destination is replaced only when <paramref name="overwrite"/>
    /// is set; the check is made when the finished dump is moved into place, so a
    /// file that appears during the download is not clobbered either.
    /// </remarks>
    public async Task<long> BackupAsync(
        string destination, Stream? stdout = null, bool overwrite = false,
        CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"{_host}{Api}/site/database");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        // The limit is on silence, not on the whole transfer: it is re-armed before
        // every read, the way the Python version's per-read timeout works. A large
        // dump on a slow link takes as long as it needs; a server that stops
        // sending is still noticed.
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(_databaseTimeout);
        try
        {
            return await BackupCoreAsync(request, destination, stdout, overwrite, timeout);
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested
                                                  && !cancellationToken.IsCancellationRequested)
        {
            throw new ApiException(
                $"The server stopped sending the dump: nothing arrived for {_databaseTimeout.TotalSeconds:0.###} s.");
        }
    }

    private async Task<long> BackupCoreAsync(
        HttpRequestMessage request, string destination, Stream? stdout, bool overwrite,
        CancellationTokenSource timeout)
    {
        // ResponseHeadersRead returns as soon as the headers arrive, leaving the
        // body on the wire to be streamed. The default would buffer the whole dump
        // in memory first.
        using HttpResponseMessage response = await _http.SendAsync(
            request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new AuthException(
                $"The site refused the dump (HTTP {(int)response.StatusCode}). This endpoint "
                + "needs an administrator on a fresh session.");
        }
        if (!response.IsSuccessStatusCode)
        {
            throw new ApiException($"The dump request failed (HTTP {(int)response.StatusCode}).");
        }

        await using Stream body = await response.Content.ReadAsStreamAsync(timeout.Token);
        long written;
        if (destination == "-")
        {
            written = await StreamToAsync(body, stdout ?? Console.OpenStandardOutput(), timeout);
        }
        else
        {
            // Write to a side file and move it into place only once the whole dump
            // has arrived. A transfer cut halfway then leaves nothing that looks
            // like a backup, and --force never destroys the old dump before the
            // new one is complete. The random part means two runs with the same
            // --out never write into, delete or move each other's file.
            string partial = $"{destination}.{Guid.NewGuid():N}.partial";
            try
            {
                await using (FileStream file = CreatePrivate(partial))
                {
                    written = await StreamToAsync(body, file, timeout);
                }
                // Do not leave a zero byte file lying around looking like a backup.
                if (written == 0) File.Delete(partial);
                else MoveIntoPlace(partial, destination, overwrite);
            }
            catch
            {
                // Covers the move too: a dump that cannot be moved into place must
                // not stay behind as <out>.partial either.
                File.Delete(partial);
                throw;
            }
        }

        if (written == 0)
        {
            throw new ApiException(
                "The server returned an empty dump. Check that the account is an "
                + "administrator and that the site has finished starting.");
        }
        return written;
    }

    /// <summary>
    /// Create <paramref name="path"/> for writing, readable by the owner only.
    /// </summary>
    /// <remarks>
    /// The dump holds every user's password hashes and the servers' auth keys, so
    /// it must not come out world-readable the way File.Create makes it under the
    /// usual umask. CreateNew never reuses an existing file, whose mode would
    /// stick. On Windows the file takes the folder's ACL, as any file does.
    /// </remarks>
    private static FileStream CreatePrivate(string path)
    {
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }
        return new FileStream(path, options);
    }

    /// <summary>Move the finished dump to its name, replacing a file there only when allowed.</summary>
    private static void MoveIntoPlace(string partial, string destination, bool overwrite)
    {
        try
        {
            File.Move(partial, destination, overwrite);
        }
        catch (IOException) when (!overwrite && File.Exists(destination))
        {
            throw new ApiException(
                $"Refusing to overwrite {destination}, which appeared during the download. "
                + "Choose another --out, or pass --force.");
        }
    }

    /// <summary>
    /// Copy a response body into an open stream, chunk by chunk. The idle timeout
    /// runs only while waiting on the server, never while writing, so a slow
    /// consumer is not mistaken for a server that stopped sending. Returns the
    /// bytes copied.
    /// </summary>
    private async Task<long> StreamToAsync(Stream body, Stream target, CancellationTokenSource timeout)
    {
        var buffer = new byte[ChunkSize];
        long written = 0;
        while (true)
        {
            timeout.CancelAfter(_databaseTimeout);
            int read = await body.ReadAsync(buffer, timeout.Token);
            timeout.CancelAfter(Timeout.InfiniteTimeSpan); // the write is not the server's time
            if (read == 0) return written;
            await target.WriteAsync(buffer.AsMemory(0, read), timeout.Token);
            written += read;
        }
    }

    /// <summary>
    /// POST site/database with the dump bytes as the body. The server restarts as
    /// soon as it accepts the dump.
    /// </summary>
    public async Task RestoreAsync(string source, CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{_host}{Api}/site/database");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        // The body is the dump file, byte for byte. No multipart, no base64. The
        // open file is the content: HttpClient takes the Content-Length from its
        // size and reads it from disk as it sends, so the dump is never held
        // whole in memory. Disposing the request closes the file. The wrapper
        // re-arms the idle timeout on every read, so a slow but steady upload is
        // never cut off, and counts what was read, which tells the restart
        // (whole dump sent, then the connection drops) from a connection lost
        // before the server had the dump.
        var body = new IdleTimeoutReadStream(File.OpenRead(source), timeout, _databaseTimeout);
        request.Content = new StreamContent(body, ChunkSize);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        timeout.CancelAfter(_databaseTimeout);

        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(request, timeout.Token);
        }
        catch (HttpRequestException ex) when (ex.InnerException is IOException)
        {
            if (body.Sent < body.Size)
            {
                // Cut off partway, or refused early: the server never had the
                // whole dump, so it cannot have loaded it.
                throw new ApiException(
                    $"The connection was lost after {body.Sent} of {body.Size} bytes were sent. "
                    + "The dump was not loaded.");
            }
            // Expected. The server restarts the moment it accepts the dump, so it
            // often drops the connection instead of answering. The whole dump was
            // handed over, so this is success, not failure.
            Token = null;
            return;
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested
                                                  && !cancellationToken.IsCancellationRequested)
        {
            if (body.Sent < body.Size)
            {
                throw new ApiException(
                    $"The server stopped reading the dump after {body.Sent} of {body.Size} bytes. "
                    + "The dump was not loaded.");
            }
            // Sent, but no answer in time. That is not the restart (which drops
            // the connection) and not a refusal (which answers), so the honest
            // report is that nobody knows yet.
            throw new ApiException(
                $"No answer within {_databaseTimeout.TotalSeconds:0.###} s after the dump was sent. "
                + "The server may have loaded it and be restarting, or the load may have failed. "
                + "Check the server before restoring again.");
        }

        using (response)
        {
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            {
                throw new AuthException(
                    $"The site refused the load (HTTP {(int)response.StatusCode}). This endpoint "
                    + "needs an administrator on a fresh session.");
            }
            if (!response.IsSuccessStatusCode)
            {
                // Anything else the server rejects (a dump from another version, a
                // corrupt file) comes back as an error status, and nothing restarts.
                throw new ApiException(
                    $"The load request failed (HTTP {(int)response.StatusCode}). The dump was not applied.");
            }
        }
    }

    /// <summary>
    /// DELETE the session so the token is not left valid. Safe to call twice. A
    /// failure to deliver it is thrown, so the caller can say so.
    /// </summary>
    public async Task LogoutAsync(CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(Token)) return;
        string token = Token;
        Token = null;
        using var request = new HttpRequestMessage(HttpMethod.Delete, $"{_host}{Api}/login/sessions/{token}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(LoginTimeout);
        using HttpResponseMessage _ = await _http.SendAsync(request, timeout.Token);
    }

    // -----------------------------------------------------------------------
    // Pure helpers
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
                && el.ValueKind == JsonValueKind.String
                && !string.IsNullOrEmpty(el.GetString()))
            {
                return el.GetString()!;
            }
            throw new ApiException("Login response did not contain a token.");
        }
    }

    /// <summary>Build a filename that says which site the dump came from, and when.</summary>
    /// <remarks>
    /// The timestamp is UTC so that dumps taken from servers in different time
    /// zones still sort into the order they were taken.
    /// </remarks>
    public static string DefaultOutputName(string host, DateTime utcNow)
    {
        int scheme = host.IndexOf("://", StringComparison.Ordinal);
        // Dots and colons become dashes, and an IPv6 literal's brackets go, so the
        // name is safe on every filesystem: [fe80::1]:7001 -> fe80--1-7001.
        string site = (scheme >= 0 ? host[(scheme + 3)..] : host)
            .Replace('.', '-').Replace(':', '-').Replace("[", "").Replace("]", "");
        // Invariant: under th-TH or ar-SA the current culture's calendar would
        // write a Buddhist or Hijri year, and the names would no longer sort with
        // the other ports'.
        return string.Create(
            System.Globalization.CultureInfo.InvariantCulture,
            $"nx-site-database-{site}-{utcNow:yyyyMMdd'T'HHmmss'Z'}.db");
    }

    /// <summary>Render a byte count the way a person reads a backup file size.</summary>
    public static string FormatSize(long byteCount)
    {
        if (byteCount < 1024) return $"{byteCount} bytes";
        if (byteCount < 1024 * 1024) return (byteCount / 1024.0).ToString("F3", System.Globalization.CultureInfo.InvariantCulture) + " KiB";
        return (byteCount / (1024.0 * 1024.0)).ToString("F3", System.Globalization.CultureInfo.InvariantCulture) + " MiB";
    }
}

/// <summary>
/// A read-only wrapper for an upload body that re-arms an idle timeout on every
/// read and counts the bytes read.
/// </summary>
/// <remarks>
/// HttpClient reads the body only as fast as the socket takes it, so a read is
/// the upload making progress: the timeout then fires only when the server stops
/// reading (or, after the last read, stops answering), never because a large
/// dump simply takes long to send.
/// </remarks>
internal sealed class IdleTimeoutReadStream : Stream
{
    private readonly Stream _inner;
    private readonly CancellationTokenSource _timeout;
    private readonly TimeSpan _idle;

    public long Sent { get; private set; }
    public long Size { get; }

    public IdleTimeoutReadStream(Stream inner, CancellationTokenSource timeout, TimeSpan idle)
    {
        _inner = inner;
        _timeout = timeout;
        _idle = idle;
        Size = inner.Length;
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        _timeout.CancelAfter(_idle);
        int read = await _inner.ReadAsync(buffer, cancellationToken);
        Sent += read;
        return read;
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        _timeout.CancelAfter(_idle);
        int read = _inner.Read(buffer, offset, count);
        Sent += read;
        return read;
    }

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    // StreamContent asks for the length to send a Content-Length.
    public override long Length => Size;
    public override long Position { get => Sent; set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing) _inner.Dispose();
        base.Dispose(disposing);
    }
}
