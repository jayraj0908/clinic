// Seeds the database: owner login, 4 agents, integration slots, demo data.
// Run: npm run seed   (safe to re-run; wipes and rebuilds)
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { load, save, DB_PATH } = require("./store");
const fs = require("fs");
const { instance, profile: clinicProfile } = require("./instance");

if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
const db = load();

db.users.push({
  id: "u1",
  email: process.env.OWNER_EMAIL || "owner@clinic.com",
  passHash: bcrypt.hashSync(process.env.OWNER_PASSWORD || "changeme123", 10),
  name: "Clinic Owner",
  role: "owner",
});

db.settings = {
  clinicName: process.env.CLINIC_NAME || instance.name || "Your Clinic",
  brandColor: instance.brandColor || "#c9a066",
  receptionistNumber: process.env.RECEPTIONIST_NUMBER || "(000) 000-0000",
  avgVisitValue: 405,
  receptionist: {
    timezone: clinicProfile.timezone,
    hours: clinicProfile.hours,
    services: clinicProfile.services,
    insuranceAccepted: clinicProfile.insuranceAccepted,
    selfPay: clinicProfile.selfPay,
    policies: clinicProfile.policies,
  },
};

// setter and billing default off: both take real-world-consequence actions
// (placing real outbound calls, submitting claims) once their credentials
// are live, so a fresh deploy/reseed never silently starts either without
// the owner explicitly opting in via the dashboard toggle.
db.agents = [
  { id: "intake", name: "Lead Intake", desc: "Pulls & qualifies leads from Google and Meta ads", schedule: "*/15 * * * *", scheduleLabel: "Every 15 min", on: true, lastRun: null, lastResult: "", stat: "" },
  { id: "setter", name: "Appointment Setter", desc: "Calls qualified leads and books open slots", schedule: "*/10 9-18 * * 1-6", scheduleLabel: "9 AM–7 PM · Mon–Sat", on: false, lastRun: null, lastResult: "", stat: "" },
  { id: "audit", name: "Visit Audit", desc: "Structures provider notes into billing-ready SOAP", schedule: "*/30 8-19 * * *", scheduleLabel: "After each visit", on: true, lastRun: null, lastResult: "", stat: "" },
  { id: "billing", name: "Insurance Billing", desc: "Codes visits, builds claims, submits after approval", schedule: "0 17 * * *", scheduleLabel: "Daily · 5:00 PM batch", on: false, lastRun: null, lastResult: "", stat: "" },
];

db.integrations = [
  { id: "vapi", name: "Vapi Voice", role: "AI receptionist + outbound calls", envKey: "VAPI_API_KEY", status: "off" },
  { id: "meta", name: "Meta Lead Ads", role: "Facebook & Instagram lead forms", envKey: "META_LEAD_ADS_TOKEN", status: "off" },
  { id: "gads", name: "Google Ads", role: "Lead form extensions webhook", envKey: "GOOGLE_ADS_WEBHOOK_KEY", status: "off" },
  { id: "gcal", name: "Google Calendar", role: "Appointment slots & booking", envKey: "GOOGLE_CALENDAR_CREDENTIALS", status: "off" },
  { id: "claimmd", name: "Claim.MD", role: "Eligibility checks & 837P claims", envKey: "CLAIMMD_API_KEY", status: "off" },
  { id: "twilio", name: "Twilio SMS", role: "Confirmations, reminders, review asks", envKey: "TWILIO_AUTH", status: "off" },
  { id: "anthropic", name: "Claude API", role: "Agent reasoning, note structuring, coding", envKey: "ANTHROPIC_API_KEY", status: "off" },
];

// mark connected if env key present
for (const i of db.integrations) if (process.env[i.envKey]) i.status = "connected";

// Live now — no seeded demo leads/calls/appointments/claims/activity.
// Everything from here on is real: leads arrive via /webhooks/meta,
// /webhooks/google, or the AI receptionist's save_contact tool; calls and
// bookings arrive via /webhooks/vapi. The graph/dashboard render correctly
// empty (agents still show, workflows/tools still render) until real data
// lands.
db.leads = [];
db.calls = [];
db.appointments = [];
db.visits = [];
db.claims = [];
db.activity = [];

save();
console.log("Seeded", DB_PATH);
console.log("Login:", db.users[0].email, "/", process.env.OWNER_PASSWORD || "changeme123");
