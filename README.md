# A2Z Operations deployment

Deploy this directory as a new Netlify project. The sibling Estimating Desk patch contains one new file. Copy it to `netlify/functions/metrics-export.js` in the existing Estimating Desk repository and redeploy that project. Dispatch and Ledger already contain protected exports in the supplied releases. If an existing production deploy predates its export, deploy the corresponding supplied release before connecting it.

## Configuration

Set runtime variables in each site's Netlify settings. Generate distinct, random keys of at least 16 characters. Keep them out of Git.

| Site | Variables | Purpose |
| --- | --- | --- |
| A2Z Operations | `DASHBOARD_KEY`, `MCP_KEY` | Dashboard access and separate MCP client access |
| A2Z Operations | `ESTIMATING_URL`, `DISPATCH_URL`, `LEDGER_URL` | HTTPS production origins of the three applications |
| A2Z Operations | `ESTIMATING_EXPORT_KEY`, `DISPATCH_EXPORT_KEY`, `LEDGER_EXPORT_KEY` | Match the respective site's `METRICS_EXPORT_KEY` |
| Each source site | `METRICS_EXPORT_KEY` | Enables its protected export |
| Estimating Desk | Existing `GHL_PIT_TOKEN`, `GHL_LOCATION_ID`, `GHL_PIPELINE_ID`, `GHL_MULTI_GC_PIPELINE_ID` | Uses the Desk's location and pipeline setup. Set `GHL_MULTI_GC_PIPELINE_ID=off` only if that pipeline does not exist |
| A2Z Operations | `GHL_PIT_TOKEN`, optional `GHL_LOCATION_ID`, `CONTAINER_PIPELINE_ID` | Direct container sales pull. Requires an A2Z location token with `opportunities.readonly`. The default IDs come from Dispatch |
| A2Z Operations | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Live account balance. Use the account that owns the billed balance |
| A2Z Operations | `NETLIFY_ACCESS_TOKEN`, `ESTIMATING_NETLIFY_SITE_ID`, `DISPATCH_NETLIFY_SITE_ID`, `LEDGER_NETLIFY_SITE_ID` | Published deploy state and latest production build state. Use a dedicated Netlify token with access to these sites |
| A2Z Operations | `NETLIFY_CREDITS_REMAINING`, `NETLIFY_CREDITS_AS_OF` | Dated credit balance from the Netlify team billing page |
| A2Z Operations | `MAKE_ZONE`, `MAKE_ORG_ID`, `MAKE_API_TOKEN` | Live organization usage with `organizations:read`. Set the zone hostname, for example `us2.make.com` |
| A2Z Operations | `MAKE_CYCLE_CREDITS`, `MAKE_CYCLE_START` | Optional cycle allowance and start date in the Make organization's time zone. The estimate uses live usage where the start is covered by the 30-day API window. Update allowance and start on renewal |
| A2Z Operations | `MAKE_CREDITS_REMAINING`, `MAKE_CREDITS_AS_OF` | Optional dated billing snapshot. Used when the dashboard cannot derive a cycle estimate |
| Accounting Ledger | `BANK_CONNECTIONS_JSON` and, for Plaid, `PLAID_CLIENT_ID`, `PLAID_SECRET`, optional `PLAID_ENV` | Read-only bank balance connections. See the configuration below |
| A2Z Operations | Optional `MONTHLY_CASH_BURN_USD` | The fallback burn uses the preceding 90 full days of recorded Ledger bill payments divided by three. It can omit payroll, debt or other outflows recorded elsewhere and excludes collections |

### Mail district

Set `MCP_COMMAND_CENTER_TOKEN` in **A2Z Operations → Netlify environment variables**, scoped to **Functions**. Use the same generated token as the A2Z Email Inbox site. Operations sends it server-side to `GET https://a2zemails.netlify.app/api/mcp/command-center` as a bearer token. Redeploy Operations after setting it.

The Mail district shows recent statistics for the single mailbox configured on the email site. It uses the dashboard's existing access key, so use a mailbox whose counts all dashboard key holders may see. The district links to the email app, where users sign in to read their own mail. Sample mode uses fixture counts and never calls the email site.

