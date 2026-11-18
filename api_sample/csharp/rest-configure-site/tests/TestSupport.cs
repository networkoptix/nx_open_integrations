// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// Shared fakes for the offline tests: a recording HttpMessageHandler for the two
// clients, and fake clients (with a shared call log) for the flow and the CLI.
// Nothing here touches a server, the Cloud or the network.

using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using NxConfigureSite;

namespace NxConfigureSite.Tests;

internal sealed record HttpCall(string Method, string Url, string? Auth, string? Body);

/// <summary>
/// Records every request, and answers from a script keyed on method and URL
/// suffix. An unscripted request is answered with 200 and an empty JSON object.
/// Like a real server, it answers 401 to a site/setup request that carries no
/// Authorization header, whatever the script says.
/// </summary>
internal sealed class RecordingHandler : HttpMessageHandler
{
    private readonly List<(string Method, string Suffix, Func<HttpResponseMessage> Respond)> _script = new();
    public List<HttpCall> Calls { get; } = new();

    public RecordingHandler On(string method, string suffix, int status, string? json = null, string text = "")
    {
        _script.Add((method, suffix, () => Reply(status, json, text)));
        return this;
    }

    /// <summary>Answer with a reply built by the test, for example one with headers.</summary>
    public RecordingHandler On(string method, string suffix, Func<HttpResponseMessage> respond)
    {
        _script.Add((method, suffix, respond));
        return this;
    }

    public static HttpResponseMessage Reply(int status, string? json = null, string text = "")
    {
        string content = json ?? (text.Length > 0 ? text : "{}");
        return new HttpResponseMessage((HttpStatusCode)status)
        {
            Content = new StringContent(content, Encoding.UTF8, "application/json"),
        };
    }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        string? body = request.Content is null
            ? null
            : await request.Content.ReadAsStringAsync(cancellationToken);
        string url = request.RequestUri!.ToString();
        Calls.Add(new HttpCall(request.Method.Method, url, request.Headers.Authorization?.ToString(), body));

        if (url.EndsWith("/site/setup", StringComparison.Ordinal) && request.Headers.Authorization is null)
        {
            // What a real server does: site/setup needs an administrator.
            return Reply(401, text: "Unauthorized");
        }

        foreach (var (method, suffix, respond) in _script)
        {
            if (request.Method.Method == method && url.EndsWith(suffix, StringComparison.Ordinal))
            {
                return respond();
            }
        }
        return Reply(200);
    }
}

/// <summary>
/// A real HTTP server on 127.0.0.1, for the few tests that must go through a real
/// HttpClientHandler (to show that a redirect is not followed). It records each
/// request as "METHOD /path" and answers it with what respond returns.
/// </summary>
internal sealed class LoopbackServer : IDisposable
{
    private readonly HttpListener _listener = new();
    private readonly List<string> _requests = new();

    public string Url { get; }

    public List<string> Requests
    {
        get { lock (_requests) return new List<string>(_requests); }
    }

    public LoopbackServer(Func<string, (int Status, string? Location, string Body)> respond)
    {
        int port;
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();

        Url = $"http://127.0.0.1:{port}";
        _listener.Prefixes.Add(Url + "/");
        _listener.Start();
        _ = Task.Run(async () =>
        {
            while (_listener.IsListening)
            {
                HttpListenerContext context;
                try
                {
                    context = await _listener.GetContextAsync();
                }
                catch (Exception error) when (error is HttpListenerException or ObjectDisposedException)
                {
                    return;
                }
                string path = context.Request.Url!.AbsolutePath;
                lock (_requests) _requests.Add($"{context.Request.HttpMethod} {path}");
                var (status, location, body) = respond(path);
                context.Response.StatusCode = status;
                if (location is not null) context.Response.RedirectLocation = location;
                byte[] bytes = Encoding.UTF8.GetBytes(body);
                context.Response.ContentType = "application/json";
                context.Response.ContentLength64 = bytes.Length;
                await context.Response.OutputStream.WriteAsync(bytes);
                context.Response.Close();
            }
        });
    }

