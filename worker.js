/* Flat Ledger — receipt reader proxy
 *
 * Sits between the app and Gemini so the API key never appears in the
 * public repo. Deploy on Cloudflare Workers (free tier, no card).
 *
 * Two things to set before this works:
 *   1. A secret named GEMINI_KEY   (Worker → Settings → Variables → Secret)
 *   2. ALLOWED_ORIGINS below, so only your app can use it
 */

// Your GitHub Pages URL. Add localhost if you test locally.
const ALLOWED_ORIGINS = [
  'https://gtrvvm.github.io',
  'http://localhost:8000'
];

/* Tried in order, best reader first, with faster and older ones behind it so
 * a spike on one doesn't kill the feature.
 * A 404 means the ID has been retired: check AI Studio for the current list. */
const MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash'
];

/* Timing is the whole point of this rewrite.
 *
 * The old version tried two models three times each with 0.7s and 1.8s
 * between, and nothing capped a single slow call. One busy model could take
 * the better part of a minute while the app gave up at thirty seconds — so a
 * request that was going to succeed on the fallback looked like a dead
 * reader. Now: every call is capped, every attempt checks the clock first,
 * and a busy model is dropped after one retry instead of three. Switching
 * models costs less than waiting on a queue. */
const TOTAL_BUDGET_MS = 22000;   // finish inside this and the app never times out
const CALL_TIMEOUT_MS = 11000;   // one hung call must not eat the whole budget
const RETRY_DELAY_MS  = 600;

const PROMPT = `You are reading a photo of a shop receipt.

Return ONLY a JSON object, no markdown fences, no explanation:
{"total": number|null, "merchant": string|null, "date": "YYYY-MM-DD"|null,
 "items": [{"name": string, "price": number}], "confident": boolean}

Rules:
- "total" is the final amount actually paid, in pounds as a plain number (e.g. 43.20).
  Do NOT return the subtotal, the VAT line, cash tendered, change given, or loyalty points.
  If several totals appear, take the one the customer paid.
- "merchant" is the shop name, short and tidy (e.g. "Tesco", "Sainsbury's").
- Receipts are often photographed at an angle, so a label and its number may not sit
  on the same visual line. Match each amount to its label by reading order, not by
  height on the page. If a "Total" label appears above a column of figures, the first
  figure belongs to it.
- A line reading "VAT included in total" is NOT the total: it is the tax already
  counted inside it. The total is always the larger figure.
- "date" is the purchase date, converted to YYYY-MM-DD. These are UK receipts, so
  dates are day-first: 16/06/26 is 16 June 2026, never 6 October. Two-digit years
  are 20xx. Formats like "19AUG2026" or "28/04/26" are both normal. The date may
  only appear in small print at the very bottom of the receipt — look there too.
  Return null only if no date appears at all.
- "items" is one entry per thing actually bought, in the order printed.
  * "price" is the line total in pounds. If a line reads "2x Milk 3.00" and 3.00 is
    the total for both, use 3.00; if 3.00 is the unit price, use 6.00. Follow the receipt.
  * Put the quantity in the name when it matters, e.g. "2x Milk".
  * Do NOT include subtotals, totals, VAT lines, discounts, vouchers, service charge,
    tips, cash tendered, change, loyalty points, or anything that is not a purchase.
    Those are handled separately — the app works out the difference itself.
  * Tidy the names lightly: "150G TD EARL GREY BISC TB" becomes "Earl Grey biscuits".
    Never invent a product that is not printed.
  * If the items are unreadable, return an empty array rather than guessing.
- "confident" is false if the image is blurred, cropped, or you are guessing.
- Any field you cannot read reliably must be null. Never invent a value.`;

// The regex alone would let "2026-13-45" through, so check it's a real day —
// and reject anything in the future, matching the rule in the app.
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (dt.getTime() > Date.now()) return null;
  if (y < 2000) return null;
  return s;
}

function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) }
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callModel(model, mime, b64, key, noThinking, timeoutMs) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  /* Flash models think by default and thinking tokens count against
   * maxOutputTokens, which is what made every receipt come back empty.
   * Turning thinking off fixes that — but not every model accepts a budget
   * of zero, and the ones that don't answer 400. So we ask for it, and if
   * the model objects we ask again without it and a bigger ceiling. */
  const generationConfig = {
    temperature: 0,
    maxOutputTokens: noThinking ? 4000 : 2500,
    responseMimeType: 'application/json'
  };
  if (!noThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  // Without this, a model that simply never answers holds the whole request open.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: mime, data: b64 } }
          ]
        }],
        generationConfig
      })
    });
  } finally {
    clearTimeout(timer);
  }
}

