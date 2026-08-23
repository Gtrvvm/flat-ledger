/* Flat Ledger — instant notifications
 *
 * Fires the moment an entry is written, rather than polling. The monthly
 * "bills not logged" nudge stays in GitHub Actions, where a schedule belongs.
 *
 * Deploy:  firebase deploy --only functions
 */

const { onValueWritten } = require('firebase-functions/v2/database');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();

// Keep it small and close to the database. maxInstances stops a runaway
// loop from ever becoming an expensive one.
setGlobalOptions({ region: 'europe-west1', maxInstances: 5, memory: '256MiB' });

function money(pence) {
  return '£' + (Math.abs(Number(pence) || 0) / 100).toFixed(2);
}
function nameOf(members, id) {
  const m = (members || []).find(x => x.id === id);
  return m ? m.name : 'Someone';
}

/* Who should hear about this entry, and what should it say?
   Mirrors scripts/notify.js exactly — if you change one, change the other. */
function messagesFor(entry, before, members) {
  const out = [];
  if (!entry || entry.voided) return out;

  if (entry.type === 'payment') {
    // Only on the transition into pending, so an edit doesn't re-ping.
    const wasPending = before && before.status === 'pending';
    if (entry.status === 'pending' && !wasPending) {
      const to = Object.keys(entry.shares || {})[0];
      if (to) out.push({
        member: to, kind: 'payment',
        title: 'Payment to confirm',
        body: `${nameOf(members, entry.paidBy)} says they sent you ${money(entry.amount)}.`,
        tag: 'pay-' + entry.id
      });
    }
    // Someone said your payment never arrived — you'd want to know.
    if (entry.status === 'declined' && (!before || before.status !== 'declined')) {
      out.push({
        member: entry.paidBy, kind: 'payment',
        title: 'Payment not received',
        body: `${nameOf(members, entry.declinedBy)} says ${money(entry.amount)} never landed.`,
        tag: 'dec-' + entry.id
      });
    }
    return out;
  }

  // Expenses: only announce brand new ones. Edits stay quiet.
  if (before) return out;

  for (const m of members || []) {
    if (m.id === entry.addedBy) continue;                 // not your own doing
    if (!(entry.shares || {})[m.id]) continue;            // not in this split
    out.push({
      member: m.id, kind: 'expense',
      title: entry.desc || 'New expense',
      body: `${nameOf(members, entry.addedBy)} added ${money(entry.amount)} — your share ${money(entry.shares[m.id])}.`,
      tag: 'exp-' + entry.id
    });
  }
  return out;
}

exports.onEntryWritten = onValueWritten(
  { ref: '/flats/{room}/entries/{entryId}', instance: process.env.RTDB_INSTANCE || undefined },
  async (event) => {
    const after = event.data.after.val();
    const before = event.data.before.val();
    if (!after) return;                                   // deleted outright

    const room = event.params.room;
    const db = admin.database();

    const [metaSnap, tokenSnap] = await Promise.all([
      db.ref(`/flats/${room}/meta`).get(),
      db.ref(`/flats/${room}/tokens`).get()
    ]);

    const tokens = tokenSnap.val();
    if (!tokens) return;

    const members = (metaSnap.val() || {}).members || [];
    const msgs = messagesFor({ ...after, id: event.params.entryId }, before, members);
    if (!msgs.length) return;

    const sends = [];
    const dead = [];

    for (const [token, info] of Object.entries(tokens)) {
      const prefs = (info && info.prefs) || {};
      const mine = msgs.filter(m => m.member === info.member && prefs[m.kind] !== false);
      if (!mine.length) continue;

      const msg = mine.length === 1
        ? mine[0]
        : { title: `${mine.length} updates`, body: mine.map(m => m.title).join(' · '), tag: 'batch' };

      sends.push(
        admin.messaging().send({
          token,
          data: { title: msg.title, body: msg.body, tag: msg.tag },
          webpush: { headers: { Urgency: 'high', TTL: '86400' } }
        }).catch(err => {
          const code = err && err.errorInfo && err.errorInfo.code;
          if (code === 'messaging/registration-token-not-registered' ||
              code === 'messaging/invalid-registration-token') {
            dead.push(token);                             // phone reinstalled or cleared
          } else {
            console.error('send failed', code || err);
          }
        })
      );
    }

    await Promise.all(sends);
    await Promise.all(dead.map(t => db.ref(`/flats/${room}/tokens/${t}`).remove()));

    // Keep the polling job's cursor moving, so if you ever fall back to it
    // you don't get a flood of everything this function already handled.
    await db.ref(`/flats/${room}/notify/cursor`).set(Date.now());

    console.log(`sent ${sends.length - dead.length}, pruned ${dead.length}`);
  }
);