    public void Dispose() => _listener.Close();
}

internal static class Json
{
    /// <summary>True when the JSON text equals the expected JSON, ignoring key order.</summary>
    public static bool Same(string? actual, string expected)
        => actual is not null && JsonNode.DeepEquals(JsonNode.Parse(actual), JsonNode.Parse(expected));

    public static bool Has(string? actual, string key)
        => actual is not null && JsonNode.Parse(actual)!.AsObject().ContainsKey(key);
}

internal static class Clients
{
    public static (NxServerClient Client, HttpClient Http, RecordingHandler Handler) Server(RecordingHandler? handler = null)
    {
        handler ??= new RecordingHandler();
        var http = new HttpClient(handler);
        return (new NxServerClient(http, "https://server:7001"), http, handler);
    }

    public static (NxCloudClient Client, HttpClient Http, RecordingHandler Handler) Cloud(RecordingHandler? handler = null)
    {
        handler ??= new RecordingHandler();
        var http = new HttpClient(handler);
        return (new NxCloudClient(http, "https://cloud.example.com"), http, handler);
    }
}

internal static class Settings
{
    public static Dictionary<string, bool> ThreeTrue() => new()
    {
        ["autoDiscoveryEnabled"] = true,
        ["cameraSettingsOptimization"] = true,
        ["statisticsAllowed"] = true,
    };
}

/// <summary>A fresh temporary folder per test, removed afterwards.</summary>
public abstract class TempDirTest : IDisposable
{
    protected string Dir { get; } = Directory.CreateTempSubdirectory("nx-configure-site-").FullName;

    protected string PathIn(string name) => Path.Combine(Dir, name);

    public void Dispose()
    {
        if (Directory.Exists(Dir)) Directory.Delete(Dir, recursive: true);
    }
}

internal sealed record Call(string Name, string?[] Args);

internal static class LogExtensions
{
    public static List<string> Names(this List<Call> log) => log.Select(c => c.Name).ToList();

    public static bool Has(this List<Call> log, string name, params string?[] args)
        => log.Any(c => c.Name == name && c.Args.SequenceEqual(args));
}

/// <summary>
/// Records the order of calls. Fail names a method that throws ApiException.
///
/// Info is what site/info answers: no LocalId is a factory-default server, a
/// LocalId makes it a server that already belongs to a site, a CloudId a bound one.
/// Every one of them also reports what every server does: the Cloud it belongs
/// to and its brand (CloudHost and Customization).
/// </summary>
internal sealed class FakeServer : IServerApi
{
    public static readonly SiteInfo New = new(null, null, null, "cloud.example.com", "default");
    public static readonly SiteInfo Existing = New with { LocalId = "{1b2c}", Name = "Front Office" };
    public static readonly SiteInfo ExistingBound = Existing with { CloudId = "cloud-site-9" };

    public List<Call> Log { get; }
    public SiteInfo Info { get; set; } = New;
    // A login with one of these passwords is rejected with an AuthException.
    public string[] RejectedPasswords { get; set; } = Array.Empty<string>();
    public string? Fail { get; set; }
    public Exception? InfoError { get; set; }
    // Thrown by a login with any password but the factory one.
    public Exception? LoginError { get; set; }
    // Thrown by the logout made after the run (once settings were applied), not
    // by the one between setup and the second login.
    public Exception? LogoutError { get; set; }
    public bool LoggedOut { get; private set; }
    public string? Token { get; private set; }
    public string Host { get; set; } = "";
    public bool VerifyTls { get; set; } = true;
    public IReadOnlyDictionary<string, bool>? SetupSettings { get; private set; }
    public CloudAuth? SetupCloud { get; private set; }
    public IReadOnlyDictionary<string, bool>? AppliedSettings { get; private set; }

    public FakeServer(List<Call>? log = null) => Log = log ?? new List<Call>();

    private void Do(string name, params string?[] args)
    {
        Log.Add(new Call(name, args));
        if (Fail == name) throw new ApiException($"{name} failed");
    }

