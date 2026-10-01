// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the rest-backup-site-database sample, client and config.
//
// These run with no VMS server and no network: every HTTP call is served by the
// fake handler below. That is a hard requirement, a test that needs a live
// server cannot run in CI, so it does not get written.
//
// The dump is opaque binary. The spec documents no response schema for
// GET /rest/v4/site/database, so these tests assert what the sample does with
// the bytes rather than what shape they have.

using System.Net;
using System.Text;
using NxBackupSiteDatabase;
using Xunit;

namespace NxBackupSiteDatabase.Tests;

internal sealed record Call(
    string Method, string Url, string? Auth, byte[] Body, string? ContentType);

/// <summary>
/// Records every request, and answers from a script keyed on method and URL
/// suffix. A scripted entry may throw, to stand in for a dropped connection.
/// </summary>
internal sealed class RecordingHandler : HttpMessageHandler
{
    private readonly List<(string Method, string Suffix, Func<HttpResponseMessage> Respond)> _script = new();
    public List<Call> Calls { get; } = new();

    public RecordingHandler On(string method, string suffix, Func<HttpResponseMessage> respond)
    {
        _script.Add((method, suffix, respond));
        return this;
    }

    public RecordingHandler On(string method, string suffix, HttpStatusCode status)
        => On(method, suffix, () => new HttpResponseMessage(status));

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        byte[] body = request.Content is null
            ? Array.Empty<byte>()
            : await request.Content.ReadAsByteArrayAsync(cancellationToken);
        string url = request.RequestUri!.ToString();
        Calls.Add(new Call(
            request.Method.Method, url, request.Headers.Authorization?.ToString(), body,
            request.Content?.Headers.ContentType?.MediaType));

        foreach (var (method, suffix, respond) in _script)
        {
            if (request.Method.Method == method && url.EndsWith(suffix, StringComparison.Ordinal))
            {
                return respond();
            }
        }
        return new HttpResponseMessage(HttpStatusCode.OK);
    }
}

/// <summary>
/// A response body that records how HttpClient consumed it. HttpClient buffers a
/// whole body by serialising it into memory, and streams it by opening a read
/// stream, so which of the two overrides ran says which one the client asked for.
/// </summary>
internal sealed class TrackingContent : HttpContent
{
    private readonly byte[] _body;
    public bool Buffered { get; private set; }

    public TrackingContent(byte[] body) => _body = body;

    protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context)
    {
        Buffered = true;
        return stream.WriteAsync(_body, 0, _body.Length);
    }

    protected override Task<Stream> CreateContentReadStreamAsync()
        => Task.FromResult<Stream>(new MemoryStream(_body, writable: false));

    protected override bool TryComputeLength(out long length)
    {
        length = _body.Length;
        return true;
    }
}

/// <summary>A read-only stream that hands out one chunk per Read, as a network does.</summary>
internal sealed class ChunkedStream : Stream
{
    private readonly Queue<byte[]> _chunks;
    public ChunkedStream(params byte[][] chunks) => _chunks = new Queue<byte[]>(chunks);

    public override int Read(byte[] buffer, int offset, int count)
    {
        if (_chunks.Count == 0) return 0;
        byte[] chunk = _chunks.Dequeue();
        Array.Copy(chunk, 0, buffer, offset, chunk.Length);
        return chunk.Length;
    }

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}

/// <summary>A body that hands out its chunks, then loses the connection.</summary>
internal sealed class DroppingStream : Stream
{
    private readonly Queue<byte[]> _chunks;
    public DroppingStream(params byte[][] chunks) => _chunks = new Queue<byte[]>(chunks);

    public override int Read(byte[] buffer, int offset, int count)
    {
        if (_chunks.Count == 0)
        {
            // What HttpClient throws when the server goes away mid-body.
            throw new HttpIOException(HttpRequestError.ResponseEnded, "The response ended prematurely.");
        }
        byte[] chunk = _chunks.Dequeue();
        Array.Copy(chunk, 0, buffer, offset, chunk.Length);
        return chunk.Length;
    }

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}

