# Moving Safe to Spend to your personal setup

This project was built on a work computer, using a work Claude account. Moving the files doesn't change who owns them. Get that settled first.

## 1. Before you copy anything

- [ ] Read the IP / inventions section of your employment agreement and any outside-activities policy.
- [ ] Ask HR or legal for **written** approval to own and sell a personal budgeting app that has nothing to do with your employer's business. Say it was built with the company's Claude account, and ask whether they claim any rights to it.
- [ ] Wait for the answer before moving the code off the work computer. Copying files from a work laptop to a personal device can trip company security monitoring, and some policies forbid it.

If they say no, or claim the code, stop here. The safe fallback is to rebuild the app from scratch on your own equipment and account, without copying these files.

## 2. Copy the bundle

`safe-to-spend-portable.zip` holds the source only. It has no installed packages, no phone build folders, no databases and no secrets.

- [ ] Move it with a method your company allows (for example, personal cloud storage if permitted, or ask IT).
- [ ] On the personal computer, unzip it somewhere like `~/code/safe-to-spend`.

## 3. Set up the personal computer

```
cd safe-to-spend
git init
git add .
git commit -m "Safe to Spend: initial import"
npm install
npm --prefix server install
npm run setup:native -- com.yourname.safetospend   # pick your permanent app ID
```

Pick the app ID carefully. Once it's published in a store, it can't be changed. Reverse your own domain if you have one (for example `app.safetospend.ios`), or use `com.yourname.safetospend`.

Push to a **private** repository on your personal GitHub or GitLab account.

## 4. Accounts in your own name

Open these with your **personal email**, and ideally your own business entity (an LLC), not anything tied to work:

| Account | Needed for |
|---|---|
| Domain name | the website, server address, support email |
| Hosting (Fly.io, Render, Railway or a VPS) | running `server/` |
| Lemon Squeezy | selling subscriptions |
| Plaid | bank syncing |
| Apple Developer Program ($99/yr) | iPhone app |
| Google Play Console ($25) | Android app |
| Claude (personal plan) | keep building with Claude, outside your work account |

Then fill in `server/.env` from `server/.env.example`, deploy, and set `server` in `www/config.js` to your new address.

## 5. Clean up the work side

- [ ] **Move your own budget data.** In the Claude artifact, open Accounts → **Copy a backup**, paste it into a file on the personal computer, then load it with **Restore a backup** in your new copy.
- [ ] **Delete the artifact** from the work Claude account once your data is safe.
- [ ] **Delete the project from the work computer** (`~/safe-to-spend-app` and the zip), if your company agrees that's appropriate.
- [ ] **Don't use your work email** in `OWNER_EMAILS`, customer support, app store listings, or any of the accounts above.
