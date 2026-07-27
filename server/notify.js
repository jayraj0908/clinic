// Outbound patient notifications — SMS via Twilio's REST API, email via
// Resend's REST API. No SDK deps: both are a single fetch() call.
//
// Both are feature-flagged by env key presence: if the keys aren't set,
// the send is skipped (logged, never thrown) so a client without these
// connectors configured never sees a broken booking flow. Every attempt —
// sent, skipped, or failed — is logged to the activity feed via log("notify", ...).
const { load, save, log } = require("./store");
const calendarApi = require("./calendar");
const { instance, messages } = require("./instance");

function hasTwilio() {
  return !!(process.env.TWILIO_SID && process.env.TWILIO_AUTH && process.env.TWILIO_FROM);
}
function hasResend() {
  return !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
}

async function sendSMS(to, body) {
  if (!to) { log("notify", "SMS skipped — no phone number on file"); return { sent: false, reason: "no recipient" }; }
  if (!hasTwilio()) {
    log("notify", `SMS skipped (Twilio not configured) — would send to ${to}: ${body}`);
    return { sent: false, reason: "twilio not configured" };
  }
  try {
    const auth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_AUTH}`).toString("base64");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { log("notify", `SMS failed to ${to}: ${data.message || res.status}`); return { sent: false, reason: data.message || String(res.status) }; }
    log("notify", `SMS sent to ${to}: ${body}`);
    return { sent: true, sid: data.sid };
  } catch (e) {
    log("notify", `SMS error to ${to}: ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

async function sendEmail(to, subject, html) {
  if (!to) return { sent: false, reason: "no recipient" }; // most leads have no email on file — not worth logging every time
  if (!hasResend()) {
    log("notify", `Email skipped (Resend not configured) — would send to ${to}: ${subject}`);
    return { sent: false, reason: "resend not configured" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: process.env.RESEND_FROM, to, subject, html }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { log("notify", `Email failed to ${to}: ${data.message || res.status}`); return { sent: false, reason: data.message || String(res.status) }; }
    log("notify", `Email sent to ${to}: ${subject}`);
    return { sent: true, id: data.id };
  } catch (e) {
    log("notify", `Email error to ${to}: ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

function renderTemplate(str, vars) {
  return String(str || "").replace(/\{(\w+)\}/g, (_, key) => (vars[key] ?? ""));
}

function formatDateTimeForTemplate(iso, timeZone) {
  const d = new Date(iso);
  return {
    date: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(d),
    time: new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(d),
  };
}

// Fired (not awaited) right after a book_appointment tool call succeeds —
// never blocks the caller-facing tool response on notification delivery.
async function notifyBookingConfirmed({ name, phone, email, service, startISO }) {
  const settings = load().settings || {};
  const tz = calendarApi.tz();
  const { date, time } = formatDateTimeForTemplate(startISO, tz);
  const vars = {
    clinic: instance.name,
    service: service || "your visit",
    date, time,
    number: settings.receptionistNumber || "",
    patient: name || "there",
  };
  await sendSMS(phone, renderTemplate(messages.bookingConfirmationSMS, vars));
  if (email) {
    await sendEmail(
      email,
      renderTemplate(messages.bookingConfirmationEmailSubject, vars),
      renderTemplate(messages.bookingConfirmationEmailHTML, vars)
    );
  }
}

// Reminder SMS for one appointment row (used by the daily reminder cron).
async function notifyReminder(appt) {
  const settings = load().settings || {};
  const tz = calendarApi.tz();
  const { date, time } = formatDateTimeForTemplate(appt.time, tz);
  const vars = {
    clinic: instance.name,
    service: appt.service || "your visit",
    date, time,
    number: settings.receptionistNumber || "",
    patient: appt.name || "there",
  };
  return sendSMS(appt.phone, renderTemplate(messages.reminderSMS, vars));
}

// Same-day-boundary-safe date key in the clinic's own timezone (not the
// server process's timezone), so "tomorrow" means tomorrow for the clinic.
function localDateKey(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// Daily reminder sweep: every confirmed appointment happening tomorrow
// (clinic-local), not yet reminded. reminderSentAt is a purely additive
// field on the appointment row — old rows without it just aren't reminded.
async function runDailyReminders() {
  const db = load();
  const tz = calendarApi.tz();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const tomorrowKey = localDateKey(tomorrow, tz);
  const due = db.appointments.filter(
    (a) => a.status === "confirmed" && !a.reminderSentAt && a.phone && localDateKey(new Date(a.time), tz) === tomorrowKey
  );
  for (const appt of due) {
    await notifyReminder(appt);
    appt.reminderSentAt = new Date().toISOString();
  }
  if (due.length) save();
  return due.length;
}

module.exports = { sendSMS, sendEmail, hasTwilio, hasResend, renderTemplate, notifyBookingConfirmed, notifyReminder, runDailyReminders };
