# OpenID Connect providers: what to register

Identity proofs through a provider ([draft](wisps/3xx-oidc-proofs.md)) need one OAuth client per provider, registered by the maintainer. Everything else ships in the code. Until a client ID is filled in, that provider is neither offered nor accepted, and the suite runs against its own local issuer (`e2e/support/oidcIssuer.ts`), so nothing here blocks tests.

Rules for every provider:

- **Public client, no secret.** Ghostly never holds a client secret. If a console generates one, do not copy it anywhere.
- **Smallest scopes:** `openid`, plus `email` and `profile` where listed. No API scopes.
- **Client IDs are public configuration.** They go in [`packages/browser/src/proofs/oidc/providers.ts`](../packages/browser/src/proofs/oidc/providers.ts), under `clientIds` for that provider: `web` and `extension` (one client registered with both redirect URIs can use the same ID in both). Desktop uses the `web` client: it signs in through the web callback page. Every build must carry the same IDs, because a contact's app accepts only tokens whose `aud` is one of them.
- **Redirect URIs, exactly:**
  - Web and desktop: `https://app.ghostly.tools/oidc-callback.html`
  - Extension (Chrome Web Store build, item `nbedaagicniejlmfcncndfjcejaidbcf`): `https://nbedaagicniejlmfcncndfjcejaidbcf.chromiumapp.org/oidc`
  - Optional, for local development: `http://localhost:5180/oidc-callback.html` (the web dev server). An unpacked extension has another ID; its URL is `https://<that id>.chromiumapp.org/oidc`.
- **Privacy policy:** `https://ghostly.tools/privacy`. Home page: `https://ghostly.tools`.

Nothing on `app.ghostly.tools` receives the token: the answer arrives in the URL fragment of a static page, which browsers never send to a server.

## Google

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project "Ghostly" (or reuse one).
2. **Google Auth Platform → Branding:** app name `Ghostly`, support email, home page `https://ghostly.tools`, privacy policy `https://ghostly.tools/privacy`, authorized domain `ghostly.tools`.
3. **Audience:** External → **Publish app**. `openid`, `email` and `profile` are non-sensitive, so no review beyond brand verification.
4. **Data access:** add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`. Nothing else.
5. **Clients → Create client → Web application**, name `Ghostly`.
   - Authorized JavaScript origins: `https://app.ghostly.tools`
   - Authorized redirect URIs: the web and extension URIs above.
6. Copy the **Client ID** (`….apps.googleusercontent.com`) into `google.clientIds.web` and `google.clientIds.extension`. Ignore the client secret.

Flow used: `response_type=id_token` (no access token is ever issued).

## Microsoft (Entra ID, work/school and personal accounts)

1. [Entra admin center](https://entra.microsoft.com/) → **App registrations → New registration**, name `Ghostly`.
2. **Supported account types:** "Accounts in any organizational directory and personal Microsoft accounts".
3. **Redirect URI:** platform **Web**, `https://app.ghostly.tools/oidc-callback.html`. After creating, **Authentication → Web → Add URI** for the extension URI.
4. **Authentication → Implicit grant and hybrid flows:** tick **ID tokens** only. Leave "Access tokens" unticked.
5. **API permissions:** keep only Microsoft Graph `openid`, `email`, `profile` (delegated); remove `User.Read` if it was added by default.
6. **Branding & properties:** home page `https://ghostly.tools`, privacy statement `https://ghostly.tools/privacy`. (Publisher verification is optional; without it the consent screen says "unverified".)
7. Copy the **Application (client) ID** (a GUID) into `microsoft.clientIds.web` and `.extension`. Create no client secret or certificate.

Flow used: `response_type=id_token` against the `common` authority. The token's issuer names the account's tenant; the verifier checks it against `tid`.

## Apple (needs a paid Apple Developer account)

1. [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list) → **Identifiers → App IDs**: create one (e.g. `tools.ghostly.app`) with the **Sign in with Apple** capability, if none exists.
2. **Identifiers → Services IDs → +**: description `Ghostly`, identifier `tools.ghostly.signin`. Enable **Sign in with Apple → Configure**:
   - Primary App ID: the one above.
   - Domains and subdomains: `app.ghostly.tools`
   - Return URLs: `https://app.ghostly.tools/oidc-callback.html` (and the extension URI; if Apple refuses `chromiumapp.org`, leave it out and Apple is simply not offered in the extension: set only `apple.clientIds.web`).
   - If Apple asks to verify the domain, it gives a file for `https://app.ghostly.tools/.well-known/apple-developer-domain-association.txt`; it goes in `web/public/.well-known/`.
3. The client ID is the **Services ID** (`tools.ghostly.signin`) → `apple.clientIds.web` (and `.extension` if accepted). Create no key: Ghostly never redeems Apple's code.

Flow used: `response_type=code id_token`, `response_mode=fragment`, **no scope**. Apple only allows the fragment without scopes, so the token carries an Apple-assigned identifier and never an email. Asking for name or email requires `form_post`, which only a server can read: out of scope.

## GitLab (gitlab.com)

1. gitlab.com → **User settings → Applications** (or a group's **Settings → Applications** to own it as a group) → **Add new application**, name `Ghostly`.
2. Redirect URI: the web and extension URIs, one per line.
3. **Confidential: unticked** (public client; GitLab then requires PKCE, which Ghostly uses).
4. Scopes: `openid`, `profile`, `email`. Nothing else.
5. Copy the **Application ID** into `gitlab.clientIds.web` and `.extension`. Ignore the secret.

Flow used: `response_type=code` with PKCE (S256), exchanged from the browser with no secret. GitLab returns an access and a refresh token with the ID token; Ghostly keeps neither and revokes both at once. GitLab adds the person's direct groups (`groups_direct`) to every ID token; the app says so before sign-in.

## Twitch

1. [Twitch developer console](https://dev.twitch.tv/console/apps) → **Register Your Application**: name `Ghostly`, category **Website Integration**, **Client Type: Public**.
2. OAuth Redirect URLs: the web and extension URIs.
3. Copy the **Client ID** into `twitch.clientIds.web` and `.extension`. There is no secret for a public client.

Flow used: `response_type=id_token`, scope `openid`, and `claims={"id_token":{"preferred_username":null}}` when the person shares their username. Twitch's email claim needs `user:read:email`, an API scope, so it is not offered.

## Not supported, and why

| Provider | Why not |
|---|---|
| Facebook | Its web login returns an access token, not an ID token Ghostly can check without Facebook's API or a server. (Limited Login's ID token is iOS-only.) |
| X / Twitter | OAuth 2.0 only, no OpenID Connect: there is no signed ID token to verify. |
| LinkedIn | Signs ID tokens, but only through a code exchange that needs the client secret, and its key set has no CORS headers: it needs a Ghostly server. |
| GitHub | OAuth apps issue no ID token. Account links go through published SSH keys instead. |
