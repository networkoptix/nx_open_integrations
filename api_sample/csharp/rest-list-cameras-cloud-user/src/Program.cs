// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// CLI wiring only: parse args, build an HttpClient (auto-redirect OFF so the
// client can follow the relay's 307 itself), log in, list cameras, log out.
// The API logic lives in NxCloudSiteClient.cs.

namespace NxListCamerasCloud;

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
        if (string.IsNullOrEmpty(config.CloudHost)) missing.Add("cloud-host");
        if (string.IsNullOrEmpty(config.User)) missing.Add("user");
        if (string.IsNullOrEmpty(config.Password)) missing.Add("password");
        if (string.IsNullOrEmpty(config.SiteId)) missing.Add("site-id");
        if (missing.Count > 0)
        {
            Console.Error.WriteLine($"Missing config: {string.Join(", ", missing)}.");
            Console.Error.WriteLine("Provide via flags or .env (copy .env.example). See the README.");
            return 2;
        }

        using HttpClient http = BuildHttpClient(args.Insecure);
        var client = new NxCloudSiteClient(http, config.CloudHost!, config.SiteId!);

        try
        {
            await client.LoginAsync(config.User!, config.Password!, config.MfaCode);
            Console.WriteLine($"Got site-scoped token for {config.SiteId}");
            Console.WriteLine();
            IReadOnlyList<Camera> cameras = await client.ListCamerasAsync();
            Console.WriteLine(NxCloudSiteClient.FormatCamerasTable(cameras));
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
            await client.LogoutAsync();
        }
    }

    private static HttpClient BuildHttpClient(bool insecure)
    {
        // AllowAutoRedirect = false: we follow the relay's 307 ourselves so the
        // Authorization header is re-attached across the cross-host hop.
        var handler = new HttpClientHandler { AllowAutoRedirect = false };
        if (insecure)
        {
            handler.ServerCertificateCustomValidationCallback =
                HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;
        }
        return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(15) };
    }
}
