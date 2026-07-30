// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// CLI wiring only: parse args, build an HttpClient, log in, list the Sites,
// print a table. The API logic lives in NxCloudOAuthClient.cs.

using System.Text.Json;

namespace NxOauth2ListSystems;

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
        var client = new NxCloudOAuthClient(http, config.Host!);

        try
        {
            await client.LoginAsync(config.User!, config.Password!, config.MfaCode, config.CloudSiteId);
            Console.WriteLine($"Logged in as: {config.User} (bearer token acquired)");
            Console.WriteLine();

            List<JsonElement> sites = await client.ListSystemsAsync();

            if (args.Debug)
            {
                Console.Error.WriteLine("--- raw /cdb/systems response ---");
                Console.Error.WriteLine(Truncate(client.LastRaw ?? "", 4000));
                Console.Error.WriteLine("--- end raw ---");
                Console.Error.WriteLine();
            }

            Console.WriteLine(SystemsTable.Format(sites));
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
    }

    private static HttpClient BuildHttpClient(bool insecure)
    {
        var handler = new HttpClientHandler();
        if (insecure)
        {
            // Lab only: trust any TLS certificate (e.g. a self-signed relay/site).
            handler.ServerCertificateCustomValidationCallback =
                HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;
        }
        return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(15) };
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
