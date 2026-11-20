# Jyoti Service

Jyoti Refrigeration's public booking page and the Jyoti Service Desk staff portal. Supabase stores operational data and authenticates staff. Vercel currently serves the live site and its API. Cloudflare deployment support is prepared separately; see [Cloudflare migration](docs/cloudflare-migration.md).

## Workflows

- Website customers submit without an account and track status with their mobile number and ticket number.
- Managers register phone and walk-in complaints, create technician and billing accounts, and assign tickets directly from the list.
- Technicians open compact assignment cards and notification links into ticket details, start an inspection, save comments and optional before photos, mark inspection complete, and then either await parts or complete the repair with work notes and at least one part used. Optional after photos appear in the completion form. Compatible browsers ask for notification permission on the first use.
- After repair completion, assigned technicians and finance staff can collect Cash or UPI before invoicing. Cash uses a customer signature or a recorded reason they cannot sign; UPI requires a payment screenshot/photo, with no transaction-reference field. Each collection has a receipt, collector and timestamp. Images are compressed on-device and kept in the private `ticket-media` bucket.
- Pre-invoice collections show `Paid, not billed` in orange. Invoice issuance attaches those receipts automatically, showing the balance due or an excess requiring refund/credit. Ticket status follows invoices and payments.
- Purchasing records itemized purchase orders, partial receipts, supplier bills, payments and balances.
- Billing uses the booking's name and service address for both invoice addresses. Parts and service charges are separate lines. Documents can be printed or saved as PDF. Customer and supplier payments are entered manually.

## Preview deployment

1. Connect this repository to a new Vercel project using the Other framework preset. Leave the root at the repository root. Deploy this version to a preview before changing the existing site's backend.
2. Apply the migrations in `supabase/migrations` in order on the target Supabase project. The Jyoti project already has these migrations. Confirm migration history before running them elsewhere.
3. Set the variables in `.env.example` for Vercel Preview. Use the project publishable key and a server secret key. Keep the server key and all other secrets out of Git and client JavaScript. Use an unpredictable rate-limit secret of at least 24 characters.
4. In Supabase Authentication, create and confirm the first manager's Auth user. Insert that user ID into `public.staff` with their display name and role `manager`. The manager signs in with the email used to create the Auth user. Staff accounts created in the app sign in with their assigned username. Keep public signups disabled until customer authentication is planned.
5. Configure the invoice issuer in the Vercel environment. Set the exact name from the approved sample, `JYOTI REFRIGERATION.`, and its approved business and payment details. JSON keys are `name`, `address`, `tagline`, `phone`, `email`, `gstin`, `bank`, `account`, and `ifsc`. For a fresh billing sequence, set `INVOICE_START_NUMBER` to the confirmed next unused number for the current financial year. The tax rates must be supplied by the shop.
6. Generate a VAPID key pair with `npx web-push generate-vapid-keys` and set the public key, private key, and subject only in Vercel settings. Open the staff portal on a technician's phone, sign in, allow alerts, and assign a test ticket to confirm delivery. On iOS, test from an installed home-screen web app.
7. Open `/` to register and track a complaint, then open `/staff` to assign the test job, capture used parts, issue a test invoice and record a partial payment. Create a test PO and verify receipt and supplier payment separately. Use sample records and review the printed invoice with Jyoti before live billing.

If the existing GitHub Pages website stays in use after verification, retain its markup and change only its intake endpoint to the verified Vercel API. Set `PUBLIC_PORTAL_ORIGIN` to its exact origin without a trailing slash. The existing website currently uses Apps Script. Historical tickets are in the existing backend and require a separate data cutover if they must remain searchable on the new backend.

## Local checks

```sh
npm ci
npm test
```

## Technician workflow verification

`test/sql/technician-workflow.sql` checks completion validation, assigned-user access, cash acknowledgements, receipt idempotency, UPI settlement, automatic invoice reconciliation and excess collections in a rollback transaction. It requires at least one active technician. Use a non-staff service-role JWT claim as supplied in the fixture so invoice notification hooks skip test invoices. Identity receipt numbers can have gaps after test rollbacks. Phone camera, signature touch input and operating-system notification behavior should also be checked on the shop’s actual phones.

