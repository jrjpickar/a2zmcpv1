# JOSE VM runtime

This patch adds a standalone Node service and a command center in the existing JOSE view. It uses one text model per attempt, persists task state and local quota counters, and performs deterministic health checks. The existing Desk and Alerts integrations continue through their existing code paths.

## Install on the VM

Apply the ZIP at the root of the repository used to create the supplied A2Z MCP archive. Review the changes before publishing Netlify or changing the VM. No packages are installed by the JOSE installer. It expects systemd and Node 22 or newer at `/usr/bin/node` by default. Set `JOSE_NODE_BINARY` when invoking the installer to select a dedicated, root-owned Node executable.

```sh
free -h
ip -6 route show default
/usr/bin/node --version
sudo bash deploy/install-jose.sh
sudoedit /etc/a2z-jose/runtime.env /etc/a2z-jose/config.json
sudo systemctl enable --now a2z-jose.service
sudo systemctl status a2z-jose.service --no-pager
sudo journalctl -u a2z-jose.service -n 30 --no-pager
```

Generate a dedicated bearer using `openssl rand -hex 32`. Set it as `JOSE_TOKEN` in the VM environment file and in the Netlify function environment. The sample config starts with no inference routes. Configure dedicated provider keys only after confirming the plan, model terms and privacy requirements. State is private to the service under `/var/lib/a2z-jose`, and includes public prompts and replies. The service retains up to 100 tasks and 100 event entries. System logs use the host journal and its existing retention policy.

### Supabase relay without inbound access

Use the existing Supabase project already connected to A2Z MCP. The relay stores two namespaced rows in its existing private `a2z_jarvis_kv` table. The VM initiates outbound HTTPS and JOSE stays on `127.0.0.1:8789`. This mode uses the existing Netlify URL and needs no DNS, tunnel or schema migration on a project with that table.

- On the VM, set `JOSE_RELAY=supabase`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` in the root-owned JOSE environment file. Keep the existing `JOSE_TOKEN` and restart only JOSE after configuring it.
- On Netlify, set or retain `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the VM's matching `JOSE_TOKEN`, available to Functions. The proxy selects the relay automatically when these are set and `JOSE_RUNTIME_URL` is absent. To choose the relay explicitly, set `JOSE_RELAY=supabase` in the Functions environment.
- Apply the patch to the repository before publishing the dashboard. After deployment, open the JOSE panel and check for live status before submitting a public-data task.

The service role credentials stay on the server side. JOSE signs commands and status snapshots with its separate token. The snapshots contain the same local JOSE task data displayed in the dashboard, including public prompts and results. The worker polls every five seconds. The mailbox admits one command at a time, times commands out after two minutes, and persists processed command IDs locally to avoid replay after a crash. The dashboard shows a confirmation when the worker applies the command. If the relay is down, use the local authenticated JOSE endpoint from the VM for emergency controls.

An authenticated direct HTTPS origin remains an optional alternative. It requires `JOSE_RUNTIME_URL=https://<runtime-host>/jose`, with any Cloudflare Access credentials in `JOSE_ACCESS_CLIENT_ID` and `JOSE_ACCESS_CLIENT_SECRET`. Keep the VM bearer enabled in either topology.

For discovery, supply `JOSE_MCP_URL` (the existing HTTPS `/mcp` endpoint, or `http://127.0.0.1:8080/mcp` for the local server) and `JOSE_MCP_READ_TOKEN`. Use an existing scoped token with `report:read`. If provisioning a token, add its SHA-256 digest to the existing MCP server's `MCP_TOKENS` configuration and apply that server's normal config procedure. JOSE issues only `tools/list`.

On the VM, confirm egress before enabling inference. A status such as 401 or 405 with a successful TLS connection still verifies reachability. Compare IPv6 against the VM's existing DNS64/NAT64 path. If inaccessible, leave the route disabled until the host's network path is fixed.

```sh
curl -6 -sS --connect-timeout 5 -o /dev/null -w '%{http_code}\n' https://openrouter.ai/api/v1/models
curl -6 -sS --connect-timeout 5 -o /dev/null -w '%{http_code}\n' https://api.groq.com/openai/v1/models
node --max-old-space-size=48 deploy/benchmark-jose.mjs
systemctl show a2z-jose.service -p MemoryCurrent -p MemoryPeak -p MainPID
```

Verify the dashboard using one small public prompt, check provider usage for zero charge, and compare the operating MCP's response time and memory with its baseline. To roll back the worker, run `sudo systemctl disable --now a2z-jose.service`. This preserves its state. Remove the patch or revert its commit using your normal dashboard release process.

## Updates at runtime

Edit `/etc/a2z-jose/config.json` using an atomic file replacement to change model order, local caps, profile eligibility or monitor thresholds. The scheduler reads the file before each scheduling pass. An invalid file pauses new inference and raises a status message. An active request finishes with the configuration selected at dispatch. Changing systemd environment credentials requires a service restart. Changes to tool implementations or authentication belong in the integration that owns the contract.

JOSE refreshes the scoped MCP catalog every 60 seconds when the scheduler is available. It saves names, concise descriptions, required inputs and schema fingerprints. A changed catalog creates a dashboard event. Failed discovery retains the previous catalog and marks it unavailable. The catalog and visible execution stages adapt ideas from EasyTool and HuggingGPT in the supplied JARVIS archive. Neither runtime nor its dependencies are included.

