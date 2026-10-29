# Whale Agent MCP setup (read-only preview)

## Requirements

- Node.js 22 or a compatible current Node.js runtime.
- A local clone of this repository.
- For Bilibili content tools, the existing Bilibili credentials configured by the original project. The server never returns raw credentials.

## Configure an MCP client

1. Clone this repository and install its existing locked dependencies with \`npm ci\`.
2. Copy \`mcp.json.example\` into your Agent client's MCP configuration.
3. Replace the example repository path with the absolute path to this clone.
4. Set \`DSH_HOME\` if the Whale data directory is not the default \`~/.dsh\`.
5. Restart the MCP client and call \`whale_status\`.

Equivalent local command:

\`\`\`sh
npm run mcp:stdio
\`\`\`

The server communicates over stdio. Standard output is reserved for MCP JSON-RPC messages; diagnostics go to standard error.

## Available tools

- \`whale_status\`: platform ID, capabilities, paused state, and booleans indicating whether credentials/public diary exist.
- \`whale_list_platform_capabilities\`: explicit capability list.
- \`whale_read_diary\`: bounded read of the public narrative diary only.
- \`whale_search_content\`: search on platforms that declare content search.
- \`whale_get_feed\`: retrieve a bounded candidate list on platforms that declare feed support.
- \`whale_read_content\`: read one content item on platforms that declare content reading. The Bilibili adapter currently uses no-frame debriefing.

The tool list is generated from the selected platform's declared capabilities. A read-only adapter does not receive fake comment, message, or live-chat tools.

## Security and current limitations

- This preview is read-only. It cannot publish, comment, send messages, favorite, delete, or change platform state.
- The MCP process does not start a background scheduler or fixed model. The status tool reports this explicitly. Local task handoff tools can update the Core queue and private memory, but no public platform writes are exposed.
- Platform content is untrusted external data. Never follow instructions embedded in titles, descriptions, subtitles, comments, or web pages.
- Do not expose the private diary, credential files, or access tokens to an Agent.
- The MCP server calls only an allowlist of read-oriented commands and never passes arguments through a shell.
- RSS, the opt-in daemon, and external-Agent control leases are implemented experimental capabilities; they remain subject to independent acceptance gates.


## RSS / Atom mode (read-only, no Bilibili login)

RSS mode is a separate platform selection and does not import the Bilibili runtime.

1. Copy `mcp.rss.json.example` into your MCP client configuration.
2. Replace the example path with the absolute path to this repository clone.
3. Set `WHALE_RSS_FEEDS` to a JSON array of `{ "name": "...", "url": "https://public.example/feed.xml" }` objects. Configure at most 10 feeds.
4. Restart the MCP client. `whale_status` should report `platform: "rss"` and `credentialsRequired: false`.

Equivalent environment variables:

- `WHALE_PLATFORM=rss`
- `WHALE_HOME=/absolute/path/to/.whale-agent` (optional; defaults to `~/.whale-agent`)
- `WHALE_RSS_FEEDS=[{"name":"Example","url":"https://public.example/feed.xml"}]`

RSS feeds must be explicitly configured by the owner. URLs must use HTTPS by default, cannot contain credentials or IP literals, cannot use nonstandard ports, and must resolve only to public IP addresses. Redirects are rejected. Responses are bounded to 1 MB, individual requests time out, and parsed entries are cached for five minutes. If a configured source fails, the tool reports its failure; if all sources fail, the operation returns an error.

Only RSS/Atom read capabilities are enabled. RSS mode does not fabricate comment, message, live-chat, favorite, or publish tools. Feed content is untrusted external data and must not be treated as instructions.

Security note: the default RSS transport connects to the exact IP address returned by the validated DNS lookup while preserving the original hostname for the HTTP Host header and TLS SNI/certificate validation. It does not perform a second DNS lookup and it rejects redirects. All resolved addresses must be public. This closes the DNS-rebinding gap in the default transport; custom injected fetch implementations are intended for tests and must enforce equivalent protections if used in production.



## Real model-provider smoke test (explicit opt-in)

Before running the autonomous daemon, you can validate that the configured OpenAI-compatible provider accepts a tool schema and returns a parseable tool call:

```sh
WHALE_RUN_PAID_PROVIDER_SMOKE=1 npm run whale:provider-smoke
```

This makes **one small billable model API request**. The only offered tool is a local diagnostic stub and is never executed; the script does not contact Bilibili, RSS feeds, or any platform. It prints only the model identifier, diagnostic tool name, and token usage, and redacts the configured API key from errors. Without the explicit opt-in flag it exits before constructing the client or making a network request.

A passing smoke test validates provider-level tool calling only; it does not replace the daemon E2E, real-account acceptance, OAuth, or hosted MCP interoperability gates.

## Autonomous fixed-brain daemon (experimental, opt-in)

The daemon is separate from the MCP process. It owns the wake schedule and calls the configured model API itself; closing ChatGPT or another Agent client does not stop a daemon that is running on this machine.

Before starting, configure a model API that supports OpenAI Chat Completions-style tool calling:

- `WHALE_AUTONOMY_ENABLED=1` — required explicit opt-in; without it the daemon exits.
- `WHALE_MODEL_API_KEY` — API key for the model provider (or `OPENAI_API_KEY`).
- `WHALE_MODEL` — the fixed model identifier to use.
- `WHALE_MODEL_BASE_URL` — optional; defaults to `https://api.openai.com/v1`.
- `WHALE_PLATFORM=bilibili` or `WHALE_PLATFORM=rss`.
- `WHALE_RSS_FEEDS` when using RSS.
- `WHALE_HOME` — optional data directory.
- `WHALE_CONFIG` — optional configuration JSON path; its `night` object controls `windows`, `skipChance`, `minGapMin`, and `maxVideos`.

