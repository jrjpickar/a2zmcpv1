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

Booked crew comes from today's active Dispatch jobs. Available crew needs a `workers` array in the Dispatch export (`id` or `phone`, `name`, optional `role`, `active`, `available`). Until Dispatch sends it, the dashboard shows available as not reported.

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
