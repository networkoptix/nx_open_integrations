// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// CLI wiring only: parse args, build an HttpClient, log in to one VMS server,
// list its cameras, log out. The API logic lives in NxServerClient.cs.

namespace NxListCameras;

public static class Program
{
    public static async Task<int> Main(string[] argv)
    {
        CliArgs args;
        try
        {
            args = Config.ParseArgs(argv);
        }
        catch (ArgumentException ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 2;
        }

        AppConfig config = Config.Resolve(args, DotEnv.Load(args.EnvFile));

        var missing = new List<string>();
        if (string.IsNullOrEmpty(config.Host)) missing.Add("host");
        if (string.IsNullOrEmpty(config.User)) missing.Add("user");
        if (string.IsNullOrEmpty(config.Password)) missing.Add("password");
        if (missing.Count > 0)
        {
            Console.Error.WriteLine($"Missing config: {string.Join(", ", missing)}.");
            Console.Error.WriteLine("Provide via flags or .env (copy .env.example). See the README.");
            return 2;
        }

        using HttpClient http = BuildHttpClient(args.Insecure);
        var client = new NxServerClient(http, config.Host!);

        try
        {
            await client.LoginAsync(config.User!, config.Password!);
            Console.WriteLine($"Logged in to {config.Host} as {config.User}");
            Console.WriteLine();
            IReadOnlyList<Camera> cameras = await client.ListCamerasAsync();
            Console.WriteLine(NxServerClient.FormatCamerasTable(cameras));
            return 0;
        }
        catch (AuthException ex)
        {
            Console.Error.WriteLine($"Login failed: {ex.Message}");
            return 1;
        }
        catch (ApiException ex)
        {
            Console.Error.WriteLine($"Error: {ex.Message}");
            return 1;
        }
        finally
        {
            // Always try to release the session token, even on error.
            await client.LogoutAsync();
        }
    }

    private static HttpClient BuildHttpClient(bool insecure)
    {
        var handler = new HttpClientHandler();
        if (insecure)
        {
            // Lab/self-signed servers: skip TLS verification.
            handler.ServerCertificateCustomValidationCallback =
                HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;
        }
        return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(15) };
    }
}
