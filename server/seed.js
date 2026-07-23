// Seeds the database: owner login, 4 agents, integration slots, demo data.
// Run: npm run seed   (safe to re-run; wipes and rebuilds)
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { load, save, DB_PATH } = require("./store");
const fs = require("fs");
const path = require("path");

const clinicProfile = JSON.parse(fs.readFileSync(path.join(__dirname, "knowledge-base", "clinic-profile.json"), "utf8"));

if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
const db = load();

const now = Date.now();
const hrs = (h) => new Date(now - h * 3600e3).toISOString();

db.users.push({
  id: "u1",
  email: process.env.OWNER_EMAIL || "owner@clinic.com",
  passHash: bcrypt.hashSync(process.env.OWNER_PASSWORD || "changeme123", 10),
  name: "Clinic Owner",
  role: "owner",
});

db.settings = {
  clinicName: process.env.CLINIC_NAME || "Your Clinic",
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

db.agents = [
  { id: "intake", name: "Lead Intake", desc: "Pulls & qualifies leads from Google and Meta ads", schedule: "*/15 * * * *", scheduleLabel: "Every 15 min", on: true, lastRun: hrs(0.3), lastResult: "6 new leads", stat: "" },
  { id: "setter", name: "Appointment Setter", desc: "Calls qualified leads and books open slots", schedule: "*/10 9-18 * * 1-6", scheduleLabel: "9 AM–7 PM · Mon–Sat", on: true, lastRun: hrs(0.1), lastResult: "booked Maria G.", stat: "" },
  { id: "audit", name: "Visit Audit", desc: "Structures provider notes into billing-ready SOAP", schedule: "*/30 8-19 * * *", scheduleLabel: "After each visit", on: true, lastRun: hrs(1), lastResult: "visit #2291 audited", stat: "" },
  { id: "billing", name: "Insurance Billing", desc: "Codes visits, builds claims, submits after approval", schedule: "0 17 * * *", scheduleLabel: "Daily · 5:00 PM batch", on: false, lastRun: hrs(20), lastResult: "11 claims sent", stat: "" },
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

// ---- demo pipeline data (delete freely once live) ----
const leads = [
  ["Maria G.", "+18045550171", "meta", "Cleaning", "booked"],
  ["Devon P.", "+18045550152", "google", "Whitening", "call_scheduled"],
  ["J. Whitfield", "+18045550183", "meta", "New patient exam", "booked"],
  ["T. Nguyen", "+18045550194", "ai_line", "Whitening consult", "booked"],
  ["R. Okafor", "+18045550115", "recall", "Crown seat", "seen"],
  ["M. Alvarez", "+18045550126", "google", "Cleaning", "booked"],
  ["K. Ellis", "+18045550137", "meta", "Invisalign consult", "qualified"],
  ["S. Brooks", "+18045550148", "google", "Cleaning", "new"],
];
db.leads = leads.map((l, i) => ({ id: "L" + (100 + i), name: l[0], phone: l[1], source: l[2], service: l[3], status: l[4], createdAt: hrs(8 - i) }));

db.calls = [
  { id: "C1", dir: "inbound", who: "(804) 555-0138", summary: "Asked about whitening pricing — booked consult Thu 10:30 AM", outcome: "booked", ts: hrs(0.2) },
  { id: "C2", dir: "outbound", who: "Maria G.", summary: "Meta lead day-2 follow-up — confirmed Friday 9:00 AM cleaning", outcome: "booked", ts: hrs(0.3) },
  { id: "C3", dir: "inbound", who: "(804) 555-0192", summary: "Rescheduled Tuesday appt to Monday 1:15 PM", outcome: "rescheduled", ts: hrs(0.5) },
  { id: "C4", dir: "outbound", who: "Devon P.", summary: "Google lead — no answer, retry 6:30 PM", outcome: "no_answer", ts: hrs(0.8) },
  { id: "C5", dir: "inbound", who: "(804) 555-0114", summary: "Insurance question routed to billing queue with note", outcome: "routed", ts: hrs(1.1) },
];

db.appointments = [
  { id: "A1", time: hrs(-1), name: "J. Whitfield", service: "New patient exam", source: "Meta", status: "confirmed" },
  { id: "A2", time: hrs(-1.8), name: "R. Okafor", service: "Crown seat", source: "Recall", status: "confirmed" },
  { id: "A3", time: hrs(-2.5), name: "T. Nguyen", service: "Whitening consult", source: "AI line", status: "unconfirmed" },
  { id: "A4", time: hrs(-3.3), name: "M. Alvarez", service: "Cleaning", source: "Google", status: "confirmed" },
];

db.visits = [{ id: "V2291", patient: "R. Okafor", auditComplete: true, billingReady: true, ts: hrs(1) }];
db.claims = [{ id: "CL1", visitId: "V2291", codes: ["D2740"], status: "awaiting_approval", amount: 1180, ts: hrs(0.9) }];

db.activity = [
  { id: "a1", ts: hrs(0.1), type: "agent", message: "Appointment Setter: placed 1 call(s)" },
  { id: "a2", ts: hrs(0.2), type: "call", message: "Inbound · (804) 555-0138: Asked about whitening pricing — booked consult Thu 10:30 AM" },
  { id: "a3", ts: hrs(0.3), type: "call", message: "Outbound · Maria G.: Meta lead day-2 follow-up — confirmed Friday 9:00 AM cleaning" },
  { id: "a4", ts: hrs(0.3), type: "agent", message: "Lead Intake: qualified 1 lead(s)" },
  { id: "a5", ts: hrs(0.5), type: "call", message: "Inbound · (804) 555-0192: Rescheduled Tuesday appt to Monday 1:15 PM" },
  { id: "a6", ts: hrs(0.9), type: "billing", message: "Insurance Billing: 1 claim(s) drafted → awaiting human approval" },
  { id: "a7", ts: hrs(1), type: "agent", message: "Visit Audit: processed 1 visit(s)" },
  { id: "a8", ts: hrs(1.1), type: "call", message: "Inbound · (804) 555-0114: Insurance question routed to billing queue with note" },
  { id: "a9", ts: hrs(8), type: "lead", message: "New Meta lead received — K. Ellis, Invisalign consult" },
  { id: "a10", ts: hrs(8), type: "lead", message: "New Google lead received — S. Brooks, Cleaning" },
];

save();
console.log("Seeded", DB_PATH);
console.log("Login:", db.users[0].email, "/", process.env.OWNER_PASSWORD || "changeme123");
