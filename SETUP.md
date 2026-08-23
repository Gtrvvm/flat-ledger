# Setup

One-off instructions for getting Flat Ledger hosted and syncing. See [README.md](README.md) for what it actually does.

Four files make the app: `index.html`, `manifest.json`, `sw.js`, and the four PNG icons. No build step, no npm, no framework.

You can use it right now with zero setup — it just won't sync between phones until you do part 2.

---

## Part 1 — Put it online (10 minutes, free)

You need HTTPS hosting, otherwise iOS won't let you install it. GitHub Pages is free and permanent.

1. Make a GitHub account if you don't have one.
2. Create a new **public** repository called `flat-ledger`.
3. Click **Add file → Upload files**, drag in all seven files, commit.
4. Go to **Settings → Pages**. Under "Branch" pick `main` and `/ (root)`. Save.
5. Wait about a minute. Your app is at:
   `https://YOURNAME.github.io/flat-ledger/`

### Install it on your phone

- **iPhone:** open the link in Safari (must be Safari), tap the share button, tap **Add to Home Screen**.
- **Android:** open in Chrome, tap the three dots, tap **Install app** or **Add to Home Screen**.

It gets its own icon and opens without a browser bar. It also works offline — the service worker caches the whole thing.

Send the link to the other three so they can do the same.

---

## Part 2 — Make all four phones sync (20 minutes, free)

Without this, each phone keeps its own separate ledger. Firebase's free tier is far more than four people will ever use.

1. Go to `console.firebase.google.com` and create a project. Turn Google Analytics **off**, you don't need it.
2. In the left menu: **Build → Realtime Database → Create Database**.
   - Pick the **europe-west1** location.
   - Start in **test mode**.
3. Go to the **Rules** tab and replace what's there with:

```json
{
  "rules": {
    "flats": {
      "$room": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

Publish it.

4. Go to **Project settings** (gear icon) → scroll to "Your apps" → click the **web** icon `</>`. Register the app with any nickname. Firebase shows you a `firebaseConfig` block. Copy the object — the bit inside the curly braces, including the braces.

5. Open the app on your phone → **Settings** → paste that config into **Firebase config**.
   The config must be valid JSON, so the keys need quotes:

```json
{
  "apiKey": "AIzaSy...",
  "authDomain": "flat-ledger-xxxx.firebaseapp.com",
  "databaseURL": "https://flat-ledger-xxxx-default-rtdb.europe-west1.firebasedatabase.app",
  "projectId": "flat-ledger-xxxx",
  "appId": "1:123456789:web:abc123"
}
```

**`databaseURL` is the important one.** If Firebase didn't include it in the snippet, copy it from the top of the Realtime Database page.

6. Set a **room code**, e.g. `coppermaker-109-k4x9`. Add random characters — anyone who guesses the code can read and edit your ledger.

7. Save. The app reloads and the dot at the bottom turns blue.

8. Give the other three the same config and the same room code. That's it — everyone's on the same ledger, updating live.

---

## About the security

The rules above let anyone with the room code read and write. For four flatmates splitting a Tesco shop that's fine, and it's why the room code should have random characters in it. Nothing sensitive is stored — no card numbers, no bank details, just names and amounts.

If you later want it locked down properly, the route is Firebase Anonymous Auth plus `".read": "auth != null"`. Not worth it on day one.

---

## Using it

**Recurring bills** live in Settings. Each one remembers who normally pays it:

| Bill | Type | Payer |
|---|---|---|
| Rent | fixed | you |
| Broadband | fixed | whoever |
| Electricity | varies | whoever |
| Water | varies | whoever |
| Heating | varies | whoever |

Fixed ones appear under "Due this month" with the amount pre-filled — one tap. Variable ones appear with the amount blank, so you type it when the bill lands. Once added for the month, they disappear from the due list.

Edit the defaults to match who actually pays what. I guessed.

**Everything else** is the Add expense button. Uncheck anyone not involved — a takeaway two of you ordered splits two ways, not four.

**Four ways to split**, chosen per expense:

- **Equally** — the default.
- **By shares** — give yourself 2 and everyone else 1, and you pay 2/5. Handy when you don't want to think in percentages; the maths adjusts automatically if someone drops out of the split.
- **By %** — must total 100. Live preview shows the pounds each person owes as you type.
- **Exact £** — type the actual amounts; must add up to the total.

**Saved splits** stop you retyping. "Food shop" is set up as 40/20/20/20. Tap it, and the percentages and the people fill in. Save new ones from the split box; delete them in Settings. They sync to everyone.

**Notes** are the optional line under the description — "includes Phoebe's shampoo". Shown in the ledger and searchable.

**Search** filters by description, note, category, payer, date or amount, and totals the matches.

**Edit** on any expense changes the amount, split or note after the fact. Balances recalculate.

**Repeat** on any past expense re-fills the form with the same payer, split and amount. Fastest way to log the weekly shop.

**Payment** is for when money actually moves between two of you. Record it, and balances reset. Don't skip this or the numbers drift from reality.

**Export CSV** opens a panel with two options. *Download file* saves a `.csv`. *Copy to clipboard* gives you the same text to paste straight into Excel or Google Sheets — use this on a phone, where browsers often block downloads silently. One column per flatmate, so you can sum a person's column to check the maths yourself.

---

## Known limits

- Two people editing the *same* thing at the same second: last one wins. Separate expenses added at the same time are fine — each is stored under its own key.
- Offline, you can view everything and add expenses, but they only sync when you're back online and the app is open.
- No login. Whoever has the link and room code is in.
- Percentages are stored with the expense, so editing one later reopens it with the same percentages ready to adjust.
