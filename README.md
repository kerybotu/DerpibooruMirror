# DerpibooruMirror

DerpibooruMirror is a fixed-origin reverse proxy dedicated to `https://derpibooru.org`. The published server starts with that upstream already configured and never accepts an upstream URL from a browser request.

It preserves streaming responses, HTTP Range/206/416 media behavior, WebSocket upgrades, and bounded HTML/CSS/JSON URL rewriting. Sessions are isolated by user and upstream origin. The optional Anubis bridge supports exact, version-controlled adapters for Anubis 1.27.0 and 1.28.2, maps only the configured PassChallenge redirect and exact upstream Location, and keeps recognized Anubis cookies separate from the ordinary CookieJar.

## Requirements

- Node.js 22 or newer
- A network path to `derpibooru.org`
- A private deployment boundary or an access-control layer in front of the server

## Quick start

```sh
npm ci
npm start
```

The default listener is `http://127.0.0.1:3000`; the default upstream is `https://derpibooru.org`, and upstream TLS verification is required. Copy `config/config.example.json` to a private file and set `MIRROR_CONFIG` when changing the listener or browser-facing origin. Custom upstreams require an explicit `ALLOW_CUSTOM_UPSTREAM=1` opt-in and still require TLS verification.

```sh
MIRROR_CONFIG=/etc/derpibooru-mirror/config.json npm start
```

The configuration's `client.origin` must match the Host header clients use. Put TLS termination in a trusted reverse proxy when needed and set the client origin to that HTTPS origin. Do not expose the default listener directly to the public Internet without access controls.

## Privacy and cookies

> **Privacy and Cookie Notice**
> DerpibooruMirror is a reverse proxy, so requests and responses pass through the server operator's host. The server keeps ordinary upstream cookies in a per-session, per-origin in-memory CookieJar so it can forward them to Derpibooru; this state is not persisted to disk. Recognized Anubis cookies are held by the browser and forwarded for the matching proxy session. Cookie values and authorization headers are not written to application diagnostics. Deployers must protect the host, restrict access, and review their own retention and logging configuration. Derpibooru's official terms and privacy policy govern data processed by Derpibooru; they do not describe or replace the deployer's handling of data that passes through this proxy.

The sample configuration does not enable persistent cookie storage or value logging. If you add a logging layer or external persistence, update this notice and disclose that behavior to users.

## Security boundaries

- The target origin is fixed by validated route configuration; client URLs, Host values, and forwarding headers cannot select an upstream.
- TLS verification is enabled and cannot be disabled through configuration.
- Sessions have separate CookieJar state per upstream origin. Browser-managed Anubis cookies are allowlisted by name and never logged or stored in the ordinary jar.
- PassChallenge mapping is exact-version and fail-closed. Unknown versions, malformed redirects, unexpected hosts, ports, schemes, and Locations are rejected.
- Diagnostics record request/flow IDs, status codes, content types, cookie names and attribute summaries only. Do not log Cookie, Authorization, PoW, or query values.

This software does not bypass Anubis or fabricate proof-of-work, authentication cookies, or upstream responses. A successful local test does not prove that every production edge policy will accept a mirror origin.

## Development

```sh
npm ci
npm test
npm run test:coverage
git diff --check
```

Tests cover fixed-origin routing, Anubis 1.27.0/1.28.2 contracts, Cookie and session isolation, redirects, streaming, Range responses, WebSockets, URL rewriting, and error lifecycles. Fixtures are local and do not claim live Derpibooru authentication.

## License

MIT. See [LICENSE](LICENSE).
