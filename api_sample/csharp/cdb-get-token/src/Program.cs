// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// CLI wiring only: parse args, build an HttpClient, call NxCloudTokenClient,
// print the token. The API logic lives in NxCloudTokenClient.cs.

namespace NxGetToken;

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
        var client = new NxCloudTokenClient(http);

        TokenResult result;
        try
        {
            result = await client.GetTokenAsync(
                config.Host!, config.User!, config.Password!, config.MfaCode, config.CloudSiteId);
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

        if (args.TokenOnly)
        {
            // Just the raw token, e.g.  TOKEN=$(dotnet run -- --token-only ...)
            Console.WriteLine(result.AccessToken);
            return 0;
        }

        Console.WriteLine("Token acquired.");
        Console.WriteLine();
        Console.WriteLine($"access_token : {result.AccessToken}");
        if (result.ExpiresInSeconds is long secs)
        {
            Console.WriteLine($"expires_in   : {secs} seconds");
        }
        Console.WriteLine();
        Console.WriteLine("Use it on later requests as a header:");
        Console.WriteLine($"  Authorization: Bearer {result.AccessToken}");
        return 0;
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
}