/// <summary>
/// A body that hands out its chunks with a pause before each one, then either
/// ends or, when <c>hangAtEnd</c> is set, goes silent until cancelled.
/// </summary>
internal sealed class PacedStream : Stream
{
    private readonly Queue<byte[]> _chunks;
    private readonly TimeSpan _pause;
    private readonly bool _hangAtEnd;

    public PacedStream(TimeSpan pause, bool hangAtEnd, params byte[][] chunks)
    {
        _pause = pause;
        _hangAtEnd = hangAtEnd;
        _chunks = new Queue<byte[]>(chunks);
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        if (_chunks.Count == 0)
        {
            if (!_hangAtEnd) return 0;
            await Task.Delay(Timeout.Infinite, cancellationToken);
        }
        await Task.Delay(_pause, cancellationToken);
        byte[] chunk = _chunks.Dequeue();
        chunk.CopyTo(buffer);
        return chunk.Length;
    }

    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}

/// <summary>
/// Answers login. Any other request has its body read (all of it, or only
/// <c>readOnly</c> bytes) and is then left waiting until it is cancelled.
/// </summary>
internal sealed class SilentHandler : HttpMessageHandler
{
    private readonly int? _readOnly;
    public SilentHandler(int? readOnly = null) => _readOnly = readOnly;

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (request.RequestUri!.AbsolutePath.EndsWith("/login/sessions", StringComparison.Ordinal))
        {
            return Responses.LoginOk();
        }
        if (request.Content is not null)
        {
            if (_readOnly is int n)
            {
                await using Stream body = await request.Content.ReadAsStreamAsync(cancellationToken);
                await body.ReadAtLeastAsync(new byte[n], n, throwOnEndOfStream: false, cancellationToken);
            }
            else
            {
                await request.Content.ReadAsByteArrayAsync(cancellationToken);
            }
        }
        await Task.Delay(Timeout.Infinite, cancellationToken);
        throw new InvalidOperationException("unreachable");
    }
}

/// <summary>A writable stream that takes its time over every write, like a throttled pipe.</summary>
internal sealed class SlowSink : Stream
{
    private readonly TimeSpan _delay;
    public readonly MemoryStream Received = new();
    public SlowSink(TimeSpan delay) => _delay = delay;

    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
    {
        await Task.Delay(_delay, cancellationToken);
        Received.Write(buffer.Span);
    }

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override bool CanRead => false;
    public override bool CanSeek => false;
    public override bool CanWrite => true;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
}

/// <summary>
/// Answers login; reads only <c>readBytes</c> of any other request's body and
/// then fails the way a reset connection does.
/// </summary>
internal sealed class PartialReadHandler : HttpMessageHandler
{
    private readonly int _readBytes;
    public PartialReadHandler(int readBytes) => _readBytes = readBytes;

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (request.RequestUri!.AbsolutePath.EndsWith("/login/sessions", StringComparison.Ordinal))
        {
            return Responses.LoginOk();
        }
        await using Stream body = await request.Content!.ReadAsStreamAsync(cancellationToken);
        await body.ReadAtLeastAsync(new byte[_readBytes], _readBytes, throwOnEndOfStream: false, cancellationToken);
        throw new HttpRequestException("Error while copying content to a stream.",
            new IOException("Connection reset by peer"));
    }
}

internal static class Responses
{
    public static HttpResponseMessage Paced(TimeSpan pause, bool hangAtEnd, params byte[][] chunks)
        => new(HttpStatusCode.OK) { Content = new StreamContent(new PacedStream(pause, hangAtEnd, chunks)) };

    public static HttpResponseMessage Dropping(params byte[][] chunks)
        => new(HttpStatusCode.OK) { Content = new StreamContent(new DroppingStream(chunks)) };

    public static HttpResponseMessage Json(string json)
        => new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    public static HttpResponseMessage LoginOk(string token = "tok-1") => Json($"{{\"token\":\"{token}\"}}");

    public static HttpResponseMessage Bytes(HttpStatusCode status, byte[] body)
        => new(status) { Content = new ByteArrayContent(body) };

    public static HttpResponseMessage Chunks(params byte[][] chunks)
        => new(HttpStatusCode.OK) { Content = new StreamContent(new ChunkedStream(chunks)) };
}

internal static class Make
{
    public const string Host = "https://server:7001";

    public static NxServerClient Client(RecordingHandler handler) => new(new HttpClient(handler), Host);

