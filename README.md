# Jyoti Service

Jyoti Refrigeration's public booking page and the Jyoti Service Desk staff portal. Supabase stores operational data and authenticates staff. Vercel serves the site and its API.

## Workflows

- Website customers submit without an account and track status with their mobile number and ticket number.
- Managers register phone and walk-in complaints, create technician and billing accounts, and assign tickets directly from the list.
- Technicians see assigned jobs, open the route in Maps, record parts used, and update progress. Compatible browsers ask for notification permission on the first use.
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
