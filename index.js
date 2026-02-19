// Telegram + PayHero STK Payment (Buttons Only: Category -> Package Button -> Proceed/Change Number)
// Save as: index.js
// npm i node-telegram-bot-api express
//
// UPDATED (as requested):
// ✅ /start WILL NOT delete previous messages (no cleanup on /start)
// ✅ For ALL OTHER messages: delete user inputs + delete all previous bot messages before sending new ones
// ✅ Removed: Convert Airtime + Sell Bonga Points (fully removed from menus + flows)
// ✅ UPDATED PACKAGES:
//    - Bingwa Deals: "95ksh 1gb 24hrs" -> "99ksh 1gb 24hrs"
//    - SMS Offers: added 4 new SMS packages (same SMS channel)
//    - Minutes: updated + added new minutes packages (same Minutes channel)
// ✅ Bingwa Deals rule: ONCE per day per PHONE NUMBER (ONLY after SUCCESS payment; failed/cancelled does NOT lock)
// ✅ Bingwa decline happens ONLY on entering phone OR tapping ✅ Proceed (not at package selection)
// ✅ PayHero callback: https://bingwabot-4.onrender.com/payhero/callback
// ✅ When user successfully paid: bot sends notification to the user + admin
//
// FIXES (latest):
// ✅ Callback will NOT mark success when transaction was cancelled/failed (STRICT ResultCode / MpesaReceiptNumber / Status / woocommerce_payment_status)
// ✅ Also treats Status === true / "true" as success
// ✅ When ResultCode/Status is missing/empty => behave like NOT TRUE (failed)
// ✅ Prevents double notifications on PayHero retries (processedPayments) for BOTH success + failure
// ✅ notifyAdmin Markdown-safe (escapes special chars to avoid "can't parse entities")
// ✅ REMOVED permanently: "✅ STK Sent OK ..." admin message
// ✅ User payment message: single message ONLY:
//    - if success: ✅ Payment Confirmed + "Your payment of Ksh X has been received and your request is being processed."
//    - if failed: ❌ Payment failed at TIME + Offer/From/Amount + support text
// ✅ Referral bonus: credit ONLY when status === true (success) and equals 2% of amount purchased
// ✅ Referral bonus admin log includes the exact callback-confirmed Kenya time
// ✅ Redeem costs updated: 20 SMS = 5 pts, 250MB = 20 pts
// ✅ Earn points on SUCCESS purchase:
//    - 20 SMS package => +5 pts
//    - 250MB package => +20 pts
//    - 20 MIN package => +20 pts
//
// NOTE:
// - Admin MUST press /start on the bot at least once, otherwise Telegram blocks bot->admin messages.
// - Put banner.jpg in same folder as index.js (or set BANNER_URL=https://...).

"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");

// ---- fetch polyfill ----
let fetchFn = global.fetch;
if (!fetchFn) {
  try {
    fetchFn = require("node-fetch");
  } catch (e) {
    console.error("❌ fetch not available. Use Node 18+ OR run: npm i node-fetch");
    process.exit(1);
  }
}
const fetch = (...args) => fetchFn(...args);

// Prevent crashes from unhandled promise rejections / exceptions
process.on("unhandledRejection", (err) => console.log("unhandledRejection:", err?.message || err));
process.on("uncaughtException", (err) => console.log("uncaughtException:", err?.message || err));

// ===================== CONFIG =====================
// ⚠️ IMPORTANT: Move secrets to Render Environment Variables (recommended)
const TELEGRAM_TOKEN = "8179985214:AAHnEgYbgq33KJrOpGv5RTZcuyhFaCKJdyc";
const PAYHERO_USERNAME = "UuT8gpaqwB5ttjYC4ivd";
const PAYHERO_PASSWORD = "FIfH59osWhh2cwwrsWfxtnx8K7SPjhitehpPgAmZ";
// ✅ ADMIN
const ADMIN_ID = 7859465542;

// ✅ CHANNEL IDS
const PAYHERO_CHANNEL_ID_DATA = 2486; // Bingwa Deals + Unlimited Deals
const PAYHERO_CHANNEL_ID_SMS = 5577; // SMS Offers + Bonga Points + Flex Deals
const PAYHERO_CHANNEL_ID_MINUTES = 5577; // Minutes

// ✅ MUST MATCH YOUR LIVE URL
const PAYHERO_CALLBACK_URL = "https://bingwabot-4.onrender.com/payhero/callback";

// Banner image:
const BANNER_URL = ""; // e.g. "https://yourdomain.com/banner.jpg"
const BANNER_LOCAL_PATH = path.join(__dirname, "banner.jpg");

// Help phone
const HELP_PHONE = "0707071631";

// Anti-spam limits
const ANTI_SPAM = {
  DUPLICATE_WINDOW_MS: 60 * 1000,
  COOLDOWN_MS: 15 * 1000,
};

// Referral bonus (2% of amount purchased)
const REFERRAL = {
  BONUS_PERCENT: 0.02,
};

// Redeem catalog (UPDATED COSTS)
const REDEEM_ITEMS = [
  { key: "FREE_SMS_20", label: "20 free SMS", cost: 5 },
  { key: "FREE_250MB", label: "250MB free", cost: 19 },
];

// ===================== DB (persistent) =====================
const DB_FILE = path.join(__dirname, "db.json");

// schema (auto-repaired):
// {
//   "users": { ... },
//   "bingwaByPhone": { "YYYY-MM-DD": { "2547xxxxxxx": 1 } },
//   "pendingPayments": { "<externalRef>": { chatId, category, pkgLabel, phone254, price, createdAt } },
//   "processedPayments": { "<externalRef>": <timestamp> },   // to prevent double-callback notifications
//   "stats": { "totalPurchases": 0, "totalBroadcasts": 0 }
// }

function todayKey() {
  // ✅ Kenya date key (Africa/Nairobi) so Bingwa limits reset at Kenya midnight
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Nairobi",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()); // YYYY-MM-DD
  } catch (_) {
    // fallback (UTC) if Intl/timezone not available
    return new Date().toISOString().slice(0, 10);
  }
}

function isoWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  const yyyy = date.getUTCFullYear();
  const ww = String(weekNo).padStart(2, "0");
  return `${yyyy}-${ww}`;
}

function parseDayKeyOffset(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const init = {
        users: {},
        bingwaByPhone: {},
        pendingPayments: {},
        processedPayments: {},
        stats: { totalPurchases: 0, totalBroadcasts: 0 },
      };
      fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const obj = raw ? JSON.parse(raw) : {};
    return repairDB(obj);
  } catch (e) {
    const init = {
      users: {},
      bingwaByPhone: {},
      pendingPayments: {},
      processedPayments: {},
      stats: { totalPurchases: 0, totalBroadcasts: 0 },
    };
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
    } catch (_) {}
    return init;
  }
}

function repairDB(obj) {
  const db0 = obj && typeof obj === "object" ? obj : {};
  if (!db0.users || typeof db0.users !== "object") db0.users = {};
  if (!db0.bingwaByPhone || typeof db0.bingwaByPhone !== "object") db0.bingwaByPhone = {};
  if (!db0.pendingPayments || typeof db0.pendingPayments !== "object") db0.pendingPayments = {};
  if (!db0.processedPayments || typeof db0.processedPayments !== "object") db0.processedPayments = {};
  if (!db0.stats || typeof db0.stats !== "object") db0.stats = { totalPurchases: 0, totalBroadcasts: 0 };
  if (typeof db0.stats.totalPurchases !== "number") db0.stats.totalPurchases = 0;
  if (typeof db0.stats.totalBroadcasts !== "number") db0.stats.totalBroadcasts = 0;

  for (const [cid, u] of Object.entries(db0.users)) {
    if (!u || typeof u !== "object") db0.users[cid] = {};
    const x = db0.users[cid];

    if (typeof x.phone !== "string") x.phone = "";
    if (!x.antiSpam || typeof x.antiSpam !== "object") x.antiSpam = { lastAt: 0, lastSig: "" };
    if (typeof x.antiSpam.lastAt !== "number") x.antiSpam.lastAt = 0;
    if (typeof x.antiSpam.lastSig !== "string") x.antiSpam.lastSig = "";

    if (typeof x.lastSeen !== "number") x.lastSeen = 0;
    if (!x.purchasesByDay || typeof x.purchasesByDay !== "object") x.purchasesByDay = {};
    if (!x.weeklyPurchases || typeof x.weeklyPurchases !== "object") x.weeklyPurchases = {};

    if (typeof x.inviterId !== "string") x.inviterId = "";
    if (typeof x.lastReferralRewardDay !== "string") x.lastReferralRewardDay = "";
    if (typeof x.points !== "number") x.points = 0;

    if (x.pendingAction === undefined) x.pendingAction = null;
    if (x.pendingAction && typeof x.pendingAction !== "object") x.pendingAction = null;
  }

  // prune bingwaByPhone old days (keep last 7 days)
  const days = Object.keys(db0.bingwaByPhone || {}).sort();
  while (days.length > 7) {
    const oldest = days.shift();
    delete db0.bingwaByPhone[oldest];
  }

  // prune pendingPayments + processedPayments (keep last 3 days)
  const now = Date.now();
  for (const [ref, p] of Object.entries(db0.pendingPayments || {})) {
    const t = Number(p?.createdAt || 0);
    if (!t || now - t > 3 * 24 * 60 * 60 * 1000) delete db0.pendingPayments[ref];
  }
  for (const [ref, t] of Object.entries(db0.processedPayments || {})) {
    const ts = Number(t || 0);
    if (!ts || now - ts > 3 * 24 * 60 * 60 * 1000) delete db0.processedPayments[ref];
  }

  return db0;
}

