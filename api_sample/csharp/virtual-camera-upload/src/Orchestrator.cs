// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// The full create -> create-upload -> chunk PUTs -> upload status -> lock ->
// consume -> extend(poll) -> release sequence, separated from the client so it is
// easy to test end-to-end.
//
// The file is uploaded to the server BEFORE the device is locked: create-upload
// and the chunk PUTs take no lock and need none. Only the IMPORT of those bytes
// into the archive needs the lock, so the lock window stays short. The import is
// started explicitly with PATCH .../virtual/consume -- the updated spec does NOT
// mark `lock`, `consume`, or `extend` deprecated, and nothing starts importing on
// its own when the last chunk lands.
//
// On any failure once the upload exists, the upload is best-effort cancelled
// (DELETE .../virtual/uploads/{uploadId}) BEFORE the lock (if one was acquired)
// is released in the finally block, so a failed run leaves nothing orphaned.

namespace NxVirtualCameraUpload;

public static class Orchestrator
{
    /// <summary>Poll `.../virtual/extend` until lockInfo.progress reaches 100.
    ///
    /// Each extend call both renews the lock (so it cannot expire mid-import) and
    /// reports progress. Throws <see cref="ApiException"/> if the timeout elapses
    /// first.
    ///
    /// `delayAsync` and `clockSeconds` are injectable so tests never really sleep:
    /// they default to Task.Delay and a monotonic tick count.</summary>
    public static async Task<int> WaitForConsumeAsync(
        NxVirtualCameraClient client,
        string deviceId,
        string lockToken,
        long ttlMs,
        double pollIntervalSeconds,
        double consumeTimeoutSeconds,
        Func<TimeSpan, CancellationToken, Task>? delayAsync = null,
        Func<double>? clockSeconds = null,
        Action<string>? onProgress = null,
        CancellationToken cancellationToken = default)
    {
        Func<TimeSpan, CancellationToken, Task> delay = delayAsync ?? DefaultDelayAsync;
        Func<double> clock = clockSeconds ?? DefaultClockSeconds;

        double deadline = clock() + consumeTimeoutSeconds;
        int progress = 0;
        while (progress < 100)
        {
            if (clock() >= deadline)
            {
                throw new ApiException(
                    $"Consume did not reach 100% within {consumeTimeoutSeconds}s "
                    + $"(last progress: {progress}%).");
            }
            await delay(TimeSpan.FromSeconds(pollIntervalSeconds), cancellationToken);
            string json = await client.ExtendAsync(deviceId, lockToken, ttlMs, cancellationToken);
            progress = NxVirtualCameraClient.ParseLockProgress(json, progress);
            onProgress?.Invoke($"Consume progress: {progress}%");
        }
        return progress;
    }

    /// <summary>Real waiting: used when the caller injects nothing.</summary>
    private static Task DefaultDelayAsync(TimeSpan span, CancellationToken cancellationToken)
        => Task.Delay(span, cancellationToken);

    /// <summary>Monotonic seconds; not wall-clock, so it is immune to clock changes.</summary>
    private static double DefaultClockSeconds() => Environment.TickCount64 / 1000.0;

    public static async Task<UploadResult> UploadVideoAsync(
        NxVirtualCameraClient client,
        string filePath,
        string name,
        long startTimeMs,
        long ttlMs,
        int requestedChunkSize,
        long? durationMs = null,
        string? deviceId = null,
        double pollIntervalSeconds = NxVirtualCameraClient.DefaultPollIntervalSeconds,
        double consumeTimeoutSeconds = NxVirtualCameraClient.DefaultConsumeTimeoutSeconds,
        Func<TimeSpan, CancellationToken, Task>? delayAsync = null,
        Func<double>? clockSeconds = null,
        Action<string>? onProgress = null,
        CancellationToken cancellationToken = default)
    {
        void Note(string message) => onProgress?.Invoke(message);

        long sizeB = new FileInfo(filePath).Length;
        string md5Base64 = NxVirtualCameraClient.FileMd5Base64(filePath);
        string filename = Path.GetFileName(filePath);

        if (deviceId is null)
        {
            deviceId = await client.CreateVirtualDeviceAsync(name, cancellationToken);
            Note($"Created virtual device {deviceId}");
        }
        else
        {
            Note($"Using existing virtual device {deviceId}");
        }

        UploadInfo info = await client.CreateUploadAsync(
            deviceId, filename, sizeB, md5Base64, startTimeMs, requestedChunkSize,
            durationMs, cancellationToken);
        string uploadId = info.UploadId;
        int serverChunkSize = info.ChunkSizeB;

        int chunkCount = 0;
        int progress = 0;
        string? lockToken = null;
        try
        {
            foreach ((int index, byte[] data) in NxVirtualCameraClient.IterFileChunks(filePath, serverChunkSize))
            {
                await client.UploadChunkAsync(deviceId, uploadId, index, data, cancellationToken);
                chunkCount += 1;
            }
            Note($"{chunkCount} chunk(s) uploaded ({serverChunkSize} B each)");

            int uploadProgress = NxVirtualCameraClient.ParseUploadProgress(
                await client.UploadStatusAsync(deviceId, uploadId, cancellationToken));
            if (uploadProgress < 100)
            {
                throw new ApiException(
                    $"Upload did not complete: server reports uploadProgressPercent={uploadProgress}.");
            }
            Note("Upload confirmed complete");

            lockToken = await client.LockDeviceAsync(deviceId, ttlMs, cancellationToken);
            Note("Lock acquired");

            await client.ConsumeAsync(deviceId, lockToken, uploadId, startTimeMs, cancellationToken);
            Note("Consume started");

            progress = await WaitForConsumeAsync(
                client, deviceId, lockToken, ttlMs, pollIntervalSeconds, consumeTimeoutSeconds,
                delayAsync, clockSeconds, Note, cancellationToken);
        }
        catch
        {
            try
            {
                await client.CancelUploadAsync(deviceId, uploadId, cancellationToken);
                Note("Cancelled upload after failure");
            }
            catch
            {
                // Best-effort cleanup; do not mask the original error.
            }
            throw;
        }
        finally
        {
            if (lockToken is not null)
            {
                await client.ReleaseAsync(deviceId, lockToken, cancellationToken);
                Note("Released");
            }
        }

        return new UploadResult(
            DeviceId: deviceId,
            UploadId: uploadId,
            ChunkCount: chunkCount,
            ChunkSizeB: serverChunkSize,
            SizeB: sizeB,
            StartTimeMs: startTimeMs,
            ConsumeProgress: progress);
    }
}
