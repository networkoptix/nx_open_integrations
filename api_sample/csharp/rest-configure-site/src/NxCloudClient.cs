// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// The Nx Cloud (CDB API) client: log in, then register the new site so the
// server can be bound to it.

using System.Text.Json;

namespace NxConfigureSite;

/// <summary>What the Cloud's bind call returns: the site id and the auth key.</summary>
public sealed record RegisteredSite(string SiteId, string AuthKey);

/// <summary>What the Cloud calls for the flow, so the tests can stand in for it.</summary>
public interface ICloudApi
{
    Task<string> LoginAsync(
        string username, string password, Func<Task<string?>>? getMfaCode = null,
        CancellationToken cancellationToken = default);
    Task<RegisteredSite> RegisterSiteAsync(
        string siteName, string customization, string? organizationId = null,
        CancellationToken cancellationToken = default);
    Task LogoutAsync(CancellationToken cancellationToken = default);
}

/// <summary>A client for the Nx Cloud (the CDB API).</summary>
public sealed class NxCloudClient : BearerClient, ICloudApi
{
    // A fixed client id Nx uses for third-party integrations in its examples.
    public const string ClientId = "3rdParty";

    public NxCloudClient(HttpClient http, string host) : base(http, host) { }

    /// <summary>
    /// POST /cdb/oauth2/token -> bearer token, stored on this client.
    ///
    /// An account with two-factor authentication gets a token that must first be
    /// confirmed with a one-time code (see ConfirmSecondFactorAsync). getMfaCode()
    /// returns that code, or is null when there is no way to get one.
    ///
    /// No scope is sent, so the token is cloud-wide. That is what registering a new
    /// site needs: a token scoped to one site cannot create another.
    /// </summary>
    public async Task<string> LoginAsync(
        string username, string password, Func<Task<string?>>? getMfaCode = null,
        CancellationToken cancellationToken = default)
    {
        using StringContent content = JsonBody(new Dictionary<string, string>
        {
            ["grant_type"] = "password",
            ["response_type"] = "token",
            ["client_id"] = ClientId,
            ["username"] = username,
            ["password"] = password,
        });
        using HttpResponseMessage response = await SendAsync(
            HttpMethod.Post, $"{Host}/cdb/oauth2/token", content, cancellationToken);

        int status = (int)response.StatusCode;
        if (status is 401 or 403)
        {
            throw new AuthException(
                $"Cloud login rejected (HTTP {status}). Check NX_CLOUD_USER and NX_CLOUD_PASSWORD.");
        }
        await EnsureSuccessAsync(response, cancellationToken);

        JsonElement reply = await ReadObjectAsync(response, "Cloud login response", cancellationToken);
        string? token = StringProperty(reply, "access_token");
        if (token is null) throw new ApiException("Cloud login response did not contain an access_token.");

        // An account with two-factor authentication gets HTTP 200 and a token,
        // plus this error. Every other call refuses that token until it is
        // confirmed with a code from the account's authenticator app.
        if (StringProperty(reply, "error") == "second_factor_required")
        {
            string? code = getMfaCode is null ? null : await getMfaCode();
            if (string.IsNullOrEmpty(code))
            {
                throw new AuthException(
                    $"Cloud login for {username} needs a two-factor code. Run again with "
                    + "--mfa-code <the 6-digit code from your authenticator app>, or "
                    + "run it in a terminal to be asked for one.");
            }
            await ConfirmSecondFactorAsync(token, code, cancellationToken);
        }

        StoreToken(token);
        return token;
    }

    /// <summary>
    /// GET /cdb/account/self/2fa/totp/key/{code}?token=&lt;token&gt;.
    ///
    /// Confirms the login token with a one-time code (TOTP). From then on the same
    /// token works for every call. The token goes in the query string here: this
    /// call does not accept it as a bearer header.
    /// </summary>
    private async Task ConfirmSecondFactorAsync(string token, string code, CancellationToken cancellationToken)
    {
        string url = $"{Host}/cdb/account/self/2fa/totp/key/{Uri.EscapeDataString(code.Trim())}"
            + $"?token={Uri.EscapeDataString(token)}";
        using HttpResponseMessage response = await SendAsync(HttpMethod.Get, url, null, cancellationToken);
        int status = (int)response.StatusCode;
        if (status is 400 or 401 or 403)
        {
            throw new AuthException(
                $"The two-factor code was not accepted (HTTP {status}). A code is only "
                + "valid for about 30 seconds, so run again with a fresh one.");
        }
        await EnsureSuccessAsync(response, cancellationToken);
    }

    /// <summary>
    /// Create the site's record in the Cloud.
    ///
    /// Without an organizationId: POST /cdb/systems/bind. The account that is
    /// logged in becomes the owner.
    ///
    /// With an organizationId: POST /partners/api/v3/cloud_systems/ (the Channel
    /// Partners API), which binds the site to the organization. The organization
    /// owns the site and its members get access through it.
    ///
    /// Both replies carry the site id and an auth key. They go to the server in
    /// NxServerClient.CloudBindAsync, which is what completes the connection.
    ///
    /// "opaque" is a free-text field the Cloud stores for the VMS. It is a required
    /// field in the spec and this sample has nothing to put in it.
    /// </summary>
    public async Task<RegisteredSite> RegisterSiteAsync(
        string siteName, string customization, string? organizationId = null,
        CancellationToken cancellationToken = default)
    {
        RequireLogin();

        var body = new Dictionary<string, string>
        {
            ["name"] = siteName,
            ["customization"] = customization,
            ["opaque"] = "",
        };
        string url;
        if (!string.IsNullOrEmpty(organizationId))
        {
            body["organization"] = organizationId;
            url = $"{Host}/partners/api/v3/cloud_systems/";
        }
        else
        {
            url = $"{Host}/cdb/systems/bind";
        }
        using StringContent content = JsonBody(body);
        using HttpResponseMessage response = await SendAsync(
            HttpMethod.Post, url, content, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);

        // Both must be non-empty JSON strings: a number or a list is not an id.
        JsonElement reply = await ReadObjectAsync(response, "Cloud bind reply", cancellationToken);
        string? id = StringProperty(reply, "id");
        string? authKey = StringProperty(reply, "authKey");
        if (id is null || authKey is null)
        {
            throw new ApiException("The Cloud bind reply did not contain both an id and an authKey.");
        }
        return new RegisteredSite(id, authKey);
    }

    /// <summary>
    /// DELETE /cdb/oauth2/token/{token}: revoke the Cloud token, which has no
    /// scope and so gives full access to the account. Safe to call twice.
    /// </summary>
    public async Task LogoutAsync(CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(Token)) return;
        using HttpResponseMessage _ = await SendAsync(
            HttpMethod.Delete, $"{Host}/cdb/oauth2/token/{Uri.EscapeDataString(Token)}", null,
            cancellationToken);
        Token = null;
        Http.DefaultRequestHeaders.Authorization = null;
    }
}
