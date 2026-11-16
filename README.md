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
| A2Z Operations | `CASH_ON_HAND_USD`, `CASH_AS_OF`, optional `MONTHLY_CASH_BURN_USD` | Enter reconciled cash and its date. The fallback burn uses the preceding 90 full days of recorded Ledger bill payments divided by three. It can omit payroll, debt or other outflows recorded elsewhere and excludes collections |

Enter snapshot and cash dates as `YYYY-MM-DD`. Update them when reconciling. Demo mode is enabled only by `DATA_MODE=sample` and serves synthetic figures. Leave this variable unset in production.

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

## Checks after deployment

1. Open the dashboard and enter its access key. A GHL Custom Page can use the dashboard origin and prompt for the key.
2. Confirm System Health shows Estimating, Dispatch and Ledger data sources and deploys. Check Twilio and Make against billing.
3. Compare a known labor booking, container sale, and assigned worker with their sources. Labor sales count confirmed Dispatch bookings. Container sales count Won GHL opportunities. Both are booked amounts.
4. Test one proposal and one award transition. Verify the counts persist after the records advance.
5. Connect MCP using `https://YOUR-A2Z-DASHBOARD/mcp` with `Authorization: Bearer <MCP_KEY>`. Discover the read-only `a2z_operating_report` tool.
6. Validate locally with `npm test`. The dashboard and MCP share a short per-instance cache and the same Pacific-date metric definitions.

## Provider references

- [GoHighLevel opportunity search](https://marketplace.gohighlevel.com/docs/ghl/opportunities/search-opportunity/)
- [Twilio Balance resource](https://help.twilio.com/articles/360025294494-Check-Your-Twilio-Account-Balance)
- [Make organization usage](https://developers.make.com/api-documentation/api-reference/organizations)
- [Netlify deploy API](https://open-api.netlify.com/)
- [Netlify team billing usage](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/monitor-usage-for-credit-based-plans/)
