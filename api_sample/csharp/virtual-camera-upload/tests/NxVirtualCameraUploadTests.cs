// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Offline tests for the virtual-camera-upload sample. No account, no network: the
// HTTP layer is a fake handler that records each request and returns scripted
// responses, so we can prove the create -> lock -> create-upload -> chunk PUTs ->
// status -> release flow. There is NO consume call. durationMs is OPTIONAL: sent
// only when the caller supplies a positive value; otherwise the server derives
// the clip's duration from the uploaded file's own metadata.

using System.Net;
using System.Security.Cryptography;
using System.Text;
using NxVirtualCameraUpload;
using Xunit;

namespace NxVirtualCameraUpload.Tests;

internal sealed record Call(string Method, string Url, string? Auth, byte[] BodyBytes, string Body)
{
    public string? ContentType { get; init; }
}

/// <summary>Records every request; returns a scripted response per call index. If
/// the queue runs dry it reuses the last response (handy for the many chunk PUTs).</summary>
internal sealed class RecordingHandler : HttpMessageHandler
{
    private readonly IReadOnlyList<HttpResponseMessage> _responses;
    private int _index;
    public List<Call> Calls { get; } = new();

    public RecordingHandler(params HttpResponseMessage[] responses)
        => _responses = responses;

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        byte[] bodyBytes = request.Content is null
            ? Array.Empty<byte>()
            : await request.Content.ReadAsByteArrayAsync(cancellationToken);
        string body = Encoding.UTF8.GetString(bodyBytes);
        Calls.Add(new Call(
            request.Method.Method, request.RequestUri!.ToString(),
            request.Headers.Authorization?.ToString(), bodyBytes, body)
        {
            ContentType = request.Content?.Headers.ContentType?.MediaType,
        });

        int i = _index < _responses.Count ? _index : _responses.Count - 1;
        _index++;
        return _responses.Count == 0 ? Responses.Ok("{}") : _responses[i];
    }
}

internal static class Responses
{
    public static HttpResponseMessage Ok(string json)
        => new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    public static HttpResponseMessage Status(HttpStatusCode code, string body = "")
        => new(code) { Content = new StringContent(body) };
}

internal static class TestHelpers
{
    public const string Host = "https://srv:7001";

    public static NxVirtualCameraClient MakeClient(HttpMessageHandler handler)
    {
        var client = new NxVirtualCameraClient(new HttpClient(handler), Host);
        client.UseToken("tok");
        return client;
    }

    public static string Md5B64(byte[] data)
        => Convert.ToBase64String(MD5.HashData(data));
}

// ---------------------------------------------------------------------------
// Md5Base64
// ---------------------------------------------------------------------------

public class Md5Tests
{
    [Fact]
    public void Md5Base64_MatchesExpected()
    {
        byte[] data = Encoding.ASCII.GetBytes(string.Concat(Enumerable.Repeat("hello virtual camera", 100)));
        string expected = Convert.ToBase64String(MD5.HashData(data));
        Assert.Equal(expected, NxVirtualCameraClient.Md5Base64(data));
    }

    [Fact]
    public void FileMd5Base64_MatchesExpected()
    {
        byte[] data = Encoding.ASCII.GetBytes(string.Concat(Enumerable.Repeat("abcdefghij", 50)));
        string path = Path.GetTempFileName();
        try
        {
            File.WriteAllBytes(path, data);
            string expected = Convert.ToBase64String(MD5.HashData(data));
            Assert.Equal(expected, NxVirtualCameraClient.FileMd5Base64(path));
        }
        finally
        {
            File.Delete(path);
        }
    }
}

// ---------------------------------------------------------------------------
// ChunkPlan
// ---------------------------------------------------------------------------

public class ChunkPlanTests
{
    [Fact]
    public void PartialLastChunk()
    {
        var plan = NxVirtualCameraClient.ChunkPlan(totalSize: 250, chunkSize: 100);
        Assert.Equal(new[]
        {
            new ChunkSpec(0, 0, 100),
            new ChunkSpec(1, 100, 100),
            new ChunkSpec(2, 200, 50),
        }, plan);
    }