let db = loadDB();

function saveDB() {
  db = repairDB(db);
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function getUser(chatId) {
  const cid = String(chatId);
  db = repairDB(db);
  if (!db.users[cid]) {
    db.users[cid] = {
      phone: "",
      antiSpam: { lastAt: 0, lastSig: "" },
      lastSeen: 0,
      purchasesByDay: {},
      weeklyPurchases: {},
      inviterId: "",
      lastReferralRewardDay: "",
      points: 0,
      pendingAction: null,
    };
  }
  if (db.users[cid].pendingAction === undefined) db.users[cid].pendingAction = null;
  return db.users[cid];
}

function touchLastSeen(chatId) {
  const u = getUser(chatId);
  u.lastSeen = Date.now();
  saveDB();
}

function setUserPhone(chatId, phone254) {
  const u = getUser(chatId);
  u.phone = phone254;
  saveDB();
}

function getUserPhone(chatId) {
  const u = getUser(chatId);
  return u.phone || "";
}

// persisted actions helpers (redeem only)
function setPendingAction(chatId, obj) {
  const u = getUser(chatId);
  u.pendingAction = obj || null;
  saveDB();
}
function getPendingAction(chatId) {
  const u = getUser(chatId);
  return u.pendingAction || null;
}
function clearPendingAction(chatId) {
  const u = getUser(chatId);
  u.pendingAction = null;
  saveDB();
}

// ✅ Bingwa once-per-day per PHONE (ONLY after SUCCESS payment)
function bingwaAlreadyPurchasedToday(phone254) {
  if (!phone254) return false;
  db = repairDB(db);
  const day = todayKey();
  const map = db.bingwaByPhone[day] || {};
  return Number(map[String(phone254)] || 0) >= 1;
}
function markBingwaPurchasedToday(phone254) {
  if (!phone254) return;
  db = repairDB(db);
  const day = todayKey();
  db.bingwaByPhone[day] = db.bingwaByPhone[day] || {};
  db.bingwaByPhone[day][String(phone254)] = 1;
  saveDB();
}

function incPurchaseStats(chatId, pkgLabel) {
  const u = getUser(chatId);
  const day = todayKey();
  u.purchasesByDay[day] = Number(u.purchasesByDay[day] || 0) + 1;

  const wk = isoWeekKey(new Date());
  if (!u.weeklyPurchases[wk] || typeof u.weeklyPurchases[wk] !== "object") u.weeklyPurchases[wk] = {};
  u.weeklyPurchases[wk][pkgLabel] = Number(u.weeklyPurchases[wk][pkgLabel] || 0) + 1;

  // prune old weeks keep last 10 weeks
  const weeks = Object.keys(u.weeklyPurchases).sort();
  if (weeks.length > 10) {
    for (let i = 0; i < weeks.length - 10; i++) delete u.weeklyPurchases[weeks[i]];
  }

  db.stats.totalPurchases = Number(db.stats.totalPurchases || 0) + 1;
  saveDB();
}

function incBroadcastStats() {
  db = repairDB(db);
  db.stats.totalBroadcasts = Number(db.stats.totalBroadcasts || 0) + 1;
  saveDB();
}

function isInactiveUser(u) {
  const lastSeen = Number(u.lastSeen || 0);
  if (!lastSeen) return true;
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  return Date.now() - lastSeen > sevenDaysMs;
}

function isActiveUser(u) {
  const d0 = parseDayKeyOffset(0);
  const d1 = parseDayKeyOffset(1);
  const d2 = parseDayKeyOffset(2);
  const p = u.purchasesByDay || {};
  return Number(p[d0] || 0) > 0 && Number(p[d1] || 0) > 0 && Number(p[d2] || 0) > 0;
}

function addPoints(chatId, pts) {
  const u = getUser(chatId);
  u.points = Number(u.points || 0) + Number(pts || 0);
  saveDB();
}

function deductPoints(chatId, pts) {
  const u = getUser(chatId);
  u.points = Number(u.points || 0) - Number(pts || 0);
  if (u.points < 0) u.points = 0;
  saveDB();
}

function setPoints(chatId, pts) {
  const u = getUser(chatId);
  const v = Number(pts || 0);
  u.points = Number.isFinite(v) && v >= 0 ? v : 0;
  saveDB();
}

function getPoints(chatId) {
  const u = getUser(chatId);
  return Number(u.points || 0);
}

// ✅ Earn points only on SUCCESS purchase (as requested)
function awardSuccessPurchasePoints(chatId, pending) {
  if (!pending || !pending.pkgLabel) return;

  const category = String(pending.category || "");
  const label = String(pending.pkgLabel).toLowerCase();

  // ✅ Points rules (NOT based on price)
  // - ONLY specific reward packages earn points.

  // SMS Offers: 20 SMS -> +5 pts
  if (category === "SMS Offers" && label.includes("20 sms")) {
    addPoints(chatId, 5);
    return;
  }

  // Minutes: 20 MIN -> +20 pts
  if (category === "Minutes" && label.includes("20 min")) {
    addPoints(chatId, 20);
    return;
  }
  // Data: 250MB -> no points (points are earned via referral/other rules)
  if ((category === "Bingwa Deals" || category === "Unlimited Deals") && label.includes("250mb")) {
    return;
  }
}


// ===================== BOT =====================
function requiredConfigOk() {
  if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN.includes("PASTE_")) return false;
  if (!PAYHERO_USERNAME || PAYHERO_USERNAME.includes("PASTE_")) return false;
  if (!PAYHERO_PASSWORD || PAYHERO_PASSWORD.includes("PASTE_")) return false;

  const ids = [PAYHERO_CHANNEL_ID_DATA, PAYHERO_CHANNEL_ID_SMS, PAYHERO_CHANNEL_ID_MINUTES];
  if (ids.some((x) => !Number.isInteger(x) || x <= 0)) return false;

  return true;
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ===================== PACKAGES =====================
const PACKAGES = {
  "Bingwa Deals": [
    { label: "Ksh 20 • 250MB 24HRS", price: 20 },
    { label: "Ksh 21 • 1GB 1HR", price: 21 },
    { label: "Ksh 47 • 350MB 7 DAYS", price: 47 },
    { label: "Ksh 49 • 1.5GB 3HRS", price: 49 },
    { label: "Ksh 55 • 1.25GB MIDNIGHT", price: 55 },
    { label: "Ksh 99 • 1GB 24HRS", price: 99 }, // ✅ updated from 95 -> 99
    { label: "Ksh 299 • 2.5GB 7 DAYS", price: 299 },
    { label: "Ksh 700 • 6GB 7 DAYS", price: 700 },
  ],
  "Unlimited Deals": [
    { label: "Ksh 23 • 1GB 1HR", price: 23 },
    { label: "Ksh 52 • 1.5GB 3HRS", price: 52 },
    { label: "Ksh 110 • 2GB 24HRS", price: 110 },
    { label: "Ksh 251 • 5GB 3 DAYS", price: 251 },
  ],
  "SMS Offers": [
    { label: "Ksh 5 • 20 SMS 24HRS", price: 5 },
    { label: "Ksh 10 • 200 SMS 24HRS", price: 10 },
    { label: "Ksh 30 • 1000 SMS 7 DAYS", price: 30 },
    // ✅ new
    { label: "Ksh 26 • Unlimited SMS DAILY", price: 26 },
    { label: "Ksh 49 • Unlimited Weekly SMS", price: 49 },
    { label: "Ksh 101 • 1500 SMS MONTHLY", price: 101 },
    { label: "Ksh 201 • 3500 SMS MONTHLY", price: 201 },
  ],
  Minutes: [
    { label: "Ksh 25 • 20 MIN MIDNIGHT", price: 25 }, // updated
    { label: "Ksh 21 • 43 MIN 3HRS", price: 21 }, // new
    { label: "Ksh 51 • 50 MIN MIDNIGHT", price: 51 },
    { label: "Ksh 250 • 200 MIN 7 DAYS", price: 250 },
    { label: "Ksh 510 • 500 MIN 7 DAYS", price: 510 },
  ],
  "Bonga Points": [{ label: "Ksh 22 • 60 Bonga Points", price: 22 }],
  "Flex Deals": [
    { label: "Ksh 20 • Flex 350 (2HRS)", price: 20 },
    { label: "Ksh 35 • Flex 500 (3HRS)", price: 35 },
    { label: "Ksh 100 • Flex 1000 (MIDNIGHT)", price: 100 },
    { label: "Ksh 255 • Flex 1500 (7 DAYS)", price: 255 },
    { label: "Ksh 1000 • Flex 9000 (30 DAYS)", price: 1000 },
  ],
};

// ===================== STATE =====================
const sessions = new Map();
const adminState = new Map();
const broadcastAlbums = new Map(); // media_group_id -> { chatId, items: [msg], timer }
const supportState = new Map();
const adminReplyState = new Map();

// ===================== CLEANUP =====================
const cleanup = new Map(); // chatId -> { botMsgIds: number[] }

function trackBotMsg(chatId, messageId) {
  const key = String(chatId);
  const obj = cleanup.get(key) || { botMsgIds: [] };
  obj.botMsgIds.push(messageId);
  if (obj.botMsgIds.length > 100) obj.botMsgIds = obj.botMsgIds.slice(-100);
  cleanup.set(key, obj);
}

async function safeDelete(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, String(messageId));
  } catch (_) {}
}