    public static async Task<NxServerClient> LoggedIn(RecordingHandler handler, string token = "tok-1")
    {
        handler.On("POST", "/login/sessions", () => Responses.LoginOk(token));
        var client = Client(handler);
        await client.LoginAsync("admin", "secret");
        return client;
    }
}

/// <summary>A temporary directory per test, removed afterwards.</summary>
public abstract class TempDirTest : IDisposable
{
    protected readonly string Dir = Directory.CreateTempSubdirectory("nx-backup-test-").FullName;
    protected string PathIn(string name) => Path.Combine(Dir, name);
    public void Dispose() => Directory.Delete(Dir, recursive: true);
}

// ---------------------------------------------------------------------------
// Login and logout
// ---------------------------------------------------------------------------

public class LoginTests
{
    [Fact]
    public async Task Login_posts_credentials_and_stores_the_token()
    {
        var handler = new RecordingHandler().On("POST", "/login/sessions", () => Responses.LoginOk());
        var client = Make.Client(handler);

        string token = await client.LoginAsync("admin", "secret");

        Assert.Equal("tok-1", token);
        Assert.Equal("tok-1", client.Token);
        Call call = handler.Calls[0];
        Assert.Equal("POST", call.Method);
        Assert.Equal("https://server:7001/rest/v4/login/sessions", call.Url);
        Assert.Equal(
            "{\"username\":\"admin\",\"password\":\"secret\",\"setCookie\":false}",
            Encoding.UTF8.GetString(call.Body));
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden)]
    public async Task Login_unauthorized_throws_AuthException(HttpStatusCode status)
    {
        var handler = new RecordingHandler().On("POST", "/login/sessions", status);
        await Assert.ThrowsAsync<AuthException>(() => Make.Client(handler).LoginAsync("admin", "wrong"));
    }

    [Fact]
    public async Task Login_without_a_token_in_the_response_throws_ApiException()
    {
        var handler = new RecordingHandler().On("POST", "/login/sessions", () => Responses.Json("{}"));
        await Assert.ThrowsAsync<ApiException>(() => Make.Client(handler).LoginAsync("admin", "secret"));
    }
}

public class LogoutTests
{
    [Fact]
    public async Task Logout_deletes_the_session_and_clears_the_token()
    {
        var handler = new RecordingHandler();
        var client = await Make.LoggedIn(handler);

        await client.LogoutAsync();

        Call call = handler.Calls[^1];
        Assert.Equal("DELETE", call.Method);
        Assert.Equal("https://server:7001/rest/v4/login/sessions/tok-1", call.Url);
        Assert.Equal("Bearer tok-1", call.Auth);
        Assert.Null(client.Token);
    }

    [Fact]
    public async Task Logout_without_a_token_is_a_noop()
    {
        var handler = new RecordingHandler();

        await Make.Client(handler).LogoutAsync();

        Assert.Empty(handler.Calls);
    }
}

// ---------------------------------------------------------------------------
// Configuration. These touch process environment variables, so every class that
// does shares one collection, which xUnit never runs in parallel.
// ---------------------------------------------------------------------------

[CollectionDefinition("process environment", DisableParallelization = true)]
public class ProcessEnvironment { }

[Collection("process environment")]
public class ConfigTests : IDisposable
{
    private static readonly string[] Vars = { "NX_SERVER_HOST", "NX_SERVER_USER", "NX_SERVER_PASSWORD" };
    private static readonly Dictionary<string, string> NoFile = new();

    public ConfigTests() { foreach (string v in Vars) Environment.SetEnvironmentVariable(v, null); }
    public void Dispose() { foreach (string v in Vars) Environment.SetEnvironmentVariable(v, null); }

    [Fact]
    public void Config_reads_the_server_env_vars()
    {
        Environment.SetEnvironmentVariable("NX_SERVER_HOST", "https://from-env:7001");
        Environment.SetEnvironmentVariable("NX_SERVER_USER", "envuser");
        Environment.SetEnvironmentVariable("NX_SERVER_PASSWORD", "envpass");

        AppConfig config = Config.Resolve(new CliArgs(), NoFile);

        Assert.Equal(new AppConfig("https://from-env:7001", "envuser", "envpass"), config);
    }

