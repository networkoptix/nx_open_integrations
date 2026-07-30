// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Optional --debug "wiretap". When enabled, the HttpClient is built around this
// DelegatingHandler, which prints every request and response — method, URL, headers,
// and body — to a TextWriter (stderr by default). Use it to see exactly what the
// sample sends to the server and what the server sends back.
//
// Bodies: JSON is printed verbatim (so you can confirm the create-upload item,
// incl. durationMs when provided). Binary chunk bodies (application/octet-stream)
// are summarized as a byte
// count so a large video upload doesn't flood the console. The Authorization bearer is
// shown as present but its value is hidden.

namespace NxVirtualCameraUpload;

public sealed class LoggingHandler : DelegatingHandler
{
    private const int MaxBody = 4000;
    private readonly TextWriter _out;

    public LoggingHandler(HttpMessageHandler inner, TextWriter? output = null) : base(inner)
        => _out = output ?? Console.Error;

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        _out.WriteLine($"--> {request.Method} {request.RequestUri}");
        if (request.Headers.Authorization is { } auth)
        {
            _out.WriteLine($"    Authorization: {auth.Scheme} <hidden>");
        }
        if (request.Content is { } reqContent)
        {
            _out.WriteLine($"    body: {await DescribeAsync(reqContent)}");
        }

        HttpResponseMessage response = await base.SendAsync(request, cancellationToken);

        _out.WriteLine(
            $"<-- {(int)response.StatusCode} {response.ReasonPhrase} "
            + $"({request.Method} {request.RequestUri})");
        if (response.Content is { } respContent)
        {
            // Buffer the body so logging it here doesn't consume the stream the
            // caller still needs to read.
            await respContent.LoadIntoBufferAsync();
            _out.WriteLine($"    body: {await DescribeAsync(respContent)}");
        }
        _out.WriteLine(string.Empty);
        return response;
    }

    private static async Task<string> DescribeAsync(HttpContent content)
    {
        string? type = content.Headers.ContentType?.MediaType;
        if (type is not null && type.Contains("octet-stream", StringComparison.OrdinalIgnoreCase))
        {
            long? len = content.Headers.ContentLength;
            return $"<{(len?.ToString() ?? "?")} bytes {type}>";
        }
        string body = (await content.ReadAsStringAsync()).Trim();
        if (body.Length == 0) return "<empty>";
        return body.Length <= MaxBody ? body : body[..MaxBody] + " …(truncated)";
    }
}