    [Fact]
    public void ExactMultiple()
    {
        var plan = NxVirtualCameraClient.ChunkPlan(totalSize: 300, chunkSize: 100);
        Assert.Equal(new[]
        {
            new ChunkSpec(0, 0, 100),
            new ChunkSpec(1, 100, 100),
            new ChunkSpec(2, 200, 100),
        }, plan);
    }

    [Fact]
    public void SmallerThanOneChunk()
    {
        var plan = NxVirtualCameraClient.ChunkPlan(totalSize: 40, chunkSize: 100);
        Assert.Equal(new[] { new ChunkSpec(0, 0, 40) }, plan);
    }

    [Fact]
    public void ZeroByteFileIsOneEmptyChunk()
    {
        var plan = NxVirtualCameraClient.ChunkPlan(totalSize: 0, chunkSize: 100);
        Assert.Equal(new[] { new ChunkSpec(0, 0, 0) }, plan);
    }

    [Fact]
    public void RejectsNonPositiveChunkSize()
        => Assert.Throws<ApiException>(() => NxVirtualCameraClient.ChunkPlan(totalSize: 100, chunkSize: 0));

    [Fact]
    public void IterFileChunks_SplitsAndConcatenates()
    {
        byte[] data = new byte[512];
        for (int i = 0; i < 512; i++) data[i] = (byte)(i % 256);
        string path = Path.GetTempFileName();
        try
        {
            File.WriteAllBytes(path, data);
            var chunks = NxVirtualCameraClient.IterFileChunks(path, chunkSize: 200).ToList();
            Assert.Equal(new[] { 0, 1, 2 }, chunks.Select(c => c.Index));
            Assert.Equal(new[] { 200, 200, 112 }, chunks.Select(c => c.Data.Length));
            byte[] rejoined = chunks.SelectMany(c => c.Data).ToArray();
            Assert.Equal(data, rejoined);
        }
        finally
        {
            File.Delete(path);
        }
    }
}

// ---------------------------------------------------------------------------
// ParseStartTimeMs
// ---------------------------------------------------------------------------

public class StartTimeTests
{
    [Fact]
    public void EpochMs()
        => Assert.Equal(1700000000000L, NxVirtualCameraClient.ParseStartTimeMs("1700000000000"));

    [Fact]
    public void IsoUtc()
        => Assert.Equal(1609459200000L, NxVirtualCameraClient.ParseStartTimeMs("2021-01-01T00:00:00Z"));

    [Fact]
    public void BlankDefaultsToNow()
    {
        var fixed_ = new DateTimeOffset(2026, 6, 16, 0, 0, 0, TimeSpan.Zero);
        Assert.Equal(fixed_.ToUnixTimeMilliseconds(), NxVirtualCameraClient.ParseStartTimeMs("", fixed_));
    }

    [Fact]
    public void NaiveTreatedAsUtc()
        => Assert.Equal(1609459200000L, NxVirtualCameraClient.ParseStartTimeMs("2021-01-01T00:00:00"));

    [Fact]
    public void BadValueThrows()
        => Assert.Throws<ApiException>(() => NxVirtualCameraClient.ParseStartTimeMs("not-a-time"));
}

// ---------------------------------------------------------------------------
// BuildItemsPayload  (durationMs optional)
// ---------------------------------------------------------------------------

public class BuildItemsPayloadTests
{
    [Fact]
    public void HasExpectedFieldsAndOmitsDurationMsWhenNotProvided()
    {
        object payload = NxVirtualCameraClient.BuildItemsPayload(
            "clip.mkv", sizeB: 1234, md5Base64: "bWQ1", startTimeMs: 1700000000000, chunkSizeB: 1048576);
        string json = System.Text.Json.JsonSerializer.Serialize(payload);

        Assert.Contains("\"filename\":\"clip.mkv\"", json);
        Assert.Contains("\"sizeB\":1234", json);
        Assert.Contains("\"md5\":\"bWQ1\"", json);
        Assert.Contains("\"startTimeMs\":1700000000000", json);
        Assert.Contains("\"chunkSizeB\":1048576", json);
        Assert.DoesNotContain("durationMs", json);
        Assert.Contains("\"items\":[", json);
    }

    [Fact]
    public void IncludesDurationMsWhenProvided()
    {
        string json = System.Text.Json.JsonSerializer.Serialize(
            NxVirtualCameraClient.BuildItemsPayload(
                "clip.mkv", sizeB: 1234, md5Base64: "bWQ1", startTimeMs: 1700000000000,
                chunkSizeB: 1048576, durationMs: 30000));
        Assert.Contains("\"durationMs\":30000", json);
    }

