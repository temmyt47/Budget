# Safe to Spend

A personal finance app in the style of Monarch: dashboard, budgets, cash flow reports, recurring bills, savings goals and net worth. It runs in three modes, and you can move between them at any time:

| Mode | What you need | Where data comes from |
|---|---|---|
| **On its own** | Nothing | Typed in, pasted, or imported from bank files (CSV, OFX, QFX, QBO) |
| **With your server** | The server in `server/`, hosted anywhere | Same as above, plus a place to connect Plaid later |
| **With bank syncing** | The server plus a Plaid account | Accounts and transactions pulled from your bank automatically |

## Project layout

```
www/index.html        the app (one file; also runs as the Claude artifact)
server/               optional sync server: Node 22.13+, Express, SQLite, Plaid
ios/  android/        native projects (Capacitor), made by `npm run setup:native -- <app id>`
assets/               app icon source
Dockerfile            builds the server with the web app bundled in
```

First time on a new machine: `npm install`, then `npm run setup:native -- com.yourname.safetospend` to create the iOS and Android projects with your own app ID. After changing `www/`, run `npm run sync` to copy it into them.

## Selling it: accounts, Lemon Squeezy, owner dashboard

When `LEMONSQUEEZY_WEBHOOK_SECRET` and `LEMONSQUEEZY_PLANS` are set, the app becomes paid:

1. A customer creates an account with email and password and gets `TRIAL_DAYS` free, with no card needed.
2. When the trial ends, the app shows your plans. **Choose** opens Lemon Squeezy checkout in the browser, with the customer's email and account ID filled in.
3. Lemon Squeezy sends webhooks to `/api/billing/webhook`. The server checks each signature, records the subscription and payment, and access opens within seconds.
4. Cancelled plans keep access until the period ends. Failed payments show "update your card" with a link to the customer's Lemon Squeezy portal.

Without billing configured, the server lets everyone in for free.

### Set up Lemon Squeezy

1. Create a product with two subscription variants, such as Monthly $9.99 and Yearly $79.99.
2. For each variant, copy the numeric **variant ID** and the **Share** checkout link into `LEMONSQUEEZY_PLANS` (see `server/.env.example`).
3. Under Settings → Webhooks, add `https://your-domain/api/billing/webhook`, select every `subscription_*` and `order_*` event, and copy the signing secret into `LEMONSQUEEZY_WEBHOOK_SECRET`.
4. Put your email in `OWNER_EMAILS`, restart the server, and create your account in the app (or sign in at `/owner`).
5. Make a test-mode purchase. It shows in the owner dashboard when you tick **Include test purchases**.

### Owner dashboard: `https://your-domain/owner`

- **Headline numbers:** MRR and ARR, paying subscribers, trials, revenue for the last 30 days, signups, cancellations, failed payments, bank connections and estimated Plaid cost
- **Charts:** MRR over 12 months (estimated from subscription start and end dates), revenue collected by month, signups by week, subscriptions by status, and MRR by plan
- **Customers:** search and filter by paying, trial, free access, no access or needs attention. For each customer you can:
  - Give free access (1 month, 3 months, 1 year or forever)
  - Make a temporary password (they must choose a new one when they sign in)
  - Turn the account off or on
  - Delete the customer
- **Billing activity:** the latest Lemon Squeezy events. **System** shows what's configured.

Refunds and cancellations are done in Lemon Squeezy; the dashboard updates from its webhooks.

**Try it with made-up data:** run `cd server && npm run demo`, open http://localhost:8787/owner, and sign in as `owner@demo.test` / `demo-owner-pass`. The demo uses its own database (`data/demo.db`).

### App build settings (`www/config.js`)

| Setting | Web copy served by the server | Phone app builds |
|---|---|---|
| `server` | leave blank (uses the same site) | your server's HTTPS address |
| `requireAccount` | set automatically when billing is on | `true` for the paid app |
| `checkoutInApp` | `true` | see below |