    [Fact]
    public void Cli_flag_beats_env_which_beats_dotenv()
    {
        var file = new Dictionary<string, string> { ["NX_SERVER_USER"] = "dotenvuser" };
        Environment.SetEnvironmentVariable("NX_SERVER_USER", "envuser");

        Assert.Equal("cliuser", Config.Resolve(new CliArgs { User = "cliuser" }, file).User);
        Assert.Equal("envuser", Config.Resolve(new CliArgs(), file).User);

        Environment.SetEnvironmentVariable("NX_SERVER_USER", null);
        Assert.Equal("dotenvuser", Config.Resolve(new CliArgs(), file).User);
    }

    [Fact]
    public void Trailing_slash_is_stripped_from_the_host()
    {
        AppConfig config = Config.Resolve(new CliArgs { Host = "https://server:7001/" }, NoFile);
        Assert.Equal("https://server:7001", config.Host);
    }
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

public class BackupTests : TempDirTest
{
    private static RecordingHandler DumpReturns(byte[] body, HttpStatusCode status = HttpStatusCode.OK)
        => new RecordingHandler().On("GET", "/site/database", () => Responses.Bytes(status, body));

    [Fact]
    public async Task Backup_gets_the_site_database_endpoint()
    {
        var handler = DumpReturns("dump"u8.ToArray());
        var client = await Make.LoggedIn(handler);

        await client.BackupAsync(PathIn("out.db"));

        Call call = handler.Calls[^1];
        Assert.Equal("GET", call.Method);
        Assert.Equal("https://server:7001/rest/v4/site/database", call.Url);
    }

    [Fact]
    public async Task Backup_sends_the_bearer_token_from_login()
    {
        var handler = DumpReturns("dump"u8.ToArray());
        var client = await Make.LoggedIn(handler, "tok-9");

        await client.BackupAsync(PathIn("out.db"));

        Call call = handler.Calls[^1];
        Assert.EndsWith("/site/database", call.Url);
        Assert.Equal("Bearer tok-9", call.Auth);
    }

    [Fact]
    public async Task Backup_asks_for_a_streamed_body()
    {
        // A site dump can be tens of megabytes; it must not be buffered whole.
        var body = new TrackingContent("dump"u8.ToArray());
        var handler = new RecordingHandler().On("GET", "/site/database",
            () => new HttpResponseMessage(HttpStatusCode.OK) { Content = body });
        var client = await Make.LoggedIn(handler);

        await client.BackupAsync(PathIn("out.db"));

        Assert.False(body.Buffered);
    }

    [Fact]
    public async Task Backup_writes_the_bytes_byte_for_byte()
    {
        // The dump is opaque binary, so it must never be decoded as text.
        byte[] dump = [0x00, 0xFF, 0xFE, 0x0D, 0x0A, 0x1A, 0x80, 0x81, .. "not-utf8"u8.ToArray()];
        var client = await Make.LoggedIn(DumpReturns(dump));
        string target = PathIn("out.db");

        await client.BackupAsync(target);

        Assert.Equal(dump, File.ReadAllBytes(target));
    }

    [Fact]
    public async Task Backup_writes_every_chunk_in_order()
    {
        // Streaming means the file is assembled from chunks, not from one buffer.
        var handler = new RecordingHandler().On("GET", "/site/database",
            () => Responses.Chunks("aaa"u8.ToArray(), "bbb"u8.ToArray(), "ccc"u8.ToArray()));
        var client = await Make.LoggedIn(handler);
        string target = PathIn("out.db");

        await client.BackupAsync(target);

        Assert.Equal("aaabbbccc"u8.ToArray(), File.ReadAllBytes(target));
    }

    [Fact]
    public async Task Backup_returns_the_byte_count()
    {
        var handler = new RecordingHandler().On("GET", "/site/database",
            () => Responses.Chunks("aaa"u8.ToArray(), "bbbb"u8.ToArray()));
        var client = await Make.LoggedIn(handler);

        Assert.Equal(7, await client.BackupAsync(PathIn("out.db")));
    }