/* Walk the model list against a clock. Each model gets one retry on a
 * transient failure, then we move on rather than queue behind a busy one.
 * Returns the first good response, or the last failure so the app can say
 * something specific rather than "model error". */
async function askModels(mime, b64, key, deadline) {
  /* One shape for every outcome. Returning {ok:true, res} from one branch and
     {ok:false, status, detail} from another left the caller reading fields
     that only exist on one of them, which every type checker rightly flags. */
  const out = {
    ok: false,
    /** @type {Response|null} */ res: null,
    model: '',
    status: 0,
    detail: '',
    timedOut: false,
    /* Why each model was given up on. Reporting only the last one left
       "the reader failed" as the entire explanation, which is no help when
       the first model is the one that is actually misconfigured.
       @type {{model:string,status:number,why:string}[]} */
    tried: []
  };

  for (const model of MODELS) {
    let noThinking = false, retried = false;
    out.model = model;

    for (;;) {
      // Never start a call that cannot finish. Better a clear answer now than
      // a timeout the app has to guess at.
      const left = deadline - Date.now();
      if (left < 4000) {
        out.timedOut = true;
        out.tried.push({ model, status: 0, why: 'ran out of time before trying' });
        return out;
      }

      let res;
      try {
        res = await callModel(model, mime, b64, key, noThinking, Math.min(CALL_TIMEOUT_MS, left));
      } catch (e) {
        /* DOMException is an Error in the browsers this runs in, but the
           name check is what matters and an unknown throw must not be
           mislabelled as a timeout. */
        const aborted = !!e && /** @type {any} */ (e).name === 'AbortError';
        out.status = 0;
        out.detail = aborted ? `no answer within ${CALL_TIMEOUT_MS / 1000}s`
                             : `could not reach Google (${String(/** @type {any} */ (e)?.message || e).slice(0, 80)})`;
        out.tried.push({ model, status: 0, why: out.detail });
        break;                                   // stuck or unreachable: try the next model
      }

      if (res.ok) { out.ok = true; out.res = res; return out; }

      const detail = await res.text().catch(() => '');
      out.status = res.status;
      out.detail = detail;

      // "thinking budget is not supported" — ask again the plain way.
      // noThinking is now true, so this can only happen once per model.
      if (res.status === 400 && !noThinking && /thinking/i.test(detail)) {
        noThinking = true;
        continue;
      }

      const transient = res.status === 503 || res.status === 429 || res.status >= 500;
      if (!transient || retried) {               // 400/403/404 never improve; one retry otherwise
        let why = '';
        try { why = (JSON.parse(detail).error || {}).message || ''; } catch { why = ''; }
        out.tried.push({ model, status: res.status, why: (why || detail || '').slice(0, 120) });
        break;
      }
      retried = true;
      await sleep(RETRY_DELAY_MS);
    }
  }
  return out;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'POST an image to this endpoint.' }, 405, origin);
    }
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'Not allowed from this origin.' }, 403, origin);
    }
    if (!env.GEMINI_KEY) {
      return json({ error: 'Server is missing its API key.' }, 500, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Body must be JSON.' }, 400, origin);
    }

    // The app sends a data URL: "data:image/jpeg;base64,AAAA..."
    const dataUrl = body.image || '';
    const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl);
    if (!match) {
      return json({ error: 'Expected a base64 image data URL.' }, 400, origin);
    }
    const [, mime, b64] = match;

    // ~1.4MB of base64 is about 1MB of image. Ours are far smaller.
    if (b64.length > 1_400_000) {
      return json({ error: 'Image too large.' }, 413, origin);
    }

    const started = Date.now();
    const out = await askModels(mime, b64, env.GEMINI_KEY, started + TOTAL_BUDGET_MS);

    if (!out.ok) {
      if (out.timedOut) {
        return json({
          error: 'Google is slow right now \u2014 nothing answered in time. Try again, or type it in.',
          status: 'timeout',
          detail: out.tried.map(t => `${t.model}: ${t.why}`).join(' \u00b7 ').slice(0, 300),
          tried: out.tried
        }, 504, origin);
      }
      if (out.status === 503) {
        return json({
          error: 'The reader is busy at Google\u2019s end. Try again in a minute, or type it in.',
          status: 503
        }, 503, origin);
      }
      if (out.status === 429) {
        return json({ error: 'Rate limit reached \u2014 type it in for now.', status: 429 }, 429, origin);
      }
      if (out.status === 404) {
        return json({
          error: `No model found. Check the IDs in AI Studio: ${MODELS.join(', ')}.`,
          status: 404
        }, 502, origin);
      }
      if (out.status === 403) {
        return json({
          error: 'The API key was rejected. Check the GEMINI_KEY secret in the Worker.',
          status: 403,
          detail: (out.detail || '').slice(0, 300)
        }, 502, origin);
      }
      if (out.status === 400) {
        // A 400 is usually a malformed request, not a bad key. Say what Google said.
        let why = '';
        try { why = (JSON.parse(out.detail).error || {}).message || ''; } catch { why = ''; }
        if (/API key not valid|API_KEY_INVALID/i.test(out.detail)) {
          return json({
            error: 'The API key is not valid. Replace the GEMINI_KEY secret in the Worker.',
            status: 400, detail: why.slice(0, 200)
          }, 502, origin);
        }
        return json({
          error: 'The model refused the request: ' + (why.slice(0, 120) || 'no reason given'),
          status: 400,
          detail: (out.detail || '').slice(0, 300)
        }, 502, origin);
      }
      /* Everything else. Name every model and what it said, so the message
         itself is the diagnosis rather than a prompt to go digging. */
      const roll = out.tried.map(t => `${t.model}: ${t.status || 'no reply'}${t.why ? ' \u2014 ' + t.why : ''}`);
      return json({
        error: roll.length
          ? 'Every model failed. ' + roll.join(' \u00b7 ')
          : 'The reader failed before it could ask Google.',
        status: out.status,
        detail: (out.detail || '').slice(0, 300),
        tried: out.tried
      }, 502, origin);
    }

    // out.ok is true here, so res is set — the check keeps the type checker happy too.
    if (!out.res) return json({ error: 'The reader failed.' }, 502, origin);
    const data = await out.res.json();
    const cand = data?.candidates?.[0];
    const text = cand?.content?.parts?.[0]?.text || '';
    const finish = cand?.finishReason || '';
    const thoughts = data?.usageMetadata?.thoughtsTokenCount || 0;

    // Empty text with MAX_TOKENS means the budget went on thinking. Say so
    // plainly rather than blaming the photo — this cost an evening once.
    if (!text && finish === 'MAX_TOKENS') {
      return json({
        error: 'The model ran out of tokens before answering. Raise maxOutputTokens in the Worker.',
        status: 'MAX_TOKENS',
        detail: `thinking tokens used: ${thoughts}`
      }, 502, origin);
    }
    if (!text) {
      return json({
        error: 'The model returned nothing.',
        status: finish || 'empty',
        detail: (JSON.stringify(data).slice(0, 300))
      }, 502, origin);
    }

    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      return json({ error: 'Could not read that receipt.', detail: text.slice(0, 200) }, 200, origin);
    }

    // Never trust the model's shape — normalise before it reaches the app.
    const total = typeof parsed.total === 'number' && isFinite(parsed.total) && parsed.total > 0
      ? Math.round(parsed.total * 100) / 100
      : null;
    const date = validDate(parsed.date);
    const merchant = typeof parsed.merchant === 'string'
      ? parsed.merchant.trim().slice(0, 60) || null
      : null;

    // Never trust the array either: drop anything malformed rather than
    // letting a stray null reach the app.
    const items = Array.isArray(parsed.items)
      ? parsed.items
          .filter(it => it && typeof it.name === 'string' &&
                        typeof it.price === 'number' && isFinite(it.price) && it.price > 0)
          .slice(0, 40)
          .map(it => ({ name: it.name.trim().slice(0, 60), price: Math.round(it.price * 100) / 100 }))
      : [];

    return json({
      total,
      merchant,
      date,
      items,
      itemsTotal: items.length ? Math.round(items.reduce((a, i) => a + i.price, 0) * 100) / 100 : null,
      confident: parsed.confident !== false,
      model: out.model,           // handy when one model reads better than another
      ms: Date.now() - started    // how long Google actually took, for when it feels slow
    }, 200, origin);
  }
};