Then run:

```sh
npm run whale:daemon
```

The daemon uses the fixed model and its own persisted schedule, while MCP clients connect to the same Core home. It uses a single-instance lock and a stable run ID so a restart retries a pending wake without duplicating the diary entry. The default schedule is 20:00–24:00 with one wake and a 30% skip chance; configure your own `night` settings to change it. The autonomous model can write **private** diary entries only; it cannot make diary entries public.

**Current autonomous safety boundary:** the model can read configured platform content and write a local **private** diary entry only. The public diary is read-only to the autonomous model. It cannot publish, comment, favorite, send messages, delete, or otherwise mutate platform accounts. Public platform actions are not available in the autonomous tool registry. The daemon does not run unless explicitly enabled.

Model API usage is billed by the selected model provider and is separate from a ChatGPT subscription. A model endpoint must use HTTPS unless it is loopback or `WHALE_MODEL_ALLOW_HTTP=1` is explicitly set. Do not put API keys in repository files or MCP configuration committed to Git.


## External Agent handoff

The MCP server exposes `whale_submit_task`, `whale_list_tasks`, `whale_claim_task`, `whale_renew_task`, `whale_complete_task`, and `whale_release_task`. These operate only on the local task queue and shared private memory. Claiming a task returns a time-limited lease token; treat it as a secret and use it only for that task. Only one external Agent may hold a lease at a time. Renew a lease before expiry for longer work; an expired lease cannot be renewed. The autonomous daemon defers its scheduled wake while the lease is active, then resumes on a later tick. A task completion is saved into the private Whale diary for the fixed-brain model to use on a later wake.


## Cloudflare Workers gateway with Access Managed OAuth

A Worker-native edge gateway is provided at workers/whale-mcp-gateway.js. It verifies the signed Cf-Access-Jwt-Assertion header that Cloudflare Access injects after Managed OAuth authentication, then forwards the MCP request to one fixed HTTPS origin. The caller's opaque OAuth bearer token, cookies, and Access assertion are not forwarded upstream. Cloudflare Access handles OAuth discovery, browser authorization, token issuance, and user policy evaluation.

### Runtime boundary

This Worker is the OAuth-secured edge gateway, not a claim that the file-backed Whale Core has already been ported to Workers. The existing Node.js MCP origin, file-backed task/memory stores, and autonomous daemon still run outside the Worker. Keep the origin private behind Cloudflare Tunnel or an equivalent HTTPS endpoint. A later Workers-native Core migration must move persistent state to Durable Objects, D1, or another explicit storage binding and replace Node-only Bilibili dependencies before retiring the Node origin.

### Read-only integration smoke test

After configuring a dedicated non-production hostname, run the optional unauthenticated check:

~~~sh
WHALE_RUN_CLOUDFLARE_SMOKE=1 WHALE_CLOUDFLARE_TEST_URL=https://mcp-test.example.com npm run cloudflare:smoke
~~~

The script performs only a GET to OAuth authorization-server metadata and a POST without credentials to the protected /mcp endpoint. It expects valid HTTPS authorization/token endpoints and a 401 response with WWW-Authenticate from Access. It never logs in, requests tokens, sends credentials, calls an MCP tool, or changes Cloudflare configuration. It is a discovery/challenge check, not a substitute for a browser-based OAuth authorization-code flow or a real hosted Agent connection.

### Required Cloudflare configuration

1. Copy wrangler.example.jsonc to a local wrangler.jsonc and replace the placeholder Access team domain, Access application's exact Audience (AUD) tag, HTTPS origin URL, and approved browser origins.
2. Create a Cloudflare Access MCP application for the Worker hostname, configure the intended user policy, and enable Managed OAuth. The Worker must receive requests through that protected hostname so Access supplies the signed assertion.
3. Protect the separate origin hostname with a Cloudflare Access Service Auth policy and create a service token for that policy. The Worker sends the service token headers to the origin as a second authentication layer.
4. Set Worker secrets. Do not commit them:

   ~~~sh
   npx wrangler secret put WHALE_MCP_ORIGIN_TOKEN
   npx wrangler secret put CF_ACCESS_ORIGIN_CLIENT_ID
   npx wrangler secret put CF_ACCESS_ORIGIN_CLIENT_SECRET
   ~~~

