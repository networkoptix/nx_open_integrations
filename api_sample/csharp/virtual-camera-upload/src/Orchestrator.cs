// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// The full create -> lock -> create-upload -> chunk PUTs -> status -> release
// sequence, separated from the client so it is easy to test end-to-end. There is
// NO explicit consume step: PATCH .../virtual/consume is deprecated, and the
// import starts automatically once all chunks reach the .../virtual/uploads/
// {uploadId} endpoint (footage placement comes from the startTimeMs given at
// create-upload). We GET that endpoint to report status. The lock is always
// released in a finally block, even if a step fails.

namespace NxVirtualCameraUpload;

public static class Orchestrator
{
    public static async Task<UploadResult> UploadVideoAsync(
        NxVirtualCameraClient client,
        string filePath,
        string name,
        long startTimeMs,
        long ttlMs,
        int requestedChunkSize,
        long? durationMs = null,
        string? deviceId = null,
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

        string lockToken = await client.LockDeviceAsync(deviceId, ttlMs, cancellationToken);
        Note("Lock acquired");

        string uploadId = filename;
        int serverChunkSize = requestedChunkSize;
        int chunkCount = 0;
        string? status = null;
        try
        {
            UploadInfo info = await client.CreateUploadAsync(
                deviceId, filename, sizeB, md5Base64, startTimeMs, requestedChunkSize, durationMs, cancellationToken);
            uploadId = info.UploadId;
            serverChunkSize = info.ChunkSizeB;

            foreach ((int index, byte[] data) in NxVirtualCameraClient.IterFileChunks(filePath, serverChunkSize))
            {
                await client.UploadChunkAsync(deviceId, uploadId, index, data, cancellationToken);
                chunkCount += 1;
            }
            Note($"{chunkCount} chunk(s) uploaded ({serverChunkSize} B each)");

            // No consume call (deprecated): the import auto-starts on completion.
            status = await client.UploadStatusAsync(deviceId, uploadId, cancellationToken);
            Note($"Upload complete; server is importing footage at {startTimeMs}ms");
        }
        finally
        {
            await client.ReleaseAsync(deviceId, lockToken, cancellationToken);
            Note("Released");
        }

        return new UploadResult(
            DeviceId: deviceId,
            UploadId: uploadId,
            ChunkCount: chunkCount,
            ChunkSizeB: serverChunkSize,
            SizeB: sizeB,
            StartTimeMs: startTimeMs,
            Status: status);
    }
}