async function cleanupBeforeReply(chatId, userMsgId) {
  if (Number(chatId) === Number(ADMIN_ID)) return;

  if (userMsgId) await safeDelete(chatId, userMsgId);

  const obj = cleanup.get(String(chatId));
  if (!obj || !obj.botMsgIds.length) return;

  const ids = obj.botMsgIds.slice().reverse();
  for (const mid of ids) {
    // eslint-disable-next-line no-await-in-loop
    await safeDelete(chatId, mid);
  }

  obj.botMsgIds = [];
  cleanup.set(String(chatId), obj);
}

// ===================== HELPERS =====================
function isAdmin(chatId) {
  return Number(chatId) === Number(ADMIN_ID);
}

function authHeader() {
  return "Basic " + Buffer.from(`${PAYHERO_USERNAME}:${PAYHERO_PASSWORD}`).toString("base64");
}

function nowISO() {
  return new Date().toISOString();
}

// Kenya time/date for receipt message
function kenyaDateTime() {
  try {
    return new Intl.DateTimeFormat("en-KE", {
      timeZone: "Africa/Nairobi",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).format(new Date());
  } catch (_) {
    return new Date().toLocaleString();
  }
}

function makeExternalRef(chatId, category, price) {
  return `BINGWA-${Date.now()}-${String(category).replace(/\s+/g, "_")}-${price}-${chatId}`;
}

function channelIdForCategory(category) {
  if (category === "SMS Offers") return PAYHERO_CHANNEL_ID_SMS;
  if (category === "Bonga Points") return PAYHERO_CHANNEL_ID_SMS;
  if (category === "Flex Deals") return PAYHERO_CHANNEL_ID_SMS;
  if (category === "Minutes") return PAYHERO_CHANNEL_ID_MINUTES;
  return PAYHERO_CHANNEL_ID_DATA; // Bingwa + Unlimited
}

// Accept: 2547XXXXXXXX OR 2541XXXXXXXX OR 07XXXXXXXX OR 01XXXXXXXX
function normalizePhone(input) {
  const p = String(input || "").replace(/\s+/g, "");
  if (/^2547\d{8}$/.test(p)) return p;
  if (/^2541\d{8}$/.test(p)) return p;
  if (/^07\d{8}$/.test(p)) return "254" + p.slice(1);
  if (/^01\d{8}$/.test(p)) return "254" + p.slice(1);
  return null;
}

function formatTo07(phone254) {
  if (!phone254) return "";
  if (phone254.startsWith("2547")) return "0" + phone254.slice(3);
  if (phone254.startsWith("2541")) return "0" + phone254.slice(3);
  return phone254;
}

// Mask phone for user-facing messages: 0707xxx636
function mask07(phone07) {
  const p = String(phone07 || "");
  if (/^0\d{9}$/.test(p)) return p.slice(0, 4) + "xxx" + p.slice(-3);
  return p;
}
function formatToMasked07(phone254) {
  return mask07(formatTo07(phone254));
}

// Anti-spam signature
function makeSig({ category, pkgLabel, phone254 }) {
  return `${category}||${pkgLabel}||${phone254}`;
}

function checkAndMarkSpam(chatId, sig) {
  const u = getUser(chatId);
  const now = Date.now();
  const lastAt = Number(u.antiSpam?.lastAt || 0);
  const lastSig = String(u.antiSpam?.lastSig || "");

  if (now - lastAt < ANTI_SPAM.COOLDOWN_MS) {
    const wait = Math.ceil((ANTI_SPAM.COOLDOWN_MS - (now - lastAt)) / 1000);
    return { ok: false, reason: `⏳ Please wait ${wait}s before requesting another STK.` };
  }

  if (lastSig === sig && now - lastAt < ANTI_SPAM.DUPLICATE_WINDOW_MS) {
    return { ok: false, reason: "🚫 Duplicate STK blocked (same request just sent). Please wait 1 minute." };
  }

  u.antiSpam.lastAt = now;
  u.antiSpam.lastSig = sig;
  saveDB();
  return { ok: true };
}

// Pending payments store (in DB)
function addPendingPayment(externalRef, payload) {
  db = repairDB(db);
  db.pendingPayments[String(externalRef)] = { ...payload, createdAt: Date.now() };
  saveDB();
}
function getPendingPayment(externalRef) {
  db = repairDB(db);
  return db.pendingPayments[String(externalRef)] || null;
}
function deletePendingPayment(externalRef) {
  db = repairDB(db);
  delete db.pendingPayments[String(externalRef)];
  saveDB();
}
function alreadyProcessed(externalRef) {
  db = repairDB(db);
  return !!db.processedPayments[String(externalRef)];
}
function markProcessed(externalRef) {
  db = repairDB(db);
  db.processedPayments[String(externalRef)] = Date.now();
  saveDB();
}

async function payheroStkPush({ amount, phone, externalRef, channelId }) {
  const payload = {
    amount: Number(amount),
    phone_number: phone,
    channel_id: Number(channelId),
    provider: "m-pesa",
    external_reference: externalRef,
    customer_name: `tg_${externalRef}`,
  };

  if (PAYHERO_CALLBACK_URL && PAYHERO_CALLBACK_URL.startsWith("https://")) {
    payload.callback_url = PAYHERO_CALLBACK_URL;
  }

  const res = await fetch("https://backend.payhero.co.ke/api/v2/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader() },
    body: JSON.stringify(payload),
  });

  const rawText = await res.text().catch(() => "");
  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch (_) {
    data = { message: rawText || `HTTP ${res.status}` };
  }

  if (!res.ok) {
    const msg =
      data?.error_message ||
      data?.message ||
      data?.error ||
      (typeof data === "string" ? data : null) ||
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function sendTracked(chatId, text, opts = {}) {
  const m = await bot.sendMessage(chatId, text, opts);
  trackBotMsg(chatId, m.message_id);
  return m;
}

async function sendBannerIfAvailable(chatId) {
  try {
    if (BANNER_URL && /^https:\/\//i.test(BANNER_URL)) {
      const m = await bot.sendPhoto(chatId, BANNER_URL);
      trackBotMsg(chatId, m.message_id);
      return true;
    }
    if (fs.existsSync(BANNER_LOCAL_PATH)) {
      const m = await bot.sendPhoto(chatId, BANNER_LOCAL_PATH);
      trackBotMsg(chatId, m.message_id);
      return true;
    }
  } catch (_) {}
  return false;
}

// Markdown safe text (Telegram Markdown parse_mode)
function mdEscape(s) {
  return String(s ?? "").replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

async function notifyAdmin(text) {
  try {
    await bot.sendMessage(ADMIN_ID, text, { parse_mode: "Markdown" });
  } catch (e) {
    console.log("notifyAdmin failed:", e?.message || e);
    try {
      await bot.sendMessage(ADMIN_ID, String(text));
    } catch (_) {}
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ===================== BROADCAST HELPERS =====================
function getAllUserIds() {
  db = repairDB(db);
  return Object.keys(db.users || {})
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0 && x !== Number(ADMIN_ID));
}

async function broadcastCopyMessage(fromChatId, messageId) {
  const userIds = getAllUserIds();
  let sent = 0;
  let failed = 0;

  for (const uid of userIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await bot.copyMessage(uid, fromChatId, messageId);
      sent++;
    } catch (_) {
      failed++;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(35);
  }
  return { sent, failed, total: userIds.length };
}

function buildInputMediaFromMsg(m, allowCaption) {
  if (m.photo && m.photo.length) {
    const fileId = m.photo[m.photo.length - 1].file_id;
    const obj = { type: "photo", media: fileId };
    if (allowCaption && m.caption) obj.caption = m.caption;
    if (allowCaption && m.caption_entities) obj.caption_entities = m.caption_entities;
    return obj;
  }
  if (m.video?.file_id) {
    const obj = { type: "video", media: m.video.file_id };
    if (allowCaption && m.caption) obj.caption = m.caption;
    if (allowCaption && m.caption_entities) obj.caption_entities = m.caption_entities;
    return obj;
  }
  if (m.document?.file_id) {
    const obj = { type: "document", media: m.document.file_id };
    if (allowCaption && m.caption) obj.caption = m.caption;
    if (allowCaption && m.caption_entities) obj.caption_entities = m.caption_entities;
    return obj;
  }
  if (m.audio?.file_id) {
    const obj = { type: "audio", media: m.audio.file_id };
    if (allowCaption && m.caption) obj.caption = m.caption;
    if (allowCaption && m.caption_entities) obj.caption_entities = m.caption_entities;
    return obj;
  }
  return null;
}

async function broadcastAlbum(items) {
  const userIds = getAllUserIds();
  let sent = 0;
  let failed = 0;

  const media = [];
  for (let i = 0; i < items.length; i++) {
    const x = buildInputMediaFromMsg(items[i], i === 0);
    if (x) media.push(x);
  }

  if (!media.length) {
    for (const uid of userIds) {
      try {
        for (const m of items) {
          // eslint-disable-next-line no-await-in-loop
          await bot.copyMessage(uid, items[0].chat.id, m.message_id);
          // eslint-disable-next-line no-await-in-loop
          await sleep(20);
        }
        sent++;
      } catch (_) {
        failed++;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(35);
    }
    return { sent, failed, total: userIds.length };
  }

  for (const uid of userIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await bot.sendMediaGroup(uid, media);
      sent++;
    } catch (_) {
      failed++;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(60);
  }

  return { sent, failed, total: userIds.length };
}

function queueBroadcastAlbum(adminChatId, msg) {
  const gid = String(msg.media_group_id);
  const existing = broadcastAlbums.get(gid) || { chatId: adminChatId, items: [], timer: null };

  existing.items.push(msg);
  broadcastAlbums.set(gid, existing);

  if (existing.timer) clearTimeout(existing.timer);

  existing.timer = setTimeout(async () => {
    const pack = broadcastAlbums.get(gid);
    if (!pack) return;
    broadcastAlbums.delete(gid);

    try {
      const result = await broadcastAlbum(pack.items);
      incBroadcastStats();
      await sendTracked(
        adminChatId,
        `📣 Broadcast album done.\nSent: ${result.sent}\nFailed: ${result.failed}\nUsers: ${result.total}`
      );
    } catch (e) {
      await sendTracked(adminChatId, `⚠️ Album broadcast error: ${e.message || e}`);
    }
  }, 1800);
}

// ===================== KEYBOARDS =====================
function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [["🛒 Buy Offers", "🎁 Redeem Points"], ["🔗 My Referral"], ["ℹ️ Help", "❌ Cancel"]],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

function categoriesKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["📦 Bingwa Deals", "∞ Unlimited Deals"],
        ["✉️ SMS Offers", "📞 Minutes"],
        ["⭐ Bonga Points", "🌀 Flex Deals"],
        ["⬅ Back", "❌ Cancel"],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

function packagesKeyboard(category) {
  const list = PACKAGES[category] || [];
  const rows = [];
  for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2).map((x) => x.label));
  rows.push(["⬅ Back", "❌ Cancel"]);
  return { reply_markup: { keyboard: rows, resize_keyboard: true, one_time_keyboard: false } };
}

function confirmKeyboard(hasSavedPhone) {
  const rows = [];
  if (hasSavedPhone) rows.push(["✅ Proceed", "📞 Change Number"]);
  rows.push(["⬅ Back", "❌ Cancel"]);
  return { reply_markup: { keyboard: rows, resize_keyboard: true, one_time_keyboard: false } };
}

function redeemKeyboard() {
  return {
    reply_markup: {
      keyboard: [["1️⃣ 20 free SMS (5 pts)"], ["2️⃣ 250MB free (19 pts)"], ["⬅ Back", "❌ Cancel"]],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

function yesNoKeyboard() {
  return {
    reply_markup: {
      keyboard: [["✅ Confirm", "❌ Cancel"], ["⬅ Back"]],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

// ===================== TEXTS =====================
function welcomeText(name) {
  return (
    `👋 Hello ${name || "there"}, welcome to *Bingwa Mtaani Data Services*.\n\n` +
    `⚡ This bot helps you buy *Data bundles*, *Unlimited offers*, *SMS packages*, *Minutes*, *Bonga Points* and *Flex deals* easily via STK — even if you have Okoa Jahazi debt.\n\n` +
    `✅ Choose what you need:\n` +
    `• 📦 Bingwa Deals (limited)\n` +
    `• ∞ Unlimited Deals\n` +
    `• ✉️ SMS Offers\n` +
    `• 📞 Minutes\n` +
    `• ⭐ Bonga Points\n` +
    `• 🌀 Flex Deals\n\n` +
    `🎁 Earn points via referrals and redeem.\n\n` +
    `⚠️ *Bingwa Deals rule:* *Once per day per phone number* (ONLY after success).\n\n` +
    `☎️ Help / delays: *${HELP_PHONE}*\n`
  );
}

function helpText() {
  return (
    `✅ How to buy:\n` +
    `1) Tap 🛒 Buy Offers\n` +
    `2) Choose a category\n` +
    `3) Tap the package button\n` +
    `4) If phone saved, tap ✅ Proceed (or 📞 Change Number)\n` +
    `5) STK prompt comes to your phone\n\n` +
    `📌 Phone formats accepted:\n` +
    `• 07XXXXXXXX\n` +
    `• 01XXXXXXXX\n` +
    `• 2547XXXXXXXX\n` +
    `• 2541XXXXXXXX\n\n` +
    `⚠️ Bingwa Deals: *Once per day per phone number* (ONLY after success).\n` +
    `Other categories: can be purchased *many times per day* on same number.\n\n` +
    `🎁 Redeem points: Tap "🎁 Redeem Points"\n\n` +
    `Help: ${HELP_PHONE}`
  );
}

function packagesOverviewText() {
  const lines = [];
  const order = ["Bingwa Deals", "Unlimited Deals", "SMS Offers", "Minutes", "Bonga Points", "Flex Deals"];
  const icons = {
    "Bingwa Deals": "📦",
    "Unlimited Deals": "∞",
    "SMS Offers": "✉️",
    Minutes: "📞",
    "Bonga Points": "⭐",
    "Flex Deals": "🌀",
  };

  lines.push(`📦 *Packages Overview*\n`);
  for (const cat of order) {
    if (!PACKAGES[cat]) continue;
    lines.push(`${icons[cat] || "•"} *${cat}*`);
    lines.push(PACKAGES[cat].map((x) => `• ${x.label}`).join("\n"));
    lines.push("");
  }
  lines.push(`\n✅ Tap 🛒 *Buy Offers* to purchase.`);
  return lines.join("\n");
}

function categoryNameFromButton(text) {
  const t = String(text || "").trim().toLowerCase();
  if (t.includes("bingwa") && t.includes("deals")) return "Bingwa Deals";
  if (t.includes("unlimited") && t.includes("deals")) return "Unlimited Deals";
  if (t.includes("sms")) return "SMS Offers";
  if (t.includes("minutes")) return "Minutes";
  if (t.includes("bonga")) return "Bonga Points";
  if (t.includes("flex")) return "Flex Deals";
  return null;
}

function findPackageByLabel(category, label) {
  const list = PACKAGES[category] || [];
  return list.find((x) => x.label === label) || null;
}

// ===================== REFERRAL HANDLING =====================
function applyReferralIfAny(chatId, payload) {
  if (!payload || typeof payload !== "string") return;
  if (!payload.startsWith("ref_")) return;
  const inviter = payload.slice(4).trim();
  if (!/^\d+$/.test(inviter)) return;
  if (String(inviter) === String(chatId)) return;

  const u = getUser(chatId);
  if (!u.inviterId) {
    u.inviterId = String(inviter);
    saveDB();
  }
}

// ✅ Referral bonus credit ONLY on SUCCESS callback; bonus = 2% of amount paid
function maybeRewardInviterOnSuccessPurchase(buyerChatId, amountKsh, when) {
  const buyer = getUser(buyerChatId);
  const inviterId = buyer.inviterId;
  if (!inviterId) return;

  const amt = Number(amountKsh || 0);
  if (!Number.isFinite(amt) || amt <= 0) return;

  const bonus = amt * REFERRAL.BONUS_PERCENT;
  if (!Number.isFinite(bonus) || bonus <= 0) return;

  addPoints(inviterId, bonus);

  notifyAdmin(
    `🎯 *Referral Reward*\n` +
      `Inviter: \`${mdEscape(inviterId)}\`\n` +
      `Buyer: \`${mdEscape(buyerChatId)}\`\n` +
      `Purchase: *Ksh ${mdEscape(amt)}*\n` +
      `Bonus (2%): *${mdEscape(bonus.toFixed(2))} pts*\n` +
      `Time: \`${mdEscape(String(when || kenyaDateTime()))}\``
  );
}

// ===================== SUPPORT (2-WAY) =====================
async function forwardToAdminWithUserTag(userMsg) {
  const fromChatId = userMsg.chat.id;
  const u = userMsg.from || {};
  const name = `${u.first_name || ""} ${u.last_name || ""}`.trim();
  const uname = u.username ? `@${u.username}` : "no_username";

  try {
    await bot.copyMessage(ADMIN_ID, fromChatId, userMsg.message_id);
  } catch (e) {
    console.log("support copy to admin failed:", e?.message || e);
  }

  try {
    await bot.sendMessage(
      ADMIN_ID,
      `💬 *Support Message*\nFrom: ${mdEscape(name)}\nUsername: ${mdEscape(uname)}\nChatID: \`${mdEscape(fromChatId)}\`\n\nReply with:\n/reply ${mdEscape(fromChatId)}`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    console.log("support meta to admin failed:", e?.message || e);
  }
}

async function sendToUserFromAdmin(targetChatId, adminMsg) {
  await bot.copyMessage(targetChatId, adminMsg.chat.id, adminMsg.message_id);
}

// ===================== REDEEM FLOW =====================
function redeemChoiceFromText(text) {
  const t = String(text || "").trim();
  if (t.startsWith("1")) return REDEEM_ITEMS[0];
  if (t.startsWith("2")) return REDEEM_ITEMS[1];
  return null;
}

// ===================== COMMAND PARSER =====================
function parseStartPayload(text) {
  const t = String(text || "").trim();
  const m = t.match(/^\/start(?:\s+(.+))?$/i);
  return m ? (m[1] || "").trim() : null;
}

// ===================== EXPRESS WEBHOOK SERVER =====================
const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.status(200).send("OK"));

// ✅ PayHero callback endpoint (FIXED: enforce "blank ResultCode/Status = FAILED", "true = SUCCESS")
app.post("/payhero/callback", async (req, res) => {
  try {
    const body = req.body || {};
    console.log("PAYHERO CALLBACK RAW:", JSON.stringify(body));

    // ✅ Reply fast to stop retries
    res.status(200).json({ ok: true });

    // PayHero may send the real fields inside `response` as a JSON string
    let payload = body;
    if (typeof body?.response === "string") {
      try {
        payload = JSON.parse(body.response);
      } catch (_) {
        payload = body;
      }
    } else if (body?.response && typeof body.response === "object") {
      payload = body.response;
    }

    console.log("PAYHERO CALLBACK PARSED:", JSON.stringify(payload));

    // externalRef mapping (PayHero uses User_Reference / External_Reference)
    const externalRef =
      payload?.external_reference ||
      payload?.External_Reference ||
      payload?.reference ||
      payload?.Reference ||
      payload?.user_reference ||
      payload?.User_Reference ||
      payload?.User_ReferenceNumber ||
      body?.external_reference ||
      body?.reference ||
      body?.User_Reference ||
      "";

    // woocommerce status (some gateways)
    const woostatus =
      payload?.woocommerce_payment_status ||
      body?.woocommerce_payment_status ||
      payload?.WooCommerce_Payment_Status ||
      "";

    // generic status fields
    const statusRaw =
      payload?.payment_status ||
      payload?.Payment_Status ||
      payload?.status ||
      body?.payment_status ||
      body?.status ||
      "";

    const statusStr = String(statusRaw).toLowerCase();
    const wooStr = String(woostatus).toLowerCase();

    // mpesa result code mapping (0 = success; non-zero = fail/cancel)
    const resultCodeRaw =
      payload?.ResultCode ||
      payload?.resultCode ||
      payload?.result_code ||
      body?.ResultCode ||
      body?.resultCode ||
      body?.result_code;

    const resultCodeNum =
      resultCodeRaw === undefined || resultCodeRaw === null || resultCodeRaw === ""
        ? null
        : Number(resultCodeRaw);

    // Status text mapping (Failed / Cancelled / Request Cancelled by user)
    const statusText =
      payload?.Status ||
      payload?.status_text ||
      payload?.ResultDesc ||
      payload?.resultDesc ||
      body?.Status ||
      body?.ResultDesc ||
      "";

    const statusTextStr = String(statusText).toLowerCase();

    // M-Pesa receipt / code mapping (TYRCYG57GDE)
    const mpesaReceipt =
      payload?.MpesaReceiptNumber ||
      payload?.mpesa_receipt_number ||
      payload?.mpesaReceiptNumber ||
      payload?.mpesa_code ||
      payload?.mpesaCode ||
      payload?.mpesa_reference ||
      payload?.mpesaReference ||
      payload?.receipt_number ||
      payload?.receiptNumber ||
      payload?.transaction_code ||
      payload?.transactionCode ||
      body?.MpesaReceiptNumber ||
      body?.mpesa_receipt_number ||
      body?.mpesaReceiptNumber ||
      body?.mpesa_code ||
      body?.mpesaCode ||
      body?.mpesa_reference ||
      body?.mpesaReference ||
      "";

    const mpesaReceiptStr = String(mpesaReceipt || "").trim();

    const isFailureByText =
      statusTextStr.includes("failed") ||
      statusTextStr.includes("cancel") ||
      statusTextStr.includes("cancelled") ||
      statusTextStr.includes("canceled") ||
      statusTextStr.includes("request cancelled") ||
      statusTextStr.includes("user cancelled") ||
      statusTextStr.includes("insufficient") ||
      statusTextStr.includes("timeout");

    // ✅ This is EXACTLY what you print as "ResultCode/Status:" to admin:
    const statusOutRaw = resultCodeRaw ?? statusRaw ?? woostatus ?? "";
    const statusOut = String(statusOutRaw ?? "").trim();

    // ✅ REQUIRED BEHAVIOR:
    // - If ResultCode/Status is blank/null/empty => FAILED (NOT TRUE)
    // - If ResultCode/Status is true/"true" => SUCCESS
    // - If ResultCode exists => success only when 0 (still allowed)
    // - Woo status completed/processing allowed ONLY when ResultCode/Status is NOT blank
    // - MpesaReceiptNumber allowed ONLY when ResultCode/Status is NOT blank
    let isSuccess = false;

    const isBlankStatusOut = !statusOut; // blank / empty / spaces => true
    const isTrueStatusOut = statusOutRaw === true || String(statusOutRaw).toLowerCase().trim() === "true";

    if (isBlankStatusOut) {
      // ✅ Your rule: blank behaves like NOT TRUE
      isSuccess = false;
    } else if (resultCodeNum !== null && Number.isFinite(resultCodeNum)) {
      isSuccess = resultCodeNum === 0;
    } else if (isTrueStatusOut) {
      isSuccess = true;
    } else if (mpesaReceiptStr) {
      isSuccess = true;
    } else if (wooStr) {
      isSuccess = wooStr === "complete" || wooStr === "completed" || wooStr === "processing";
    } else {
      isSuccess = false;
    }

    // If failure keywords appear, force fail
    if (isFailureByText) isSuccess = false;

    console.log("PAYHERO CALLBACK DECISION:", {
      externalRef,
      statusRaw,
      woocommerce_payment_status: woostatus,
      ResultCode: resultCodeRaw,
      statusText,
      mpesaReceipt: mpesaReceiptStr,
      statusOut,
      isSuccess,
    });

    if (!externalRef) return;

    // Extract chatId from our ref: BINGWA-<timestamp>-<category>-<price>-<chatId>
    const parts = String(externalRef).split("-");
    const chatId = Number(parts[parts.length - 1]);
    if (!Number.isFinite(chatId)) return;

    const when = kenyaDateTime();
    const mpesaOut = mpesaReceiptStr || "N/A";

    // If failed/cancelled/blank -> SEND FAILURE MESSAGE ONCE
    if (!isSuccess) {
      const failKey = `FAIL-${externalRef}`;
      if (alreadyProcessed(failKey)) return;
      markProcessed(failKey);

      const pending = getPendingPayment(externalRef);
      const details =
        pending && pending.pkgLabel
          ? `Offer: ${pending.pkgLabel}\nFrom: ${formatToMasked07(pending.phone254)}\nAmount: Ksh ${pending.price}`
          : "";

      if (pending) deletePendingPayment(externalRef);

      const out =
        `❌ Payment failed at ${when}.\n` +
        (details ? `${details}\n` : "") +
        `Your package could not be processed. Please try again or contact customer support.\n\nHelp: ${HELP_PHONE}`;

      await sendTracked(chatId, out, { ...mainMenuKeyboard() });
      return;
    }

    // Prevent double-processing if PayHero retries (SUCCESS)
    if (alreadyProcessed(externalRef)) return;

    // mark processed FIRST (idempotent)
    markProcessed(externalRef);

    // If we have pending payment, apply rules + stats
    const pending = getPendingPayment(externalRef);

    if (pending) {
      // ✅ Bingwa locks only after SUCCESS
      if (pending.category === "Bingwa Deals" && pending.phone254) {
        markBingwaPurchasedToday(pending.phone254);
      }
      if (pending.pkgLabel) incPurchaseStats(chatId, pending.pkgLabel);

      // ✅ Earn points ONLY on success purchase (as requested)
      awardSuccessPurchasePoints(chatId, pending);

      // ✅ Referral bonus ONLY on success, 2% of amount (callback-confirmed time)
      maybeRewardInviterOnSuccessPurchase(chatId, pending.price, when);

      deletePendingPayment(externalRef);
    }

    // ✅ Notify user (ONLY ONE MESSAGE on success)
    if (pending) {
      await sendTracked(
        chatId,
        `✅ Payment Confirmed\nYour payment of *Ksh ${pending.price}* has been received and your request is being processed.\nYour package will be processed now.`,
        { parse_mode: "Markdown", ...mainMenuKeyboard() }
      );
    } else {
      await sendTracked(
        chatId,
        `✅ Payment Confirmed\nYour payment has been received and your request is being processed.\nYour package will be processed now.`,
        { ...mainMenuKeyboard() }
      );
    }

    // ✅ Notify admin (kept exactly with External Ref + M-Pesa Ref + Time + ResultCode/Status)
    await notifyAdmin(
      `✅ *Payment Confirmed*\n` +
        `ChatID: \`${mdEscape(chatId)}\`\n` +
        `External Ref: \`${mdEscape(externalRef)}\`\n` +
        `M-Pesa Ref: \`${mdEscape(mpesaOut)}\`\n` +
        `Time: \`${mdEscape(when)}\`\n` +
        `ResultCode/Status: \`${mdEscape(String(statusOutRaw ?? ""))}\``
    );
  } catch (e) {
    console.log("callback error:", e?.message || e);
  }
});

app.listen(PORT, () => console.log("🌐 Webhook server listening on", PORT));

// ===================== MAIN FLOW (SINGLE HANDLER) =====================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // ensure user exists + lastSeen
  getUser(chatId);
  touchLastSeen(chatId);

  // ✅ IMPORTANT: /start should NOT delete previous messages (requested)
  const isStartCmd = /^\/start\b/i.test(text);

  // cleanup user message + previous bot messages (users only), except /start
  if (!isStartCmd && msg.message_id) {
    await cleanupBeforeReply(chatId, msg.message_id);
  }

  // ===================== ADMIN: BROADCAST MODE =====================
  const aState = adminState.get(String(chatId));
  if (isAdmin(chatId) && aState?.step === "await_broadcast") {
    if (text === "/cancel") {
      adminState.delete(String(chatId));
      return sendTracked(chatId, "✅ Broadcast cancelled.");
    }

    if (msg.media_group_id) {
      queueBroadcastAlbum(chatId, msg);
      return;
    }

    try {
      const result = await broadcastCopyMessage(chatId, msg.message_id);
      incBroadcastStats();
      adminState.delete(String(chatId));
      return sendTracked(
        chatId,
        `📣 Broadcast done.\nSent: ${result.sent}\nFailed: ${result.failed}\nUsers: ${result.total}`
      );
    } catch (e) {
      return sendTracked(chatId, `⚠️ Broadcast error: ${e.message || e}\nTry again or /cancel.`);
    }
  }

  // ===================== ADMIN: REPLY MODE =====================
  if (isAdmin(chatId)) {
    const r = adminReplyState.get(String(chatId));
    if (r && Date.now() < (r.until || 0) && text !== "/cancel" && !text.startsWith("/reply")) {
      try {
        await sendToUserFromAdmin(r.targetChatId, msg);
        return sendTracked(chatId, `✅ Sent to ${r.targetChatId}`);
      } catch (e) {
        return sendTracked(chatId, `⚠️ Failed sending to ${r.targetChatId}: ${e?.message || e}`);
      }
    }
    if (text === "/cancel") {
      adminReplyState.delete(String(chatId));
      adminState.delete(String(chatId));
      return sendTracked(chatId, "✅ Admin mode cancelled.");
    }
  }

  // ===================== COMMANDS (TEXT) =====================
  if (text.startsWith("/")) {
    // /start
    const startPayload = parseStartPayload(text);
    if (startPayload !== null) {
      if (startPayload) applyReferralIfAny(chatId, startPayload);

      if (!requiredConfigOk()) {
        return sendTracked(
          chatId,
          "❌ Config not set.\n\nReplace:\n- TELEGRAM_TOKEN\n- PAYHERO_USERNAME\n- PAYHERO_PASSWORD\n- PAYHERO_CHANNEL_ID_DATA (> 0)\n- PAYHERO_CHANNEL_ID_SMS (> 0)\n- PAYHERO_CHANNEL_ID_MINUTES (> 0)\n\nThen restart the server."
        );
      }

      await sendBannerIfAvailable(chatId);

      await sendTracked(chatId, welcomeText(msg.from?.first_name), {
        parse_mode: "Markdown",
        ...mainMenuKeyboard(),
      });

      await sendTracked(chatId, packagesOverviewText(), { parse_mode: "Markdown", ...mainMenuKeyboard() });

      const pts = getPoints(chatId);
      return sendTracked(chatId, `⭐ Your points: *${pts.toFixed(2)}*\n\nUse "🎁 Redeem Points" to redeem.`, {
        parse_mode: "Markdown",
        ...mainMenuKeyboard(),
      });
    }

    // /help
    if (/^\/help$/i.test(text)) {
      return sendTracked(chatId, helpText(), { ...mainMenuKeyboard() });
    }

    // /buy
    if (/^\/buy$/i.test(text)) {
      sessions.set(chatId, { step: "category", category: null, pkgKey: null, createdAt: Date.now() });
      await sendBannerIfAvailable(chatId);
      await sendTracked(chatId, packagesOverviewText(), { parse_mode: "Markdown" });
      return sendTracked(chatId, "✅ Choose a category:", categoriesKeyboard());
    }

    // /cancel
    if (/^\/cancel$/i.test(text)) {
      sessions.delete(chatId);
      adminState.delete(String(chatId));
      supportState.delete(String(chatId));
      clearPendingAction(chatId);
      adminReplyState.delete(String(chatId));
      return sendTracked(chatId, "❌ Cancelled.", { reply_markup: { remove_keyboard: true } });
    }

    // admin only
    if (isAdmin(chatId)) {
      if (/^\/users$/i.test(text)) {
        db = repairDB(db);
        const total = Object.keys(db.users || {}).filter((id) => String(id) !== String(ADMIN_ID)).length;
        return sendTracked(chatId, `👥 Total users: ${total}`);
      }

      if (/^\/stats$/i.test(text)) {
        db = repairDB(db);
        const userEntries = Object.entries(db.users || {}).filter(([cid]) => String(cid) !== String(ADMIN_ID));
        const users = userEntries.map(([, u]) => u);
        const totalUsers = users.length;

        let activeUsers = 0;
        let inactiveUsers = 0;

        for (const u of users) {
          if (isInactiveUser(u)) inactiveUsers++;
          if (isActiveUser(u)) activeUsers++;
        }

        const wk = isoWeekKey(new Date());

        const weeklyTotals = {};
        for (const u of users) {
          const wkMap = (u.weeklyPurchases && u.weeklyPurchases[wk]) || {};
          for (const [pkgLabel, cnt] of Object.entries(wkMap)) {
            weeklyTotals[pkgLabel] = Number(weeklyTotals[pkgLabel] || 0) + Number(cnt || 0);
          }
        }

        const weeklyLines =
          Object.entries(weeklyTotals)
            .sort((a, b) => Number(b[1]) - Number(a[1]))
            .map(([label, cnt]) => `• ${label} : ${cnt}`)
            .join("\n") || "• (No purchases this week)";

        const out =
          `📊 *Bot statistics*\n\n` +
          `Active users: *${activeUsers}*\n` +
          `Inactive users: *${inactiveUsers}*\n` +
          `Total users: *${totalUsers}*\n` +
          `Total purchases: *${Number(db.stats.totalPurchases || 0)}*\n` +
          `Total broadcasts: *${Number(db.stats.totalBroadcasts || 0)}*\n\n` +
          `🗓️ *Weekly package purchases* (week ${wk})\n` +
          `${weeklyLines}`;

        return sendTracked(chatId, out, { parse_mode: "Markdown" });
      }
      // /points <chatId>  (check user balance)
      const ptsm = text.match(/^\/points\s*(\d+)?$/i);
      if (ptsm) {
        const target = ptsm[1] ? String(ptsm[1]) : null;
        if (!target) return sendTracked(chatId, "Usage: /points <chatId>");
        const bal = getPoints(target);
        return sendTracked(chatId, `⭐ Points\nUser: ${target}\nBalance: ${bal.toFixed(2)} pts`);
      }

      
      // /addpoints <chatId> <points>
      const ap = text.match(/^\/addpoints\s+(\d+)\s+([\d.]+)$/i);
      if (ap) {
        const target = String(ap[1]);
        const val = Number(ap[2]);
        if (!Number.isFinite(val) || val <= 0) return sendTracked(chatId, "❌ Invalid points amount.");
        const before = getPoints(target);
        addPoints(target, val);
        const after = getPoints(target);
        return sendTracked(
          chatId,
          `✅ Points added.\nUser: ${target}\nAdded: ${val.toFixed(2)} pts\nBefore: ${before.toFixed(2)} pts\nAfter: ${after.toFixed(2)} pts`
        );
      }

// /setpoints <chatId> <points>  (overwrite balance)
      const sp = text.match(/^\/setpoints\s+(\d+)\s+([\d.]+)$/i);
      if (sp) {
        const target = String(sp[1]);
        const val = Number(sp[2]);
        if (!Number.isFinite(val) || val < 0) return sendTracked(chatId, "❌ Invalid points amount.");
        setPoints(target, val);
        return sendTracked(chatId, `✅ Points overwritten.\nUser: ${target}\nNew balance: ${getPoints(target).toFixed(2)} pts`);
      }

      // /removepoints <chatId> <points>
      const rp = text.match(/^\/removepoints\s+(\d+)\s+([\d.]+)$/i);
      if (rp) {
        const target = String(rp[1]);
        const val = Number(rp[2]);
        if (!Number.isFinite(val) || val <= 0) return sendTracked(chatId, "❌ Invalid points amount.");
        const before = getPoints(target);
        deductPoints(target, val);
        const after = getPoints(target);
        return sendTracked(
          chatId,
          `✅ Points removed.\nUser: ${target}\nRemoved: ${val.toFixed(2)} pts\nBefore: ${before.toFixed(2)} pts\nAfter: ${after.toFixed(2)} pts`
        );
      }

      // /topusers  (top 20 by points)
      if (/^\/topusers$/i.test(text)) {
        db = repairDB(db);
        const rows = Object.entries(db.users || {})
          .filter(([cid]) => String(cid) !== String(ADMIN_ID))
          .map(([cid, u]) => ({ cid, pts: Number(u?.points || 0) }))
          .sort((a, b) => b.pts - a.pts)
          .slice(0, 20);

        if (!rows.length) return sendTracked(chatId, "No users found.");

        const lines = rows.map((r, i) => `${i + 1}. ${r.cid} — ${r.pts.toFixed(2)} pts`);
        return sendTracked(chatId, `🏆 Top Users (by points)\n\n${lines.join("\n")}`);
      }



      if (/^\/broadcast$/i.test(text)) {
        adminState.set(String(chatId), { step: "await_broadcast" });
        return sendTracked(
          chatId,
          "📣 Broadcast mode ON.\n\nSend ANYTHING to broadcast:\n• text\n• photo / video\n• music/audio / voice\n• document\n• sticker\n• animation/gif\n• album (multi photos/videos as one post)\n\nSend /cancel to stop."
        );
      }

      const rm = text.match(/^\/reply\s+(\d+)$/i);
      if (rm) {
        const target = Number(rm[1]);
        adminReplyState.set(String(chatId), { targetChatId: target, until: Date.now() + 10 * 60 * 1000 });
        return sendTracked(chatId, `✅ Reply mode ON.\nNext message you send will go to: ${target}\nSend /cancel to stop.`);
      }
    }

    return;
  }

  // ===================== SUPPORT MODE (USER) =====================
  const sup = supportState.get(String(chatId));
  if (!isAdmin(chatId) && sup?.step === "support") {
    if (text === "/cancel" || text === "❌ Cancel") {
      supportState.delete(String(chatId));
      return sendTracked(chatId, "✅ Support closed.", { ...mainMenuKeyboard() });
    }

    await forwardToAdminWithUserTag(msg);
    return sendTracked(chatId, "✅ Sent to support. We will reply here.\nSend more or /cancel to stop.", {
      ...mainMenuKeyboard(),
    });
  }

  // ===================== ACTIONS FLOW (REDEEM ONLY) =====================
  const act = getPendingAction(chatId);
  if (act && !isAdmin(chatId)) {
    if (text === "❌ Cancel" || text === "/cancel") {
      clearPendingAction(chatId);
      return sendTracked(chatId, "❌ Cancelled.", { ...mainMenuKeyboard() });
    }
    if (text === "⬅ Back") {
      clearPendingAction(chatId);
      return sendTracked(chatId, "⬅ Back to menu.", { ...mainMenuKeyboard() });
    }

    if (act.kind === "redeem") {
      const item = act.data.item;
      if (!item) {
        clearPendingAction(chatId);
        return sendTracked(chatId, "❌ Redeem error. Try again.", { ...mainMenuKeyboard() });
      }

      if (act.step === "confirm") {
        if (text === "✅ Confirm") {
          act.step = "number";
          setPendingAction(chatId, act);
          return sendTracked(chatId, "📱 Enter the phone number to load (07/01/254...).", { ...mainMenuKeyboard() });
        }
        return sendTracked(chatId, "Tap ✅ Confirm or ❌ Cancel.", yesNoKeyboard());
      }

      if (act.step === "number") {
        const phone = normalizePhone(text);
        if (!phone) return sendTracked(chatId, "❌ Invalid phone. Use 07/01/2547/2541 format.", { ...mainMenuKeyboard() });

        const cost = item.cost;
        const bal = getPoints(chatId);
        if (bal < cost) {
          clearPendingAction(chatId);
          return sendTracked(chatId, `❌ Not enough points.\nYou have: ${bal.toFixed(2)} pts\nNeed: ${cost} pts`, {
            ...mainMenuKeyboard(),
          });
        }

        deductPoints(chatId, cost);
        clearPendingAction(chatId);

        await notifyAdmin(
  `🎁 Redeem Request
` +
    `User: ${chatId}
` +
    `Item: ${item.label}
` +
    `Cost: ${cost} pts
` +
    `Load To: ${formatTo07(phone)}
` +
    `Time: ${kenyaDateTime()}`
);

return sendTracked(
          chatId,
          `✅ Redemption submitted!\nItem: ${item.label}\nLoad to: ${formatToMasked07(phone)}\nPoints deducted: ${cost}\nRemaining: ${getPoints(chatId).toFixed(2)} pts`,
          { ...mainMenuKeyboard() }
        );
      }
    }
  }

  // ===================== GLOBAL BUTTONS =====================
  if (text === "❌ Cancel") {
    sessions.delete(chatId);
    supportState.delete(String(chatId));
    clearPendingAction(chatId);
    adminState.delete(String(chatId));
    adminReplyState.delete(String(chatId));
    return sendTracked(chatId, "❌ Cancelled.", { reply_markup: { remove_keyboard: true } });
  }

  if (text === "ℹ️ Help") return sendTracked(chatId, helpText(), { ...mainMenuKeyboard() });

  if (text === "🔗 My Referral") {
    const BOT_USERNAME = ""; // OPTIONAL: set your bot username here (without @)
    const u = (BOT_USERNAME || "").trim();
    const link = u ? `https://t.me/${u}?start=ref_${chatId}` : `Use: /start ref_${chatId} (share this code)`;
    return sendTracked(
      chatId,
      `🔗 Your referral:\n${link}\n\n⭐ Your points: ${getPoints(chatId).toFixed(2)} pts\n\nRule: You earn *2%* of the amount paid when your referred user completes a successful payment.`,
      { ...mainMenuKeyboard() }
    );
  }

  if (text === "🎁 Redeem Points") {
    const pts = getPoints(chatId);
    return sendTracked(chatId, `🎁 Redeem Points\n\nYour balance: *${pts.toFixed(2)} pts*\n\nChoose an item:`, {
      parse_mode: "Markdown",
      ...redeemKeyboard(),
    });
  }

  if (text === "1️⃣ 20 free SMS (5 pts)" || text === "2️⃣ 250MB free (20 pts)") {
    const item = redeemChoiceFromText(text);
    if (!item) return;

    const bal = getPoints(chatId);
    if (bal < item.cost) {
      return sendTracked(chatId, `❌ Not enough points.\nYou have: ${bal.toFixed(2)} pts\nNeed: ${item.cost} pts`, {
        ...mainMenuKeyboard(),
      });
    }

    setPendingAction(chatId, { kind: "redeem", step: "confirm", data: { item }, createdAt: Date.now() });
    return sendTracked(chatId, `Confirm redemption:\n\nItem: *${item.label}*\nCost: *${item.cost} pts*\n\nTap ✅ Confirm to continue.`, {
      parse_mode: "Markdown",
      ...yesNoKeyboard(),
    });
  }

  if (text === "🛒 Buy Offers") {
    sessions.set(chatId, { step: "category", category: null, pkgKey: null, createdAt: Date.now() });
    await sendBannerIfAvailable(chatId);
    await sendTracked(chatId, packagesOverviewText(), { parse_mode: "Markdown" });
    return sendTracked(chatId, "✅ Choose a category:", categoriesKeyboard());
  }

  // ===================== PURCHASE FLOW =====================
  let s = sessions.get(chatId);

  // If user taps category without session, auto-start
  if (!s) {
    const maybeCategory = categoryNameFromButton(text);
    if (maybeCategory && PACKAGES[maybeCategory]) {
      s = { step: "category", category: null, pkgKey: null, createdAt: Date.now() };
      sessions.set(chatId, s);
    } else {
      return;
    }
  }

  // expire session after 15 mins
  if (Date.now() - (s.createdAt || Date.now()) > 15 * 60 * 1000) {
    sessions.delete(chatId);
    return sendTracked(chatId, "⏱️ Session expired. Tap 🛒 Buy Offers again.", { ...mainMenuKeyboard() });
  }

  try {
    // BACK
    if (text === "⬅ Back") {
      if (s.step === "phone" || s.step === "confirm") {
        s.step = "package";
        sessions.set(chatId, s);
        return sendTracked(chatId, `✅ Choose a ${s.category} package:`, packagesKeyboard(s.category));
      }
      s.step = "category";
      s.category = null;
      s.pkgKey = null;
      sessions.set(chatId, s);
      return sendTracked(chatId, "✅ Choose a category:", categoriesKeyboard());
    }

    // STEP 1: CATEGORY
    if (s.step === "category") {
      const category = categoryNameFromButton(text);
      if (!category) return sendTracked(chatId, "Tap a category button:", categoriesKeyboard());
      if (!PACKAGES[category]) return sendTracked(chatId, "Tap a category button:", categoriesKeyboard());

      s.category = category;
      s.step = "package";
      sessions.set(chatId, s);

      if (category === "Bingwa Deals") {
        await sendTracked(chatId, `📦 *Bingwa Deals*\nRule: *Once per day per phone number* (ONLY after success).\n\nChoose a package:`, {
          parse_mode: "Markdown",
        });
      } else {
        await sendTracked(chatId, `✅ Choose a ${category} package:`);
      }

      return sendTracked(chatId, `👇 ${category} packages:`, packagesKeyboard(category));
    }

    // STEP 2: PACKAGE BUTTON
    if (s.step === "package") {
      const pkg = findPackageByLabel(s.category, text);
      if (!pkg) return sendTracked(chatId, "Tap a package button from the list:", packagesKeyboard(s.category));

      s.pkgKey = pkg.label;
      s.step = "confirm";
      sessions.set(chatId, s);

      const savedPhone = getUserPhone(chatId);
      const hasSaved = !!savedPhone;

      // ✅ IMPORTANT: NO early Bingwa block here (block only on ✅ Proceed or entering phone)

      const msgText =
        `✅ Selected:\n*${pkg.label}*\n\n` +
        (hasSaved ? `📱 Saved number: *${formatToMasked07(savedPhone)}*\n\n` : `📱 No saved phone yet.\n\n`) +
        `Choose:\n• ✅ Proceed (use saved number)\n• 📞 Change Number`;

      return sendTracked(chatId, msgText, { parse_mode: "Markdown", ...confirmKeyboard(hasSaved) });
    }

    // STEP 3: CONFIRM
    if (s.step === "confirm") {
      const pkg = findPackageByLabel(s.category, s.pkgKey);
      if (!pkg) {
        sessions.delete(chatId);
        return sendTracked(chatId, "❌ Package missing. Tap 🛒 Buy Offers again.", { ...mainMenuKeyboard() });
      }

      if (text === "📞 Change Number") {
        s.step = "phone";
        sessions.set(chatId, s);
        return sendTracked(
          chatId,
          "📱 Send your phone number:\n• 07XXXXXXXX\n• 01XXXXXXXX\n• 2547XXXXXXXX\n• 2541XXXXXXXX",
          confirmKeyboard(false)
        );
      }

      if (text === "✅ Proceed") {
        const savedPhone = getUserPhone(chatId);
        if (!savedPhone) {
          s.step = "phone";
          sessions.set(chatId, s);
          return sendTracked(
            chatId,
            "📱 No saved number found. Send phone:\n• 07XXXXXXXX\n• 01XXXXXXXX\n• 2547XXXXXXXX\n• 2541XXXXXXXX",
            confirmKeyboard(false)
          );
        }

        // ✅ Bingwa once per day per phone (hard block ONLY here)
        if (s.category === "Bingwa Deals" && bingwaAlreadyPurchasedToday(savedPhone)) {
          sessions.delete(chatId);
          return sendTracked(
            chatId,
            `🚫 *Bingwa Deals limit reached*\nNumber: *${formatToMasked07(savedPhone)}*\nThis number already bought Bingwa today.\n\nUse a different number or try again tomorrow.`,
            { parse_mode: "Markdown", ...mainMenuKeyboard() }
          );
        }

        const sig = makeSig({ category: s.category, pkgLabel: pkg.label, phone254: savedPhone });
        const spam = checkAndMarkSpam(chatId, sig);
        if (!spam.ok) return sendTracked(chatId, spam.reason, { ...mainMenuKeyboard() });

        await sendTracked(chatId, "🔔 Sending STK push… Check your phone.");

        const ref = makeExternalRef(chatId, s.category, pkg.price);
        const channelId = channelIdForCategory(s.category);

        // Save pending payment so callback can credit/lock Bingwa only after success
        addPendingPayment(ref, {
          chatId,
          category: s.category,
          pkgLabel: pkg.label,
          phone254: savedPhone,
          price: pkg.price,
        });

        await notifyAdmin(
          `📌 *STK Attempt*\n` +
            `User: ${mdEscape(msg.from?.first_name || "")} (@${mdEscape(msg.from?.username || "no_username")})\n` +
            `ChatID: \`${mdEscape(chatId)}\`\n` +
            `Category: *${mdEscape(s.category)}*\n` +
            `Offer: *${mdEscape(pkg.label)}*\n` +
            `Phone: *${mdEscape(formatTo07(savedPhone))}*\n` +
            `Amount: *Ksh ${mdEscape(pkg.price)}*\n` +
            `Channel: *${mdEscape(channelId)}*\n` +
            `Ref: \`${mdEscape(ref)}\`\n` +
            `Time: ${mdEscape(nowISO())}`
        );

        try {
          await payheroStkPush({ amount: pkg.price, phone: savedPhone, externalRef: ref, channelId });

          sessions.delete(chatId);

          // ✅ REMOVED permanently: "✅ STK Sent OK ..." admin message

          return sendTracked(
            chatId,
            `✅ STK sent!\n\nOffer: ${pkg.label}\nPay: Ksh ${pkg.price}\nFrom: ${formatToMasked07(savedPhone)}\nChannel: ${channelId}\nRef: ${ref}\nTime: ${nowISO()}\n\nWhen payment is successful you will receive a confirmation message here.\n\nIf delay: ${HELP_PHONE}`,
            { ...mainMenuKeyboard() }
          );
        } catch (err) {
          sessions.delete(chatId);
          deletePendingPayment(ref);

          await notifyAdmin(
            `❌ *STK Failed*\nChatID: \`${mdEscape(chatId)}\`\nRef: \`${mdEscape(ref)}\`\nError: \`${mdEscape(
              String(err.message || err)
            )}\``
          );
          return sendTracked(chatId, `⚠️ Error: ${err.message}`, { ...mainMenuKeyboard() });
        }
      }

      // accept phone typed here
      const phoneMaybe = normalizePhone(text);
      if (phoneMaybe) {
        setUserPhone(chatId, phoneMaybe);

        // ✅ Bingwa once per day per phone (hard block ONLY when entering phone)
        if (s.category === "Bingwa Deals" && bingwaAlreadyPurchasedToday(phoneMaybe)) {
          sessions.delete(chatId);
          return sendTracked(
            chatId,
            `🚫 *Bingwa Deals limit reached*\nNumber: *${formatToMasked07(phoneMaybe)}*\nThis number already bought Bingwa today.\n\nUse a different number or try again tomorrow.`,
            { parse_mode: "Markdown", ...mainMenuKeyboard() }
          );
        }

        await sendTracked(chatId, `✅ Saved number: ${formatToMasked07(phoneMaybe)}\nNow tap ✅ Proceed.`, {
          ...confirmKeyboard(true),
        });
        return;
      }

      return sendTracked(chatId, "Choose ✅ Proceed or 📞 Change Number.", confirmKeyboard(!!getUserPhone(chatId)));
    }

    // STEP 4: PHONE INPUT
    if (s.step === "phone") {
      const phone = normalizePhone(text);
      if (!phone) {
        return sendTracked(
          chatId,
          "❌ Invalid phone.\nUse: 07XXXXXXXX / 01XXXXXXXX / 2547XXXXXXXX / 2541XXXXXXXX",
          confirmKeyboard(false)
        );
      }

      setUserPhone(chatId, phone);

      // ✅ Bingwa once per day per phone (hard block ONLY here)
      if (s.category === "Bingwa Deals" && bingwaAlreadyPurchasedToday(phone)) {
        sessions.delete(chatId);
        return sendTracked(
          chatId,
          `🚫 *Bingwa Deals limit reached*\nNumber: *${formatToMasked07(phone)}*\nThis number already bought Bingwa today.\n\nUse a different number or try again tomorrow.`,
          { parse_mode: "Markdown", ...mainMenuKeyboard() }
        );
      }

      s.step = "confirm";
      sessions.set(chatId, s);

      const pkg = findPackageByLabel(s.category, s.pkgKey);
      if (!pkg) {
        sessions.delete(chatId);
        return sendTracked(chatId, "❌ Package missing. Tap 🛒 Buy Offers again.", { ...mainMenuKeyboard() });
      }

      return sendTracked(
        chatId,
        `✅ Number saved: *${formatToMasked07(phone)}*\n\nSelected: *${pkg.label}*\n\nTap ✅ Proceed to send STK.`,
        {
          parse_mode: "Markdown",
          ...confirmKeyboard(true),
        }
      );
    }
  } catch (err) {
    sessions.delete(chatId);
    return sendTracked(chatId, `⚠️ Error: ${err.message}\n\nHelp: ${HELP_PHONE}`, { ...mainMenuKeyboard() });
  }
});

// ===================== STARTUP LOG =====================
console.log("✅ Bingwa Mtaani PayHero STK bot running");