    [Fact]
    public async Task Backup_rejects_an_empty_dump_and_leaves_no_file()
    {
        // A zero byte body is never a valid dump, and half a backup is worse than none.
        var client = await Make.LoggedIn(DumpReturns(Array.Empty<byte>()));
        string target = PathIn("out.db");

        await Assert.ThrowsAsync<ApiException>(() => client.BackupAsync(target));

        Assert.False(File.Exists(target));
    }

    [Fact]
    public async Task Backup_cut_off_midway_leaves_no_file()
    {
        // Half a dump on disk would pass for a backup until the day it is needed.
        var handler = new RecordingHandler().On("GET", "/site/database",
            () => Responses.Dropping("first half "u8.ToArray()));
        var client = await Make.LoggedIn(handler);

        await Assert.ThrowsAsync<HttpIOException>(() => client.BackupAsync(PathIn("out.db")));

        Assert.Empty(Directory.GetFiles(Dir));
    }

    [Fact]
    public async Task Backup_that_goes_silent_is_stopped_and_leaves_no_file()
    {
        var handler = new RecordingHandler()
            .On("POST", "/login/sessions", () => Responses.LoginOk())
            .On("GET", "/site/database",
                () => Responses.Paced(TimeSpan.Zero, hangAtEnd: true, "first"u8.ToArray()));
        var client = new NxServerClient(new HttpClient(handler), Make.Host, TimeSpan.FromMilliseconds(50));
        await client.LoginAsync("admin", "secret");

        var caught = await Assert.ThrowsAsync<ApiException>(() => client.BackupAsync(PathIn("out.db")));

        Assert.Contains("stopped sending", caught.Message);
        Assert.Empty(Directory.GetFiles(Dir));
    }

    [Fact]
    public async Task Backup_that_keeps_arriving_may_outlast_the_timeout()
    {
        // The limit is on silence, not on the whole transfer: six chunks 20 ms
        // apart take well over the 50 ms limit and must still succeed.
        byte[][] chunks = Enumerable.Range(1, 6).Select(i => new[] { (byte)i }).ToArray();
        var handler = new RecordingHandler()
            .On("POST", "/login/sessions", () => Responses.LoginOk())
            .On("GET", "/site/database",
                () => Responses.Paced(TimeSpan.FromMilliseconds(20), hangAtEnd: false, chunks));
        var client = new NxServerClient(new HttpClient(handler), Make.Host, TimeSpan.FromMilliseconds(50));
        await client.LoginAsync("admin", "secret");

        long written = await client.BackupAsync(PathIn("out.db"));

        Assert.Equal(6, written);
        Assert.Equal(new byte[] { 1, 2, 3, 4, 5, 6 }, File.ReadAllBytes(PathIn("out.db")));
    }

    [Fact]
    public async Task The_dump_is_readable_by_its_owner_only()
    {
        // It holds password hashes and server auth keys. Under the usual umask
        // File.Create would make it -rw-r--r--, readable by every local user.
        if (OperatingSystem.IsWindows()) return;
        string target = PathIn("out.db");
        // A stale side file with a loose mode must not lend the dump its mode.
        File.WriteAllText(target + ".partial", "old");
        File.SetUnixFileMode(target + ".partial", (UnixFileMode)0b110_100_100);
        var handler = new RecordingHandler().On("GET", "/site/database",
            () => Responses.Bytes(HttpStatusCode.OK, "dump"u8.ToArray()));
        var client = await Make.LoggedIn(handler);

        await client.BackupAsync(target);

        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(target));
        Assert.Equal("dump"u8.ToArray(), File.ReadAllBytes(target));
    }

    [Fact]
    public async Task A_move_that_fails_leaves_no_partial_behind()
    {
        // The whole dump is in the side file by then, hashes and all.
        string folder = PathIn("adir");
        Directory.CreateDirectory(folder); // moving a file onto a directory fails
        var handler = new RecordingHandler().On("GET", "/site/database",
            () => Responses.Bytes(HttpStatusCode.OK, "dump"u8.ToArray()));
        var client = await Make.LoggedIn(handler);

        await Assert.ThrowsAnyAsync<IOException>(() => client.BackupAsync(folder));

        Assert.Empty(Directory.GetFiles(Dir));
    }