Configure monitors with `{ "id": "mcp", "kind": "mcp", "seconds": 60 }`, `{ "id": "memory", "kind": "memory", "minFreeMiB": 100 }`, or a `kind: "https"` entry with a trusted HTTPS `url` that responds to HEAD. Monitor results and state transitions are local. Use the existing dashboard Alerts and integrations for their business-specific metrics and delivery channels.

## Routing

Each entry in `models` uses `provider`, `model`, `rank` (lower first), `context`, `rpm`, `rpd`, `tpm`, `tpd`, and optionally `profiles` (dashboard labels in lowercase). An OpenRouter entry needs a specific vetted model ID ending in `:free`. Start with local caps below the published account limits. A Groq entry requires a model from the dedicated Free organization console, `JOSE_GROQ_FREE_KEY` and `JOSE_GROQ_UNBILLED=yes`. The latter is an operator declaration. Remove it before enabling billing on that organization. The worker cannot verify the Groq billing tier through the inference API.

Account request counters are shared per provider. Token counters are local per model, using a pre-request estimate and provider-reported usage when available. Local day counters reset at UTC midnight. Provider reset schedules and usage by other clients can differ. A rate limit can open the provider circuit, while other failures back off the route. The worker honors valid Retry-After values. Exhausted tasks remain queued. An interrupted attempt can be replayed after restart, and a canceled request may already have been accepted by the provider.

### Provider comparison, reviewed November 25, 2026

| Provider | Published free access | Decision and source |
| --- | --- | --- |
| OpenRouter | 20 req/min and 50 req/day without a credit purchase | Supported with explicit free model IDs, zero price ceilings, no fallback and required ZDR. Check each model's license and endpoint availability. [Limits and free models](https://openrouter.ai/collections/free-models/) · [API keys](https://openrouter.ai/settings/keys) |
| Groq | Free organization, per-model request and token limits | Supported, off by default. Check the Free Plan table and actual organization limits. [Limits](https://console.groq.com/docs/rate-limits) · [API keys](https://console.groq.com/keys) |
| Gemini | Selected models have free quotas that vary by project and model | No adapter. Free tier content can be used for product improvement. [Pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) |
| Cloudflare Workers AI | 10,000 neurons/day on Workers Free, reset at UTC midnight | No adapter. Eligibility depends on plan and model, and a Paid account can incur overages. [Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| SambaNova | Listed free models at 20 req/min, 20 req/day and 200,000 tokens/day | Omitted for production because the listed models are evaluation previews. [Limits](https://docs.sambanova.ai/docs/en/models/rate-limits) |
| Mistral | Free monthly usage at evaluation and prototype rates | No adapter. Review terms and actual org caps before production use. [Free mode](https://docs.mistral.ai/resources/glossary) |
| Cerebras | $5 trial credit expires after 30 days | No recurring free tier. [Limits](https://inference-docs.cerebras.ai/support/rate-limits) |
| NVIDIA NIM | Trial/prototype access | Excluded from recurring production inference. Review endpoint-specific terms if evaluating it. [Model catalog](https://build.nvidia.com/explore/discover) |
| GitHub Models | Retired July 30, 2026 | No inference endpoint. [GitHub Changelog](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/) |
| Hugging Face | No monthly Inference Providers credits for free users | Excluded. [Pricing](https://huggingface.co/docs/inference-providers/pricing) |
| Cohere | Limited free trial keys | Excluded from production inference. [Pricing](https://docs.cohere.com/docs/how-does-cohere-pricing-work) |

The table reports published limits and scope. Provider authentication, model availability, account-specific quotas and commercial permissions were not exercised. Use dedicated unbilled accounts. A free tier or model price alone does not establish commercial rights for a particular deployment.

## OpenClaw and feature boundaries

The handoff reports 1,140 MB idle RSS on the 1 GB VM. This patch uses the standalone worker on that size host and does not install OpenClaw. If you already have a secured loopback OpenClaw gateway on a larger VM, set `JOSE_OPENCLAW_GATEWAY_TOKEN` to display a reachability check against port 18789. The route does not perform inference. The gateway would need its own resource validation, model and tool restrictions, and independent zero-charge enforcement before serving as an inference engine. [Gateway API](https://docs.openclaw.ai/gateway/openai-http-api)

This worker supports public-data text tasks, one-time scheduling via the API using `startAt` epoch milliseconds, priority via `priority: true`, approvals for held tasks, health checks and MCP discovery. Its task history is local to JOSE. It has no model-driven tool execution, autonomous code changes, production writes, external communications, private-data inference, built-in web research, or recurring task UI. The existing Desk workflows are independent of the runtime emergency stop.

## Validation

Run `node --test test/jose-runtime.test.mjs` for the mocked tests covering the budget guard, approvals, rotation, quota exhaustion, persistence, emergency stop, proxy authorization and MCP contract drift. The local HTTP benchmark used real loopback requests and mocked inference on macOS x64, Node 24.22.3. The measured idle RSS was 44.8 MiB, and the sampled active peak was 82 MiB for ten tasks. The benchmark process also ran the HTTP client. The requested 80 MB active target and the actual VM capacity remain unverified. Live provider inference and the published dashboard were not exercised. A separate VM check showed successful IPv6 HTTP connections to OpenRouter and Groq. The relay runs on the VM and published a verified signed status to the existing Supabase store while the MCP remained healthy.

The focused suite passed 38 tests across JOSE, MCP scopes, MCP mail, JOSE Desk, and Alerts. The broader macOS run passed 190 of 197 tests. Five existing auto-update tests and one existing Bash error-line assertion failed. The seventh failure concerned the new installer's missing ERR trap, which was corrected and passed the subsequent deploy-script syntax and trap check.
