// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// CLI wiring only: parse args, build an HttpClient, establish a TokenSession
// (login with a password, or resume from a refresh token), and optionally
// demonstrate a manual refresh + rotation. The API logic lives in TokenSession.cs.

namespace NxRefreshToken;

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

        if (string.IsNullOrEmpty(config.Host))
        {
            Console.Error.WriteLine("Missing config: host. Provide --host or NX_CLOUD_HOST.");
            return 2;
        }

        using HttpClient http = BuildHttpClient(args.Insecure);
        var session = new TokenSession(http, config.Host!, args.Store);

        // A refresh token can come from the CLI/env even without a --store file.
        if (!string.IsNullOrEmpty(config.RefreshToken))
        {
            session.RefreshToken = config.RefreshToken;
        }

        try
        {
            bool haveCredentials = !string.IsNullOrEmpty(config.User) && !string.IsNullOrEmpty(config.Password);

            // Decide how to establish the session.
            if (!string.IsNullOrEmpty(session.RefreshToken) && !haveCredentials)
            {
                // Resume: we already have a refresh token, so skip the password.
                Console.WriteLine("Resuming session from a refresh token (no password)...");
                await session.RefreshAsync();
                if (args.Debug) Dump(session);
                PrintState("resumed", session);
            }
            else if (haveCredentials)
            {
                await session.LoginAsync(config.User!, config.Password!, config.MfaCode);
                if (args.Debug) Dump(session);
                PrintState("login  ", session);
            }
            else
            {
                Console.Error.WriteLine("Provide --user/--password to log in, or --refresh-token to resume.");
                return 2;
            }

            // Optionally demonstrate a manual refresh (shows rotation if the server
            // issues a new refresh token).
            if (args.ForceRefresh)
            {
                string? before = session.RefreshToken;
                await session.RefreshAsync();
                if (args.Debug) Dump(session);
                PrintState("refresh", session);
                bool rotated = session.RefreshToken != before;
                Console.WriteLine($"refresh token rotated: {(rotated ? "true" : "false")}");
            }

            if (!string.IsNullOrEmpty(args.Store))
            {
                Console.WriteLine();
                Console.WriteLine($"Session saved to {args.Store} — re-run without a password to resume.");
            }
            return 0;
        }
        catch (AuthException ex)
        {
            Console.Error.WriteLine($"Auth failed: {ex.Message}");
            return 1;
        }
        catch (ApiException ex)
        {
            Console.Error.WriteLine($"Error: {ex.Message}");
            return 1;
        }
    }

    private static string Short(string? token)
        => token is { Length: > 27 } ? token[..24] + "..." : token ?? "";

    private static void PrintState(string label, TokenSession session)
    {
        Console.WriteLine(
            $"{label}: access_token={Short(session.AccessToken)}  "
            + $"~{(int)session.SecondsUntilExpiry()}s to expiry  "
            + $"refresh_token={Short(session.RefreshToken)}");
    }

    private static void Dump(TokenSession session)
    {
        Console.Error.WriteLine("--- raw token response ---");
        Console.Error.WriteLine(Truncate(session.LastRaw ?? "", 4000));
        Console.Error.WriteLine("--- end raw ---");
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];

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