    [Fact]
    public void OmitsDurationMsWhenZeroOrNegative()
    {
        string json = System.Text.Json.JsonSerializer.Serialize(
            NxVirtualCameraClient.BuildItemsPayload(
                "clip.mkv", 1, "bWQ1", 1, 1024, durationMs: 0));
        Assert.DoesNotContain("durationMs", json);
    }
}

// ---------------------------------------------------------------------------
// Defensive parsing
// ---------------------------------------------------------------------------

public class ParseDeviceIdTests
{
    [Fact]
    public void BareObject()
        => Assert.Equal("{dev-1}", NxVirtualCameraClient.ParseDeviceId("{\"id\":\"{dev-1}\",\"name\":\"x\"}"));

    [Fact]
    public void ReplyEnvelope()
        => Assert.Equal("{dev-2}", NxVirtualCameraClient.ParseDeviceId("{\"reply\":{\"id\":\"{dev-2}\"}}"));

    [Fact]
    public void SingleItemList()
        => Assert.Equal("{dev-3}", NxVirtualCameraClient.ParseDeviceId("[{\"id\":\"{dev-3}\"}]"));

    [Fact]
    public void MissingThrows()
        => Assert.Throws<ApiException>(() => NxVirtualCameraClient.ParseDeviceId("{\"name\":\"no id here\"}"));
}

public class ParseLockTokenTests
{
    [Fact]
    public void LockInfoToken()
        => Assert.Equal("lock-abc",
            NxVirtualCameraClient.ParseLockToken("{\"id\":\"d1\",\"lockInfo\":{\"token\":\"lock-abc\"}}"));

    [Fact]
    public void LockInfoTokenInReplyEnvelope()
        => Assert.Equal("lock-rep",
            NxVirtualCameraClient.ParseLockToken("{\"reply\":{\"lockInfo\":{\"token\":\"lock-rep\"}}}"));

    [Fact]
    public void TopLevelTokenFallback()
        => Assert.Equal("lock-xyz", NxVirtualCameraClient.ParseLockToken("{\"token\":\"lock-xyz\"}"));

    [Fact]
    public void TopLevelTokenInReplyEnvelope()
        => Assert.Equal("lock-env", NxVirtualCameraClient.ParseLockToken("{\"reply\":{\"token\":\"lock-env\"}}"));

    [Fact]
    public void MissingThrows()
        => Assert.Throws<ApiException>(() => NxVirtualCameraClient.ParseLockToken("{\"nope\":1}"));
}

public class ParseUploadItemTests
{
    [Fact]
    public void UsesServerChunkSize()
    {
        UploadInfo info = NxVirtualCameraClient.ParseUploadItem(
            "{\"items\":[{\"uploadId\":\"clip.mkv\",\"chunkSizeB\":4096}]}", 1048576, "clip.mkv");
        Assert.Equal("clip.mkv", info.UploadId);
        Assert.Equal(4096, info.ChunkSizeB);
    }

    [Fact]
    public void FallsBackToRequestedChunkSize()
    {
        UploadInfo info = NxVirtualCameraClient.ParseUploadItem(
            "{\"items\":[{\"filename\":\"clip.mkv\"}]}", 2048, "clip.mkv");
        Assert.Equal("clip.mkv", info.UploadId);
        Assert.Equal(2048, info.ChunkSizeB);
    }

    [Fact]
    public void BareListResponse()
    {
        UploadInfo info = NxVirtualCameraClient.ParseUploadItem(
            "[{\"uploadId\":\"clip.mkv\",\"chunkSizeB\":512}]", 2048, "clip.mkv");
        Assert.Equal("clip.mkv", info.UploadId);
        Assert.Equal(512, info.ChunkSizeB);
    }

    [Fact]
    public void InvalidChunkSizeFallsBack()
    {
        UploadInfo info = NxVirtualCameraClient.ParseUploadItem(
            "{\"items\":[{\"chunkSizeB\":\"garbage\"}]}", 999, "clip.mkv");
        Assert.Equal(999, info.ChunkSizeB);
    }
}