On a visible dashboard, Mail checks every 30 seconds. The first successful check sets the baseline. Later increases send up to five envelopes into the stack. Add `arrivalSequence` to the existing stats response to animate actual deliveries. This must be a durable, monotonically increasing integer for the configured mailbox, incremented once per new incoming delivery irrespective of read state. Keep it stable across polling, deploys and folder changes. Until it is present, the animation follows net increases in unread incoming mail.

**Summarize mailbox** uses `GROQ_API_KEY` and the optional existing `GROQ_MODEL`. On request, the server sends subjects and up to 2,000 UTF-8 bytes of plain text per message to Groq. It displays the result page by page for the whole mailbox. Attachments are excluded. The dashboard's current access key also grants access to summaries, so use a mailbox whose contents all key holders are authorized to see.

Extend the email app's existing bearer-protected endpoint as follows:

- `GET /api/mcp/command-center` keeps its existing `stats`, `asOf` and `coverage` fields. Add `arrivalSequence` as described above.
- `GET /api/mcp/command-center?view=messages&limit=5` returns the first page of the configured mailbox. Honor the requested limit. Include all read and unread messages across the folders the email app exposes for this integration, without duplicates. Use a stable ordering and an opaque cursor that continues the same traversal even when new mail arrives.
- `GET /api/mcp/command-center?view=messages&limit=5&cursor=…` returns the next page. Return `nextCursor: null` on the last page. Continue enforcing the same bearer token and mailbox allowlist. Send plain text only.

```json
{
  "messages": [
    { "id": "stable-id", "subject": "Crew confirmation", "text": "Please confirm six workers.", "receivedAt": "2026-11-17T20:00:00Z" }
  ],
  "nextCursor": null
}
```

Run `npm run build:city` followed by `node scripts/build-sandbox.mjs` to preview the district and sample summaries locally.

### HighLevel Marketplace

