# Flat Ledger

A shared expense tracker for a flatshare. Four people, one ledger, no subscription.

Built because Splitwise puts recurring bills and CSV export behind a paywall, and because a flat where different people pay the rent, the broadband, the electricity and the water needs something that remembers who pays what.

Installs to the home screen, works offline, syncs live between phones.

---

## What it does

**Splits an expense four ways** — or two, or three. Uncheck whoever wasn't involved; a takeaway two people ordered doesn't get split four ways.

**Four splitting modes**, chosen per expense:

| Mode | Use it when |
|---|---|
| Equally | The default. Most things. |
| By shares | Someone takes a bigger portion. Give them `2` and everyone else `1`. Rebalances automatically if a person leaves the split. |
| By % | You want fixed proportions. Must total 100. |
| Exact £ | You know the actual amounts. Must add up to the total. |

Percentages and shares are stored with the expense, so editing one later reopens it with the same numbers ready to adjust. Frequently-used splits can be saved by name and reused in one tap.

**Recurring bills** each remember their own payer and whether the amount is fixed or variable. Rent and broadband are the same every month and appear pre-filled. Electricity, water and heating vary, so they appear with the amount blank. Once logged for the month they drop off the list.

**Settle up** reduces everyone's position to the fewest possible transfers, rather than everyone paying everyone. Recording a transfer clears the balance.

**Also:** notes on expenses, full-text search across the ledger, monthly totals, CSV export with one column per person.

---

## How the numbers work

**Everything is integer pence.** No floats anywhere in the money path. `12.50` becomes `1250` on the way in and is formatted back on the way out.

**Splits use largest-remainder allocation.** £10 across three people gives 3.34 / 3.33 / 3.33 — never 3.33 / 3.33 / 3.33 with a penny quietly lost. Each person gets the floor of their exact share, then the leftover pennies go to whoever had the largest fractional remainder. Verified against 500 randomised totals and weightings with zero drift.

**Balances are a single pass** over the ledger: a payer's balance goes up by what they paid, each participant's goes down by their share. A settlement payment is stored as the same shape — payer pays, recipient owes — so one code path handles both and the column always nets to zero.

**Settle-up is greedy matching**, largest debtor against largest creditor. Not provably minimal in the general case, but for four people it produces the obvious answer in at most three transfers.

---

## Design decisions

**No framework, no build step.** One HTML file, vanilla JS, no npm, no bundler. Editing a line and committing puts it live in about a minute. Nothing to break in two years when a dependency goes stale.

**Firebase Realtime Database, keyed per entry.** Each expense is written to its own key rather than the whole ledger being rewritten, so two people adding expenses at the same moment don't overwrite each other.

**Network-first service worker.** Most PWA tutorials cache-first, which strands users on an old version for days. This tries the network, falls back to cache offline — so an update reaches everyone as soon as they reopen the app.

**localStorage mirror.** The Realtime Database web SDK has no disk persistence, so a copy of the ledger is kept locally for cold starts with no signal.

**Sync config lives in app settings, not the source.** Nothing secret is committed, and nobody needs to edit code to join.

---

## Stack

Vanilla JS · Firebase Realtime Database · Service Worker · Web App Manifest · GitHub Pages

No dependencies. No build. Roughly 900 lines.

---

## Setup

See [SETUP.md](SETUP.md). Short version: host the folder anywhere with HTTPS, create a Firebase Realtime Database, paste the config and a room code into the app's settings on each phone.

It runs fine with no Firebase at all — you just get a ledger per device instead of a shared one.

---

## Limitations

- One flat, one currency (£).
- No login. Anyone with the link and the room code can read and write, which is why the room code should have random characters in it. No card or bank details are ever stored.
- Offline edits sync when the app is next open with a connection, not in the background.
- Simultaneous edits to *the same* entry are last-write-wins.

---

## Licence

MIT.