// ---------------------------------------------------------------------------
// Client: login
// ---------------------------------------------------------------------------

public class LoginTests
{
    [Fact]
    public async Task PostsCredentialsAndStoresToken()
    {
        var handler = new RecordingHandler(Responses.Ok("{\"token\":\"abc123\"}"));
        var client = new NxVirtualCameraClient(new HttpClient(handler), TestHelpers.Host);

        string token = await client.LoginAsync("admin", "pw");

        Assert.Equal("abc123", token);
        Assert.Equal(TestHelpers.Host + "/rest/v4/login/sessions", handler.Calls[0].Url);
        Assert.Contains("\"username\":\"admin\"", handler.Calls[0].Body);
        Assert.Contains("\"setCookie\":false", handler.Calls[0].Body);
    }

    [Fact]
    public async Task Rejected401ThrowsAuthException()
    {
        var handler = new RecordingHandler(Responses.Status(HttpStatusCode.Unauthorized, "bad"));
        var client = new NxVirtualCameraClient(new HttpClient(handler), TestHelpers.Host);
        await Assert.ThrowsAsync<AuthException>(() => client.LoginAsync("admin", "pw"));
    }
}

// ---------------------------------------------------------------------------
// Full happy-path orchestration: exact call sequence
// ---------------------------------------------------------------------------

