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
// ✅ Bingwa Deals rule: ONCE per day per PHONE NUMBER (after successful purchase, same number can't buy again until midnight)
// ✅ PayHero callback: https://bingwabot-4.onrender.com/payhero/callback
// ✅ When user successfully paid: bot sends notification to the user + admin
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
const TELEGRAM_TOKEN = "8179985214:AAGUCtLsLuMD90hKMNbWs6N70unEWbyAEbc";
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

// Referral points
const REFERRAL = {
  POINTS_PER_DAY_FIRST_STK: 0.2, // per referred user per day (DATA + UNLIMITED only)
};

// Redeem catalog
const REDEEM_ITEMS = [
  { key: "FREE_SMS_20", label: "20 free SMS", cost: 3 },
  { key: "FREE_250MB", label: "250MB free", cost: 7 },
];

// ===================== DB (persistent) =====================
const DB_FILE = path.join(__dirname, "db.json");

// schema (auto-repaired):
// {
//   "users": { ... },
//   "bingwaByPhone": { "YYYY-MM-DD": { "2547xxxxxxx": 1 } },
//   "pendingPayments": { "<externalRef>": { chatId, category, pkgLabel, phone254, price, createdAt } },
//   "stats": { "totalPurchases": 0, "totalBroadcasts": 0 }
// }

function todayKey() {
  return new Date().toISOString().slice(0, 10);
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
      stats: { totalPurchases: 0, totalBroadcasts: 0 },
    };
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
    } catch (_) {}
    return init;
  }
}