    [Fact]
    public async Task A_slow_consumer_is_not_mistaken_for_a_server_that_stopped_sending()
    {
        // The server has the whole dump ready at once; only the consumer is slow.
        // The timeout covers waits on the server, not the time spent writing.
        var handler = new RecordingHandler()
            .On("POST", "/login/sessions", () => Responses.LoginOk())
            .On("GET", "/site/database", () => Responses.Chunks([1], [2], [3]));
        var client = new NxServerClient(new HttpClient(handler), Make.Host, TimeSpan.FromMilliseconds(50));
        await client.LoginAsync("admin", "secret");
        var sink = new SlowSink(TimeSpan.FromMilliseconds(120));

        long written = await client.BackupAsync("-", sink);

        Assert.Equal(3, written);
        Assert.Equal(new byte[] { 1, 2, 3 }, sink.Received.ToArray());
    }

    [Fact]
    public async Task Two_backups_to_one_out_never_share_a_side_file()
    {
        // A fixed <out>.partial let the second run delete the first's file, and
        // the first then moved the second's half-written dump into place.
        string target = PathIn("out.db");
        var a = await Make.LoggedIn(new RecordingHandler().On("GET", "/site/database",
            () => Responses.Paced(TimeSpan.FromMilliseconds(5), false,
                Enumerable.Range(0, 20).Select(_ => Enumerable.Repeat((byte)1, 1000).ToArray()).ToArray())));
        var b = await Make.LoggedIn(new RecordingHandler().On("GET", "/site/database",
            () => Responses.Paced(TimeSpan.FromMilliseconds(5), false,
                Enumerable.Range(0, 10).Select(_ => Enumerable.Repeat((byte)2, 1000).ToArray()).ToArray())));

        long[] written = await Task.WhenAll(
            a.BackupAsync(target, overwrite: true), b.BackupAsync(target, overwrite: true));

        Assert.Equal(new long[] { 20000, 10000 }, written);
        byte[] final = File.ReadAllBytes(target);
        Assert.True(final.SequenceEqual(Enumerable.Repeat((byte)1, 20000))
                    || final.SequenceEqual(Enumerable.Repeat((byte)2, 10000)));
        Assert.Equal(new[] { target }, Directory.GetFiles(Dir));
    }

    [Fact]
    public async Task Without_overwrite_a_file_that_appears_during_the_download_is_kept()
    {
        string target = PathIn("out.db");
        var handler = new RecordingHandler().On("GET", "/site/database", () =>
        {
            File.WriteAllText(target, "someone else's file");
            return Responses.Bytes(HttpStatusCode.OK, "dump"u8.ToArray());
        });
        var client = await Make.LoggedIn(handler);

        var caught = await Assert.ThrowsAsync<ApiException>(() => client.BackupAsync(target));

        Assert.Contains("Refusing to overwrite", caught.Message);
        Assert.Equal("someone else's file", File.ReadAllText(target));
        Assert.Equal(new[] { target }, Directory.GetFiles(Dir));
    }

    [Fact]
    public async Task Backup_throws_AuthException_on_401()
    {
        var client = await Make.LoggedIn(DumpReturns(Array.Empty<byte>(), HttpStatusCode.Unauthorized));

        await Assert.ThrowsAsync<AuthException>(() => client.BackupAsync(PathIn("out.db")));
    }

    [Fact]
    public async Task Backup_403_names_the_role_and_the_fresh_session_rule()
    {
        // The spec's permission line is "Administrator with a fresh session", and a
        // 403 here is nearly always one of those two, so the message must say both.
        var client = await Make.LoggedIn(DumpReturns(Array.Empty<byte>(), HttpStatusCode.Forbidden));

        var caught = await Assert.ThrowsAsync<AuthException>(() => client.BackupAsync(PathIn("out.db")));

        string message = caught.Message.ToLowerInvariant();
        Assert.Contains("administrator", message);
        Assert.Contains("fresh session", message);
    }

    [Fact]
    public async Task Backup_throws_ApiException_on_a_server_error()
    {
        // The body is non-empty on purpose: an error page must be rejected on its
        // status, not incidentally by the empty-dump check.
        var client = await Make.LoggedIn(DumpReturns(
            "<html>Internal Server Error</html>"u8.ToArray(), HttpStatusCode.InternalServerError));
        string target = PathIn("out.db");

        await Assert.ThrowsAsync<ApiException>(() => client.BackupAsync(target));

        Assert.False(File.Exists(target));
    }
}

