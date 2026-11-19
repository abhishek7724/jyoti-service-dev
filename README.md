# Jyoti Service

Jyoti Refrigeration's public booking page and the Jyoti Service Desk staff portal. Supabase stores operational data and authenticates staff. Vercel serves the site and its API.

## Workflows

- Website customers submit without an account and track status with their mobile number and ticket number.
- Managers register phone and walk-in complaints, create technician and billing accounts, and assign tickets directly from the list.
- Technicians open compact assignment cards and notification links into ticket details, start an inspection, save comments and optional before photos, mark inspection complete, and then either await parts or complete the repair with work notes and at least one part used. Optional after photos appear in the completion form. Compatible browsers ask for notification permission on the first use.
- After repair completion, assigned technicians and finance staff can collect Cash or UPI before invoicing. Cash uses a customer signature or a recorded reason they cannot sign; UPI requires a payment screenshot/photo, with no transaction-reference field. Each collection has a receipt, collector and timestamp. Images are compressed on-device and kept in the private `ticket-media` bucket.
- Pre-invoice collections show `Paid, not billed` in orange. Invoice issuance attaches those receipts automatically, showing the balance due or an excess requiring refund/credit. Ticket status follows invoices and payments.
- The staff ticket detail provides a private customer link. Customers enter their registered mobile number to view inspection/completion photos and payment receipts. Ordinary ticket-number/mobile tracking continues to return status only. New website bookings receive their private link on confirmation. Signed image URLs expire after ten minutes; check the ticket again to refresh them.
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

The technician detail reveals each stage as it becomes available. Assigned tickets show only Start inspection. Inspection comments/photos appear while In Progress; Inspection Complete enables Awaiting parts or Complete repair. Repair completion and payment sections are shown only after repair completion is saved. The completion form has Work performed and Parts used, without Test result. Photo controls use the shared camera icon first and Upload photo second above image previews. Inspection and completion photos stay optional. Customer invoice payments from the billing module also use the same Cash/UPI collection form so proof requirements are consistent.
