# Setting up notifications

Pushes arrive when someone adds an expense, when a payment is waiting on you to confirm, and once a month if bills haven't been logged.

Two pieces do the sending:

- **A Cloud Function** fires the instant an entry is written — expenses and payments. Needs the Blaze plan, so a card on file. At four people's volume you'll use a rounding error of the free allowance, but **set a £1 budget alert anyway** (Firebase console → Usage and billing → Budgets & alerts). Alerts email you; they don't cap spending.
- **A GitHub Actions job** sends the monthly "bills not logged" nudge on the 1st. A schedule is the right tool for that, and it keeps the function to live events only.

About 30 minutes, done once by one person. You'll need Node and the Firebase CLI on a laptop for the function — it can't be pasted into the console.

---

## Part 1 — Get the web push key

1. Firebase console → gear icon → **Project settings** → **Cloud Messaging** tab.
2. Scroll to **Web configuration** → **Web Push certificates**.
3. Click **Generate key pair**.
4. Copy the key string it shows.

In the app: **Settings → Notifications → Web push key** → paste → Save.

This syncs to everyone, so only one of you does it.

---

## Part 2 — Create a service account

This is what lets the GitHub job send messages on your behalf.

1. Firebase console → **Project settings** → **Service accounts** tab.
2. Click **Generate new private key** → **Generate key**. A JSON file downloads.
3. Open it in a text editor. You'll paste the whole thing in a moment.

**Treat this file like a password.** It can read and write your database. Never commit it, never put it in the repo.

---

## Part 3 — Add the repository secrets

In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret.**

Add three:

| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | The entire contents of that JSON file, pasted in |
| `FIREBASE_DB_URL` | `https://xxxx-default-rtdb.europe-west1.firebasedatabase.app` — the same `databaseURL` from your app config, no trailing slash |
| `FLAT_ROOM` | Your room code, exactly as typed in the app |

Names must match exactly.

---

## Part 4 — Deploy the Cloud Function

This is the instant half. On a laptop, in your repo folder:

```bash
npm install -g firebase-tools
firebase login
firebase use --add          # pick your project, call the alias "default"
cd functions && npm install && cd ..
firebase deploy --only functions
```

First deploy takes a few minutes and may ask to enable some Google Cloud APIs — say yes.

**Check the region.** `functions/index.js` sets `region: 'europe-west1'`. If your database is elsewhere, change it to match, or the function won't see the writes.

If deploy complains the database instance can't be found, add your instance name to the trigger:

```js
{ ref: '/flats/{room}/entries/{entryId}', instance: 'your-project-default-rtdb' }
```

## Part 5 — Add the monthly reminder

Copy these into the repo, keeping the folder structure:

```
.github/workflows/notify.yml
scripts/notify.js
```

Commit, then check the **Actions** tab for "Flat Ledger monthly reminder".

GitHub disables scheduled workflows after 60 days of repo inactivity. If the monthly nudge stops months from now, that's why. Live notifications are unaffected — the function doesn't depend on GitHub.

---

## Part 6 — Switch it on, per phone

Each person: **Settings → Notifications → Turn on for this phone**, then allow when the browser asks.

Three toggles appear, each phone choosing separately:

- **New expenses** — someone adds an expense you're part of
- **Payments to confirm** — someone says they sent you money
- **Monthly bills** — the 1st-of-the-month nudge

**iPhone: the app must be installed to the home screen first.** Notifications do not work from a Safari tab. Android works either way, but installing is better.

---

## Part 7 — Test it

Switch notifications on for two phones, then add an expense on one. The other should buzz within a second or two.

If nothing arrives: Firebase console → **Functions** → your function → **Logs**. It logs how many it sent and how many dead tokens it pruned.

For the monthly reminder: **Actions** tab → **Run workflow** to fire it by hand.

---

## What gets sent to whom

- **You are never notified about your own entries.**
- Expenses only reach people **in that split**. A takeaway between two of you doesn't bother the other two.
- A payment only reaches **the person who has to confirm it**.
- Confirmed payments notify nobody.
- Several updates at once collapse into a single buzz, not five.
- Deleted entries send nothing.
- **Editing an expense doesn't re-notify.** Only genuinely new ones do — which also means the offline queue retrying a write can't send it twice.
- If someone says your payment never arrived, you're told.

---

## If something breaks

| What happens | Cause |
|---|---|
| "Turn on for this phone" doesn't appear | No web push key saved, or the browser can't do notifications. On iPhone, install to the home screen. |
| Button does nothing, no prompt | Notifications were blocked for the site earlier. Allow them in browser settings. |
| Workflow runs, says "No phones registered" | Nobody has switched it on yet, or `FLAT_ROOM` doesn't match your room code. |
| Function deploys but never fires | Wrong region in `functions/index.js`, or the database instance name doesn't match. |
| Two notifications for one expense | Both the function and the old polling workflow are live. The workflow should be the monthly-only version. |
| Workflow fails with "No access token" | The service account JSON is malformed. Paste the whole file, including braces. |
| Nothing arrives but the log says "Sent 1" | The phone has the app closed and the OS delayed it. Android battery optimisation is the usual culprit — exclude Chrome. |
| Notifications stop after months | GitHub disabled the schedule for inactivity. Open Actions and re-enable. |

Dead tokens — from a reinstalled app or cleared data — are removed automatically the first time a send to them fails.