**App Store and Google Play rules:** both stores generally require their own in-app purchase system for digital subscriptions sold inside the app. Selling through Lemon Squeezy is safest on the web. For store builds, set `checkoutInApp: false`: the app then shows no prices or purchase links, and customers subscribe on your website and sign in on the phone. US storefronts currently allow links to outside payment, but the rules have been changing, so check the current Apple and Google guidelines before you submit.

**Password resets:** there's no email service connected, so customers who forget their password contact you. In the owner dashboard, use **Make a temporary password**. Connecting an email provider (Resend, Postmark) for self-service resets is a good next step.

## How bank syncing works

```
phone app ──HTTPS──▶ your server ──▶ Plaid ──▶ bank
   │                     │
   │  Plaid Link opens   │  stores the Plaid access token, encrypted (AES-256-GCM)
   │  inside the app     │  pulls /transactions/sync and /accounts/get
   ▼                     ▼
 budget, goals,       SQLite: accounts + transactions, each change numbered
 categories stay      so the app asks for "everything after N"
 on the phone
```

- The Plaid secret and access tokens never reach the phone. The phone holds only a sign-in session token, and the server stores just its SHA-256 hash. Passwords are hashed with scrypt.
- Plaid categories are mapped to the app's categories. Credit card payments and moves between your own accounts go to **Transfers**, which is left out of spending and income so nothing is counted twice.
- If you typed something by hand before the bank caught up (same amount, within 4 days, similar name), the bank's copy replaces yours and keeps your category.
- Changing a category teaches the app. That merchant goes to the same category next time, from the bank or typed by hand.
- The first bank sync replaces the sample data.

## Run the server

```
cd server
npm install
cp .env.example .env        # fill in the values you need
npm start                   # http://localhost:8787
```

With no Plaid keys, the server still runs and the app can connect to it. It reports that bank syncing isn't set up yet. The server also serves the web app, so opening `http://localhost:8787` gives you a working browser copy.

### Add Plaid (sandbox is free)

