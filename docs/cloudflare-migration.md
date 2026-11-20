# Cloudflare deployment and cutover

The `cloudflare-migration` branch adds a Workers entry point while preserving the
existing Vercel deployment. The same Supabase project remains the database,
authentication provider, file storage and Realtime source. No data migration or
customer/staff account recreation is required.

## Deploy

1. In the shop's selected Cloudflare account, create a Worker connected to
   `abhishek7724/jyoti-service-dev`, branch `cloudflare-migration`.
2. Use Node 24, install `npm ci`, leave the build command empty, and set deploy
   command to `npm run deploy:cloudflare`. Worker name: `jyoti-service`.
   The checked-in `wrangler.jsonc` bundles both the public assets and the APIs.
3. Copy the existing production settings into Worker settings. Store credentials
   as **secrets**, never in GitHub or the public assets:

   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (secret)
   - `PUBLIC_RATE_LIMIT_SECRET` (secret; preserve existing value)
   - `INVOICE_ISSUER_JSON` (secret; contains bank details)
   - `INVOICE_START_NUMBER` (preserve existing setting; do not reset database counters)
   - `WEB_PUSH_PUBLIC_KEY`
   - `WEB_PUSH_PRIVATE_KEY` (secret; preserve existing key pair)
   - `WEB_PUSH_SUBJECT`
   - `PUBLIC_PORTAL_ORIGIN` (only if the separate existing public portal still uses it)

   `keep_vars` retains dashboard-defined non-secret settings on redeployment.
   WhatsApp's token remains in the existing Supabase private configuration.
4. Redeploy and verify `/api/health` returns 200, then test the staff login and
   customer portal. Do not publish an app with missing backend settings.

Local alternative: `npm ci`, `npx wrangler login`, configure secrets with
`npx wrangler secret put NAME`, then `npm run deploy:cloudflare`.
Local test credentials belong in gitignored `.dev.vars` files only.

## Verify before switching customers

- Staff login/refresh/logout and technician-only access.
- Complaint submission, retry protection, five-digit ticket number and tracking.
- Assignment, accept/reject, inspection, required parts, completion and photos.
- Purchase orders, duplicate-PO prevention, supplier ledger and payments.
- Invoice PDF, price/discount corrections, part-paid balance and receipts.
- Realtime changes across manager and technician devices.
- Install PWA on new origin; enable alerts again and verify a notification opens
  the assigned ticket while the phone is locked. Push subscriptions are tied to
  the origin; do not assume old Vercel installations have migrated.
- Signed invoice callback generates the PDF and follows the existing Meta
  template/test-recipient restrictions. Do not generate real test messages
  without the user's authorization.

## WhatsApp callback and domain cutover

The database's invoice-notification function now calls the Cloudflare endpoint. On future domain changes,
Inspect its live definition and change **only** the callback URL to the final
Cloudflare origin after the Cloudflare callback has passed verification. Keep
the signature validation, deduplication and restrictions unchanged. Retain the
original function definition privately for rollback. Check any database
configuration URL and existing public portal endpoint too.

Attach a custom domain such as `jf.krivyo.com` only after verifying ownership,
availability and the deployment. Verify HTTPS and both API and asset routes
there. Update relevant Supabase allowed redirect URLs if the auth setup uses
redirects (the current staff password flow is same-origin).

Keep Vercel running during initial verification. Do not remove it or switch the
database callback before the replacement is live. Rollback consists of restoring
the previous callback origin and returning users to the Vercel app.

## Capacity

Free Workers has both request and CPU limits. Static assets bypass the Worker
except `/api` routes. The built bundle fits the free compressed upload limit,
but PDF creation and push encryption need real runtime CPU/latency measurements.
Request volume alone does not establish free-tier suitability. Upgrade only
with the account owner's approval if measured workload needs it.

## Validation prepared on 20 November 2026

`npm test` passes 48 tests. `npm run test:cloudflare` builds the production
bundle and runs it under Cloudflare workerd through Miniflare. The smoke check
intercepts every outbound call and verifies static assets, staff clean URLs,
Supabase requests, rate-limit crypto, unauthorized access, assignment VAPID
encryption/HTTPS transport, and signed WhatsApp callback PDF creation/upload.
It sends no actual messages and changes no live data. Live account deployment,
real-device notifications and free-tier CPU profiling remain required.

## Deployment status - 20 November 2026

- Worker: `jyoti-service`, Krivyo account `76765c7097044b6b30cef91fa05408b8`.
- Public portal: https://jyoti-service.abhishek-767.workers.dev/
- Staff portal: https://jyoti-service.abhishek-767.workers.dev/staff
- Worker code/assets deployed through the Cloudflare API; GitHub automatic
  builds are not configured yet. The migration branch is the source of truth.
- Supabase server key entered by the owner as an encrypted Worker secret.
  Its value was never read back. Existing invoice issuer settings were copied
  with explicit owner authorization; secrets are not stored in GitHub.
- A new Cloudflare VAPID key pair and rate-limit secret were configured.
  All technicians must open/install this origin and allow assignment alerts
  once. Managers should assign through this origin too; Vercel uses its old keys.
- Live health returned 200. Live tracking returned 200 through Cloudflare and
  Supabase, and the browser showed the expected no-match result for a deliberately
  nonexistent ticket. Staff sign-in rendered successfully; a full staff session
  has not yet been tested on this origin.
- A signed callback from Supabase for a nonexistent invoice returned
  `already_processed` (200), verifying server authentication, Meta template
  lookup and deduplication without sending a message or creating an invoice.
- The invoice dispatcher callback was changed to Cloudflare by migration
  `route_invoice_notifications_through_cloudflare`. No database records or
  existing account passwords were moved or recreated.
- Vercel remains available as a fallback. Real-phone locked-screen push delivery,
  a full PDF WhatsApp delivery and free-tier CPU profiling remain to be verified.
