/* Flat Ledger notifier
 *
 * Runs on a schedule from GitHub Actions. Reads the ledger, works out what
 * is new since the last run, and sends a push to the phones that care.
 *
 * No Cloud Functions, so no billing account. FCM itself is free.
 *
 * Needs two repository secrets:
 *   FIREBASE_SERVICE_ACCOUNT  - the whole service account JSON, pasted in
 *   FLAT_ROOM                 - your room code, exactly as in the app
 *
 * And one variable (or secret):
 *   FIREBASE_DB_URL           - https://xxxx-default-rtdb.<region>.firebasedatabase.app
 */

const crypto = require('crypto');

const SA = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
const DB = (process.env.FIREBASE_DB_URL || '').replace(/\/+$/, '');
const ROOM = (process.env.FLAT_ROOM || '').replace(/[.#$[\]/]/g, '_');

if (!SA.client_email || !DB || !ROOM) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT, FIREBASE_DB_URL or FLAT_ROOM.');
  process.exit(1);
}

const BASE = `${DB}/flats/${ROOM}`;

/* ---------- database over plain REST ---------- */
async function dbGet(path) {
  const res = await fetch(`${BASE}/${path}.json`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}
async function dbPut(path, value) {
  const res = await fetch(`${BASE}/${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  if (!res.ok) throw new Error(`PUT ${path} -> ${res.status}`);
}
async function dbDelete(path) {
  await fetch(`${BASE}/${path}.json`, { method: 'DELETE' }).catch(() => {});
}

/* ---------- an OAuth token for FCM, signed with the service account ---------- */
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: SA.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const sig = b64url(signer.sign(SA.private_key));
  const jwt = `${header}.${claim}.${sig}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('No access token: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

/* ---------- sending ---------- */
async function send(token, title, body, tag, auth) {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${SA.project_id}/messages:send`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      // data-only, so our service worker decides how it looks
      body: JSON.stringify({
        message: {
          token,
          data: { title, body, tag },
          webpush: { headers: { Urgency: 'normal', TTL: '86400' } }
        }
      })
    }
  );
  if (res.ok) return true;
  const err = await res.json().catch(() => ({}));
  const code = err?.error?.details?.[0]?.errorCode || err?.error?.status;
  // A phone that uninstalled or cleared data leaves a dead token behind.
  if (code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT' || res.status === 404) return 'dead';
  console.error('send failed', res.status, JSON.stringify(err).slice(0, 200));
  return false;
}

function money(pence) {
  return '£' + (Math.abs(pence) / 100).toFixed(2);
}
function nameOf(members, id) {
  const m = (members || []).find(x => x.id === id);
  return m ? m.name : 'Someone';
}

async function main() {
  const [meta, entries, tokens, cursorRaw] = await Promise.all([
    dbGet('meta').catch(() => null),
    dbGet('entries').catch(() => null),
    dbGet('tokens').catch(() => null),
    dbGet('notify/cursor').catch(() => null)
  ]);

  if (!tokens) { console.log('No phones registered. Nothing to do.'); return; }

  const members = (meta && meta.members) || [];
  const all = Object.values(entries || {});
  const cursor = Number(cursorRaw) || 0;
  const now = Date.now();

  // First run: don't spam everyone with the whole history.
  if (!cursor && process.env.MONTHLY_ONLY !== '1') {
    await dbPut('notify/cursor', now);
    console.log('First run — cursor set, no notifications sent.');
    return;
  }

  // With the Cloud Function deployed, live events are already handled.
  // MONTHLY_ONLY keeps this job to the 1st-of-month nudge and nothing else.
  const monthlyOnly = process.env.MONTHLY_ONLY === '1';
  const fresh = monthlyOnly ? [] : all.filter(e => Number(e.createdAt) > cursor && !e.voided);
  const messages = [];   // { forMember, kind, title, body, tag }

  for (const e of fresh) {
    if (e.type === 'payment') {
      // Only the person who has to confirm it needs telling.
      if (e.status === 'pending') {
        const to = Object.keys(e.shares || {})[0];
        if (to) messages.push({
          forMember: to, kind: 'payment',
          title: 'Payment to confirm',
          body: `${nameOf(members, e.paidBy)} says they sent you ${money(e.amount)}.`,
          tag: 'pay-' + e.id
        });
      }
    } else {
      for (const m of members) {
        if (m.id === e.addedBy) continue;          // don't tell you what you just did
        if (!(e.shares || {})[m.id]) continue;     // not in the split, not their problem
        messages.push({
          forMember: m.id, kind: 'expense',
          title: e.desc || 'New expense',
          body: `${nameOf(members, e.addedBy)} added ${money(e.amount)} — your share ${money(e.shares[m.id])}.`,
          tag: 'exp-' + e.id
        });
      }
    }
  }

  // Monthly bills, once, on the day configured in the workflow.
  if (process.env.MONTHLY_CHECK === '1') {
    const period = new Date().toISOString().slice(0, 7);
    const logged = new Set(all.filter(e => !e.voided && e.templateId && e.period)
      .map(e => e.templateId + '|' + e.period));
    const due = (meta?.templates || []).filter(t => !logged.has(t.id + '|' + period));
    if (due.length) {
      const list = due.map(t => t.name).join(', ');
      for (const m of members) {
        messages.push({
          forMember: m.id, kind: 'monthly',
          title: 'Bills not logged yet',
          body: `${list} — still to add for this month.`,
          tag: 'monthly-' + period
        });
      }
    }
  }

  if (!messages.length) {
    await dbPut('notify/cursor', now);
    console.log('Nothing new.');
    return;
  }

  const auth = await accessToken();
  let sent = 0, dead = 0;

  for (const [token, info] of Object.entries(tokens)) {
    const prefs = info.prefs || {};
    const mine = messages.filter(msg =>
      msg.forMember === info.member && prefs[msg.kind] !== false
    );
    // One phone, one buzz — collapse a burst into a single line.
    if (!mine.length) continue;
    const msg = mine.length === 1
      ? mine[0]
      : { title: `${mine.length} updates`, body: mine.map(m => m.title).join(' · '), tag: 'batch' };

    const result = await send(token, msg.title, msg.body, msg.tag, auth);
    if (result === 'dead') { await dbDelete(`tokens/${token}`); dead++; }
    else if (result) sent++;
  }

  await dbPut('notify/cursor', now);
  console.log(`Sent ${sent}. Removed ${dead} dead token(s). ${messages.length} message(s) considered.`);
}

main().catch(err => { console.error(err); process.exit(1); });