The technician detail reveals each stage as it becomes available. Assigned tickets show Accept/Reject; accepted tickets show Start inspection. Inspection comments/photos appear while In Progress; Inspection Complete enables Awaiting parts or Complete repair. Repair completion and payment sections are shown only after repair completion is saved. The completion form has Work performed and Parts used, without Test result. Photo controls use the shared camera icon first and Upload photo second above image previews. Inspection and completion photos stay optional. Customer invoice payments from the billing module also use the same Cash/UPI collection form so proof requirements are consistent.

## Assignment acceptance and live updates

Assigned technicians must Accept or Reject before starting inspection. Rejection retains the technician and optional reason for the manager, who can select a different technician in the card or use Reassign technician in the detail screen. Save assignment is disabled while the selection matches the saved assignee, including unassigned tickets. Responses include an assignment version so stale notifications cannot accept a later assignment. Existing repairs already past assignment remain usable.

The staff portal subscribes to Supabase Postgres Changes for `service_tickets` using the signed-in staff token and existing row-level access rules. Ticket changes and changes to photos, parts, invoices and payments update the ticket activity version. Live updates debounce incoming events and wait while forms, uploads or dialogs are active. Foreground safety refresh runs every 30 seconds while subscribed, or every 5 seconds when disconnected; returning to the app also checks immediately. Lists rerender only when their data changes. Reassignment away from a technician is also reconciled by the safety refresh.

`public/vendor/realtime-2.119.0.js` bundles the pinned Supabase Realtime client from the existing dependencies; licenses are adjacent. Rebuild after `npm ci` with `npx --yes esbuild@0.28.2 scripts/realtime-entry.js --bundle --format=esm --platform=browser --minify --outfile=public/vendor/realtime-2.119.0.js`. Keep the bundled version and license notices aligned with the installed dependency. No server secrets are included in the browser configuration.

## Awaited parts and push delivery

Awaiting parts requires one or more active item-master parts and positive quantities. Requests are stored in `ticket_required_parts`, shown on staff tickets and used to prefill linked purchase orders. They remain separate from consumed parts and can be edited while awaiting parts. A database guard prevents changing to Awaiting Parts with an empty request.

Assignment pushes use high urgency, a 24-hour expiry and a ticket-specific topic. Transient send errors get one retry; expired endpoints are removed. Per-device registration, push-service acceptance time and last error code are stored without exposing subscription credentials in logs. Acceptance by the push provider is not proof that Android displayed a notification. On opening/focusing the portal, supported clients recheck granted subscriptions, including expired subscriptions and VAPID-key changes. Android/browser notification permissions and background battery restrictions still affect locked-phone delivery. The startup screen uses a waiting spinner with an accessible hidden label.

## Staff module

Managers use Staff in the left menu to view all accounts, search by name/username/mobile, and create accounts with Technician, Manager or Billing roles. The list pages at 50 records. Account creation requires a valid Indian mobile number and stores the username alongside the staff profile; existing usernames are derived from their current authentication email without changing sign-in credentials. Edit updates name, mobile and role. Passwords never appear in the directory. The server blocks non-manager access, removing the last active manager, and changing a technician's role while they still have open assigned tickets. Add staff is located in the Staff module rather than the ticket dashboard.

A ticket can have one linked purchase order. The manager card shows the existing PO number with creation disabled, and a partial unique index plus a locked-ticket check prevents duplicate creation from stale tabs or concurrent requests. Creating standalone POs in Purchasing remains available. PO creation publishes ticket activity so other open dashboards pick up the linked order.

## Unpaid and part-paid invoice corrections

Billing and manager users can use the pencil icon before Record payment to correct an issued invoice while the invoice has not been fully settled. The form edits customer billing details, item/service prices, tax rates and fixed/percentage discounts. Quantities and item descriptions remain the invoice snapshot. Corrections keep the invoice ID, number, date and issuer/template, recalculate totals and store the previous snapshot in private revision history. Optimistic revision checks and the same ticket/invoice row-lock order used by payment collection prevent stale corrections and payment races. Recorded payments, including pre-invoice collections, stay unchanged during corrections. A corrected total cannot be below the amount already received; an exact match settles the invoice. Fully paid invoices remain locked. Existing WhatsApp copies are not replaced automatically; use the updated printable bill when sharing a correction. Customer view and Copy customer link controls, along with the new-booking private-link prompt, are removed from the app.

Part-paid invoice corrections are covered by `test/sql/part-paid-invoice.sql`, including payment preservation, recalculated balances, lower-than-received rejection and exact-balance settlement. The historical WhatsApp reply-window test pins its clock inside the original test window; this does not extend the expired production test mode.
