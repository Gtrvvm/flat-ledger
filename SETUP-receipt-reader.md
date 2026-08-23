# Setting up the receipt reader

Reads the total, shop and date off a receipt photo and fills them in for you. You check the numbers before saving — it never saves on its own.

Two free accounts, no card for either. About 25 minutes.

**Do these in order and test at step 4 before going further.** If the Worker doesn't respond, nothing else will work and you'll waste time looking in the wrong place.

---

## Part 1 — Get a Gemini API key

1. Go to `aistudio.google.com` and sign in with a Google account.
2. Click **Get API key**, then **Create API key**.
3. Pick **Create API key in new project** if it asks.
4. Copy the key. It starts with `AIza...`.

**Keep this key private.** Never paste it into `index.html`, never commit it to GitHub. That's the entire reason we're building the Worker.

While you're here, look at the rate limits shown for your project. Free-tier Flash models allow far more per day than four flatmates will ever use.

**One thing to tell the others:** on the free tier, Google may use what you send to improve their models. That means receipt photos. Not especially sensitive, but they do show what you bought and where, so everyone should know.

---

## Part 2 — Create the Cloudflare Worker

1. Go to `cloudflare.com`, create a free account, verify your email.
2. In the dashboard sidebar: **Compute (Workers)** → **Workers & Pages** → **Create** → **Start with Hello World** → **Deploy**.

   Give it a name like `flat-receipt`. It deploys a placeholder — that's fine.
3. Once deployed, click **Edit code**.
4. Delete everything in the editor. Paste in the whole of `worker.js`.
5. **Change one line near the top:**

   ```js
   const ALLOWED_ORIGINS = [
     'https://YOURNAME.github.io',     // <- your actual GitHub Pages address
     'http://localhost:8000'
   ];
   ```

   Just the origin — no repo name, no trailing slash. If your app is at
   `https://jackycheung.github.io/flat-ledger/`, the origin is
   `https://jackycheung.github.io`.

   This stops anyone else who finds your Worker URL from spending your quota.
6. Click **Deploy**.

---

## Part 3 — Add the key as a secret

The key goes in Cloudflare's secret store, never in the code.

1. Leave the editor. On the Worker's page: **Settings** → **Variables and Secrets**.
2. **Add** → type **Secret** (not plain text).
3. Name it exactly `GEMINI_KEY` — capitals and underscore matter.
4. Paste your `AIza...` key as the value.
5. **Deploy** / **Save**.

Note your Worker URL from the Worker's overview page. It looks like:

```
https://flat-receipt.yourname.workers.dev
```

---

## Part 4 — Test it before going further

Easiest check: open your Worker URL in a browser tab. You should see:

```json
{"error":"POST an image to this endpoint."}
```

That's the right answer — it means the Worker is alive and rejecting a GET, as designed.

If you instead see a Cloudflare error page, the Worker didn't deploy. Go back to step 2.

A proper test needs a POST with an image, which the app will do for you in Part 5. If you want to check now, open your **app** on GitHub Pages, then in the browser console:

```js
fetch('https://YOUR-WORKER-URL.workers.dev', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ image: 'data:image/jpeg;base64,AAAA' })
}).then(r => r.json()).then(console.log)
```

Run it from a tab on your GitHub Pages origin, not from a blank tab, or the origin check will reject it. A reply mentioning the image or the model means everything is wired up. A CORS error means `ALLOWED_ORIGINS` doesn't match your actual address.

---

## Part 5 — Point the app at it

**Settings → Receipt reader → paste your Worker URL** → Save.

**Only one of you needs to do this.** The address syncs with the rest of the flat settings, so the other three get it automatically next time their app connects. Nobody else needs a Google account, a Cloudflare account, or an API key — that's the point of the proxy.

Then: Add expense → Take photo → **Read the receipt** appears under the thumbnail. It comes back with the total, shop and date, each with its own **Use** button, or **Use all of it**.

Nothing is filled in without you tapping. Nothing saves without you tapping Save. If the reader is wrong, ignore it and type over the top.

---

## If something breaks

| What you see | Cause |
|---|---|
| CORS error in the console | `ALLOWED_ORIGINS` doesn't match your site exactly. No trailing slash, no repo name. |
| `Server is missing its API key` | The secret isn't named exactly `GEMINI_KEY`, or was added as plain text instead of a secret. |
| `Model "..." not found` | Google retired that model ID. Check the current one in AI Studio and change `MODEL` at the top of `worker.js`. |
| `Rate limit reached` | Free-tier limit hit. Wait a minute. |
| `Could not read that receipt` | The model replied with something unparseable. Usually a very poor photo. |
| No **Read the receipt** button | No Worker URL saved in Settings, or no photo attached yet. Both are needed. |
| `Could not reach the reader` | Wrong URL in Settings, or you're offline. Reading needs a connection; attaching photos doesn't. |

---

## Costs

Both free tiers are far beyond what four flatmates generate. Cloudflare Workers allow 100,000 requests a day; you'll do a handful a week. Gemini Flash free tier is measured in hundreds of requests a day.

No card is required for either. If you somehow exceeded the Gemini free tier, requests fail rather than charging you — there's no billing account attached to fail into.
