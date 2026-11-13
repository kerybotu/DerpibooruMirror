# DerpibooruMirror

[English](README.md) | [简体中文](README_zh_CN.md) | [繁體中文](README_zh_TW.md)

**Contents:** [Introduction](#introduction) · [Architecture & Mechanism](#architecture--mechanism) · [Building](#building--compilation) · [Deployment](#deployment--operations) · [Privacy & Cookies](#privacy-and-cookies)

<a id="introduction"></a>

DerpibooruMirror is a fixed-origin reverse proxy dedicated to [`https://derpibooru.org`](https://derpibooru.org). The published server starts with that upstream already configured and never accepts an upstream URL from a browser request. Deploy it for private use or behind access controls; it is not an open proxy.

It preserves streaming responses, HTTP Range/206/416 media behavior, WebSocket upgrades, and bounded HTML/CSS/JSON URL rewriting. Cookie state is isolated by proxy session and upstream origin. The optional Anubis bridge supports exact, version-controlled adapters for Anubis 1.27.0 and 1.28.2, maps only the configured PassChallenge redirect and exact upstream Location, and keeps recognized Anubis cookies separate from the ordinary CookieJar.

## Architecture & Mechanism

The browser connects to the configured `client.origin`. The server checks the Host header, then `ClientGateway` creates a request context and passes the fixed route to `UpstreamGateway`. That gateway dispatches the request to `ProxyEngine`, which forwards the request upstream and returns the response to the browser. URL rewriting is limited to known upstream URLs and bounded HTML/CSS/JSON bodies; binary and streaming responses are passed through. Range (`206`/`416`) and WebSocket forwarding are supported.

`SessionManager` creates a random mirror session and keeps a separate in-memory `tough-cookie` `CookieJar` for each session and upstream origin. Ordinary upstream cookies are temporarily stored there so later requests can be authenticated; they are never written to disk. Recognized Anubis cookies remain browser-managed and are forwarded only for the matching session. The configured Anubis adapter requires an exact version match. Unknown versions cannot activate PassChallenge mapping; the proxy does not automatically switch adapters. Redirect mapping accepts only the configured origins.

The diagnostic logger supports request/flow IDs, status codes, content types, and cookie names and attribute summaries. It omits credential headers and redacts known sensitive query fields. The default `npm start` entry point does not attach this logger to request events; integrations must use the supplied sanitizers and must not log raw headers, request bodies, or request contexts.

## Building & Compilation

Requirements: Git, Node.js 22 or newer, and npm. Dependency installation needs access to the npm registry; running the proxy needs access to `derpibooru.org`.

```sh
git clone https://github.com/kerybotu/DerpibooruMirror.git
cd DerpibooruMirror
npm ci
npm test
npm run test:coverage
git diff --check
```

There is no separate compile step: Node runs the checked-in ES modules directly. `npm ci` installs the locked runtime dependencies. Tests use local fixtures and do not claim live Derpibooru authentication.

## Deployment & Operations

### Quick start

```sh
npm ci
npm start
```

The default listener is `http://127.0.0.1:3000`; the default upstream is `https://derpibooru.org`, and upstream TLS verification is required. Copy `config/config.example.json` to a private file and set `MIRROR_CONFIG` when changing the listener or browser-facing origin. Custom upstreams require an explicit `ALLOW_CUSTOM_UPSTREAM=1` opt-in and still require TLS verification.

```sh
cp config/config.example.json config.local.json
# Edit config.local.json before starting the server.
MIRROR_CONFIG="$PWD/config.local.json" npm start
```

Keep this private configuration outside version control. On Windows PowerShell, set `$env:MIRROR_CONFIG = (Resolve-Path ./config.local.json).Path`, then run `npm start`. Listener and upstream options are read from JSON; `SERVER_HOST` and `UPSTREAM_ORIGIN` are not implemented environment variables.

The configuration's `client.origin` must match the Host header clients use. Put TLS termination in a trusted reverse proxy when needed and set the client origin to that HTTPS origin. Do not expose the default listener directly to the public Internet without access controls.

The sample configuration listens on `127.0.0.1:3000` over HTTP. For production, keep the Node listener private and place a trusted HTTPS terminator (for example, an existing Nginx, Caddy, or Cloudflare Tunnel) in front of it. Set `client.origin` to the browser-visible origin. The application has no built-in `/healthz`; check the listener with a normal request with `curl -I http://127.0.0.1:3000/` under the default configuration. If `client.origin` is `https://mirror.example.com`, instead use `curl -I -H "Host: mirror.example.com" http://127.0.0.1:3000/`. A mismatched Host returns 421. A response proves HTTP reachability, not successful browser authentication; also inspect the status and test the browser flow.

For systemd, run the service as a dedicated unprivileged user with `WorkingDirectory` set to the installation directory, `Environment=MIRROR_CONFIG=/etc/derpibooru-mirror/config.json`, `ExecStart=/usr/bin/npm start`, `Restart=on-failure`, and restrictive file permissions. Keep service logs access-controlled and do not add middleware that logs request headers or bodies. A process manager such as PM2 may be used with the same environment and log restrictions.

## Privacy and Cookies

> **Privacy and Cookie Notice**
> DerpibooruMirror is a reverse proxy, so requests and responses pass through the server operator's host. During an active session, ordinary upstream cookies are temporarily held in a per-session, per-origin in-memory `CookieJar` so they can be forwarded to Derpibooru. This cache is never persisted to disk. Anubis cookie values are primarily held by the browser; the proxy only forwards recognized browser cookies for the matching session and keeps their names/attribute summaries for routing and diagnostics. No cookie value, authentication credential, token, authorization header, or other sensitive credential is written to disk, application diagnostics, or console output. Apart from the session-scoped memory needed for forwarding, the proxy does not retain or collect this data. Deployers must protect the host and review their own process and infrastructure logs. Derpibooru's official terms and privacy policy govern data processed by [Derpibooru](https://derpibooru.org); they do not describe or replace the deployer's handling of data that passes through this proxy.

The sample configuration does not enable persistent cookie storage or value logging. If you add a logging layer or external persistence, update this notice and disclose that behavior to users.

## Security boundaries

- The target origin is fixed by validated route configuration; client URLs, Host values, and forwarding headers cannot select an upstream.
- TLS verification is enabled and cannot be disabled through configuration.
- Sessions have separate CookieJar state per upstream origin. Browser-managed Anubis cookies are allowlisted by name; their values are not logged or stored in the ordinary jar.
- PassChallenge mapping is exact-version and fail-closed. Unknown versions cannot activate mapping. Malformed redirects and unexpected hosts, ports, schemes, and Locations are rejected when the bridge applies.
- Diagnostics record request/flow IDs, status codes, content types, cookie names and attribute summaries only. Do not log Cookie, Authorization, PoW, or query values.

This software does not bypass Anubis or fabricate proof-of-work, authentication cookies, or upstream responses. A successful local test does not prove that every production edge policy will accept a mirror origin.

## Test coverage

Tests cover fixed-origin routing, Anubis 1.27.0/1.28.2 contracts, Cookie and session isolation, redirects, streaming, Range responses, WebSockets, URL rewriting, and error lifecycles. Fixtures are local and do not claim live Derpibooru authentication.

## License

MIT. See [LICENSE](LICENSE).