public class OrchestrationTests
{
    [Fact]
    public async Task FullUploadCallSequence()
    {
        // File of 2.5 chunks (chunkSize 100, size 250) -> 3 PUTs with chunk=0,1,2.
        byte[] data = Enumerable.Repeat((byte)'x', 250).ToArray();
        string md5 = TestHelpers.Md5B64(data);
        string path = Path.Combine(Path.GetTempPath(), $"clip-{Guid.NewGuid():N}.mkv");
        File.WriteAllBytes(path, data);

        try
        {
            // Scripted responses in the exact order the client issues requests:
            // POST create -> PATCH lock -> POST create-upload -> PUT x3 -> GET status -> PATCH release.
            var handler = new RecordingHandler(
                Responses.Ok("{\"id\":\"{dev-1}\"}"),                                  // create virtual
                Responses.Ok("{\"lockInfo\":{\"token\":\"lock-1\"}}"),                 // lock
                Responses.Ok("{\"items\":[{\"uploadId\":\"clip.mkv\",\"chunkSizeB\":100}]}"), // create upload
                Responses.Ok("{}"),                                                    // PUT chunk 0
                Responses.Ok("{}"),                                                    // PUT chunk 1
                Responses.Ok("{}"),                                                    // PUT chunk 2
                Responses.Ok("{\"status\":\"consuming\"}"),                            // GET status
                Responses.Ok("{}"));                                                   // PATCH release

            var client = TestHelpers.MakeClient(handler);

            UploadResult result = await Orchestrator.UploadVideoAsync(
                client, path, name: "Cam", startTimeMs: 1700000000000,
                ttlMs: 300000, requestedChunkSize: 1048576, durationMs: 30000);

            // The uploadId echoed by the server happens to be "clip.mkv" here.
            string baseUrl = TestHelpers.Host + "/rest/v4/devices";
            var methodsUrls = handler.Calls.Select(c => (c.Method, c.Url)).ToList();
            // No deprecated /virtual/consume call: status is read from the uploads
            // endpoint and the import auto-starts on completion.
            Assert.Equal(new (string, string)[]
            {
                ("POST", baseUrl + "/*/virtual"),
                ("PATCH", baseUrl + "/{dev-1}/virtual/lock"),
                ("POST", baseUrl + "/{dev-1}/virtual/uploads"),
                ("PUT", baseUrl + "/{dev-1}/virtual/uploads/clip.mkv?chunk=0"),
                ("PUT", baseUrl + "/{dev-1}/virtual/uploads/clip.mkv?chunk=1"),
                ("PUT", baseUrl + "/{dev-1}/virtual/uploads/clip.mkv?chunk=2"),
                ("GET", baseUrl + "/{dev-1}/virtual/uploads/clip.mkv"),
                ("PATCH", baseUrl + "/{dev-1}/virtual/release"),
            }, methodsUrls);

            // No consume URL anywhere.
            Assert.DoesNotContain(handler.Calls, c => c.Url.Contains("/virtual/consume"));

            // Bodies on the way through.
            Assert.Contains("\"name\":\"Cam\"", handler.Calls[0].Body);
            Assert.Contains("\"ttlMs\":300000", handler.Calls[1].Body);

            string createUploadBody = handler.Calls[2].Body;
            // filename is the real file's basename (clip-<guid>.mkv); "clip.mkv" is
            // only the server-echoed uploadId, which lives in the PUT/GET URLs.
            Assert.Contains("\"filename\":\"" + Path.GetFileName(path) + "\"", createUploadBody);
            Assert.Contains("\"sizeB\":250", createUploadBody);
            Assert.Contains("\"md5\":\"" + md5 + "\"", createUploadBody);
            Assert.Contains("\"startTimeMs\":1700000000000", createUploadBody);
            Assert.Contains("\"chunkSizeB\":1048576", createUploadBody);
            Assert.Contains("\"durationMs\":30000", createUploadBody);

            // PUT chunks: octet-stream, correct lengths (100, 100, 50).
            var puts = handler.Calls.Where(c => c.Method == "PUT").ToList();
            Assert.Equal(new[] { 100, 100, 50 }, puts.Select(p => p.BodyBytes.Length));
            Assert.All(puts, p => Assert.Equal("application/octet-stream", p.ContentType));

            // Release body carries the lock token.
            Assert.Contains("\"token\":\"lock-1\"", handler.Calls[7].Body);

            // Bearer attached to every authenticated call.
            Assert.All(handler.Calls, c => Assert.Equal("Bearer tok", c.Auth));

            Assert.Equal("{dev-1}", result.DeviceId);
            Assert.Equal(3, result.ChunkCount);
            Assert.Equal(100, result.ChunkSizeB);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public async Task ExistingDeviceSkipsCreate()
    {
        byte[] data = Enumerable.Repeat((byte)'y', 50).ToArray();
        string path = Path.Combine(Path.GetTempPath(), $"clip-{Guid.NewGuid():N}.mp4");
        File.WriteAllBytes(path, data);

        try
        {
            var handler = new RecordingHandler(
                Responses.Ok("{\"token\":\"L\"}"),                          // lock (top-level token)
                Responses.Ok("{\"items\":[{\"uploadId\":\"clip.mp4\"}]}"),  // create upload
                Responses.Ok("{}"),                                          // PUT chunk 0
                Responses.Ok("{}"),                                          // GET status
                Responses.Ok("{}"));                                         // PATCH release

            var client = TestHelpers.MakeClient(handler);

            await Orchestrator.UploadVideoAsync(
                client, path, name: "ignored", startTimeMs: 1, ttlMs: 1000,
                requestedChunkSize: 1024, deviceId: "{existing}");

            string baseUrl = TestHelpers.Host + "/rest/v4/devices";
            // No create-virtual POST; first call is the lock.
            Assert.Equal(("PATCH", baseUrl + "/{existing}/virtual/lock"),
                (handler.Calls[0].Method, handler.Calls[0].Url));
            Assert.DoesNotContain(handler.Calls, c => c.Url == baseUrl + "/*/virtual");
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public async Task Login401ThrowsAuthException()
    {
        var handler = new RecordingHandler(Responses.Status(HttpStatusCode.Unauthorized, "no"));
        var client = new NxVirtualCameraClient(new HttpClient(handler), TestHelpers.Host);
        await Assert.ThrowsAsync<AuthException>(() => client.LoginAsync("admin", "pw"));
    }

    [Fact]
    public async Task ReleaseCalledEvenWhenAStepFails()
    {
        byte[] data = Enumerable.Repeat((byte)'z', 10).ToArray();
        string path = Path.Combine(Path.GetTempPath(), $"clip-{Guid.NewGuid():N}.mkv");
        File.WriteAllBytes(path, data);

        try
        {
            var handler = new RecordingHandler(
                Responses.Ok("{\"id\":\"{dev-9}\"}"),                       // create virtual
                Responses.Ok("{\"lockInfo\":{\"token\":\"lock-9\"}}"),      // lock OK
                Responses.Ok("{\"items\":[{\"uploadId\":\"clip.mkv\"}]}"),  // create upload
                Responses.Ok("{}"),                                          // PUT chunk 0
                Responses.Status(HttpStatusCode.InternalServerError, "status boom"), // GET status FAILS
                Responses.Ok("{}"));                                         // PATCH release still runs

            var client = TestHelpers.MakeClient(handler);

            await Assert.ThrowsAsync<ApiException>(() => Orchestrator.UploadVideoAsync(
                client, path, name: "Cam", startTimeMs: 1, ttlMs: 1000, requestedChunkSize: 1024));

            string baseUrl = TestHelpers.Host + "/rest/v4/devices";
            var releaseCalls = handler.Calls
                .Where(c => c.Method == "PATCH" && c.Url.EndsWith("/release"))
                .ToList();
            Assert.Single(releaseCalls);
            Assert.Equal(baseUrl + "/{dev-9}/virtual/release", releaseCalls[0].Url);
            Assert.Contains("\"token\":\"lock-9\"", releaseCalls[0].Body);
        }
        finally
        {
            File.Delete(path);
        }
    }
}

// ---------------------------------------------------------------------------
// LoggingHandler (--debug wiretap)
// ---------------------------------------------------------------------------

public class LoggingHandlerTests
{
    [Fact]
    public async Task LogsRequestAndResponseAndStillForwardsBody()
    {
        var inner = new RecordingHandler(Responses.Ok("{\"id\":\"{dev-1}\"}"));
        var sw = new StringWriter();
        var http = new HttpClient(new LoggingHandler(inner, sw));
        var client = new NxVirtualCameraClient(http, TestHelpers.Host);
        client.UseToken("tok");

        // The call still works (response body is buffered, not consumed by logging).
        string id = await client.CreateVirtualDeviceAsync("Cam");
        Assert.Equal("{dev-1}", id);

        string log = sw.ToString();
        Assert.Contains("POST", log);
        Assert.Contains("/rest/v4/devices/*/virtual", log);
        Assert.Contains("Authorization: Bearer <hidden>", log);   // bearer redacted
        Assert.Contains("\"name\":\"Cam\"", log);                 // request body logged
        Assert.Contains("200", log);                              // response status
        Assert.Contains("{\"id\":\"{dev-1}\"}", log);             // response body logged
    }

    [Fact]
    public async Task SummarizesBinaryChunkBodyAsByteCount()
    {
        var inner = new RecordingHandler(Responses.Ok("{}"));
        var sw = new StringWriter();
        var http = new HttpClient(new LoggingHandler(inner, sw));
        var client = new NxVirtualCameraClient(http, TestHelpers.Host);
        client.UseToken("tok");

        await client.UploadChunkAsync("{dev-1}", "up-1", index: 0, dataBytes: new byte[2048]);

        string log = sw.ToString();
        Assert.Contains("PUT", log);
        Assert.Contains("application/octet-stream", log);
        Assert.DoesNotContain(new string('\0', 16), log);   // raw bytes not dumped
    }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

public class ConfigTests
{
    [Fact]
    public void ParsesFlags_IncludingUploadOptions()
    {
        var a = Config.ParseArgs(new[]
        {
            "--file", "clip.mkv", "--name=Front Door", "--ttl", "600",
            "--chunk-size", "2097152", "--start-time", "2026-06-16T00:00:00Z",
            "--duration-ms", "30000", "--server-host", "https://srv:7001", "--insecure", "--debug",
        });
        Assert.Equal("clip.mkv", a.File);
        Assert.Equal("Front Door", a.Name);
        Assert.Equal(600L, a.Ttl);
        Assert.Equal(2097152, a.ChunkSize);
        Assert.Equal("2026-06-16T00:00:00Z", a.StartTime);
        Assert.Equal(30000L, a.DurationMs);
        Assert.Equal("https://srv:7001", a.Host);
        Assert.True(a.Insecure);
        Assert.True(a.Debug);
    }

    [Fact]
    public void UnknownArgThrows()
        => Assert.Throws<ArgumentException>(() => Config.ParseArgs(new[] { "--nope" }));

    [Fact]
    public void ResolveCliBeatsEnvFile()
    {
        var cfg = Config.Resolve(
            new CliArgs { Host = "https://cli:7001" },
            new Dictionary<string, string> { ["NX_SERVER_HOST"] = "https://file:7001" });
        Assert.Equal("https://cli:7001", cfg.Host);
    }
}