// ---------------------------------------------------------------------------
// The default output name
// ---------------------------------------------------------------------------

public class DefaultOutputNameTests
{
    [Fact]
    public void Default_output_name_carries_the_host_and_a_utc_timestamp()
    {
        var moment = new DateTime(2026, 9, 14, 3, 12, 0, DateTimeKind.Utc);

        string name = NxServerClient.DefaultOutputName("https://192.168.1.10:7001", moment);

        Assert.Equal("nx-site-database-192-168-1-10-7001-20260914T031200Z.db", name);
    }

    [Fact]
    public void Default_output_name_keeps_the_port_and_drops_the_scheme()
    {
        // A relay address and a plain http host must both survive intact.
        var moment = new DateTime(2026, 1, 2, 0, 0, 0, DateTimeKind.Utc);

        Assert.Equal(
            "nx-site-database-abcd-1234-relay-vmsproxy-com-20260102T000000Z.db",
            NxServerClient.DefaultOutputName("https://abcd-1234.relay.vmsproxy.com", moment));
        Assert.Equal(
            "nx-site-database-10-0-0-5-7001-20260102T000000Z.db",
            NxServerClient.DefaultOutputName("http://10.0.0.5:7001", moment));
    }

    [Fact]
    public void Default_output_name_drops_ipv6_brackets()
    {
        var moment = new DateTime(2026, 10, 1, 8, 9, 10, DateTimeKind.Utc);

        Assert.Equal(
            "nx-site-database-fe80--1-7001-20261001T080910Z.db",
            NxServerClient.DefaultOutputName("https://[fe80::1]:7001", moment));
    }

    [Fact]
    public void Default_output_name_uses_the_gregorian_year_in_every_culture()
    {
        var moment = new DateTime(2026, 10, 1, 8, 9, 10, DateTimeKind.Utc);
        var before = System.Globalization.CultureInfo.CurrentCulture;
        try
        {
            foreach (string culture in new[] { "th-TH", "ar-SA", "fa-IR" })
            {
                System.Globalization.CultureInfo.CurrentCulture = new System.Globalization.CultureInfo(culture);
                Assert.Equal(
                    "nx-site-database-192-168-1-10-7001-20261001T080910Z.db",
                    NxServerClient.DefaultOutputName("https://192.168.1.10:7001", moment));
            }
        }
        finally
        {
            System.Globalization.CultureInfo.CurrentCulture = before;
        }
    }

    [Fact]
    public void Format_size_uses_binary_units()
    {
        // The divisor is 1024, so the honest unit names are KiB and MiB.
        Assert.Equal("512 bytes", NxServerClient.FormatSize(512));
        Assert.Equal("1.500 KiB", NxServerClient.FormatSize(1536));
        Assert.Equal("3.000 MiB", NxServerClient.FormatSize(3 * 1024 * 1024));
    }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

public class RestoreTests : TempDirTest
{
    private string Dump(byte[] bytes)
    {
        string path = PathIn("in.db");
        File.WriteAllBytes(path, bytes);
        return path;
    }

    private static RecordingHandler LoadReturns(HttpStatusCode status = HttpStatusCode.OK)
        => new RecordingHandler().On("POST", "/site/database", status);

    [Fact]
    public async Task Restore_posts_to_the_site_database_endpoint()
    {
        var handler = LoadReturns();
        var client = await Make.LoggedIn(handler);

        await client.RestoreAsync(Dump("a dump"u8.ToArray()));

        Call call = handler.Calls[^1];
        Assert.Equal("POST", call.Method);
        Assert.Equal("https://server:7001/rest/v4/site/database", call.Url);
    }

    [Fact]
    public async Task Restore_sends_the_octet_stream_content_type()
    {
        // The spec declares the request body as application/octet-stream.
        var handler = LoadReturns();
        var client = await Make.LoggedIn(handler);

        await client.RestoreAsync(Dump("a dump"u8.ToArray()));

        Assert.Equal("application/octet-stream", handler.Calls[^1].ContentType);
    }

