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

/* Tried in order. The newest model is usually the busiest — one released days
 * ago returns 503 "high demand" far more often than one a few months old, and
 * for reading a receipt the older one is no worse. Keep a settled model first
 * and a smaller one behind it, so a spike on one doesn't kill the feature.
 * A 404 means the ID has been retired: check AI Studio for the current list. */
const MODELS = [
  'gemini-3.6-flash',
  'gemini-3.1-flash-lite'
];

// 503 and 429 are transient. Wait and try again before moving on.
const RETRY_DELAYS = [700, 1800];

const PROMPT = `You are reading a photo of a shop receipt.

Return ONLY a JSON object, no markdown fences, no explanation:
{"total": number|null, "merchant": string|null, "date": "YYYY-MM-DD"|null, "confident": boolean}

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

async function callModel(model, mime, b64, key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: mime, data: b64 } }
        ]
      }],
      generationConfig: {
        temperature: 0,
        /* Flash models think by default and thinking tokens are charged against
         * maxOutputTokens. At 300 the model spent the lot reasoning and returned
         * empty text with finishReason MAX_TOKENS — every receipt "unreadable".
         * Reading a total off a receipt needs no reasoning, so thinking is off,
         * and the ceiling is generous in case a model ignores that. */
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 1200,
        responseMimeType: 'application/json'
      }
    })
  });
}

/* Walk the model list, retrying transient failures on each before dropping to
 * the next. Returns the first good response, or the last failure so the app
 * can say something specific rather than "model error". */
async function askModels(mime, b64, key) {
  let last = { status: 0, detail: '', model: '' };

  for (const model of MODELS) {
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      let res;
      try {
        res = await callModel(model, mime, b64, key);
      } catch {
        last = { status: 0, detail: 'network error reaching the model', model };
        break;                                   // network fault: try the next model
      }

      if (res.ok) return { ok: true, res, model };

      const detail = await res.text().catch(() => '');
      last = { status: res.status, detail, model };

      const transient = res.status === 503 || res.status === 429 || res.status >= 500;
      if (!transient) break;                     // 400/403/404: retrying won't help
      if (attempt < RETRY_DELAYS.length) await sleep(RETRY_DELAYS[attempt]);
    }
  }
  return { ok: false, ...last };
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

    const out = await askModels(mime, b64, env.GEMINI_KEY);

    if (!out.ok) {
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
      if (out.status === 400 || out.status === 403) {
        return json({
          error: 'The API key was rejected. Check the GEMINI_KEY secret in the Worker.',
          status: out.status,
          detail: (out.detail || '').slice(0, 300)
        }, 502, origin);
      }
      return json({
        error: 'The reader failed.',
        status: out.status,
        detail: (out.detail || '').slice(0, 300)
      }, 502, origin);
    }

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

    return json({
      total,
      merchant,
      date,
      confident: parsed.confident !== false,
      model: out.model            // handy when one model reads better than another
    }, 200, origin);
  }
};
