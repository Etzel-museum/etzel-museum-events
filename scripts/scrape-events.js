// Scrapes the museum's official events list (museums.mod.gov.il) and drafts
// matching events/sessions into our own Firestore, via the Admin SDK
// (runs only inside the GitHub Action - never in the browser).
//
// Design notes:
// - Groups scraped cards by title, since the source site lists the same
//   event once per date (each with its own time(s)) rather than once with
//   multiple sessions - we fold those back into one event with N sessions.
// - Never touches an existing session's capacity/registeredCount - those
//   are either admin-set or real registration data, not ours to overwrite.
// - Only marks a NEW event active if title/description/image/location/at
//   least one session all parsed successfully; incomplete ones stay draft
//   (active: false) for the admin to review.
// - Also self-heals registeredCount by recounting real registrations, to
//   bound the damage window of any client-side counter tampering.
const cheerio = require('cheerio');
const admin = require('firebase-admin');
const fs = require('fs');

const SOURCE_URL = 'https://museums.mod.gov.il/sites/Etzel/Events/Pages/Eventslist.aspx';
const CLOUDINARY_CLOUD_NAME = 'qtdjlxjs';
const CLOUDINARY_UPLOAD_PRESET = 'קלודקוד';
const DEFAULT_CAPACITY = 50;

function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function parseHebrewDate(dateStr) {
  const m = (dateStr || '').trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y.length === 2) y = '20' + y;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function parseTimes(timeStr) {
  return (timeStr || '').match(/\d{1,2}:\d{2}/g) || [];
}

async function uploadImageToCloudinary(imageUrl) {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`image fetch failed (${imgRes.status}): ${imageUrl}`);
  const blob = await imgRes.blob();
  const form = new FormData();
  form.append('file', blob, 'event.jpg');
  form.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
    method: 'POST',
    body: form
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`cloudinary upload failed: ${JSON.stringify(data)}`);
  return data.secure_url;
}

function scrapeCards(html) {
  const $ = cheerio.load(html);
  const cards = [];
  $('.specificMuseumEvent').each((_, el) => {
    const $el = $(el);
    const title = $el.find('.specificMuseumEventTitle').first().text().trim();
    const summary = $el.find('.specificMuseumEventSummary').first().text().trim();
    let imageSrc = $el.find('.specificMuseumEventImg').first().attr('src') || '';
    if (imageSrc && !/^https?:\/\//.test(imageSrc)) {
      imageSrc = new URL(imageSrc, SOURCE_URL).href;
    }
    let dateStr = '', timeStr = '', location = '';
    $el.find('.specificMuseumEventTimeAndLocation').each((__, row) => {
      const $row = $(row);
      const text = $row.find('span').first().text().trim();
      if ($row.find('.fa-calendar-alt').length) dateStr = text;
      else if ($row.find('.fa-clock').length) timeStr = text;
      else if ($row.find('.fa-map-marker-alt').length) location = text;
    });
    if (!title) return;
    cards.push({ title, summary, imageSrc, dateStr, timeStr, location });
  });
  return cards;
}

async function main() {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
  const db = admin.firestore();

  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`source page fetch failed: ${res.status}`);
  const html = await res.text();
  const cards = scrapeCards(html);

  const groups = new Map();
  for (const card of cards) {
    if (!groups.has(card.title)) groups.set(card.title, []);
    groups.get(card.title).push(card);
  }

  let created = 0, updated = 0, draft = 0, sessionsWritten = 0;

  for (const [title, group] of groups) {
    const summary = group[0].summary;
    const location = group.map(c => c.location).find(Boolean) || '';
    const imageSrc = group.map(c => c.imageSrc).find(Boolean) || '';

    const sessions = [];
    for (const card of group) {
      const date = parseHebrewDate(card.dateStr);
      const times = parseTimes(card.timeStr);
      if (!date || times.length === 0) continue;
      for (const time of times) sessions.push({ date, time, dateTime: `${date}T${time}` });
    }

    const fieldsOk = !!(title && summary && imageSrc && location && sessions.length > 0);
    const eventId = 'mod-' + hashString(title);
    const eventRef = db.collection('events').doc(eventId);
    const existingSnap = await eventRef.get();

    let imageUrl = '';
    if (imageSrc) {
      try {
        imageUrl = await uploadImageToCloudinary(imageSrc);
      } catch (e) {
        console.error(`image upload failed for "${title}":`, e.message);
      }
    }

    const eventData = {
      title,
      description: summary,
      source: 'mod-scrape',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (imageUrl) eventData.imageUrl = imageUrl;

    if (!existingSnap.exists) {
      eventData.active = fieldsOk;
      eventData.createdAt = admin.firestore.FieldValue.serverTimestamp();
      created++;
    } else {
      if (fieldsOk && existingSnap.data().active === false) eventData.active = true;
      updated++;
    }
    if (!fieldsOk) draft++;

    await eventRef.set(eventData, { merge: true });

    for (const s of sessions) {
      const sessionRef = eventRef.collection('sessions').doc(hashString(s.dateTime));
      const sExisting = await sessionRef.get();
      if (!sExisting.exists) {
        await sessionRef.set({ date: s.date, time: s.time, dateTime: s.dateTime, capacity: DEFAULT_CAPACITY, registeredCount: 0 });
        sessionsWritten++;
      }
    }
  }

  // Integrity self-heal: recompute registeredCount from real registrations,
  // bounding how long any tampered counter can stay wrong.
  let healed = 0;
  const eventsSnap = await db.collection('events').get();
  for (const eventDoc of eventsSnap.docs) {
    const sessionsSnap = await eventDoc.ref.collection('sessions').get();
    for (const sessionDoc of sessionsSnap.docs) {
      const regsSnap = await sessionDoc.ref.collection('registrations').get();
      const real = regsSnap.docs.reduce((sum, r) => sum + (r.data().partySize || 0), 0);
      if (real !== (sessionDoc.data().registeredCount || 0)) {
        await sessionDoc.ref.update({ registeredCount: real });
        healed++;
      }
    }
  }

  const summaryText = `Scraped ${cards.length} cards -> ${groups.size} events (${created} new, ${updated} updated, ${draft} left as draft), ${sessionsWritten} new sessions, ${healed} counters healed.`;
  console.log(summaryText);
  fs.writeFileSync('last-scrape.json', JSON.stringify({ ranAt: new Date().toISOString(), summary: summaryText }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