1. Create an account at https://dashboard.plaid.com and copy the **sandbox** client ID and secret.
2. In `server/.env`, set `PLAID_CLIENT_ID`, `PLAID_SECRET` and `PLAID_ENV=sandbox`, plus `ENCRYPTION_KEY` (run `npm run keygen` to make one).
3. Restart the server. In the app, sign in (Accounts → Bank connections when the app isn't paid-only), then tap **Connect a bank**.
4. In Plaid's sandbox, pick any bank and sign in as `user_good` with password `pass_good`.

For real banks, request **production** access in the Plaid dashboard. Plaid reviews your app and security practices first, and charges per connected account.

### Deploy

The phone app needs an **HTTPS** address. Any host that runs Docker works: Fly.io, Render, Railway, or a small VPS.

```
docker build -t safe-to-spend .
docker run -p 8787:8787 -v sts-data:/data --env-file server/.env safe-to-spend
```

Keep the `/data` volume, which holds the SQLite database, and back it up. Keep `ENCRYPTION_KEY` safe too: without it, the stored bank connections can't be decrypted.

To test a local server from a phone, expose it over HTTPS with a tunnel such as `cloudflared tunnel --url http://localhost:8787`, then enter that URL in the app.

Optional settings:
- `PLAID_WEBHOOK_URL=https://your-domain/api/plaid/webhook`: Plaid tells the server when new transactions are ready. Webhooks are signature-checked.
- `INVITE_CODE`: only devices that know the code can register. Set this before you share the server address.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Is the server up, is Plaid configured |
| POST | `/api/auth/signup` | Creates an account `{email, password, invite?}` and returns a session token |
| POST | `/api/auth/login` | Signs in `{email, password}` and returns a session token |
| POST | `/api/auth/logout` · `/api/auth/password` | Signs out, or changes the password (signs out other devices) |
| GET | `/api/me` | Account, access (trial, subscription, free access), plans with checkout links |
| POST | `/api/billing/webhook` | Lemon Squeezy webhooks (signature-checked) |
| GET/POST/DELETE | `/api/owner/*` | Owner dashboard data and customer actions (owners only) |
| POST | `/api/link-token` | Plaid Link token; `{itemId}` opens repair mode for a broken login |
| POST | `/api/items` | Exchanges Plaid's public token and runs the first sync |
| GET | `/api/items` | Connected banks and their status |
| DELETE | `/api/items/:id` | Disconnects a bank (at Plaid, too) |
| POST | `/api/sync` | `{since}`: pulls from Plaid, returns changes after `since` |
| DELETE | `/api/me` | Deletes the account, every bank connection and all server data |
| POST | `/api/plaid/webhook` | Plaid webhooks |

## Light and dark

The app follows your device by default. The button at the bottom of the sidebar — on a phone, the sun/moon button in the header — cycles **system → light → dark → system**, and the choice is remembered on that device.

The choice is read before the first pixel is drawn, so opening in dark mode never flashes white. The surrounding chrome follows too: the address bar on Android Chrome and iOS Safari, and the status bar text in the phone app (via `@capacitor/status-bar`).

Stored under the `safe-to-spend/theme` key in local storage. Clearing site data puts it back to "system".

## Phone app

See "Try it on your phone" and the store steps below. Nothing changes for bank syncing. The app asks for your server address under **Accounts → Bank connections**.

### Try it on your phone (free)

Run `npm run sync` first, and again after every change to `www/` — the phone projects read their own copy, not `www/` directly.

- **iPhone:** install Xcode, then run `npx cap open ios`. Pick your team under Signing & Capabilities, plug in the phone, and press Run.
- **Android:** install Android Studio, then run `npx cap open android`. Turn on USB debugging on the phone, plug it in, and press Run.

### TestFlight (iPhone)

Needs the Apple Developer Program ($99 a year).

1. In App Store Connect, create an app with the same bundle ID you gave `npm run setup:native`.
2. In Xcode, choose Product → Archive, then Distribute App → App Store Connect.
3. Add internal testers in TestFlight. Internal testing isn't reviewed.

### Google Play internal testing

Needs a Play Console account ($25 once).

1. In Android Studio, choose Build → Generate Signed App Bundle. Back up the upload key.
2. In Play Console, go to Testing → Internal testing, upload the `.aab` file, and add tester emails.
3. New personal accounts must run a closed test with 12 testers for 14 days before a public release.

### Before a public store release

- **Privacy policy URL:** both stores require one, and so does Plaid. List what the server stores: bank account names and masks, balances, and transactions.
- **Account deletion:** already built in (Accounts → Delete my server data, which calls `DELETE /api/me`).
- **Apple's App Privacy form:** declare financial info if bank syncing is on.
- **OAuth banks (Chase, Capital One and others) inside the phone app:** they need Plaid's redirect flow. That means Universal Links (iOS) and App Links (Android) pointing at `PLAID_REDIRECT_URI`, or swapping Plaid Link web for Plaid's native iOS and Android SDKs. The browser copy served by your server already handles the OAuth return. Sandbox and non-OAuth banks work in the app as is.
- **Apple guideline 4.2:** a public release may be reviewed harder for web-wrapped apps. TestFlight internal testing isn't affected.

## Known limits

- Budget, goals and category rules live on each device. The server syncs bank data only, not your budget, between devices.
- Balances come from Plaid's `/accounts/get`, which Plaid refreshes about once a day. Real-time balance checks (`/accounts/balance/get`) cost extra and aren't used.
- On Android, the moment before the app's first paint uses `android.backgroundColor` from `capacitor.config.json`, a single fixed colour (dark). A cold start in light mode flashes dark. Neither the web manifest nor the Capacitor config can hold two colours; fixing it properly needs a themed `values-night` resource in the Android project.
- The Claude artifact version can't reach outside servers, so it has no bank syncing. File import, CSV and backups work there.
