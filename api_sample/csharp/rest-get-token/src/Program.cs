// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// CLI wiring only: parse args, build an HttpClient, then walk the four steps —
// log in, use the token, log out, and show that the token is now rejected.
// The API logic lives in NxLoginClient.cs.

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
        var client = new NxLoginClient(http, config.Host!);

        try
        {
            // 1. Trade the username/password for a token.
            LoginSession session = await client.LoginAsync(config.User!, config.Password!);
            Console.WriteLine($"Logged in to {config.Host} as {config.User}");
            Console.WriteLine();
            Console.WriteLine(NxLoginClient.FormatSession(session));

            // 2. Use the token on a real authenticated request.
            Console.WriteLine();
            Console.WriteLine($"Using the token: GET {NxLoginClient.Api}/login/sessions/current");
            LoginSession live = await client.GetCurrentSessionAsync();
            Console.WriteLine(
                "  -> 200 OK, the server recognised the token. "
                + $"Session belongs to '{live.Username}'.");

            // 3. Hand the token back. Keep a copy so we can prove it stopped working.
            string spentToken = client.Token!;
            Console.WriteLine();
            Console.WriteLine($"Logging out: DELETE {NxLoginClient.Api}/login/sessions/current");
            bool confirmed = await client.LogoutAsync();
            Console.WriteLine(confirmed
                ? "  -> session deleted."
                : "  -> the server did not confirm the delete (the session may still expire on its own).");

            // 4. Show that the token really is gone. A rejection here is success.
            Console.WriteLine();
            Console.WriteLine(
                $"Re-checking with the same token: GET {NxLoginClient.Api}/login/sessions/current");
            TokenProbe probe = await client.TokenStillWorksAsync(spentToken);
            if (probe.IsLive)
            {
                Console.WriteLine("  -> unexpectedly still accepted. The session was not released.");
            }
            else if (probe.Status is null)
            {
                Console.WriteLine("  -> could not reach the server to confirm.");
            }
            else
            {
                Console.WriteLine(
                    $"  -> HTTP {probe.Status}, the token is rejected. "
                    + "That is the expected result: logout worked.");
            }
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
            // If we bailed out early the session is still open; release it.
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