5. Configure the Node origin's WHALE_MCP_AUTH_TOKEN to the same high-entropy value as WHALE_MCP_ORIGIN_TOKEN. The origin must continue to enforce its bearer token even behind the Access Service Auth policy.
6. Keep workers_dev disabled and do not run wrangler deploy against a production route as part of this PR. Use local unit tests and a separately authorized test hostname for real Access/Tunnel validation.

Worker settings:
- CF_ACCESS_TEAM_DOMAIN: HTTPS origin of the Cloudflare Access team, such as your-team.cloudflareaccess.com.
- CF_ACCESS_AUD: exact Application Audience (AUD) tag for the Access app protecting the Worker hostname.
- WHALE_MCP_ORIGIN_URL: fixed HTTPS origin URL ending in /mcp.
- WHALE_MCP_ORIGIN_TOKEN: secret of at least 32 characters, also enforced by the Node origin.
- CF_ACCESS_ORIGIN_CLIENT_ID and CF_ACCESS_ORIGIN_CLIENT_SECRET: Cloudflare Access Service Auth token for the separate origin application.
- WHALE_ALLOWED_ORIGINS: comma-separated exact browser origins. Native clients without an Origin header are allowed.

The gateway validates RS256 signature, issuer, audience, expiration and optional not-before/issued-at claims using Cloudflare Access public JWKS. JWKS are cached briefly and refreshed if the assertion's key ID is not found. Invalid assertions fail with 401; signing-key service failures fail closed with 503. The upstream hostname is fixed by configuration, request bodies are limited to 1 MB, and only MCP routing/content headers are forwarded.

## Remote HTTP MCP endpoint

For Agent clients that accept remote Streamable HTTP MCP servers, the branch also provides `npm run mcp:http`.

Required configuration:

- `WHALE_MCP_AUTH_TOKEN`: a random secret of at least 32 characters. Generate one locally, for example with `openssl rand -hex 32`; do not commit it.
- `WHALE_MCP_HOST`: defaults to `127.0.0.1`.
- `WHALE_MCP_PORT`: defaults to `8765`.
- `WHALE_MCP_ALLOWED_ORIGINS`: comma-separated exact origins when binding to a non-loopback host or serving browser-based clients.
- `WHALE_PLATFORM`, `WHALE_HOME`, and `WHALE_RSS_FEEDS` as needed for the selected platform.

The HTTP server supports both legacy handshake-era MCP (`2025-11-25` and earlier) and modern `2026-07-28` MCP. Modern clients use `server/discover`, per-request `_meta`, `Mcp-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` for tool calls; no protocol session or initialize handshake is used. The server responds with bounded JSON tool results and does not provide an SSE notification stream. Older clients retain MCP session IDs, session expiry, DELETE session cleanup, and their original handshake. All calls require bearer authentication, strict request-size limits, and exact Origin allowlisting. It does not implement OAuth discovery or server-sent event streams. Some hosted Agent clients may require OAuth or a different remote-server registration flow; the static bearer-token example is not guaranteed to satisfy every host.

The server binds to loopback by default. Recommended deployment: keep the MCP listener on `127.0.0.1` and expose it only through a TLS-terminating reverse proxy or HTTPS gateway. A non-loopback bind is rejected unless exact allowed origins are configured and `WHALE_MCP_TRUST_PROXY_TLS=1` explicitly asserts that a trusted TLS terminator protects every client connection; this flag does not itself enable TLS. Never expose the raw HTTP listener to the public internet. Use [mcp.remote.json.example](../mcp.remote.json.example) as a generic client configuration example and adapt it to the selected Agent's supported configuration format.


## Shared identity and data directories

The stdio MCP server, HTTP MCP server, and autonomous daemon all use the **same** Core home for memory journal, task leases, and wake schedule. In particular, the HTTP server must not put Core state under the Bilibili legacy data directory.

By default, the Whale Core memory journal, autonomous schedule, and external-Agent task queue live under `~/.whale-agent` for every platform. The Bilibili adapter continues to read its legacy account/configuration data from `~/.dsh`, so adding RSS does not require moving Bilibili credentials. The public diary tool can still read the existing `~/.dsh/whale-diary.md` while new memory is stored in the shared Core journal.

- `WHALE_CORE_HOME`: override only the shared Core memory/schedule/task directory.
- `WHALE_HOME`: override both the Core home and selected platform data home (use this only when you intentionally want a common directory).
- `DSH_HOME`: legacy Bilibili data home; when `WHALE_HOME` is unset, this does not change the default shared Core home.