Use a **Private** Marketplace app targeting a **Sub-account**. This deployment serves one A2Z company and location and uses the existing Operations data integrations. The Custom Page uses [HighLevel's embedded user context](https://marketplace.gohighlevel.com/docs/other/user-context-marketplace-apps/index.html) to sign staff in individually.

1. Add a **Custom Page** named **A2Z Operations** with URL `https://<operations-domain>/?highlevel=1`. Open it from the actual HighLevel sub-account menu for sign-in. The supported frame origins are `https://app.gohighlevel.com` and `https://app.leadconnectorhq.com`. For a white-label console, add its exact HTTPS origin in both `netlify.toml` and `public/app.js`.
2. Add `https://<operations-domain>/api/highlevel/install` as the exact **OAuth redirect URI**. Generate a client key pair and the app's **Shared Secret** in Advanced Settings. Keep the scope selection minimal. If the installer requires a scope, `locations.readonly` is sufficient for this private deployment's installation configuration. Operations uses its existing credentials for CRM data.
3. Set these variables in **Operations Netlify → Functions**, then redeploy:

| Variable | Value |
| --- | --- |
| `GHL_APP_SHARED_SECRET` | Marketplace app Shared Secret |
| `GHL_SESSION_SECRET` | Separate random secret, generated with `openssl rand -hex 32` |
| `GHL_MARKETPLACE_CLIENT_ID`, `GHL_MARKETPLACE_CLIENT_SECRET` | Marketplace app client key pair |
| `GHL_MARKETPLACE_INSTALL_URL` | The standard OAuth authorize URL from Advanced Settings, including the registered redirect URI |
| `GHL_MARKETPLACE_COMPANY_ID`, `GHL_LOCATION_ID` | The intended agency and existing Operations location |
| `GHL_MARKETPLACE_ALLOWED_USERS` | Comma-separated HighLevel user IDs approved to view Operations data |
| `GHL_MARKETPLACE_MAIL_USERS` | Approved user IDs who may also access the configured mailbox and AI summaries |
| `GHL_MARKETPLACE_ADMIN_USERS` | Approved user IDs who may also access alert settings and diagnostics |

4. As the HighLevel installer, open `https://<operations-domain>/api/highlevel/install` in a top-level tab and select the configured sub-account. Operations adds OAuth state and verifies the location during the callback. Netlify Blobs makes each install attempt single use. The exchanged OAuth credentials are discarded after verification because Operations already has separate source credentials.
5. Open the Custom Page as a listed user. Check that an Operations-only user can see the city and that a user explicitly listed for Mail can also see the Mail district. Use a test mailbox while checking the Groq summary. The Diagnostics page's live connection check verifies Groq model access. **Summarize mailbox** exercises actual inference once the email app exposes the message feed.

The session lasts 15 minutes and renews from the HighLevel parent. A user's permissions are checked on every protected request. This is the private staff installation. Only explicitly listed Mail users can read the shared mailbox summaries. External IONOS users and per-user mailbox routing need their own connection and permissions.

Enter credit snapshot dates as `YYYY-MM-DD`. Update them when reconciling. Demo mode is enabled only by `DATA_MODE=sample` and serves synthetic figures. Leave this variable unset in production.

## Live cash balance

Deploy the Ledger files to the existing Ledger project and the MCP files to the existing A2Z Operations project. Configure `BANK_CONNECTIONS_JSON` in the Ledger's server-side Netlify variables. Include one entry per connection. Examples:

```json
[
  {"provider":"plaid","accessToken":"PLAID_ITEM_ACCESS_TOKEN","accountIds":["USD_OPERATING_ACCOUNT_ID"]},
  {"provider":"https","url":"https://bank-gateway.example/balance","token":"READ_ONLY_TOKEN"}
]
```

- **Plaid** requires `PLAID_CLIENT_ID`, `PLAID_SECRET` and a previously linked Item with access to `/accounts/balance/get`. Obtain the access token through Plaid Link in your Plaid integration. Set `PLAID_ENV=sandbox` only for testing. Production is the default. Include the account IDs of the USD deposit accounts used for runway. The balance check uses available balances and records when Ledger received them.
- **HTTPS** sends a read-only GET with bearer authentication to a bank or treasury gateway that returns a numeric `balance`, `currency: "USD"`, and an ISO 8601 `asOf` timestamp with timezone. Return funds available from the intended operating accounts.
- Include each underlying operating account once across all connections. Ledger only exports the combined balance, currency, status and oldest observation time. If any configured connection fails, the total is unavailable and the expense and invoice data still load.
- The MCP receives the total through the existing `LEDGER_URL` and `LEDGER_EXPORT_KEY` and refreshes on its existing 90-second cache. Remove the old manual cash variables. If you previously set `CASH_BALANCE_URL` or `CASH_BALANCE_TOKEN` on MCP, you can remove them when the Ledger feed is active. Check System Health for the cash balance feed and Financial Runway for the total and timestamp.


## Proposal and award history

Set a separate `METRICS_EVENT_KEY` on Estimating Desk. In the A2Z GoHighLevel location, add custom webhook actions for these events:

- Proposal Sent stage entry in the primary and Multiple GCs Bidding pipelines. Send `type` as `proposal`.
- Job Awarded stage entry or Won status in the primary pipeline. Send `type` as `award`.

Each action sends a POST to the Estimating Desk origin at `/.netlify/functions/metrics-export`. Send `Content-Type: application/json` and `x-metrics-event-key` with the event key. Map `opportunityId` to the triggered opportunity ID. Map `occurredAt` to the transition's ISO 8601 timestamp with timezone. If the workflow cannot supply a stable timestamp, use Make to map the source event timestamp. Reuse the same timestamp when retrying delivery.

Example body with placeholder values:

```json
{"type":"proposal","opportunityId":"GHL_OPPORTUNITY_ID","occurredAt":"2026-11-16T17:30:00Z"}
```

The handler keeps events after an opportunity advances and deduplicates retries. Counts use one first observed event per opportunity. Before event coverage starts, current GHL stage and status timestamps provide a partial backfill. Historical proposals and awards that have already advanced can be loaded through the same endpoint if verified timestamps are available.

## HQ and Groq

Click A2Z HQ in the city. It shows rule-based signals (Act, Watch, Good) at once, then a 3 bullet Groq overview. The prompt below it answers questions from the same numbers. `POST /api/ask` uses `GROQ_API_KEY` and `openai/gpt-oss-120b` (override with `GROQ_MODEL`, cap with `GROQ_MAX_TOKENS`, default 900 including reasoning). Groq only runs when someone opens HQ or asks. The same question on the same data reuses the answer for 10 minutes. Only aggregates are sent: no crew names or contact data.

## Diagnostics

The Diagnostics tab (`GET /api/diagnostics`, dashboard key) lists every data source, deploy and service with status, the exact error, response time, last check and record counts, plus which variables are set (never their values). It reads the shared 90 second cache. Run fresh check re-reads everything once and verifies the Groq key with Groq's free models endpoint. The alert scheduler records each run so a stalled schedule shows as failing.

## Pipeline sales

Multiple GCs Bidding, Hiring and New Customer are excluded from sales by name and by `GHL_MULTI_GC_PIPELINE_ID` when set. Add more pipeline IDs or exact names with `SALES_EXCLUDE_PIPELINE_IDS` (comma separated). Proposal counts still include Multiple GCs bids.

## System health PC

Top fans are the Netlify deploys, RAM sticks are the data feeds. Healthy parts cycle RGB. Setup parts turn amber and slow down. Failed parts stall and flash red. The front power light shows the worst status.

## Live updates and Netlify cost

The page makes one request per refresh: `/api/metrics` now includes triggered alerts, and `/api/alerts` is only called on the Alerts page. It refreshes every 2 minutes while someone is using the page, every 10 minutes after 10 idle minutes, and never while the tab is hidden. One open, active tab is about 30 function calls an hour. Upstream reads are cached for 90 seconds per function instance. Between refreshes the city animates in the browser at no cost.

On each refresh the city compares with the last one: a blue car drives New leads to Proposals sent per new proposal, a gold car drives Proposals sent to Jobs won per new win, and a worker who changed between booked and available walks across. Workers are matched by a hashed Dispatch ID, never the raw ID or phone.

## Alerts

Open **Alerts** in the header. Every metric on the dashboard can have one rule: above or below a threshold for numbers, or not healthy for feeds and deploys. Sales rules also take a period. Rules, the webhook URL (default is the A2Z Make webhook) and the cooldown are saved in Netlify Blobs. Saving or sending needs the dashboard key.

`alerts-scheduled` runs every 15 minutes and exits early when alerts are off or no rule is enabled. Each triggered rule posts once, then waits out the cooldown. A rule that recovers can post again on its next breach. Sample mode only posts with `ALERT_ALLOW_SAMPLE=1`. The Make payload: `event` (`alert.triggered` or `alert.test`), `sentAt`, `count`, `summary`, and `alerts[]` with `id`, `metric`, `group`, `condition`, `threshold`, `value`, `valueText`, `period`, `range`, `severity`, `message`.

## Workforce

Booked and available follow the Dispatch board's own rules (`getLiveBookedIdentifiers`): a worker is booked when on an open job (not closed, not Completed or Cancelled) whose days include today. A job dated earlier that is still open holds its crew today, an open job with no date counts, a night shift ending before it started runs to the next morning, and workers sent home today drop off. Workers are matched by phone or name, like the board. Available is the board's labor roster (the cached Make roster plus manual workers, minus hidden workers) not booked today. The board also drops jobs that GoHighLevel closed; the export cannot see that, so open rows untouched for 21 days are skipped. Diagnostics, Dispatch export shows how each job was counted.

## Credits

Make credits come live from the Make organization (allowance minus consumed) when Make reports them, else allowance minus usage since the last reset. Netlify has no credit API: enter the balance from Usage and billing in Alerts, Billing inputs. `MAKE_CYCLE_*` and `NETLIFY_CREDITS_*` env vars still work as fallbacks.

## JARVIS agents

The JARVIS tab (admins only) runs LangGraph agents on Groq `openai/gpt-oss-20b`. **Main** hands each request to **Email**, **Systems and KPIs**, **Development** (checked automatically by **QC**) or a custom bot you create in the Learning panel. Each agent keeps saved chats (50 per agent, 80 messages each, up to 10 pinned), search, Markdown export, "remember:" lessons, Helpful or Needs work ratings, and a playbook it rewrites every 5 ratings. A new playbook is scored over its next 6 ratings. If its helpful rate falls 20 or more points below the previous version (which needs at least 3 ratings), the previous version is restored and logged. "remember for all agents:" adds to company memory (20 entries of up to 300 characters), which every agent receives. Calls without a chat (no `threadId` or `newThread`) use no storage. Groq is called only when you send a message or a reflection runs. History sent to the model is the last 6 messages within `JARVIS_HISTORY_CHARS` (default 6000).

| Variable | Purpose |
| --- | --- |
| `GROQ_API_KEY` | Required for agents. Optional `JARVIS_GROQ_MODEL` overrides `openai/gpt-oss-20b` |
| `MCP_COMMAND_CENTER_TOKEN` | Existing token. The Email agent reads the email app with it. `jarvis-mail-sync` refreshes a snapshot every 30 minutes with no Groq calls |
| `JARVIS_EMAIL_URL`, `JARVIS_EMAIL_PAGES`, `JARVIS_EMAIL_SYNC` | Optional HTTPS override of the command-center URL, pages of 5 messages per sync (1 to 4, default 2), and `off` to stop the sync |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Optional. Moves JARVIS storage from the Netlify Blobs store `a2z-jarvis` to the Supabase table in `supabase/migrations`. Run that SQL in the Supabase SQL editor first. Keep the service key in Netlify Functions only |
| `JARVIS_EXECUTE` | `off` disables the execution sandbox |

**Execution sandbox.** Paste `/execute {plan JSON}` in any chat, or run a plan Development proposed after QC approves it. Validation runs first and returns a plan hash. **Run in sandbox** needs that exact hash and an audit record, then runs the plan on a throwaway in-memory SQLite copy of A2Z aggregates (no crew names or contacts) in a worker with a 3 second limit. Only `SELECT` and `CREATE VIEW` run. Module bindings, refresh schedules and refresh triggers are recorded as staged changes and are never applied to the live dashboard.

**Local check.** `npm run sandbox` serves sample data at `http://127.0.0.1:4174`. The key is `a2z-local-sandbox-key`, and chats are saved in `.a2z-jarvis-local`. Use `node --import ./sandbox/fake-groq.mjs sandbox/server.mjs` for fixture replies with no Groq calls. `npm run validate` loads every function, runs the sandbox once and builds the static preview.

## Docker server (Google Cloud e2-micro)

The same functions also run as one standalone Node server (`server/index.mjs`) in Docker on a 24/7 Google Cloud Always Free e2-micro VM (Ubuntu 24.04, x86_64, 1 GB RAM). Netlify deploys are unchanged. Nothing is published to the internet: the container binds to `127.0.0.1:8080`, `GET /health` needs no key, and `/mcp` needs `Authorization: Bearer <MCP_AUTH_TOKEN>` (generated into `.env`). The container has a 512 MB memory limit (768 MB with swap), a 320 MB Node heap and Docker log rotation of 10 MB x 3. JARVIS memory goes to Supabase when `SUPABASE_URL` and `SUPABASE_KEY` are set (run `supabase/migrations` in the Supabase SQL editor first), otherwise to the `a2z-data` volume.

**Network.** The VM has no public IPv4, only internal IPv4 and public IPv6. `deploy/setup-ipv6-net.sh` sets systemd-resolved to the public nat64.net DNS64 servers first and Cloudflare IPv6 DNS (`2606:4700:4700::1111`, `2606:4700:4700::1001`) as the backup, in `/etc/systemd/resolved.conf.d/zz-a2z-nat64.conf`, which loads after Google's `gce-resolved.conf` and starts with an empty `DNS=` to clear the metadata server entry. A networkd drop-in sets `DNSDefaultRoute=false` on `ens4` and keeps only `~internal` there. The script is safe to rerun on a VM fixed by hand: it rewrites files only when they differ, removes the old `10-a2z-nat64.conf` names, and restarts nothing when nothing changed. IPv4 only hosts such as GitHub work through nat64.net's NAT64 gateways. If nat64.net is down, hosts that publish IPv6 addresses (Cloudflare, Ubuntu mirrors, Google) still resolve through Cloudflare, but IPv4 only hosts such as GitHub fail until it is back. supabase.com has no IPv6 address. Whether your Supabase project host has one shows in the in-container check in `verify.sh`. Every 5 minutes the health timer restarts resolved if the Global current DNS server is not a nat64.net address. Google internal names (`*.internal`) stay on the metadata server so the guest agent and OS Login keep working. Docker runs with IPv6 and the same DNS servers. All SSH uses `gcloud compute ssh ubuntu@a2z-mcp --zone us-west1-b --tunnel-through-iap --ssh-key-file ~/.ssh/a2z-gcp`. To copy one file, use `gcloud compute scp <file> ubuntu@a2z-mcp:~/a2z-mcp/ --zone us-west1-b --tunnel-through-iap --ssh-key-file ~/.ssh/a2z-gcp`.

**Uptime.** Create a check at Healthchecks.io: Name `A2Z MCP VM`, Schedule **Simple**, Period **5 minutes**, Grace Time **10 minutes**, Integrations **Email** on. Copy its ping URL (`https://hc-ping.com/<UUID>`) into `.env` as `HC_PING_URL`. The `a2z-healthcheck.timer` checks the local `/health` every 5 minutes. HTTP 200 pings the URL. Anything else pings `<URL>/fail`, which alerts right away. If the whole VM is down, pings stop and Healthchecks.io emails you after the grace time.

1. From your computer: `deploy/push.sh` copies the repo to the VM over IAP as `ubuntu@a2z-mcp` with `--ssh-key-file ~/.ssh/a2z-gcp`. Then connect with the SSH command above and `cd a2z-mcp`.
2. On the VM: `cd a2z-mcp && deploy/setup-ipv6-net.sh`. It must print a GitHub HTTP status and a `git ls-remote` line.
3. `deploy/bootstrap-vm.sh`. It adds 2 GB swap (swappiness 10), updates the system, turns on unattended upgrades, installs Docker and git, sets SSH to key only, enables ufw with OpenSSH only, asks for `GROQ_API_KEY`, `SUPABASE_URL`, `SUPABASE_KEY` and `HC_PING_URL` without echoing them, starts the stack and installs the health timer.
4. Run `deploy/verify.sh`, then `sudo reboot`, reconnect and run it again. It checks the container, timers, swap, memory, SSH, ufw, DNS64, `curl -6 https://github.com`, `git ls-remote`, a DNS failover test with nat64.net blocked for a few seconds, and that GitHub, the Groq API and Supabase answer from inside the container.
5. Redeploy with `./deploy.sh`. Nothing pulls images or code on a schedule.

## Checks after deployment

1. Open the dashboard and enter its access key. A GHL Custom Page can use the dashboard origin and prompt for the key.
2. Confirm System Health shows Estimating, Dispatch and Ledger data sources and deploys. Check Twilio and Make against billing.
3. Compare a known labor job, container sale, and assigned worker with their sources. All sales values come from GHL opportunities marked Won, once per opportunity, dated by status change. Labor sales is the Labor pipeline (by name, or set `LABOR_PIPELINE_ID`). Pipeline sales is every other sales pipeline. Dispatch is used for crew only.
4. Test one proposal and one award transition. Verify the counts persist after the records advance.
5. Connect MCP using `https://YOUR-A2Z-DASHBOARD/mcp` with `Authorization: Bearer <MCP_KEY>`. Discover the read-only `a2z_operating_report` tool.
6. Validate locally with `npm test`. The dashboard and MCP share a short per-instance cache and the same Pacific-date metric definitions.

## Provider references

- [GoHighLevel opportunity search](https://marketplace.gohighlevel.com/docs/ghl/opportunities/search-opportunity/)
- [Twilio Balance resource](https://help.twilio.com/articles/360025294494-Check-Your-Twilio-Account-Balance)
- [Make organization usage](https://developers.make.com/api-documentation/api-reference/organizations)
- [Netlify deploy API](https://open-api.netlify.com/)
- [Netlify team billing usage](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/monitor-usage-for-credit-based-plans/)