    [Fact]
    public async Task Restore_sends_the_file_bytes_unchanged()
    {
        // No multipart wrapper, no base64, no JSON, no text encoding: the raw dump.
        byte[] payload = [0x00, 0xFF, 0xFE, 0x80, 0x81, .. "binary"u8.ToArray(), 0x0D, 0x0A];
        var handler = LoadReturns();
        var client = await Make.LoggedIn(handler);

        await client.RestoreAsync(Dump(payload));

        Assert.Equal(payload, handler.Calls[^1].Body);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden)]
    public async Task Restore_unauthorized_throws_AuthException(HttpStatusCode status)
    {
        var client = await Make.LoggedIn(LoadReturns(status));

        var caught = await Assert.ThrowsAsync<AuthException>(
            () => client.RestoreAsync(Dump("a dump"u8.ToArray())));

        string message = caught.Message.ToLowerInvariant();
        Assert.Contains("administrator", message);
        Assert.Contains("fresh session", message);
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest)]
    [InlineData(HttpStatusCode.InternalServerError)]
    public async Task Restore_error_status_throws_ApiException(HttpStatusCode status)
    {
        // A rejected dump (wrong version, corrupt file) is a failure, not a restart.
        var client = await Make.LoggedIn(LoadReturns(status));

        var caught = await Assert.ThrowsAsync<ApiException>(
            () => client.RestoreAsync(Dump("a dump"u8.ToArray())));

        Assert.Contains("not applied", caught.Message);
    }

    [Fact]
    public async Task Restore_with_no_answer_in_time_says_the_outcome_is_unknown()
    {
        // Not the restart (that drops the connection) and not a refusal (that
        // answers). Calling it success could hide a failed load; calling it
        // failure invites a second load into a server already restarting.
        var client = new NxServerClient(new HttpClient(new SilentHandler()), Make.Host, TimeSpan.FromMilliseconds(50));
        await client.LoginAsync("admin", "secret");

        var caught = await Assert.ThrowsAsync<ApiException>(
            () => client.RestoreAsync(Dump("a dump"u8.ToArray())));

        Assert.Contains("may have loaded it", caught.Message);
        Assert.Contains("Check the server", caught.Message);
    }

    [Fact]
    public async Task A_server_that_stops_reading_the_upload_means_not_loaded()
    {
        var client = new NxServerClient(new HttpClient(new SilentHandler(readOnly: 3)), Make.Host,
                                        TimeSpan.FromMilliseconds(50));
        await client.LoginAsync("admin", "secret");

        var caught = await Assert.ThrowsAsync<ApiException>(
            () => client.RestoreAsync(Dump(new byte[64 * 1024])));

        Assert.Contains("stopped reading the dump after", caught.Message);
        Assert.Contains("not loaded", caught.Message);
    }

    [Fact]
    public async Task A_connection_lost_partway_through_the_upload_is_not_success()
    {
        // A reset after part of the dump, or an early refusal and close: the
        // server never had the whole dump, so it cannot have loaded it.
        var client = new NxServerClient(new HttpClient(new PartialReadHandler(readBytes: 10)), Make.Host);
        await client.LoginAsync("admin", "secret");

        var caught = await Assert.ThrowsAsync<ApiException>(
            () => client.RestoreAsync(Dump(new byte[64 * 1024])));

        Assert.Contains("lost after", caught.Message);
        Assert.Contains("not loaded", caught.Message);
    }

    [Fact]
    public async Task A_redirect_answering_the_load_is_a_failure()
    {
        var client = await Make.LoggedIn(LoadReturns(HttpStatusCode.Found));

        var caught = await Assert.ThrowsAsync<ApiException>(
            () => client.RestoreAsync(Dump("a dump"u8.ToArray())));

        Assert.Contains("HTTP 302", caught.Message);
    }

    [Fact]
    public async Task Restore_treats_a_dropped_connection_as_success()
    {
        // The spec says the server restarts after loading, so it can cut the
        // connection before answering. That is the success path, not a failure.
        var handler = new RecordingHandler().On("POST", "/site/database",
            () => throw new HttpRequestException(
                "An error occurred while sending the request.",
                new IOException("Connection reset by peer")));
        var client = await Make.LoggedIn(handler);

        await client.RestoreAsync(Dump("a dump"u8.ToArray()));   // must not throw
    }
}
