// Live Google Calendar availability + booking, used by the Vapi tool-call
// handlers in server.js. No-op-if-unconfigured, same pattern as the claude()
// helper in agents.js — safe to call before GOOGLE_CALENDAR_* env vars exist.
const { google } = require("googleapis");
const { load } = require("./store");

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SLOT_STEP_MINUTES = 15;
const MAX_SLOTS = 6;

function tz() {
  return load().settings.receptionist?.timezone || process.env.CLINIC_TIMEZONE || "America/New_York";
}

function calendarId() {
  return process.env.GOOGLE_CALENDAR_ID;
}

function configured() {
  return !!process.env.GOOGLE_CALENDAR_CREDENTIALS && !!calendarId();
}

async function client() {
  if (!configured()) return null;
  const raw = process.env.GOOGLE_CALENDAR_CREDENTIALS.trim();
  const opts = raw.startsWith("{")
    ? { credentials: JSON.parse(raw), scopes: SCOPES } // inline JSON pasted into the env var
    : { keyFile: raw, scopes: SCOPES }; // path to the downloaded key file
  const auth = new google.auth.GoogleAuth(opts);
  return google.calendar({ version: "v3", auth: await auth.getClient() });
}

// ---------- timezone-correct local-time <-> UTC conversion, no date lib ----------
function pad(n) { return String(n).padStart(2, "0"); }

function tzOffsetMinutes(utcGuess, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(utcGuess).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - utcGuess.getTime()) / 60000;
}

function zonedTimeToISO(dateISO, hh, mm, timeZone) {
  const guess = new Date(`${dateISO}T${pad(hh)}:${pad(mm)}:00Z`);
  const offsetMin = tzOffsetMinutes(guess, timeZone);
  return new Date(guess.getTime() - offsetMin * 60000).toISOString();
}

function weekdayAbbrInZone(dateISO, timeZone) {
  const noon = new Date(`${dateISO}T12:00:00Z`); // avoid midnight edge cases across the offset
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(noon);
}

function parseClockTime(str) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((str || "").trim());
  if (!m) return null;
  let hh = +m[1] % 12;
  if (/pm/i.test(m[3])) hh += 12;
  return { hh, mm: +m[2] };
}

function expandDays(daysStr) {
  const parts = daysStr.split(/[–-]/).map((s) => s.trim());
  if (parts.length === 1) return [DAY_ABBR.indexOf(parts[0])];
  const start = DAY_ABBR.indexOf(parts[0]);
  const end = DAY_ABBR.indexOf(parts[1]);
  const days = [];
  for (let i = start; i <= end; i++) days.push(i);
  return days;
}

function clinicWindowFor(dateISO) {
  const timeZone = tz();
  const abbr = weekdayAbbrInZone(dateISO, timeZone);
  const weekdayIdx = DAY_ABBR.indexOf(abbr);
  const hours = load().settings.receptionist?.hours || [];
  const entry = hours.find((h) => expandDays(h.days).includes(weekdayIdx));
  if (!entry || !entry.open || !entry.close) return null; // closed that day
  const open = parseClockTime(entry.open);
  const close = parseClockTime(entry.close);
  if (!open || !close) return null;
  return {
    openISO: zonedTimeToISO(dateISO, open.hh, open.mm, timeZone),
    closeISO: zonedTimeToISO(dateISO, close.hh, close.mm, timeZone),
  };
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function computeOpenSlots(window, busy, durationMinutes) {
  const slots = [];
  const stepMs = SLOT_STEP_MINUTES * 60000;
  const durMs = durationMinutes * 60000;
  const closeTime = new Date(window.closeISO).getTime();
  const now = Date.now();
  for (let t = new Date(window.openISO).getTime(); t + durMs <= closeTime; t += stepMs) {
    if (t < now) continue;
    const slotEnd = t + durMs;
    const busyHit = busy.some((b) => overlaps(t, slotEnd, new Date(b.start).getTime(), new Date(b.end).getTime()));
    if (!busyHit) slots.push(new Date(t).toISOString());
    if (slots.length >= MAX_SLOTS) break;
  }
  return slots;
}

function serviceDurationMinutes(serviceName) {
  const services = load().settings.receptionist?.services || [];
  const svc = services.find((s) => s.name.toLowerCase() === (serviceName || "").toLowerCase());
  if (!svc) return 30;
  const nums = (svc.duration.match(/\d+/g) || []).map(Number);
  return nums.length ? Math.max(...nums) : 30; // ranged durations ("30–60 min") take the larger bound
}

async function getAvailability(dateISO, durationMinutes) {
  const cal = await client();
  if (!cal) return { configured: false, slots: [] };
  const window = clinicWindowFor(dateISO);
  if (!window) return { configured: true, closed: true, slots: [] };
  const { data } = await cal.freebusy.query({
    requestBody: { timeMin: window.openISO, timeMax: window.closeISO, timeZone: tz(), items: [{ id: calendarId() }] },
  });
  const busy = data.calendars[calendarId()]?.busy || [];
  return { configured: true, slots: computeOpenSlots(window, busy, durationMinutes || 30) };
}

async function bookAppointment({ name, phone, service, startISO, durationMinutes }) {
  const cal = await client();
  if (!cal) return { configured: false };
  const dur = durationMinutes || serviceDurationMinutes(service);
  const endISO = new Date(new Date(startISO).getTime() + dur * 60000).toISOString();
  const { data } = await cal.events.insert({
    calendarId: calendarId(),
    requestBody: {
      summary: `${service || "Appointment"} — ${name}`,
      description: `Booked via AI receptionist.\nPatient: ${name}\nPhone: ${phone}\nService: ${service}`,
      start: { dateTime: startISO, timeZone: tz() },
      end: { dateTime: endISO, timeZone: tz() },
    },
    sendUpdates: "none",
  });
  return { configured: true, eventId: data.id, htmlLink: data.htmlLink, startISO, endISO };
}

module.exports = { configured, getAvailability, bookAppointment, serviceDurationMinutes, clinicWindowFor, zonedTimeToISO, tz };