    public Task<SiteInfo> GetSiteInfoAsync(CancellationToken cancellationToken = default)
    {
        Do("server.get_site_info");
        if (InfoError is not null) throw InfoError;
        return Task.FromResult(Info);
    }

    public Task SetupAsync(
        string siteName, string? adminPassword, IReadOnlyDictionary<string, bool> settings,
        CloudAuth? cloud = null, CancellationToken cancellationToken = default)
    {
        if (cloud is null) Do("server.setup", siteName, adminPassword);
        else Do("server.setup", siteName, adminPassword,
            cloud.AuthKey, cloud.Owner, cloud.SiteId, cloud.OrganizationId);
        SetupCloud = cloud;
        if (Token is null) throw new InvalidOperationException("site/setup was called without a login");
        SetupSettings = settings;
        return Task.CompletedTask;
    }

    public Task<string> LoginAsync(string username, string password, CancellationToken cancellationToken = default)
    {
        Do("server.login", username, password);
        if (LoginError is not null && password != SiteFlow.FactoryPassword) throw LoginError;
        if (RejectedPasswords.Contains(password))
        {
            throw new AuthException("Login rejected (HTTP 401). Check the user name and password.");
        }
        Token = "tok";
        return Task.FromResult(Token);
    }

    public Task CloudBindAsync(
        string authKey, string owner, string siteId, string? organizationId = null,
        CancellationToken cancellationToken = default)
    {
        Do("server.cloud_bind", authKey, owner, siteId, organizationId);
        return Task.CompletedTask;
    }

    public Task<Dictionary<string, bool>> ApplySettingsAsync(
        IReadOnlyDictionary<string, bool> wanted, CancellationToken cancellationToken = default)
    {
        Do("server.apply_settings");
        AppliedSettings = wanted;
        return Task.FromResult(new Dictionary<string, bool> { ["statisticsAllowed"] = false });
    }

    public Task LogoutAsync(CancellationToken cancellationToken = default)
    {
        Log.Add(new Call("server.logout", Array.Empty<string?>()));
        Token = null;
        LoggedOut = true;
        if (LogoutError is not null && Log.Names().Contains("server.apply_settings")) throw LogoutError;
        return Task.CompletedTask;
    }
}

/// <summary>
/// Also stands in for the makeCloud factory: Make records the URL the flow chose
/// (and, from Program, whether TLS is verified) and returns the fake itself.
/// </summary>
internal sealed class FakeCloud : ICloudApi
{
    public List<Call> Log { get; }
    public string? Fail { get; set; }
    public string? Url { get; private set; }
    public bool? VerifyTls { get; private set; }

    public ICloudApi Make(string url)
    {
        Url = url;
        return this;
    }

    public ICloudApi Make(string url, bool verifyTls)
    {
        VerifyTls = verifyTls;
        return Make(url);
    }

    public FakeCloud(List<Call>? log = null) => Log = log ?? new List<Call>();

    private void Do(string name, params string?[] args)
    {
        Log.Add(new Call(name, args));
        if (Fail == name) throw new ApiException($"{name} failed");
    }

    public Func<Task<string?>>? GetMfaCode { get; private set; }

    public Task<string> LoginAsync(
        string username, string password, Func<Task<string?>>? getMfaCode = null,
        CancellationToken cancellationToken = default)
    {
        Do("cloud.login", username, password);
        GetMfaCode = getMfaCode;
        return Task.FromResult("cloud-tok");
    }

    public Task<RegisteredSite> RegisterSiteAsync(
        string siteName, string customization, string? organizationId = null,
        CancellationToken cancellationToken = default)
    {
        Do("cloud.register_site", siteName, customization, organizationId);
        return Task.FromResult(new RegisteredSite("site-id-1", "auth-key-1"));
    }

    public bool LoggedOut { get; private set; }

    public Task LogoutAsync(CancellationToken cancellationToken = default)
    {
        Log.Add(new Call("cloud.logout", Array.Empty<string?>()));
        LoggedOut = true;
        return Task.CompletedTask;
    }
}