function repairDB(obj) {
  const db = obj && typeof obj === "object" ? obj : {};
  if (!db.users || typeof db.users !== "object") db.users = {};
  if (!db.bingwaByPhone || typeof db.bingwaByPhone !== "object") db.bingwaByPhone = {};
  if (!db.pendingPayments || typeof db.pendingPayments !== "object") db.pendingPayments = {};
  if (!db.stats || typeof db.stats !== "object") db.stats = { totalPurchases: 0, totalBroadcasts: 0 };
  if (typeof db.stats.totalPurchases !== "number") db.stats.totalPurchases = 0;
  if (typeof db.stats.totalBroadcasts !== "number") db.stats.totalBroadcasts = 0;

  for (const [cid, u] of Object.entries(db.users)) {
    if (!u || typeof u !== "object") db.users[cid] = {};
    const x = db.users[cid];

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
  const days = Object.keys(db.bingwaByPhone || {}).sort();
  while (days.length > 7) {
    const oldest = days.shift();
    delete db.bingwaByPhone[oldest];
  }

  // prune pendingPayments (keep last 3 days)
  const now = Date.now();
  for (const [ref, p] of Object.entries(db.pendingPayments || {})) {
    const t = Number(p?.createdAt || 0);
    if (!t || now - t > 3 * 24 * 60 * 60 * 1000) delete db.pendingPayments[ref];
  }

  return db;
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

function getPoints(chatId) {
  const u = getUser(chatId);
  return Number(u.points || 0);
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

async function notifyAdmin(text) {
  try {
    await bot.sendMessage(ADMIN_ID, text, { parse_mode: "Markdown" });
  } catch (e) {
    console.log("notifyAdmin failed:", e?.message || e);
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
      keyboard: [["1️⃣ 20 free SMS (3 pts)"], ["2️⃣ 250MB free (7 pts)"], ["⬅ Back", "❌ Cancel"]],
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
    `⚠️ *Bingwa Deals rule:* *Once per day per phone number* (after success, same number can’t buy Bingwa again until midnight).\n\n` +
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
    `⚠️ Bingwa Deals: *Once per day per phone number*.\n` +
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

function maybeRewardInviterOnSuccessPurchase(buyerChatId, category) {
  if (category !== "Bingwa Deals" && category !== "Unlimited Deals") return;

  const buyer = getUser(buyerChatId);
  const inviterId = buyer.inviterId;
  if (!inviterId) return;

  const day = todayKey();
  if (buyer.lastReferralRewardDay === day) return;

  addPoints(inviterId, REFERRAL.POINTS_PER_DAY_FIRST_STK);
  buyer.lastReferralRewardDay = day;
  saveDB();

  notifyAdmin(
    `🎯 *Referral Reward*\nInviter: \`${inviterId}\`\nBuyer: \`${buyerChatId}\`\n+${REFERRAL.POINTS_PER_DAY_FIRST_STK} pts\nDay: ${day}`
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
      `💬 *Support Message*\nFrom: ${name}\nUsername: ${uname}\nChatID: \`${fromChatId}\`\n\nReply with:\n/reply ${fromChatId}`,
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

// ✅ PayHero callback endpoint
app.post("/payhero/callback", async (req, res) => {
  try {
    const body = req.body || {};
    console.log("PAYHERO CALLBACK:", JSON.stringify(body));

    // ✅ Always reply fast to stop retries
    res.status(200).json({ ok: true });

    const statusRaw =
      body?.payment_status || body?.status || body?.data?.status || body?.data?.payment_status || "";

    const status = String(statusRaw).toLowerCase();

    const externalRef =
      body?.external_reference || body?.data?.external_reference || body?.reference || body?.data?.reference || "";

    const isSuccess =
      status.includes("success") ||
      status.includes("paid") ||
      status.includes("complete") ||
      status === "1" ||
      body?.success === true ||
      body?.data?.success === true;

    if (!externalRef) return;

    // Our externalRef format: BINGWA-<timestamp>-<category>-<price>-<chatId>
    const parts = String(externalRef).split("-");
    const chatId = Number(parts[parts.length - 1]);
    if (!Number.isFinite(chatId)) return;

    if (!isSuccess) {
      // optional: notify failed/cancelled
      // await sendTracked(chatId, `⚠️ Payment not completed.\nRef: ${externalRef}\nStatus: ${statusRaw}`, { ...mainMenuKeyboard() });
      return;
    }

    // ✅ SUCCESS: use pending payment data if available
    const pending = getPendingPayment(externalRef);

    // Prevent double-processing:
    if (pending?.processed) return;

    // Mark processed + delete pending after handling
    // (If you want to keep history, don’t delete—just mark processed.)
    if (pending) {
      // If Bingwa Deals, enforce once-per-day AFTER success
      if (pending.category === "Bingwa Deals" && pending.phone254) {
        markBingwaPurchasedToday(pending.phone254);
      }

      // Stats + referral reward happen on SUCCESS payment
      if (pending.pkgLabel) incPurchaseStats(chatId, pending.pkgLabel);
      if (pending.category) maybeRewardInviterOnSuccessPurchase(chatId, pending.category);

      deletePendingPayment(externalRef);
    }

    // ✅ Notify user
    const details =
      pending && pending.pkgLabel
        ? `\nOffer: ${pending.pkgLabel}\nFrom: ${formatTo07(pending.phone254)}\nAmount: Ksh ${pending.price}`
        : "";

    await sendTracked(
      chatId,
      `✅ Payment received successfully!\nRef: ${externalRef}${details}\n\nYour package will be processed now.`,
      {
        parse_mode: "Markdown",
        ...mainMenuKeyboard(),
      }
    );

    // ✅ Notify admin
    await notifyAdmin(
      `✅ *Payment Confirmed*\nChatID: \`${chatId}\`\nRef: \`${externalRef}\`\nStatus: \`${statusRaw}\`${
        pending?.pkgLabel ? `\nOffer: *${pending.pkgLabel}*` : ""
      }${pending?.phone254 ? `\nPhone: *${formatTo07(pending.phone254)}*` : ""}${
        pending?.price ? `\nAmount: *Ksh ${pending.price}*` : ""
      }`
    );
  } catch (e) {
    console.log("callback error:", e?.message || e);
    // return 200 already sent above in normal flow
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
      return sendTracked(chatId, `⭐ Your points: *${pts.toFixed(1)}*\n\nUse "🎁 Redeem Points" to redeem.`, {
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
          return sendTracked(chatId, `❌ Not enough points.\nYou have: ${bal.toFixed(1)} pts\nNeed: ${cost} pts`, {
            ...mainMenuKeyboard(),
          });
        }

        deductPoints(chatId, cost);
        clearPendingAction(chatId);

        await notifyAdmin(
          `🎁 *Redeem Request*\nChatID: \`${chatId}\`\nItem: *${item.label}*\nCost: *${cost} pts*\nLoad To: *${formatTo07(phone)}*\nTime: ${nowISO()}`
        );

        return sendTracked(
          chatId,
          `✅ Redemption submitted!\nItem: ${item.label}\nLoad to: ${formatTo07(phone)}\nPoints deducted: ${cost}\nRemaining: ${getPoints(chatId).toFixed(1)} pts`,
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
      `🔗 Your referral:\n${link}\n\n⭐ Your points: ${getPoints(chatId).toFixed(1)} pts\n\nRule: You earn +${REFERRAL.POINTS_PER_DAY_FIRST_STK} pts when your referred user makes their *first paid purchase of the day* (Data + Unlimited only).`,
      { ...mainMenuKeyboard() }
    );
  }

  if (text === "🎁 Redeem Points") {
    const pts = getPoints(chatId);
    return sendTracked(chatId, `🎁 Redeem Points\n\nYour balance: *${pts.toFixed(1)} pts*\n\nChoose an item:`, {
      parse_mode: "Markdown",
      ...redeemKeyboard(),
    });
  }

  if (text === "1️⃣ 20 free SMS (3 pts)" || text === "2️⃣ 250MB free (7 pts)") {
    const item = redeemChoiceFromText(text);
    if (!item) return;

    const bal = getPoints(chatId);
    if (bal < item.cost) {
      return sendTracked(chatId, `❌ Not enough points.\nYou have: ${bal.toFixed(1)} pts\nNeed: ${item.cost} pts`, {
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
        await sendTracked(chatId, `📦 *Bingwa Deals*\nRule: *Once per day per phone number*.\n\nChoose a package:`, {
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

      // If bingwa and saved phone already used today, block here (early)
      if (s.category === "Bingwa Deals" && hasSaved && bingwaAlreadyPurchasedToday(savedPhone)) {
        sessions.delete(chatId);
        return sendTracked(
          chatId,
          `🚫 *Bingwa Deals limit reached*\nNumber: *${formatTo07(savedPhone)}*\nYou can buy Bingwa Deals again after *midnight*.\n\nTip: You can still buy *Unlimited / SMS / Minutes / Bonga / Flex* anytime.`,
          { parse_mode: "Markdown", ...mainMenuKeyboard() }
        );
      }

      const msgText =
        `✅ Selected:\n*${pkg.label}*\n\n` +
        (hasSaved ? `📱 Saved number: *${formatTo07(savedPhone)}*\n\n` : `📱 No saved phone yet.\n\n`) +
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

        // ✅ Bingwa once per day per phone (hard block)
        if (s.category === "Bingwa Deals" && bingwaAlreadyPurchasedToday(savedPhone)) {
          sessions.delete(chatId);
          return sendTracked(
            chatId,
            `🚫 *Bingwa Deals limit reached*\nNumber: *${formatTo07(savedPhone)}*\nYou can buy Bingwa Deals again after *midnight*.\n\nOther categories can be purchased many times per day.`,
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
            `User: ${msg.from?.first_name || ""} (@${msg.from?.username || "no_username"})\n` +
            `ChatID: \`${chatId}\`\n` +
            `Category: *${s.category}*\n` +
            `Offer: *${pkg.label}*\n` +
            `Phone: *${formatTo07(savedPhone)}*\n` +
            `Amount: *Ksh ${pkg.price}*\n` +
            `Channel: *${channelId}*\n` +
            `Ref: \`${ref}\`\n` +
            `Time: ${nowISO()}`
        );

        try {
          await payheroStkPush({ amount: pkg.price, phone: savedPhone, externalRef: ref, channelId });

          sessions.delete(chatId);

          await notifyAdmin(
            `✅ *STK Sent OK*\nChatID: \`${chatId}\`\nRef: \`${ref}\`\nAmount: *Ksh ${pkg.price}*\nChannel: *${channelId}*`
          );

          return sendTracked(
            chatId,
            `✅ STK sent!\n\nOffer: ${pkg.label}\nPay: Ksh ${pkg.price}\nFrom: ${formatTo07(savedPhone)}\nChannel: ${channelId}\nRef: ${ref}\nTime: ${nowISO()}\n\nWhen payment is successful you will receive a confirmation message here.\n\nIf delay: ${HELP_PHONE}`,
            { ...mainMenuKeyboard() }
          );
        } catch (err) {
          sessions.delete(chatId);
          deletePendingPayment(ref);

          await notifyAdmin(
            `❌ *STK Failed*\nChatID: \`${chatId}\`\nRef: \`${ref}\`\nError: \`${String(err.message || err)}\``
          );
          return sendTracked(chatId, `⚠️ Error: ${err.message}`, { ...mainMenuKeyboard() });
        }
      }

      // accept phone typed here
      const phoneMaybe = normalizePhone(text);
      if (phoneMaybe) {
        setUserPhone(chatId, phoneMaybe);

        // if bingwa and this phone already used today, block immediately
        if (s.category === "Bingwa Deals" && bingwaAlreadyPurchasedToday(phoneMaybe)) {
          sessions.delete(chatId);
          return sendTracked(
            chatId,
            `🚫 *Bingwa Deals limit reached*\nNumber: *${formatTo07(phoneMaybe)}*\nYou can buy Bingwa Deals again after *midnight*.\n\nOther categories can be purchased many times per day.`,
            { parse_mode: "Markdown", ...mainMenuKeyboard() }
          );
        }

        await sendTracked(chatId, `✅ Saved number: ${formatTo07(phoneMaybe)}\nNow tap ✅ Proceed.`, {
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

      // if bingwa and this phone already used today, block now
      if (s.category === "Bingwa Deals" && bingwaAlreadyPurchasedToday(phone)) {
        sessions.delete(chatId);
        return sendTracked(
          chatId,
          `🚫 *Bingwa Deals limit reached*\nNumber: *${formatTo07(phone)}*\nYou can buy Bingwa Deals again after *midnight*.\n\nOther categories can be purchased many times per day.`,
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
        `✅ Number saved: *${formatTo07(phone)}*\n\nSelected: *${pkg.label}*\n\nTap ✅ Proceed to send STK.`,
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
