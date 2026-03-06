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

// ===================== PHONE NORMALIZATION =====================
function normalizePhone(input) {
  if (!input) return null;

  let phone = String(input).trim().replace(/\s+/g, "");

  // Remove leading +
  if (phone.startsWith("+")) {
    phone = phone.slice(1);
  }

  // Accept 07xxxxxxxx or 01xxxxxxxx
  if (/^0[17]\d{8}$/.test(phone)) {
    return "254" + phone.slice(1);
  }

  // Accept 2547xxxxxxxx or 2541xxxxxxxx
  if (/^254[17]\d{8}$/.test(phone)) {
    return phone;
  }

  return null;
}
// ================================================================

function inputTo07(input) {
  const n = normalizePhone(input);
  return n ? formatTo07(n) : String(input || "");
}


const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const TelegramBot = require("node-telegram-bot-api");

// ---- fetch polyfill ----
let fetchFn = global.fetch;
if (!fetchFn) {
  try {
    fetchFn = require("node-fetch");
var bot; // hoisted to avoid TDZ issues on some startup paths
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
let TELEGRAM_TOKEN = ""; // set from db or env later
// ORIGINAL TOKEN REMOVED FOR SECURITY
// const TELEGRAM_TOKEN = "Hnf2wGQ4aXqqZUX02u_0rLYGronNhwP8Y";
const PAYHERO_USERNAME = process.env.PAYHERO_USERNAME || "";
// const PAYHERO_USERNAME = "UuT8gpaqwB5ttjYC4ivd";
const PAYHERO_PASSWORD = process.env.PAYHERO_PASSWORD || "";
// const PAYHERO_PASSWORD = "FIfH59osWhh2cwwrsWfxtnx8K7SPjhitehpPgAmZ";
// ✅ ADMIN
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);
const SMSLEOPARD_TOKEN = process.env.SMSLEOPARD_TOKEN || "";
const ADMIN_SMS_TO = normalizePhone(process.env.ADMIN_SMS_TO || "0759423842") || "254759423842";

async function sendAdminPaymentSms({ payingPhone254 = "", receivingPhone254 = "" } = {}) {
  try {
    console.log("SMSLEOPARD DEBUG: starting sendAdminPaymentSms");

    if (!SMSLEOPARD_TOKEN || !ADMIN_SMS_TO) {
      console.log("SMSLEOPARD DEBUG: missing config", {
        SMSLEOPARD_TOKEN: SMSLEOPARD_TOKEN ? "SET" : "MISSING",
        ADMIN_SMS_TO
      });
      return { ok: false, skipped: true, reason: "missing_sms_config" };
    }

    const paying07 = formatTo07(String(payingPhone254 || ""));
    const receiving07 = formatTo07(String(receivingPhone254 || payingPhone254 || ""));

    if (!paying07 && !receiving07) {
      console.log("SMSLEOPARD DEBUG: missing numbers");
      return { ok: false, skipped: true, reason: "missing_numbers" };
    }

    const payload = {
      source: "INFO",
      destination: String(ADMIN_SMS_TO),
      message: `Paying: ${paying07 || "-"}
Receiving: ${receiving07 || "-"}`
    };

    console.log("SMSLEOPARD DEBUG payload:", payload);

    const resp = await fetch("https://api.smsleopard.com/v1/sms/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${String(SMSLEOPARD_TOKEN)}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();

    if (!resp.ok) {
      console.log("SMSLEOPARD ERROR:", resp.status, text);
      return { ok: false, status: resp.status, body: text };
    }

    console.log("SMSLEOPARD SUCCESS:", text);
    return { ok: true, body: text };
  } catch (err) {
    console.log("SMSLEOPARD EXCEPTION:", err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
}

function adminNotify(text) {
  try {
    if (!bot || typeof bot.sendMessage !== "function") return;
    bot.sendMessage(String(ADMIN_ID), String(text)).catch(() => {});
  } catch (_) {}
}

// const ADMIN_ID = 7859465542;

// ✅ CHANNEL IDS
const PAYHERO_CHANNEL_ID_DATA = 2486; // Bingwa Deals + Unlimited Deals
const PAYHERO_CHANNEL_ID_SMS = 5577; // SMS Offers + Bonga Points + Flex Deals
const PAYHERO_CHANNEL_ID_MINUTES = 5577; // Minutes
const PAYHERO_CHANNEL_ID_BUSINESS = PAYHERO_CHANNEL_ID_DATA; // Business subscription uses same channel as Bingwa/Data

// ✅ MUST MATCH YOUR LIVE URL
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "").trim();
const PAYHERO_CALLBACK_URL = (BASE_URL && BASE_URL.startsWith("http"))
  ? `${BASE_URL.replace(/\/+$/,"")}/payhero/callback`
  : "";

// Banner image:
const BANNER_URL = ""; // e.g. "https://yourdomain.com/banner.jpg"
const BANNER_LOCAL_PATH = path.join(__dirname, "banner.jpg");

// Help phone
const HELP_PHONE = "0707071631";

// STK retry expiry window (prevents abuse)
const STK_RETRY_EXPIRE_MS = 2 * 60 * 1000; // 2 minutes

// Bot username (used for referral links). Set BOT_USERNAME in env if you change the bot username.
const BOT_USERNAME = process.env.BOT_USERNAME || "bingwa1_bot";

// Prune inactive users (days). Set PRUNE_INACTIVE_DAYS in env to change.
const PRUNE_INACTIVE_DAYS = Number(process.env.PRUNE_INACTIVE_DAYS || 365);

// ===================== WITHDRAW RATE =====================
// 100 pts = 70 KES  →  1 pt = 0.7 KES
// ✅ Withdraw unlock rule: user must spend at least MIN_WITHDRAW_SPEND before making a withdrawal request (admin bypass)
const MIN_WITHDRAW_SPEND = 300;
function pointsToKes(pts) {
  return Number(pts || 0) * 0.7;
}


// Anti-spam limits
const ANTI_SPAM = {
  DUPLICATE_WINDOW_MS: 60 * 1000,
  COOLDOWN_MS: 15 * 1000,
};

// /start cooldown (anti-spam)
const START_COOLDOWN_MS = 5 * 1000;
const startCooldownByChat = new Map();

// Referral bonus (2% of amount purchased)
const REFERRAL = {
  BONUS_PERCENT: 0.02,
  EXPIRY_DAYS: 30, // secret: inviter earns only for first 30 days
};

// Redeem catalog (UPDATED COSTS)
const REDEEM_ITEMS = [
  { key: "FREE_SMS_20", label: "20 free SMS", cost: 5 },
  { key: "FREE_250MB", label: "250MB free", cost: 20 },
  { key: "FREE_20MIN", label: "20mins midnight free", cost: 25 },
];

// ===================== BUSINESS SUBSCRIPTION PLANS =====================
const BUSINESS_PLANS = {
  BUS_W1: { label: "Business 1 Week", price: 56, days: 7 },
  BUS_1M: { label: "Business 1 Month", price: 105, months: 1 },
  BUS_3M: { label: "Business 3 Months", price: 260, months: 3 },
};


// ===================== DB (persistent) =====================
const DB_FILE = path.join(__dirname, "db.json");

// schema (auto-repaired):
// {
//   "users": { ... },
//   "bingwaByPhone": { "YYYY-MM-DD": { "2547xxxxxxx": 1 } },
//   "pendingPayments": { "<externalRef>": { chatId, category, pkgLabel, phone254, receivingPhone254, price, createdAt } },
//   "processedPayments": { "<externalRef>": <timestamp> },   // to prevent double-callback notifications
//   "stats": { "totalPurchases": 0, "totalBroadcasts": 0 }
// }

function kenyaDayKey() {
  // Same as todayKey(), but kept separate for clarity
  return todayKey();
}

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

function kenyaDayKeyOffset(daysBack = 0) {
  // ✅ Kenya day key offset (Africa/Nairobi) for rolling windows like "last 30 days"
  try {
    const d = new Date(Date.now() - Number(daysBack || 0) * 86400000);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Nairobi",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d); // YYYY-MM-DD (Kenya)
  } catch (_) {
    const d = new Date(Date.now() - Number(daysBack || 0) * 86400000);
    return d.toISOString().slice(0, 10);
  }
}


function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const init = {
        users: {},
        bingwaByPhone: {},
        pendingPayments: {},
        pendingRedeems: {},
        redeemByPhoneDay: {},
        redeemCooldownByChat: {},
        processedPayments: {},
        usedBackupIds: {},
        usedInlineActions: {},
        scheduledBroadcasts: [],
        usedBackupIds: {},
        usedInlineActions: {},
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
      pendingRedeems: {},
      redeemByPhoneDay: {},
      redeemCooldownByChat: {},
      processedPayments: {},
      usedBackupIds: {},
    usedInlineActions: {},
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
  if (!db0.pendingRedeems || typeof db0.pendingRedeems !== "object") db0.pendingRedeems = {};
  if (!db0.redeemByPhoneDay || typeof db0.redeemByPhoneDay !== "object") db0.redeemByPhoneDay = {};
  if (!db0.redeemCooldownByChat || typeof db0.redeemCooldownByChat !== "object") db0.redeemCooldownByChat = {};
  if (!db0.processedPayments || typeof db0.processedPayments !== "object") db0.processedPayments = {};
  if (!db0.referralsByDay || typeof db0.referralsByDay !== "object") db0.referralsByDay = {};
  if (!db0.usedBackupIds || typeof db0.usedBackupIds !== "object") db0.usedBackupIds = {};
  if (!db0.backupVault || typeof db0.backupVault !== "object") db0.backupVault = {};
  if (!db0.usedInlineActions || typeof db0.usedInlineActions !== "object") db0.usedInlineActions = {};
  if (!Array.isArray(db0.scheduledBroadcasts)) db0.scheduledBroadcasts = [];
  if (!db0.phoneCooldown || typeof db0.phoneCooldown !== "object") db0.phoneCooldown = {};
  if (!db0.stats || typeof db0.stats !== "object") db0.stats = { totalPurchases: 0, totalBroadcasts: 0 };
  if (typeof db0.stats.lastLeaderboardWeek !== "string") db0.stats.lastLeaderboardWeek = "";
  if (typeof db0.stats.totalPurchases !== "number") db0.stats.totalPurchases = 0;
  if (typeof db0.stats.totalBroadcasts !== "number") db0.stats.totalBroadcasts = 0;
  if (typeof db0.stats.lastDailyReportDay !== "string") db0.stats.lastDailyReportDay = "";
// analytics (revenue)
if (!db0.analytics || typeof db0.analytics !== "object") db0.analytics = {};
if (!db0.analytics.revenueByDay || typeof db0.analytics.revenueByDay !== "object") db0.analytics.revenueByDay = {};
if (!db0.analytics.revenueByWeek || typeof db0.analytics.revenueByWeek !== "object") db0.analytics.revenueByWeek = {};
if (!db0.analytics.revenueByCategoryDay || typeof db0.analytics.revenueByCategoryDay !== "object") db0.analytics.revenueByCategoryDay = {};
if (!db0.analytics.revenueByPackageDay || typeof db0.analytics.revenueByPackageDay !== "object") db0.analytics.revenueByPackageDay = {};
if (!db0.analytics.transactionsByDay || typeof db0.analytics.transactionsByDay !== "object") db0.analytics.transactionsByDay = {};


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
    if (typeof x.redeemUnlockStart !== "number") x.redeemUnlockStart = 0;
    if (typeof x.redeemUnlockPurchases !== "number") x.redeemUnlockPurchases = 0;
    if (!x.redeemedCounts || typeof x.redeemedCounts !== "object") x.redeemedCounts = {};

    if (typeof x.inviterId !== "string") x.inviterId = "";
    if (typeof x.inviterSetAt !== "number") x.inviterSetAt = 0;
    if (typeof x.lastReferralRewardDay !== "string") x.lastReferralRewardDay = "";
    if (typeof x.points !== "number") x.points = 0;
    if (typeof x.totalSpentKsh !== "number") x.totalSpentKsh = 0;
    if (typeof x.referralSuccessCount !== "number") x.referralSuccessCount = 0;
    if (typeof x.referralCounted !== "boolean") x.referralCounted = false;
    if (typeof x.bonusEligibleCount !== "number") x.bonusEligibleCount = 0;
    if (typeof x.lastNudgeDay !== "string") x.lastNudgeDay = "";

    if (x.lastPurchase === undefined) x.lastPurchase = null;
    if (x.lastPurchase && typeof x.lastPurchase !== "object") x.lastPurchase = null;

    if (x.pendingAction === undefined) x.pendingAction = null;
    if (typeof x.accountType !== "string") x.accountType = "normal";
    if (typeof x.subscriptionStart !== "number") x.subscriptionStart = 0;
    if (typeof x.subscriptionExpiry !== "number") x.subscriptionExpiry = 0;
    if (typeof x.businessIntroShown !== "boolean") x.businessIntroShown = false;
    if (typeof x.businessReminderLastDay !== "string") x.businessReminderLastDay = "";
    if (typeof x.businessExpiredNotifiedAt !== "number") x.businessExpiredNotifiedAt = 0;
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

  // ✅ Prune inactive users to prevent DB growth (does NOT affect referral lock; it only removes old records)
  // Default: remove users inactive for PRUNE_INACTIVE_DAYS (env overridable).
  try {
    const pruneMs = Math.max(30, Number(PRUNE_INACTIVE_DAYS || 365)) * 24 * 60 * 60 * 1000;
    for (const [cid, u] of Object.entries(db0.users || {})) {
      if (String(cid) === String(ADMIN_ID)) continue;
      const last = Number(u?.lastSeen || 0);
      if (last && now - last > pruneMs) {
        // Clean related pending objects best-effort
        try { delete db0.pendingRedeems?.[String(cid)]; } catch (_) {}
        try {
          // Remove any pendingPayments for this chat (best-effort)
          for (const [ref, p] of Object.entries(db0.pendingPayments || {})) {
            if (Number(p?.chatId) === Number(cid)) delete db0.pendingPayments[ref];
          }
        } catch (_) {}
        delete db0.users[cid];
      }
    }
  } catch (_) {}


  for (const [ref, p] of Object.entries(db0.pendingPayments || {})) {
    const t = Number(p?.createdAt || 0);
    if (!t || now - t > 3 * 24 * 60 * 60 * 1000) delete db0.pendingPayments[ref];
  }
  for (const [ref, t] of Object.entries(db0.processedPayments || {})) {
    const ts = Number(t || 0);
    if (!ts || now - ts > 3 * 24 * 60 * 60 * 1000) delete db0.processedPayments[ref];
  }

// prune analytics transactionsByDay old days (keep last 30 days)
try {
  const txDays = Object.keys(db0.analytics?.transactionsByDay || {}).sort();
  while (txDays.length > 30) {
    const oldestTxDay = txDays.shift();
    delete db0.analytics.transactionsByDay[oldestTxDay];
  }
} catch (_) {}

// prune backup vault old keys (keep 180 days)
try {
  const cutoff = now - (180 * 24 * 60 * 60 * 1000);
  for (const [bk, rec] of Object.entries(db0.backupVault || {})) {
    const t = Number(rec?.createdAt || 0);
    if (!t || t < cutoff) delete db0.backupVault[bk];
  }
} catch (_) {}

  return db0;

  if (!db.customPackages || typeof db.customPackages !== "object") db.customPackages = {};
}

let db = {};

db = loadDB();
try { cleanupExpiredBackups(); } catch (_) {}


// ===================== TELEGRAM TOKEN (Admin-settable) =====================
// Priority: db.botToken (set via /settoken) -> Render env TELEGRAM_TOKEN
try {
  const fromDb = (db && typeof db.botToken === "string") ? db.botToken.trim() : "";
  const fromEnv = String(process.env.TELEGRAM_TOKEN || "").trim();
  TELEGRAM_TOKEN = fromDb || fromEnv || "";
} catch (_) {
  TELEGRAM_TOKEN = String(process.env.TELEGRAM_TOKEN || "").trim();
}


// ===== WEEKLY DRAW (Admin UI state) =====
const weeklyDrawAdminState = new Map(); // chatId -> { mode, messageId? }
function setWeeklyDrawAdminState(chatId, state) {
  if (!state) weeklyDrawAdminState.delete(chatId);
  else weeklyDrawAdminState.set(chatId, state);
}
function getWeeklyDrawAdminState(chatId) {
  return weeklyDrawAdminState.get(chatId) || null;
}
function isWeeklyDrawEnabled() {
  return !!(db.campaign && db.campaign.enabled);
}
function ensureWeeklyDrawObject() {
  db.campaign = db.campaign || {};
  db.campaign.prizes = db.campaign.prizes || { first: 250, second: 150, third: 100 };
  db.campaign.winnersCount = Number.isFinite(Number(db.campaign.winnersCount)) ? Math.max(1, Math.floor(Number(db.campaign.winnersCount))) : 3;
  db.campaign.name = db.campaign.name || "WEEKLY DRAW";
  db.campaign.heading = db.campaign.heading || db.campaign.name || "WEEKLY DRAW";
  db.campaign.status = db.campaign.status || (db.campaign.enabled ? "RUNNING" : "OFF");
  db.campaign.winners = db.campaign.winners || [];
  db.campaign.entries = db.campaign.entries && typeof db.campaign.entries === "object" ? db.campaign.entries : {};
  db.campaign.image = db.campaign.image || ""; // legacy single file_id or URL
  db.campaign.media = Array.isArray(db.campaign.media) ? db.campaign.media : []; // [{type:"photo"|"video", fileId}]

  // ✅ Weekly random rule: only one category counts per ISO week (optional)
  db.campaign.randomPurchaseRule = (db.campaign.randomPurchaseRule && typeof db.campaign.randomPurchaseRule === "object")
    ? db.campaign.randomPurchaseRule
    : { enabled: false, category: "", weekKey: "" };


  // ✅ Dynamic campaign qualifications (admin-editable)
  // enabled=true means requirement is needed to qualify.
  // Notes:
  // - "purchases" counts successful purchases with amount >= minAmount
  // - "activeReferrals" counts referred users who have >=1 successful purchase
  // - "spend" uses total spent in THIS campaign (successful payments only)
  // - "withdraw" tracks withdrawal REQUESTS in THIS campaign (you can change later to paid withdrawals)
  // - "offer" matches purchases whose offer label includes the match text (case-insensitive)
  db.campaign.qualifications = db.campaign.qualifications && typeof db.campaign.qualifications === "object"
    ? db.campaign.qualifications
    : {
        ageDays: { enabled: true, days: 3 },
        purchases: { enabled: true, count: 5, minAmount: 20 },
        activeReferrals: { enabled: true, count: 3 },
        spend: { enabled: false, amount: 300 },
        withdraw: { enabled: false, count: 1 },
        offer: { enabled: false, match: "" },
        tickets: { enabled: false, count: 100 },
        points: { enabled: false, amount: 200 },
      };

  // Per-campaign tracking maps (successful purchases only)
  db.campaign.spend = db.campaign.spend && typeof db.campaign.spend === "object" ? db.campaign.spend : {};
  db.campaign.withdrawReq = db.campaign.withdrawReq && typeof db.campaign.withdrawReq === "object" ? db.campaign.withdrawReq : {};
  db.campaign.offerCount = db.campaign.offerCount && typeof db.campaign.offerCount === "object" ? db.campaign.offerCount : {};

  return db.campaign;
}

// ===== WEEKLY DRAW: Random Weekly Category Rule =====
// If enabled, the bot will choose ONE category per ISO week and ONLY purchases in that category earn tickets.
const WD_RANDOM_CATEGORIES = [
  "SMS Offers",
  "Bingwa Deals",
  "Minutes",
  "Unlimited Deals",
];

function pickRandomWDCategory() {
  const list = WD_RANDOM_CATEGORIES;
  const i = Math.floor(Math.random() * list.length);
  return list[i];
}

function ensureWeeklyRandomRuleFresh() {
  try {
    const c = ensureWeeklyDrawObject();
    const rr = c.randomPurchaseRule;
    if (!rr || !rr.enabled) return;

    const wk = isoWeekKey(new Date());
    if (String(rr.weekKey || "") !== String(wk) || !String(rr.category || "").trim()) {
      rr.weekKey = wk;
      rr.category = pickRandomWDCategory();
      saveDB();
    }
  } catch (_) {}
}

function weeklyRandomRuleText(chatId) {
  try {
    const c = ensureWeeklyDrawObject();
    const rr = c.randomPurchaseRule;
    if (!rr || !rr.enabled) return "";
    ensureWeeklyRandomRuleFresh();
    const cat = String(rr.category || "").trim();
    if (!cat) return "";
    // If chatId provided, localize
    if (chatId) return tr(chatId, `🎯 This week: Only ${cat} purchases count`, `🎯 Wiki hii: Ni manunuzi ya ${cat} pekee ndiyo yanahesabika`);
    return `🎯 This week: Only ${cat} purchases count`;
  } catch (_) {
    return "";
  }
}



/**
 * Safe display name (never returns undefined/empty).
 * Uses same idea as /start: first+last, then username, then saved u.name, else "User <id>".
 */
function safeDisplayName(u, chatId) {
  const id = String(chatId || "");
  try {
    const first = String(u?.profile?.firstName || u?.firstName || "").trim();
    const last  = String(u?.profile?.lastName  || u?.lastName  || "").trim();
    const full = (first + " " + last).trim();
    if (full && full.toLowerCase() !== "undefined") return full;

    const uname = String(u?.profile?.username || u?.username || "").trim();
    if (uname && uname.toLowerCase() !== "undefined") return "@" + uname.replace(/^@/,"");

    const saved = String(u?.name || "").trim();
    if (saved && saved.toLowerCase() !== "undefined" && saved !== id) return saved;

    return id ? ("User " + id) : "User";
  } catch (_) {
    return id ? ("User " + id) : "User";
  }
}

/**
 * Capture Telegram profile into our user object (call on /start and on any message).
 */
function updateUserProfileFromMsg(chatId, msg) {
  try {
    const u = getUser(chatId);
    if (!u.profile || typeof u.profile !== "object") u.profile = { firstName:"", lastName:"", username:"" };
    const f = msg?.from || {};
    u.profile.firstName = String(f.first_name || u.profile.firstName || "").trim();
    u.profile.lastName  = String(f.last_name  || u.profile.lastName  || "").trim();
    u.profile.username  = String(f.username   || u.profile.username  || "").trim();
    u.profileUpdatedAt = Date.now();

    // Keep u.name in sync for leaderboards/winners
    const snap = safeDisplayName(u, chatId);
    if (snap) u.name = snap;

    try { saveDB(); } catch (_) {}
  } catch (_) {}
}

/**
 * Return winner record for a user if they are among winners (current or lastEnded snapshot).
 * Returns { rec, source } where source is "current" | "lastEnded" or null.
 */
function getWeeklyDrawWinnerRecord(chatId) {
  const c = ensureWeeklyDrawObject();
  const id = String(chatId);
  try {
    if (Array.isArray(c.winners)) {
      const rec = c.winners.find(w => String(w.chatId) === id);
      if (rec) return { rec, source: "current" };
    }
    if (c.lastEnded && Array.isArray(c.lastEnded.winners)) {
      const rec = c.lastEnded.winners.find(w => String(w.chatId) === id);
      if (rec) return { rec, source: "lastEnded" };
    }
  } catch (_) {}
  return { rec: null, source: null };
}

function hasSubmittedPayoutDetails(chatId) {
  const { rec } = getWeeklyDrawWinnerRecord(chatId);
  return !!(rec && (rec.payoutSubmitted === true));
}

// Basic Kenya number normalize: accept 07/01/2547/2541 and return 2547XXXXXXXX or 2541XXXXXXXX
function normalizeMpesaNumber(input) {
  const t = String(input || "").replace(/\s+/g, "");
  if (!t) return null;
  if (/^0[71]\d{8}$/.test(t)) return "254" + t.slice(1);
  if (/^254[71]\d{8}$/.test(t)) return t;
  return null;
}


/**
 * Parse duration strings like:
 *  - "5" (days)
 *  - "5d", "1h", "30m", "2w", "1mo", "1yr"
 *  - combined: "2d 1h", "1w 2d"
 *  - range: "5,6" or "5-6" (days) -> uses max value
 * Returns milliseconds or null if invalid.
 */
function parseDurationMs(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;

  // Support "5,6" or "5-6" meaning "up to 6 days" (use max)
  const rangeMatch = raw.match(/^(\d+(?:\.\d+)?)\s*[,|-]\s*(\d+(?:\.\d+)?)\s*(yr|y|mo|w|d|h|m|min|mins|minute|minutes)?$/i);
  if (rangeMatch) {
    const a = Number(rangeMatch[1] || 0);
    const b = Number(rangeMatch[2] || 0);
    const unit = String(rangeMatch[3] || "d").toLowerCase();
    const n = Math.max(a, b);
    return n > 0 ? (n * durationUnitToMs(unit)) : null;
  }

  // Tokenize: "2d 1h 30m" or "2d1h" (we'll split by space then also match repeated tokens)
  const parts = raw.split(/\s+/).filter(Boolean);
  let total = 0;

  const tokenRe = /(\d+(?:\.\d+)?)(yr|y|mo|w|d|h|m|min|mins|minute|minutes)?/g;

  for (const p of parts) {
    let any = false;
    let match;
    while ((match = tokenRe.exec(p)) !== null) {
      any = true;
      const num = Number(match[1] || 0);
      const unit = String(match[2] || "d").toLowerCase(); // default days
      if (!(num > 0)) continue;
      total += num * durationUnitToMs(unit);
    }
    if (!any) return null;
  }

  return total > 0 ? Math.floor(total) : null;
}

function durationUnitToMs(unit) {
  const u = String(unit || "").toLowerCase();
  if (u === "yr" || u === "y") return 365 * 24 * 60 * 60 * 1000;
  if (u === "mo") return 30 * 24 * 60 * 60 * 1000;
  if (u === "w") return 7 * 24 * 60 * 60 * 1000;
  if (u === "d") return 24 * 60 * 60 * 1000;
  if (u === "h") return 60 * 60 * 1000;
  if (u === "m" || u === "min" || u === "mins" || u === "minute" || u === "minutes") return 60 * 1000;
  return 24 * 60 * 60 * 1000; // default days
}


/**
 * Broadcast weekly draw campaign launch message to all users in DB.
 * Runs only once per unique campaign key (period/heading/prizes).
 */
function weeklyDrawCampaignKey() {
  const c = ensureWeeklyDrawObject();
  const p = c.prizes || {};
  return [
    String(c.heading || "WEEKLY DRAW"),
    String(c.startAt || ""),
    String(c.endAt || ""),
    String(p.first || ""),
    String(p.second || ""),
    String(p.third || ""),
    String(c.image || ""),
  ].join("|");
}

function weeklyDrawBroadcastText() {
  const c = ensureWeeklyDrawObject();
  const heading = String(c.heading || "WEEKLY DRAW").toUpperCase();
  const p = c.prizes || {};
  const first = Number(p.first || 0);
  const second = Number(p.second || 0);
  const third = Number(p.third || 0);

  const req = weeklyDrawQualificationsInfoLines();
  const hurry = "🔥 Hurry! Buy offers now to earn tickets and climb the leaderboard.";
  const how = tr(chatId,"✅ Tap 🎉 WEEKLY DRAW in the bot menu to view status, join/leave, and track your rank.","✅ Bonyeza 🎉 DROO YA WIKI kwenye menyu ya bot kuona hali, kujiunga/kutoka na kufuatilia nafasi yako.");

  return (
    `🎉 ${heading} is LIVE!\n\n` +
    `Prizes: 🥇 ${first} • 🥈 ${second} • 🥉 ${third} (KSH)\n\n` +
    `Requirements to qualify:\n${req}\n\n` +
    `${hurry}\n\n${how}`
  );
}


async function broadcastWeeklyDrawLaunch(force = false) {
  const c = ensureWeeklyDrawObject();
  if (!c.enabled) return;

  const key = weeklyDrawCampaignKey();
  if (!force && c.lastBroadcastKey === key) return;

  c.lastBroadcastKey = key;
  c.lastBroadcastAt = Date.now();
  try { saveDB(); } catch (_) {}

  const msgText = weeklyDrawBroadcastText();
  const img = String(c.image || "").trim();

  async function sendToChat(targetId) {
    if (!targetId) return;
    try {
      if (img) {
        await bot.sendPhoto(targetId, img, { caption: msgText, ...WD_BROADCAST_JOIN_KB }).catch(async () => {
          await bot.sendMessage(targetId, msgText, WD_BROADCAST_JOIN_KB).catch(() => {});
        });
      } else {
        await bot.sendMessage(targetId, msgText, WD_BROADCAST_JOIN_KB).catch(() => {});
      }
    } catch (_) {}
  }

  // Send to channel (de-dupe: prevents double posts when multiple handlers / retries trigger)
  try {
    const now = Date.now();
    const lastKey = String(c.lastChannelBroadcastKey || "");
    const lastAt = Number(c.lastChannelBroadcastAt || 0);
    const recentlySentSame = (lastKey === String(key)) && lastAt && (now - lastAt) < (2 * 60 * 1000);

    if (!recentlySentSame) {
      await sendToChat(FORCE_JOIN_CHANNEL);
      c.lastChannelBroadcastKey = key;
      c.lastChannelBroadcastAt = now;
      try { saveDB(); } catch (_) {}
    }
  } catch (_) {}

  // Send to users
  const userIds = Object.keys((db && db.users) ? db.users : {});
  for (const cid of userIds) {
    if (!cid) continue;
    await sendToChat(cid);
    await new Promise(r => setTimeout(r, 35));
  }
}






  // ===== WEEKLY DRAW: User Opt-In (controls campaign notifications) =====
  function isWeeklyDrawOptedIn(chatId) {
    const u = getUser(chatId);
    return !!u.weeklyDrawOptIn;
  }
  function setWeeklyDrawOptIn(chatId, value) {
    const u = getUser(chatId);
    u.weeklyDrawOptIn = !!value;
    // keep a display name snapshot for lists
    if (!u.name || u.name === String(chatId)) {
      u.name = safeDisplayName(u, chatId);
}


function isWeeklyDrawLeaderboardEligible(chatId) {
  // Eligible if opted-in, OR opted-out within last 3 days (grace period).
  try {
    if (isWeeklyDrawOptedIn(chatId)) return true;
    const u = getUser(chatId);
    const t = Number(u?.lastOptOutAt || 0);
    if (!t) return false;
    return (Date.now() - t) <= (3 * 24 * 60 * 60 * 1000);
  } catch (_) {
    return false;
  }
}

    try { saveDB(); } catch (_) {}
  }
    function weeklyDrawUserMenuKeyboard(chatId, page = "menu") {
    const opted = isWeeklyDrawOptedIn(chatId);

    const rows = [];

    // Sub-pages use a Back button to return to the campaign menu
    if (page === "more") {
      rows.push([{ text: tr(chatId,tr(chatId,"⬅️ BACK","⬅️ NYUMA"),"⬅️ NYUMA"), callback_data: "wdusr:back" }]);
      // keep opt toggle visible on info pages too
      if (!opted) rows.push([{ text: tr(chatId,tr(chatId,"✅ JOIN","✅ JIUNGE"),"✅ JIUNGE"), callback_data: "wdusr:optin" }]);
      else rows.push([{ text: tr(chatId,tr(chatId,"🚫 LEAVE","🚫 ONDOKA"),"🚫 ONDOKA"), callback_data: "wdusr:optout" }]);
      rows.push([{ text: tr(chatId,tr(chatId,"🏆 PREVIOUS WINNERS","🏆 WASHINDI WALIOPITA"),"🏆 WASHINDI WA AWALI"), callback_data: "wdusr:prev" }]);
      return { reply_markup: { inline_keyboard: rows } };
    }

    if (page === "prev") {
      rows.push([{ text: tr(chatId,tr(chatId,"⬅️ BACK","⬅️ NYUMA"),"⬅️ NYUMA"), callback_data: "wdusr:back" }]);
      if (!opted) rows.push([{ text: tr(chatId,tr(chatId,"✅ JOIN","✅ JIUNGE"),"✅ JIUNGE"), callback_data: "wdusr:optin" }]);
      else rows.push([{ text: tr(chatId,tr(chatId,"🚫 LEAVE","🚫 ONDOKA"),"🚫 ONDOKA"), callback_data: "wdusr:optout" }]);
      rows.push([{ text: tr(chatId,tr(chatId,"ℹ️ MORE…","ℹ️ ZAIDI…"),"ℹ️ ZAIDI…"), callback_data: "wdusr:more" }]);
      return { reply_markup: { inline_keyboard: rows } };
    }

    // Main campaign menu
    if (!opted) {
      rows.push([{ text: tr(chatId, "✅ JOIN", "✅ JIUNGE"), callback_data: "wdusr:optin" }]);
    }


// ✅ Winner payout details button (only shows if you are a winner and have not submitted details yet)
try {
  const { rec } = getWeeklyDrawWinnerRecord(chatId);
  if (rec && rec.paid !== true && rec.payoutSubmitted !== true) {
    rows.push([{ text: tr(chatId,"📲 Submit M-PESA Details","📲 Tuma Maelezo ya M-PESA"), callback_data: "wdusr:claim" }]);
          } else if (rec && rec.paid !== true && rec.payoutSubmitted === true) {
            rows.push([{ text: tr(chatId,"✏️ Edit M-PESA Details","✏️ Hariri Maelezo ya M-PESA"), callback_data: "wdusr:editclaim" }]);
  }
  if (rec && rec.paid === true) {
    rows.push([{ text: tr(chatId,"✅ Payout PAID","✅ Malipo YAMELIPWA"), callback_data: "wdusr:refresh" }]);
  }
} catch (_) {}

    rows.push(
      [{ text: tr(chatId,tr(chatId,"ℹ️ MORE…","ℹ️ ZAIDI…"),"ℹ️ ZAIDI…"), callback_data: "wdusr:more" }],
      [{ text: tr(chatId,tr(chatId,"🏆 PREVIOUS WINNERS","🏆 WASHINDI WALIOPITA"),"🏆 WASHINDI WA AWALI"), callback_data: "wdusr:prev" }]
    );

    return { reply_markup: { inline_keyboard: rows } };
  }



function weeklyDrawQualificationsInfoLines(chatId) {
  const c = ensureWeeklyDrawObject();
  const qcfg = (c.qualifications && typeof c.qualifications === "object") ? c.qualifications : {};
  const lines = [];

  const add = (txt) => { if (txt) lines.push("• " + txt); };

  // Weekly random rule (optional)
  const rrTxt = weeklyRandomRuleText(chatId);
  if (rrTxt) add(rrTxt);

  if (qcfg.ageDays?.enabled) add(tr(chatId, `Stay at least ${Number(qcfg.ageDays.days || 0)} day(s) in the bot`, `Kaa angalau siku ${Number(qcfg.ageDays.days || 0)} kwenye bot`));
  if (qcfg.purchases?.enabled) add(tr(chatId, `${Number(qcfg.purchases.count || 0)}+ successful purchases of ${Number(qcfg.purchases.minAmount || 20)} KSH or more`, `Manunuzi ${Number(qcfg.purchases.count || 0)}+ yaliyofanikiwa ya Ksh ${Number(qcfg.purchases.minAmount || 20)} au zaidi`));
  if (qcfg.tickets?.enabled) add(tr(chatId, `Earn at least ${Number(qcfg.tickets.count || 0)} ticket(s)`, `Pata angalau tiketi ${Number(qcfg.tickets.count || 0)}`));
  if (qcfg.points?.enabled) add(tr(chatId, `Hold at least ${Number(qcfg.points.amount || 0)} point(s)`, `Kuwa na angalau pointi ${Number(qcfg.points.amount || 0)}`));
  if (qcfg.activeReferrals?.enabled) add(tr(chatId, `${Number(qcfg.activeReferrals.count || 0)} active referrals (referred users with at least 1 successful purchase)`, `Refa hai ${Number(qcfg.activeReferrals.count || 0)} (waliotumia link yako na wana angalau manunuzi 1 yaliyofanikiwa)`));
  if (qcfg.spend?.enabled) add(tr(chatId, `Spend at least ${Number(qcfg.spend.amount || 0)} KSH (successful purchases only)`, `Tumia angalau Ksh ${Number(qcfg.spend.amount || 0)} (manunuzi yaliyofanikiwa pekee)`));
  if (qcfg.withdraw?.enabled) add(tr(chatId, `${Number(qcfg.withdraw.count || 0)} withdrawal request(s)`, `Maombi ya kutoa ${Number(qcfg.withdraw.count || 0)}`));
  if (qcfg.offer?.enabled) {
    const match = String(qcfg.offer.match || "").trim();
    const need = Number(qcfg.offer.count || 1);
    add(match ? tr(chatId, `Buy "${match}" ${need} time(s)`, `Nunua "${match}" mara ${need}`) : tr(chatId, `Buy the required offer (set by admin)`, `Nunua ofa inayohitajika (imewekwa na admin)`));
  }

  if (qcfg.bizMonths?.enabled) add(tr(chatId, `Business subscription: at least ${Number(qcfg.bizMonths.minMonths || 0)} month(s) remaining`, `Usajili wa Business: angalau miezi ${Number(qcfg.bizMonths.minMonths || 0)} ibaki`));

  return lines.length ? lines.join("\n") : tr(chatId, "• No qualification rules set (everyone qualifies).", "• Hakuna sheria za kuqualify (kila mtu anahesabika).");
}

function weeklyDrawPurchasesCountText(chatId) {
  const c = ensureWeeklyDrawObject();
  const qcfg = c.qualifications || {};
  if (qcfg?.purchases?.enabled) {
    return tr(chatId, `✅ Purchases ≥${Number(qcfg.purchases.minAmount || 20)} KSH count toward qualification.`, `✅ Manunuzi ya Ksh ${Number(qcfg.purchases.minAmount || 20)} au zaidi yanahesabiwa kwenye kuqualify.`);
  }
  return tr(chatId, `✅ Any successful purchase earns tickets.`, `✅ Manunuzi yoyote yaliyofanikiwa hupata tiketi.`);
}
function weeklyDrawMoreText(chatId) {
  const c = ensureWeeklyDrawObject();
  const heading = String(c.heading || "WEEKLY DRAW").toUpperCase();
  const p = c.prizes || {};
  const first = Number(p.first || 0);
  const second = Number(p.second || 0);
  const third = Number(p.third || 0);
  const total = first + second + third;

  const prizesEn = `🥇 1st: ${first} KSH
🥈 2nd: ${second} KSH
🥉 3rd: ${third} KSH
💰 Total: ${total} KSH`;

  const prizesSw = `🥇 Nafasi ya 1: ${first} KSH
🥈 Nafasi ya 2: ${second} KSH
🥉 Nafasi ya 3: ${third} KSH
💰 Jumla: ${total} KSH`;

  const periodTxt = (c.startAt && c.endAt)
    ? `${new Date(c.startAt).toISOString().slice(0,10)} → ${new Date(c.endAt).toISOString().slice(0,10)}`
    : tr(chatId, "Not set yet", "Bado haijawekwa");

  const qualTxt = weeklyDrawQualificationsInfoLines(chatId);
  const rr = weeklyRandomRuleText(chatId);
  const purchasesTxt = weeklyDrawPurchasesCountText(chatId);

  const en =
`🎉 ${heading}

What is this?
Weekly Draw is a giveaway where you earn tickets from successful purchases. More tickets = higher chance to win.

Prizes (current):
${prizesEn}

Period:
${periodTxt}

How to participate:
1) Tap ✅ JOIN (so you receive ticket updates, reminders & winner announcements)
2) Buy offers — every 5 KSH = 1 ticket (Business gets +5% bonus tickets (opt-in required))
3) Invite friends using 🔗 My Referral

What purchases count?
✅ Only successful payments.
✅ Purchase must be ≥ 5 KSH to earn tickets.
${purchasesTxt}
${rr ? ("✅ " + rr + "\n") : ""}

How to qualify (current rules):
${qualTxt}

What is an active referral?
A person who joined using your referral link and has made at least one successful purchase.

Tip:
Buy more to earn more tickets and climb the Top Participants list.`;

  const sw =
`🎉 ${heading}

Hii ni nini?
Weekly Draw ni zawadi ambapo unapata tiketi kupitia manunuzi yaliyofanikiwa. Tiketi nyingi = nafasi kubwa ya kushinda.

Zawadi (kwa sasa):
${prizesSw}

Muda:
${periodTxt}

Jinsi ya kushiriki:
1) Bonyeza ✅ JIUNGE (upokee taarifa za tiketi, vikumbusho na matangazo ya washindi)
2) Nunua ofa — kila Ksh 5 = tiketi 1 (Business hupata +5% tiketi za ziada (inahitajika kujiunga))
3) Alika marafiki kupitia 🔗 Rufaa Yangu

Manunuzi gani yanahesabiwa?
✅ Malipo yaliyofanikiwa pekee.
✅ Manunuzi lazima yawe angalau Ksh 5 ili kupata tiketi.
${purchasesTxt}
${rr ? ("✅ " + rr + "\n") : ""}

Jinsi ya kuqualify (sheria za sasa):
${qualTxt}

Refa hai ni nini?
Ni mtu aliyejiunga kwa kutumia link yako ya rufaa na amefanya angalau manunuzi 1 yaliyofanikiwa.

Kidokezo:
Nunua zaidi upate tiketi zaidi na upande kwenye orodha ya Washiriki Bora.`;

  return tr(chatId, en, sw);
}


function weeklyDrawLastWinnersText(chatId) {
    const c = ensureWeeklyDrawObject();
    const last = c.lastEnded || null; // { endedAt, heading, prizes, image, winners }
    if (!last || !Array.isArray(last.winners) || !last.winners.length) return "";
    const date = last.endedAt ? new Date(last.endedAt).toISOString().slice(0,10) : "";
    const head = String(last.heading || "WEEKLY DRAW").toUpperCase();
    const p = last.prizes || {};
    const prizeLine = `🥇 ${Number(p.first||0)} • 🥈 ${Number(p.second||0)} • 🥉 ${Number(p.third||0)} (KSH)`;
    const lines = last.winners.slice(0, (c.winnersCount || 3)).map((w,i)=>{
      const pos = i===0?"🥇":i===1?"🥈":"🥉";
      return `${pos} ${(w.name || safeDisplayName(getUser(w.chatId), w.chatId) || w.chatId)} — Ksh ${Number(w.prize||0)} (${w.paid ? tr(chatId,"Paid ✅","Imelipwa ✅") : tr(chatId,"Pending ⏳","Inasubiri ⏳")})`;
    }).join("\n");
    return `\n\n🏁 ${tr(chatId,"Previous Winners","Washindi wa Awali")} (${date})\n${head}\n${tr(chatId,"Prizes","Zawadi")}: ${prizeLine}\n${lines}`;
  }
  function buildWeeklyDrawMainCaption(chatId) {
    const c = ensureWeeklyDrawObject();
    const status = String(c.status || "OFF").toUpperCase();
    const heading = String(c.heading || "WEEKLY DRAW").toUpperCase();
    const countdown = getCampaignCountdown();

    const entries = (c.entries && typeof c.entries === "object") ? c.entries : {};
    const ranked = Object.entries(entries)
      .map(([cid, t]) => ({ cid, tickets: Number(t || 0) }))
      .filter((x) => x.tickets > 0)
      .map((x) => {
        const u = getUser(x.cid);
        const name = safeDisplayName(u, x.cid);
        const q = weeklyDrawQualification(x.cid);
        return { ...x, name, qualified: q.qualified };
      })
      .filter((x) => x.qualified)
      .sort((a, b) => b.tickets - a.tickets)
      .slice(0, 10);

    const listLines = ranked.length
      ? ranked.map((r, i) => `${i + 1}️⃣ ${r.name} — ${r.tickets} ${tr(chatId,"tickets","tiketi")}`).join("\n")
      : tr(chatId, 'No qualified participants yet.', 'Bado hakuna washiriki waliohitimu.');

    let winnersBlock = "";
    if (status === "ENDED" && Array.isArray(c.winners) && c.winners.length) {
      const lines = c.winners.slice(0, (c.winnersCount || 3)).map((w, i) => {
        const pos = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
        const paid = w.paid ? tr(chatId,"Paid ✅","Imelipwa ✅") : tr(chatId,"Pending ⏳","Inasubiri ⏳");
        return `${pos} ${(w.name || safeDisplayName(getUser(w.chatId), w.chatId) || w.chatId)} — Ksh ${Number(w.prize || 0)} (${paid})`;
      });
      winnersBlock = `\n\n🏁 ${tr(chatId,"Winners (Top 3)","Washindi (Top 3)")}\n${lines.join("\n")}`;
    }

    
let optedLine = tr(chatId, 'ℹ️ You are not opted in (no campaign messages). Tap ✅ JOIN to participate.', 'ℹ️ Hujajiunga (hutapokea taarifa za kampeni). Bonyeza ✅ JIUNGE kushiriki.');
if (isWeeklyDrawOptedIn(chatId)) {
  // If opted in, show motivational message based on your position in top 10 (qualified list)
  const myPos = ranked.findIndex((r) => String(r.cid) === String(chatId)) + 1; // 1-based
  if (myPos >= 1 && myPos <= 3) {
    optedLine = tr(chatId, `🎊 Congratulations! You are among the TOP 3 this week (#${myPos}). Keep buying to maintain your position.`, `🎊 Hongera! Uko kwenye TOP 3 wiki hii (#${myPos}). Endelea kununua ili udumishe nafasi yako.`);
  } else if (myPos >= 4 && myPos <= 10) {
    optedLine = tr(chatId, `👏 Great! You are close to winning (#${myPos} in Top 10). Keep buying to climb into Top 3.`, `👏 Poa! Uko karibu kushinda (#${myPos} kwenye Top 10). Endelea kununua ili upande hadi Top 3.`);
  } else {
    optedLine = tr(chatId, '✅ You are opted in (you will receive updates).', '✅ Umejiunga (utapokea taarifa).');
  }
}

    const caption =
      `🎉 ${heading}\n` +
      `${tr(chatId,"Status","Hali")}: ${status}\n` +
      `⏳ ${tr(chatId,"Ends in","Inaisha baada ya")}: ${countdown}${winnersBlock}\n\n` +
      `${optedLine}\n\n` +
      `🏆 ${tr(chatId,"Top Participants (Top 10)","Washiriki Bora (Top 10)")}\n${listLines}`;

    return caption;
  }



// ===== WEEKLY DRAW LIVE COUNTDOWN UPDATER (edits same message every 30s) =====
const weeklyDrawLiveIntervals = new Map(); // chatId -> intervalId

function startWeeklyDrawLiveUpdate(chatId, messageId, preferCaption = true) {
  const key = String(chatId);
  stopWeeklyDrawLiveUpdate(chatId);

  const tick = async () => {
    try {
      const caption = buildWeeklyDrawMainCaption(chatId) + (weeklyDrawLastWinnersText(chatId) || "");
      const kb = weeklyDrawUserMenuKeyboard(chatId);

      // Try caption edit first (for photo messages), then fallback to text edit.
      if (preferCaption) {
        await bot.editMessageCaption(caption, {
          chat_id: chatId,
          message_id: messageId,
          ...kb,
        }).catch(async () => {
          await bot.editMessageText(caption, {
            chat_id: chatId,
            message_id: messageId,
            ...kb,
          }).catch(() => {});
        });
      } else {
        await bot.editMessageText(caption, {
          chat_id: chatId,
          message_id: messageId,
          ...kb,
        }).catch(async () => {
          await bot.editMessageCaption(caption, {
            chat_id: chatId,
            message_id: messageId,
            ...kb,
          }).catch(() => {});
        });
      }
    } catch (_) {
      stopWeeklyDrawLiveUpdate(chatId);
    }
  };

  tick();
  const id = setInterval(tick, 30 * 1000);
  weeklyDrawLiveIntervals.set(key, id);
}

function stopWeeklyDrawLiveUpdate(chatId) {
  const key = String(chatId);
  const id = weeklyDrawLiveIntervals.get(key);
  if (id) clearInterval(id);
  weeklyDrawLiveIntervals.delete(key);
}


async function openWeeklyDrawUserMenu(chatId) {
  const c = ensureWeeklyDrawObject();
  if (!c.enabled) {
    return sendTracked(chatId, tr(chatId,"❌ WEEKLY DRAW is not active right now.","❌ Droo ya Wiki haiko hewani kwa sasa."), mainMenuKeyboard(chatId)).catch(() => {});
}

  // If user already opted-in, show the quick-deals UI (like the screenshot)
  // instead of the basic JOIN/INFO menu.
  try {
    if (isWeeklyDrawOptedIn(chatId)) {
      const p = wdJoinSuggestedPayload();
      return sendTracked(chatId, p.text, { ...p.keyboard, ...mainMenuKeyboard(chatId) }).catch(() => {});
    }
  } catch (_) {}

  const caption = buildWeeklyDrawMainCaption(chatId) + (weeklyDrawLastWinnersText(chatId) || "");
  const img = String(c.image || "").trim();

  try {
    if (img) {
      const sent = await bot.sendPhoto(chatId, img, { caption, ...weeklyDrawUserMenuKeyboard(chatId) });
      // Live update (caption)
      try { startWeeklyDrawLiveUpdate(chatId, sent.message_id, true); } catch (_) {}
      return sent;
    } else {
      const sent = await sendTracked(chatId, caption, weeklyDrawUserMenuKeyboard(chatId));
      // Live update (text)
      try { startWeeklyDrawLiveUpdate(chatId, sent.message_id, false); } catch (_) {}
      return sent;
    }
  } catch (e) {
    // fallback to message
    const sent = await sendTracked(chatId, caption, weeklyDrawUserMenuKeyboard(chatId)).catch(() => null);
    if (sent) {
      try { startWeeklyDrawLiveUpdate(chatId, sent.message_id, false); } catch (_) {}
      return sent;
    }
    return null;
  }
}



  async function editInlineMessage(q, text, keyboard) {
    const chatId = q.message?.chat?.id;
    const messageId = q.message?.message_id;
    if (!chatId || !messageId) return;

    // If the message has a photo, edit the caption; otherwise edit the text.
    if (q.message && Array.isArray(q.message.photo) && q.message.photo.length) {
      await bot.editMessageCaption(text, {
        chat_id: chatId,
        message_id: messageId,
        ...keyboard,
      }).catch(async () => {
        // Fallback: try edit text
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...keyboard }).catch(() => {});
      });
    } else {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...keyboard }).catch(() => {});
    }
  }

  async function editAdminStateMessage(chatId, state, text, keyboard) {
    const mid = state && state.messageId ? state.messageId : null;
    if (mid) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: mid, ...keyboard }).catch(async () => {
        await bot.sendMessage(chatId, text, keyboard).catch(() => {});
      });
      return;
    }
    await bot.sendMessage(chatId, text, keyboard).catch(() => {});
  }
function weeklyDrawAdminMenuKeyboard() {
  const c = ensureWeeklyDrawObject();
  const isOn = !!c.enabled;
  const toggleText = isOn ? "🚫 Hide" : "✅ Activate";
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: toggleText, callback_data: "wdadm:toggle" }],
        [{ text: "📢 Broadcast Now", callback_data: "wdadm:broadcast" }],
        [{ text: "🏁 End & Announce", callback_data: "wdadm:end" }, { text: "🔄 Restart", callback_data: "wdadm:restart" }],
        [{ text: "💰 Pay Winners", callback_data: "wdadm:pay" }],
        [{ text: "📝 Set Prizes", callback_data: "wdadm:set_prizes" }, { text: "🗓 Set Period", callback_data: "wdadm:set_period" }],
        [{ text: "✅ Qualifications", callback_data: "wdadm:quals" }],        [{ text: "🖼 Set Image", callback_data: "wdadm:set_image" }],
        [{ text: "✏️ Set Name", callback_data: "wdadm:set_name" }, { text: "📝 Set Heading", callback_data: "wdadm:set_heading" }],
        [{ text: "📋 Status", callback_data: "wdadm:status" }],
        [{ text: "❌ Close", callback_data: "ui:close" }],
      ],
    },
  };
}

function weeklyDrawQualificationsKeyboard() {
  const c = ensureWeeklyDrawObject();
  const qcfg = c.qualifications || {};
  const row = (key, title) => {
    const enabled = !!(qcfg[key] && qcfg[key].enabled);
    const mark = enabled ? "✅" : "⬜️";
    return [
      { text: `${mark} ${title}`, callback_data: `wdadm:qual_toggle:${key}` },
      { text: "⚙️ Set", callback_data: `wdadm:qual_set:${key}` },
    ];
  };

  return {
    reply_markup: {
      inline_keyboard: [
        row("ageDays", "Account Age (days)"),
        row("purchases", "Purchases (count/min)"),
        row("tickets", "Tickets Required"),
        row("points", "Hold Minimum Points"),
        row("activeReferrals", "Active Referrals"),
        row("spend", "Spend (KSH)"),
        row("withdraw", "Withdraw Requests"),
        row("offer", "Specific Offer"),
        row("bizMonths", "Business Subscription (months)"),
        [{ text: "⬅️ Back", callback_data: "wdadm:menu" }],
      ],
    },
  };
}

function qualificationPromptFor(key) {
  if (key === "ageDays") return "🗓 Send required days in bot (e.g., 3)";
  if (key === "purchases") return "🛒 Send: <count> <minAmount>  (example: 5 20)";
  if (key === "tickets") return "🎟 Send required minimum tickets (e.g., 100)";
  if (key === "points") return "💎 Send required minimum points to hold (e.g., 200)";
  if (key === "activeReferrals") return "👥 Send required active referrals (e.g., 3)";
  if (key === "spend") return "💰 Send required spend in KSH (e.g., 300)";
  if (key === "withdraw") return "💸 Send required withdrawal requests (e.g., 1)";
  if (key === "offer") return "🎯 Send offer match text + optional count.\nExample: 99ksh 1gb | 1\n(Format: <text> | <count>)";
  if (key === "bizMonths") return "🏢 Send required Business subscription months remaining (e.g., 1 or 3)";
  return "Send value";
}

function setQualificationValue(c, key, inputText) {
  c.qualifications = c.qualifications || {};
  c.qualifications[key] = c.qualifications[key] || { enabled: true };
  // Ensure nested config objects exist
  if (key === "bizMonths") c.qualifications.bizMonths = c.qualifications.bizMonths || { enabled: true, minMonths: 0 };

  const t = String(inputText || "").trim();

  if (key === "ageDays") {
    const days = Number(t);
    if (!Number.isFinite(days) || days < 0) return { ok: false, err: "Invalid days." };
    c.qualifications.ageDays.days = Math.floor(days);
    return { ok: true };
  }

  if (key === "purchases") {
    const parts = t.split(/\s+/).filter(Boolean);
    const count = Number(parts[0]);
    const minAmount = parts.length > 1 ? Number(parts[1]) : Number(c.qualifications.purchases.minAmount || 20);
    if (!Number.isFinite(count) || count < 0 || !Number.isFinite(minAmount) || minAmount < 0) return { ok: false, err: "Invalid purchases format." };
    c.qualifications.purchases.count = Math.floor(count);
    c.qualifications.purchases.minAmount = Math.floor(minAmount);
    return { ok: true };
  }

  if (key === "activeReferrals") {
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return { ok: false, err: "Invalid number." };
    c.qualifications.activeReferrals.count = Math.floor(n);
    return { ok: true };
  }

  if (key === "spend") {
    const amt = Number(t);
    if (!Number.isFinite(amt) || amt < 0) return { ok: false, err: "Invalid amount." };
    c.qualifications.spend.amount = Math.floor(amt);
    return { ok: true };
  }

  if (key === "withdraw") {
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return { ok: false, err: "Invalid number." };
    c.qualifications.withdraw.count = Math.floor(n);
    return { ok: true };
  }

  if (key === "tickets") {
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return { ok: false, err: "Invalid number." };
    c.qualifications.tickets.count = Math.floor(n);
    return { ok: true };
  }

  if (key === "points") {
    const amt = Number(t);
    if (!Number.isFinite(amt) || amt < 0) return { ok: false, err: "Invalid amount." };
    c.qualifications.points.amount = Math.floor(amt);
    return { ok: true };
  }

  if (key === "offer") {
    // Format: "<text> | <count>" (count optional)
    const parts = t.split("|").map(s => s.trim()).filter(Boolean);
    const match = parts[0] || "";
    const count = parts[1] ? Number(parts[1]) : 1;
    if (!match) return { ok: false, err: "Offer match text is required." };
    if (!Number.isFinite(count) || count <= 0) return { ok: false, err: "Invalid count." };
    c.qualifications.offer.match = match;
    c.qualifications.offer.count = Math.floor(count);
    return { ok: true };
  }


  if (key === "bizMonths") {
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return { ok: false, err: "Invalid number." };
    c.qualifications.bizMonths.minMonths = Math.floor(n);
    return { ok: true };
  }

  return { ok: false, err: "Unknown qualification." };
}
function formatWeeklyDrawAdminStatus() {
  const c = ensureWeeklyDrawObject();
  const enabled = c.enabled ? "ON" : "OFF";
  const status = c.status || "OFF";
  const heading = c.heading || "WEEKLY DRAW";
  const startAt = c.startAt ? new Date(c.startAt).toISOString().slice(0, 10) : "-";
  const endAt = c.endAt ? new Date(c.endAt).toISOString().slice(0, 10) : "-";
  const p = c.prizes || {};
  const prizesTxt = `1st: ${Number(p.first||0)} KSH, 2nd: ${Number(p.second||0)} KSH, 3rd: ${Number(p.third||0)} KSH`;
  const winners = Array.isArray(c.winners) ? c.winners : [];
  const wTxt = winners.length
    ? winners.map((w, i) => `${i+1}. ${(w.name || safeDisplayName(getUser(w.chatId), w.chatId) || w.chatId)} — ${w.prize} KSH (${w.paid ? "Paid ✅" : "Pending"})`).join("\n")
    : "No winners frozen yet.";
  return (
    `🎛 WEEKLY DRAW ADMIN\n` +
    `Heading: ${heading}\n` +
    `Enabled: ${enabled}\n` +
    `Status: ${status}\n` +
    `Period: ${startAt} → ${endAt}\n` +
    `Prizes: ${prizesTxt}\n\n` +
    `Winners:\n${wTxt}`
  );
}
function weeklyDrawPayWinnersKeyboard() {
  const c = ensureWeeklyDrawObject();
  const winners = Array.isArray(c.winners) ? c.winners.slice(0, (c.winnersCount || 3)) : [];
  const rows = [];
  if (!winners.length) {
    rows.push([{ text: "⬅ Back", callback_data: "wdadm:menu" }]);
    return { reply_markup: { inline_keyboard: rows } };
  }
  for (const w of winners) {
    const label = `${w.paid ? "✅ Paid" : "⏳ Pending"} — ${(w.name || safeDisplayName(getUser(w.chatId), w.chatId) || w.chatId)} (${w.prize}KSH)`;
    rows.push([{ text: label, callback_data: `wdadm:toggle_paid:${w.chatId}` }]);
  }
  rows.push([{ text: "⬅ Back", callback_data: "wdadm:menu" }]);
  return { reply_markup: { inline_keyboard: rows } };
}


// ===== WEEKLY DRAW: Tickets + Qualification =====
function isCampaignRunning() {
  const c = ensureWeeklyDrawObject();
  return !!(c.enabled && String(c.status || "").toUpperCase() === "RUNNING" && Number(c.endAt || 0) > Date.now());
}
function getCampaignCountdown() {
  const c = ensureWeeklyDrawObject();
  const endAt = Number(c.endAt || 0);
  if (!endAt) return "N/A";
  if (endAt <= Date.now()) return "Ended";
  const ms = endAt - Date.now();
  const d = Math.floor(ms / (24*60*60*1000));
  const h = Math.floor((ms % (24*60*60*1000)) / (60*60*1000));
  const m = Math.floor((ms % (60*60*1000)) / (60*1000));
  return `${d}d ${h}h ${m}m`;
}
function weeklyDrawBaseTickets(amountKsh) {
  const amt = Number(amountKsh || 0);
  if (!(amt >= 5)) return 0;
  return Math.floor(amt / 5);
}
function weeklyDrawTicketsWithBonus(chatId, baseTickets) {
  let t = Number(baseTickets || 0);
  if (!(t > 0)) return 0;

  // Business bonus tickets: +5% ONLY when business active AND opted-in
  try {
    const biz = (typeof isBusinessActive === "function" && isBusinessActive(chatId));
    const opted = (typeof isWeeklyDrawOptedIn === "function" && isWeeklyDrawOptedIn(chatId));
    if (biz && opted) {
      t = Math.floor(t * 1.05);
      if (t < baseTickets) t = baseTickets;
    }
  } catch (_) {}

  return t;
}
function addWeeklyDrawTicketsFromPurchase(chatId, amountKsh, category) {
  const c = ensureWeeklyDrawObject();
  if (!c.enabled || String(c.status || "").toUpperCase() !== "RUNNING") return { earned: 0, total: 0 };

  // Random weekly category rule
  ensureWeeklyRandomRuleFresh();
  try {
    const rr = c.randomPurchaseRule;
    if (rr && rr.enabled) {
      const needCat = String(rr.category || "").trim();
      const cat = String(category || "").trim();
      if (needCat && cat && cat !== needCat) {
        const k0 = String(chatId);
        c.entries = c.entries && typeof c.entries === "object" ? c.entries : {};
        return { earned: 0, total: Number(c.entries[k0] || 0) };
      }
    }
  } catch (_) {}


  const amt = Number(amountKsh || 0);
  // Track campaign spend (successful purchases only) for Fast Track
  const k = String(chatId);
  c.spend = c.spend && typeof c.spend === "object" ? c.spend : {};
  c.spend[k] = Number(c.spend[k] || 0) + (amt > 0 ? amt : 0);

  const base = weeklyDrawBaseTickets(amt);
  const earned = weeklyDrawTicketsWithBonus(chatId, base);
  c.entries = c.entries && typeof c.entries === "object" ? c.entries : {};
  if (!(earned > 0)) {
    try { saveDB(); } catch (_) {}
    return { earned: 0, total: Number(c.entries[k] || 0) };
  }

  c.entries[k] = Number(c.entries[k] || 0) + earned;
  try { saveDB(); } catch (_) {}
  return { earned, total: Number(c.entries[k] || 0) };
}
function countActiveReferrals(inviterId) {
  const inv = String(inviterId);
  let n = 0;
  try {
    for (const [cid, u] of Object.entries(db.users || {})) {
      if (String(u.inviterId || "") === inv && u.hasPurchased === true) n += 1;
    }
  } catch (_) {}
  return n;
}
function weeklyDrawQualification(chatId) {
  const u = getUser(chatId);
  const c = ensureWeeklyDrawObject();
  const qcfg = (c.qualifications && typeof c.qualifications === "object") ? c.qualifications : {};
  const now = Date.now();

  // Stats
  const createdAt = Number(u.createdAt || u.firstSeen || u.profileUpdatedAt || 0);
  const ageDays = createdAt ? Math.floor((now - createdAt) / (24 * 60 * 60 * 1000)) : 0;

  // Purchases that qualify for "purchases" rule: successful purchases >= minAmount
  const purchCount = Number(u.qPurch20Count || 0); // we reuse the existing counter (>=20 KSH)
  const activeRefs = countActiveReferrals(chatId);
  const spent = Number((c.spend || {})[String(chatId)] || 0);
  const withdrawReq = Number((c.withdrawReq || {})[String(chatId)] || 0);
  const myTickets = Number((c.entries || {})[String(chatId)] || 0);
  const myPoints = Number(getPoints(chatId) || 0);

  // Offer match counter (optional)
  const offerMap = (c.offerCount || {})[String(chatId)] || {};
  let offerHits = 0;
  try {
    const match = String((qcfg.offer && qcfg.offer.match) || "").trim().toLowerCase();
    if (match) {
      // Sum all offer keys that include match
      for (const [k, v] of Object.entries(offerMap || {})) {
        if (String(k).toLowerCase().includes(match)) offerHits += Number(v || 0);
      }
    } else {
      offerHits = 0;
    }
  } catch (_) {
    offerHits = 0;
  }

  // Evaluate enabled requirements and build remaining list (only unmet)
  const enabledKeys = Object.keys(qcfg).filter(k => qcfg[k] && qcfg[k].enabled);

  const remaining = [];
  const satisfied = {};

  for (const key of enabledKeys) {
    const cfg = qcfg[key] || {};
    if (key === "ageDays") {
      const need = Math.max(0, Number(cfg.days || 0));
      const ok = ageDays >= need;
      satisfied[key] = ok;
      if (!ok) remaining.push(`Stay ${Math.max(0, need - ageDays)} more day(s)`);
    } else if (key === "purchases") {
      const needCount = Math.max(0, Number(cfg.count || 0));
      // We currently track qPurch20Count (>=20K). If admin changes minAmount away from 20,
      // we still use qPurch20Count as a safe baseline; adjust later if you add dynamic tracking.
      const ok = purchCount >= needCount;
      satisfied[key] = ok;
      if (!ok) remaining.push(`${Math.max(0, needCount - purchCount)} more purchases (≥${Number(cfg.minAmount || 20)} KSH)`);
    } else if (key === "tickets") {
      const need = Math.max(0, Number(cfg.count || 0));
      const ok = myTickets >= need;
      satisfied[key] = ok;
      if (!ok) remaining.push(`Earn ${Math.max(0, need - myTickets)} more ticket(s)`);
    } else if (key === "points") {
      const need = Math.max(0, Number(cfg.amount || 0));
      const ok = myPoints >= need;
      satisfied[key] = ok;
      if (!ok) remaining.push(`Hold ${Math.max(0, need - myPoints)} more point(s)`);
    } else if (key === "activeReferrals") {
      const need = Math.max(0, Number(cfg.count || 0));
      const ok = activeRefs >= need;
      satisfied[key] = ok;
      if (!ok) remaining.push(`${Math.max(0, need - activeRefs)} more active referrals`);
    } else if (key === "spend") {
      const need = Math.max(0, Number(cfg.amount || 0));
      const ok = spent >= need;
      satisfied[key] = ok;
      if (!ok) remaining.push(`Spend ${Math.max(0, need - spent)} KSH more`);
    } else if (key === "withdraw") {
      const need = Math.max(0, Number(cfg.count || 0));
      const ok = withdrawReq >= need;
      satisfied[key] = ok;
      if (!ok) remaining.push(`Make ${Math.max(0, need - withdrawReq)} more withdrawal request(s)`);
    
} else if (key === "bizMonths") {
  const need = Math.max(0, Number(cfg.minMonths || 0));
  let monthsLeft = 0;
  try {
    if (typeof isBusinessActive === "function" && isBusinessActive(chatId)) {
      const exp = Number(getUser(chatId).subscriptionExpiry || 0);
      if (exp > now) monthsLeft = Math.floor((exp - now) / (30 * 24 * 60 * 60 * 1000));
    }
  } catch (_) {
    monthsLeft = 0;
  }
  const ok = monthsLeft >= need;
  satisfied[key] = ok;
  if (!ok) remaining.push(`Business subscription: ${Math.max(0, need - monthsLeft)} more month(s) remaining`);
} else if (key === "offer") {
      const need = Math.max(0, Number(cfg.count || 1));
      const match = String(cfg.match || "").trim();
      const ok = !!match && offerHits >= need;
      satisfied[key] = ok;
      if (!ok) {
        if (!match) remaining.push(`Buy the required offer (admin will set it)`);
        else remaining.push(`Buy "${match}" (${Math.max(0, need - offerHits)} more time(s))`);
      }
    }
  }

  // Business Fast Track (kept): if business active, 5+ active refs AND spent >= 500 in campaign,
  // then qualify even if missing ONE enabled requirement.
  let fastTrack = false;
  try {
    if (typeof isBusinessActive === "function" && isBusinessActive(chatId)) {
      if (activeRefs >= 5 && spent >= 500) fastTrack = true;
    }
  } catch (_) {}

  const enabledCount = enabledKeys.length;
  const satisfiedCount = enabledKeys.reduce((acc, k) => acc + (satisfied[k] ? 1 : 0), 0);
  const qualified = enabledCount === 0
    ? true
    : (satisfiedCount === enabledCount) || (fastTrack && enabledCount >= 2 && satisfiedCount >= (enabledCount - 1));

  return {
    qualified,
    fastTrack,
    enabledKeys,
    satisfied,
    remaining,
    stats: { ageDays, purchCount, activeRefs, spent, withdrawReq, offerHits },
  };
}

function weeklyDrawQualificationText(chatId) {
  const q = weeklyDrawQualification(chatId);
  if (q.qualified) return q.fastTrack ? "✅ You are QUALIFIED for WEEKLY DRAW (Business Fast Track)." : "✅ You are QUALIFIED for WEEKLY DRAW.";
  if (!q.remaining.length) return "📌 To qualify for WEEKLY DRAW: complete the remaining requirements.";
  const lines = ["📌 Remaining to qualify for WEEKLY DRAW:"];
  for (const r of q.remaining) lines.push(`• ${r}`);
  return lines.join("\n");
}



function weeklyDrawRankInfo(chatId) {
  const c = ensureWeeklyDrawObject();
  const entries = c.entries && typeof c.entries === "object" ? c.entries : {};
  const ranked = Object.entries(entries)
    .map(([cid, t]) => ({ chatId: Number(cid), tickets: Number(t || 0) }))
    .filter(x => x.chatId && x.tickets > 0)
    .map(x => {
      const q = weeklyDrawQualification(x.chatId);
      return { ...x, qualified: q.qualified };
    })
    .filter(x => x.qualified)
    .filter(x => isWeeklyDrawLeaderboardEligible(x.chatId))
    .sort((a,b) => b.tickets - a.tickets);

  const idx = ranked.findIndex(x => x.chatId === Number(chatId));
  if (idx === -1) return { rank: 0, totalQualified: ranked.length, tickets: Number(entries[String(chatId)] || 0) };

  const rank = idx + 1;
  const tickets = ranked[idx].tickets;
  const above = ranked[idx - 1];
  const gapAbove = above ? Math.max(0, above.tickets - tickets) : 0;
  const third = ranked[2];
  const gapToTop3 = (third && rank > 3) ? Math.max(0, third.tickets - tickets) : 0;

  return { rank, totalQualified: ranked.length, tickets, gapAbove, gapToTop3, top3: rank > 0 && rank <= 3 };
}

function weeklyDrawRankGapText(chatId) {
  const info = weeklyDrawRankInfo(chatId);
  if (!info.rank) return "";
  // Only show gaps that feel achievable
  if (info.top3) {
    if (info.rank === 1) return `🥇 You are #1! Keep buying to stay on top.`;
    return `🏆 You are #${info.rank} (Top 3). Keep buying to protect your spot.`;
  }
  if (info.gapToTop3 > 0 && info.gapToTop3 <= 100) {
    return `🏆 Rank #${info.rank}. Only ${info.gapToTop3} ticket(s) behind Top 3!`;
  }
  if (info.gapAbove > 0 && info.gapAbove <= 100) {
    return `🏆 Rank #${info.rank}. Only ${info.gapAbove} ticket(s) behind #${info.rank - 1}!`;
  }
  return `🏆 Rank #${info.rank}.`;
}

// ===== WEEKLY DRAW: Reminders + Rank notifications + Broadcasts =====
function getCampaignRemainingDays() {
  const c = ensureWeeklyDrawObject();
  const endAt = Number(c.endAt || 0);
  if (!endAt) return null;
  const ms = endAt - Date.now();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

async function broadcastToAllUsers(messageText) {
  const ids = Object.keys(db.users || {});
  for (const cid of ids) {
    const chatId = Number(cid);
    if (!chatId) continue;
    try { if (isWeeklyDrawOptedIn(chatId) && !isStopCampaignNotifs(chatId)) await bot.sendMessage(chatId, messageText, mainMenuKeyboard(chatId)); } catch (_) {}
  }
}

// Freeze winners (Top 3 qualified) and announce to all users + DM winners
async function weeklyDrawFreezeAndAnnounce(reasonText) {
  const c = ensureWeeklyDrawObject();
  if (String(c.status || "").toUpperCase() === "ENDED") return;

  c.status = "ENDED";
  c.endedAt = Date.now();

  const entries = c.entries && typeof c.entries === "object" ? c.entries : {};
  const candidates = [];
  for (const [cid, tickets] of Object.entries(entries)) {
    const chatId = Number(cid);
    if (!chatId) continue;
    const q = weeklyDrawQualification(chatId);
    if (!q.qualified) continue;
    if (!isWeeklyDrawLeaderboardEligible(chatId)) continue;
    candidates.push({ chatId, tickets: Number(tickets || 0) });
  }
  candidates.sort((a, b) => (b.tickets - a.tickets));

    // Freeze snapshot of qualified leaderboard for this ending
    try { c.lastEnded = c.lastEnded || {}; c.lastEnded.snapshot = candidates.map(x => ({ chatId: x.chatId, score: x.score, name: x.name })); } catch (_) {}

  const prizes = c.prizes || { first: 250, second: 150, third: 100 };
  const top3 = candidates.slice(0, (c.winnersCount || 3));
  const winners = [];
  if (top3[0]) winners.push({ chatId: top3[0].chatId, tickets: top3[0].tickets, prize: Number(prizes.first || 0), paid: false });
  if (top3[1]) winners.push({ chatId: top3[1].chatId, tickets: top3[1].tickets, prize: Number(prizes.second || 0), paid: false });
  if (top3[2]) winners.push({ chatId: top3[2].chatId, tickets: top3[2].tickets, prize: Number(prizes.third || 0), paid: false });

  // Attach display names (best-effort)
  for (const w of winners) {
    try {
      const u = getUser(w.chatId);
      w.name = safeDisplayName(u, w.chatId);
    } catch (_) {}
  }

  c.winners = winners;
  // Save last ended campaign snapshot (for 'Previous Winners' info)
  c.lastEnded = {
    endedAt: Date.now(),
    heading: c.heading || "WEEKLY DRAW",
    prizes: { ...(c.prizes || {}) },
    image: c.image || "",
    winners: (winners || []).map(x => ({ ...x }))
  };

  c.rankCache = {}; // reset rank cache
  c.reminders = c.reminders || {};
  c.reminders.endSoon3dSent = true; // already ended
  try { saveDB(); } catch (_) {}

  // Announcement to ALL users
  const heading = String(c.heading || "WEEKLY DRAW").toUpperCase();
  const lines = [];
  lines.push(`🎉 ${heading} RESULTS`);
  if (reasonText) lines.push(reasonText);
  lines.push("");
  if (!winners.length) {
    lines.push("No qualified winners this round.");
  } else {
    const medals = ["🥇", "🥈", "🥉"];
    winners.forEach((w, i) => {
      lines.push(`${medals[i]} ${w.name} — ${w.prize} KSH (${w.paid ? "Paid ✅" : "Pending ⏳"})`);
    });
  }
  const announceMsg = lines.join("\n");
  await broadcastToAllUsers(announceMsg);

  // DM winners
  for (const w of winners) {
    const winMsg =
      `🎉 CONGRATULATIONS!\n\n` +
      `You are a winner of ${w.prize} KSH from WEEKLY DRAW.\n` +
      `Status: ${w.paid ? "Paid ✅" : "Pending ⏳"}\n\n` +
      `Thank you for participating.`;
    try { await bot.sendMessage(w.chatId, winMsg, mainMenuKeyboard(w.chatId)); } catch (_) {}
  }
}

// Auto-end when time is over
async function maybeAutoEndWeeklyDraw() {
  const c = ensureWeeklyDrawObject();
  if (!c.enabled) return;
  if (String(c.status || "").toUpperCase() !== "RUNNING") return;
  const endAt = Number(c.endAt || 0);
  if (endAt && endAt <= Date.now()) {
    await weeklyDrawFreezeAndAnnounce("⏳ Campaign ended.");
  }
}

// Broadcast reminder when 3 days remain (once)
async function maybeBroadcastEndSoon3Days() {
  // opt-in filtering is handled per-user inside

  const c = ensureWeeklyDrawObject();
  if (!c.enabled) return;
  if (String(c.status || "").toUpperCase() !== "RUNNING") return;
  const days = getCampaignRemainingDays();
  if (days === null) return;
  c.reminders = c.reminders || {};
  if (days <= 3 && !c.reminders.endSoon3dSent) {
    c.reminders.endSoon3dSent = true;
    try { saveDB(); } catch (_) {}
    const heading = String(c.heading || "WEEKLY DRAW").toUpperCase();
    const msg =
      `⏳ ${heading} ends in ${getCampaignCountdown()}!\n\n` +
      `Buy offers to earn more tickets and climb the leaderboard. 🎟🔥`;
    await broadcastToAllUsers(msg);
  }
}

// Near-qualification reminder after 2 days in bot (sent once)
async function maybeSendNearQualifyReminder(chatId) {
  if (!isWeeklyDrawOptedIn(chatId)) return;

  const c = ensureWeeklyDrawObject();
  if (!c.enabled || String(c.status || "").toUpperCase() !== "RUNNING") return;

  const u = getUser(chatId);
  const now = Date.now();
  const createdAt = Number(u.createdAt || u.firstSeen || 0);
  if (!createdAt) return;

  // after 2 days in bot
  if (now - createdAt < 2 * 24 * 60 * 60 * 1000) return;

  c.reminders = c.reminders || {};
  c.reminders.nearQualify = c.reminders.nearQualify || {};
  if (c.reminders.nearQualify[String(chatId)]) return;

  const q = weeklyDrawQualification(chatId);
  const tickets = Number((c.entries || {})[String(chatId)] || 0);

  // Only nudge users who are close:
  // - have 3 active refs OR
  // - have 15+ tickets OR
  // - have 3+ qualifying purchases
  const close =
    q.activeRefs >= 3 ||
    tickets >= 15 ||
    q.purchases20 >= 3;

  if (!close || q.qualified) return;

  c.reminders.nearQualify[String(chatId)] = Date.now();
  try { saveDB(); } catch (_) {}

  const heading = String(c.heading || "WEEKLY DRAW").toUpperCase();
  const msg =
    `🎟 ${heading} qualification tip:\n\n` +
    `You are close! ${weeklyDrawQualificationText(chatId)}\n\n` +
    `Keep going — you can qualify and win this week. 🔥`;
  try { await bot.sendMessage(chatId, msg, mainMenuKeyboard(chatId)); } catch (_) {}
}

// Rank change motivation (only near the end: <=2 days)
async function weeklyDrawRankChangeNotify() {
  // opt-in filtering is handled per-user inside

  const c = ensureWeeklyDrawObject();
  if (!c.enabled || String(c.status || "").toUpperCase() !== "RUNNING") return;

  const days = getCampaignRemainingDays();
  if (days === null || days > 2) return;

  const entries = c.entries && typeof c.entries === "object" ? c.entries : {};
  const list = Object.entries(entries).map(([cid, t]) => ({ chatId: Number(cid), tickets: Number(t || 0) }))
    .filter(x => x.chatId && x.tickets > 0)
    .sort((a, b) => b.tickets - a.tickets);

  const top10 = list.slice(0, 10);
  const newRanks = {};
  top10.forEach((x, i) => { newRanks[String(x.chatId)] = i + 1; });

  c.rankCache = c.rankCache && typeof c.rankCache === "object" ? c.rankCache : {};
  c.reminders = c.reminders || {};
  c.reminders.rankNotifyAt = c.reminders.rankNotifyAt || {};

  const now = Date.now();
  for (const [cid, newRank] of Object.entries(newRanks)) {
    const oldRank = Number(c.rankCache[cid] || 0);
    if (oldRank === 0) continue; // avoid first-time spam
    if (oldRank === newRank) continue;

    const lastAt = Number(c.reminders.rankNotifyAt[cid] || 0);
    if (now - lastAt < 6 * 60 * 60 * 1000) continue; // 6h cooldown

    c.reminders.rankNotifyAt[cid] = now;

    if (newRank < oldRank) {
      // climbed
      const msg =
        `🚀 NICE! You climbed to #${newRank} on WEEKLY DRAW.\n` +
        `⏳ Only ${getCampaignCountdown()} left — buy more to stay on top! 🎟🔥`;
      try { if (isWeeklyDrawOptedIn(Number(cid))) await bot.sendMessage(Number(cid), msg, mainMenuKeyboard(Number(cid))); } catch (_) {}
    } else {
      // dropped (overtaken)
      const msg =
        `⚠️ You were overtaken on WEEKLY DRAW.\n` +
        `You moved from #${oldRank} to #${newRank}.\n\n` +
        `⏳ Only ${getCampaignCountdown()} left — buy more to climb back! 🎟🔥`;
      try { if (isWeeklyDrawOptedIn(Number(cid))) await bot.sendMessage(Number(cid), msg, mainMenuKeyboard(Number(cid))); } catch (_) {}
    }
  }

  // Save new ranks snapshot
  c.rankCache = { ...c.rankCache, ...newRanks };
  try { saveDB(); } catch (_) {}
}

// Auto-clean expired pending STK requests
setInterval(() => { try { cleanExpiredPendingPayments(); } catch (_) {} }, 60 * 1000);

// ===================== DB DAILY BACKUP =====================
let _lastBackupDayKey = "";
function writeDailyBackupIfNeeded() {
  try {
    const day = todayKey();
    if (day === _lastBackupDayKey) return;
    _lastBackupDayKey = day;

    // Ensure latest in-memory db is persisted before writing backup
    try { flushDBSync(); } catch (_) {}
    const fs = require("fs");
    const path = require("path");
    const file = path.join(__dirname, `backup_${day}.json`);
    fs.writeFileSync(file, JSON.stringify(db, null, 2), "utf-8");
    adminNotify(`✅ DB backup saved: backup_${day}.json`);
  } catch (e) {
    adminNotify(`⚠️ DB backup failed: ${String(e?.message || e)}`);
  }
}
// check every hour
setInterval(() => { setTimeout(() => { try { setTimeout(() => { try { writeDailyBackupIfNeeded(); } catch (_) {} }, 15 * 1000); } catch (_) {} }, 10 * 1000); }, 60 * 60 * 1000);
writeDailyBackupIfNeeded();

// ===================== HEALTH CHECK ALERTS =====================
let _payheroFailWindowStart = Date.now();
let _payheroFailCount = 0;
function healthPayheroFail(err) {
  const now = Date.now();
  if (now - _payheroFailWindowStart > 10 * 60 * 1000) {
    _payheroFailWindowStart = now;
    _payheroFailCount = 0;
  }
  _payheroFailCount += 1;
  if (_payheroFailCount >= 5) {
    _payheroFailCount = 0;
    adminNotify(`🚨 PayHero callback errors (>=5 in 10min). Latest: ${String(err?.message || err)}`);
  }
}



// ===== WEEKLY DRAW AUTO-CLOSE (ends campaign automatically when endAt passes) =====
function weeklyDrawAutoCloseTick() {
  try {
    const c = ensureWeeklyDrawObject();
    if (!c.enabled) return;
    if (String(c.status || "OFF") !== "RUNNING") return;
    const endAt = Number(c.endAt || 0);
    if (!endAt) return;
    if (Date.now() > endAt) {
      if (c._autoEndedAt) return;
      c._autoEndedAt = Date.now();
      try { saveDB(); } catch (_) {}
      weeklyDrawFreezeAndAnnounce("⏰ Campaign ended automatically.").catch(() => {});
    }
  } catch (_) {}
}
setInterval(() => { weeklyDrawAutoCloseTick(); }, 60 * 1000);

// ===== WEEKLY DRAW DAILY REMINDER (opted-in users only; once per day) =====
async function weeklyDrawDailyReminderTick() {
  try {
    const c = ensureWeeklyDrawObject();
    if (!c.enabled) return;
    if (String(c.status || "OFF") !== "RUNNING") return;

    const day = todayKey(); // Kenya day key (YYYY-MM-DD)
    db = repairDB(db);

    for (const [cidStr, u] of Object.entries(db.users || {})) {
      const cid = Number(cidStr);
      if (!Number.isFinite(cid)) continue;
      if (!isWeeklyDrawOptedIn(cid)) continue;

      // once per day per user
      if (String(u.lastWDDailyRemindDay || "") === String(day)) continue;

      const rank = weeklyDrawRankInfo(cid); // { rank, totalQualified, qualified, ... }
      const endsIn = msToDHMS(Math.max(0, Number(c.endAt || 0) - Date.now()));
      let msg = `${tr(chatId,"🎉 WEEKLY DRAW","🎉 DROO YA WIKI")} Reminder\n⏳ Ends in: ${endsIn}\n`;

      const r = Number(rank?.rank || 0);
      if (r >= 1 && r <= 3) {
        msg += `\n🎊 You are TOP ${r}! Keep buying to maintain your position.`;
      } else if (r >= 4 && r <= 10) {
        msg += `\n👏 You are close (#${r} in Top 10). Keep buying to reach Top 3.`;
      } else if (rank?.qualified) {
        msg += `\n✅ You are qualified. Keep buying to enter Top 10.`;
      } else {
        msg += `\n⏳ Keep buying to qualify and enter Top 10.`;
      }

      await bot.sendMessage(cid, msg, weeklyDrawUserMenuKeyboard(cid)).catch(() => {});

      u.lastWDDailyRemindDay = day;
    }

    try { saveDB(); } catch (_) {}
  } catch (_) {}
}

// run every 30 minutes (will still send max once/day per user)
setInterval(() => { weeklyDrawDailyReminderTick(); }, 30 * 60 * 1000);





// ===================== DB WRITE (DEBOUNCED) =====================
// Writing db.json on every tiny action can slow down the bot (especially on Render disk).
// We debounce writes to coalesce many saveDB() calls into a single disk write.
// NOTE: DB is still updated in memory immediately; we only delay the filesystem write slightly.
let _saveTimer = null;

function flushDBSync() {
  db = repairDB(db);
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function saveDB() {
  try { db = repairDB(db); } catch (_) {}
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try { flushDBSync(); } catch (e) { console.error("saveDB flush error:", e?.message || e); }
  }, 250);
}

// ===================== USER DATA WIPE (FOR BACKUP+RESET) =====================
function getStoredLang(chatId) {
  try {
    const cid = String(chatId);
    const raw = String(db?.users?.[cid]?.lang || "").trim().toLowerCase();
    return raw === "sw" ? "sw" : "en";
  } catch (_) {
    return "en";
  }
}

function wipeUserData(chatId, options = {}) {
  const cid = String(chatId);
  const preserveLang = options?.preserveLang !== false;
  const keepLang = preserveLang ? getStoredLang(chatId) : "en";

  try {
    // remove user record
    if (db && db.users && typeof db.users === "object") {
      delete db.users[cid];
    }

    // campaign user-scoped
    try { if (db?.campaign?.entries) delete db.campaign.entries[cid]; } catch (_) {}
    try { if (db?.campaign?.spend) delete db.campaign.spend[cid]; } catch (_) {}
    try { if (db?.campaign?.withdrawReq) delete db.campaign.withdrawReq[cid]; } catch (_) {}
    try { if (db?.campaign?.offerCount) delete db.campaign.offerCount[cid]; } catch (_) {}

    // withdraw / redeem
    try { if (db?.pendingRedeems) delete db.pendingRedeems[cid]; } catch (_) {}
    try { if (db?.redeemCooldownByChat) delete db.redeemCooldownByChat[cid]; } catch (_) {}
    try { if (db?.redeemByPhoneDay) delete db.redeemByPhoneDay[cid]; } catch (_) {}

    // user ledger events
    try {
      if (Array.isArray(db?.ledger)) {
        db.ledger = db.ledger.filter(e => String(e?.chatId || "") !== cid);
      }
    } catch (_) {}

    // preserve selected language even after account clear/reset
    try {
      if (preserveLang) {
        if (!db.users || typeof db.users !== "object") db.users = {};
        db.users[cid] = { lang: keepLang };
      }
    } catch (_) {}

    // safety repair + save
    db = repairDB(db);
    saveDB();
    return true;
  } catch (e) {
    console.log("wipeUserData error:", e?.message || e);
    return false;
  }
}
// ============================================================================

// ===================== USER DATA BACKUP / RESTORE =====================
// Export/import a user's OWN data safely. Backup includes:
// - db.users[chatId]
// - db.campaign.entries[chatId] (if present)
// - db.pendingRedeems[chatId] (if present)
// - db.redeemCooldownByChat[chatId] (if present)
function buildUserBackup(chatId) {
  const cid = String(chatId);

  // User-scoped ledger events (withdrawals, orders, points, etc.)
  const ledgerAll = Array.isArray(db?.ledger) ? db.ledger : [];
  const userLedger = ledgerAll.filter(e => String(e?.chatId || "") === cid);

  return {
    version: 3,
    createdAt: Date.now(),
    chatId: cid,

    // Core user record (balances, settings, referral fields, business plan, withdrawStats, etc.)
    user: db?.users?.[cid] || {},

    // Campaign / weekly draw user-scoped data
    campaignEntry: db?.campaign?.entries?.[cid] || null,
    campaignSpend: (db?.campaign?.spend && typeof db.campaign.spend === "object") ? Number(db.campaign.spend[cid] || 0) : 0,
    campaignWithdrawReq: (db?.campaign?.withdrawReq && typeof db.campaign.withdrawReq === "object") ? Number(db.campaign.withdrawReq[cid] || 0) : 0,
    campaignOfferCount: (db?.campaign?.offerCount && typeof db.campaign.offerCount === "object") ? (db.campaign.offerCount[cid] || null) : null,

    // Withdraw system
    pendingRedeem: db?.pendingRedeems?.[cid] || null,
    redeemCooldown: db?.redeemCooldownByChat?.[cid] || null,
    redeemByPhoneDay: db?.redeemByPhoneDay?.[cid] || null,

    // User-scoped history
    ledger: userLedger
  };
}

function sha256Hex(bufOrStr) {
  try {
    return crypto.createHash("sha256").update(bufOrStr).digest("hex");
  } catch (_) {
    return "";
  }
}

function kenyaBackupStamp(ts = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Nairobi",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(new Date(ts));

    const get = (type) => String((parts.find((p) => p.type === type) || {}).value || "");
    const day = get("day");
    const month = get("month");
    const year = get("year");
    const hour = get("hour");
    const minute = get("minute");
    const period = get("dayPeriod").toUpperCase();
    return `${day}${month}${year}${hour}${minute}${period}`;
  } catch (_) {
    const d = new Date(ts);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = String(d.getFullYear());
    let hh = d.getHours();
    const ampm = hh >= 12 ? "PM" : "AM";
    hh = hh % 12 || 12;
    const h2 = String(hh).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${dd}${mm}${yyyy}${h2}${mi}${ampm}`;
  }
}

function randomUpperToken(len) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < Number(len || 0); i++) {
    const idx = crypto.randomInt(0, chars.length);
    out += chars[idx];
  }
  return out;
}

const BACKUP_KEY_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function generateBackupKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  function block(len) {
    let out = "";
    for (let i = 0; i < len; i++) {
      out += chars[crypto.randomInt(0, chars.length)];
    }
    return out;
  }

  return `BINGWA-${block(4)}-${block(4)}-${block(4)}-${block(4)}-${block(4)}-${block(4)}`;
}

function hashBackupKey(key) {
  return crypto
    .createHash("sha256")
    .update(String(key || "").trim().toUpperCase())
    .digest("hex");
}

function backupKeyInfo(rawKey) {
  db = repairDB(db);
  const keyHash = hashBackupKey(rawKey);
  return db.backupVault?.[keyHash] || null;
}

function isBackupAlreadyUsed(backupKey) {
  try {
    const rec = backupKeyInfo(backupKey);
    return !!(rec && rec.usedAt);
  } catch (_) {
    return false;
  }
}

function isBackupExpired(rec) {
  if (!rec || !rec.createdAt) return true;
  return (Date.now() - Number(rec.createdAt || 0)) > BACKUP_KEY_EXPIRE_MS;
}

function markBackupUsed(backupKey, restoredByChatId) {
  try {
    db = repairDB(db);
    const keyHash = hashBackupKey(backupKey);
    if (!keyHash || !db.backupVault?.[keyHash]) return;
    db.backupVault[keyHash].usedAt = Date.now();
    db.backupVault[keyHash].restoredByChatId = String(restoredByChatId || "");
    db.usedBackupIds[keyHash] = Date.now();
    saveDB();
  } catch (_) {}
}

function createServerBackupKey(chatId) {
  db = repairDB(db);
  db.backupVault = db.backupVault && typeof db.backupVault === "object" ? db.backupVault : {};

  let key = "";
  let keyHash = "";
  for (let i = 0; i < 5; i++) {
    key = generateBackupKey();
    keyHash = hashBackupKey(key);
    if (!db.backupVault[keyHash]) break;
  }
  if (!key || !keyHash) throw new Error("Failed to generate backup key.");

  const payload = buildUserBackup(chatId);
  db.backupVault[keyHash] = {
    ownerChatId: String(chatId),
    createdAt: Date.now(),
    usedAt: 0,
    restoredByChatId: "",
    payload,
  };
  saveDB();
  return { key, payload };
}

function cleanupExpiredBackups() {
  db = repairDB(db);
  db.backupVault = db.backupVault && typeof db.backupVault === "object" ? db.backupVault : {};
  const now = Date.now();
  for (const [keyHash, rec] of Object.entries(db.backupVault || {})) {
    if (!rec || (now - Number(rec.createdAt || 0)) > BACKUP_KEY_EXPIRE_MS) {
      delete db.backupVault[keyHash];
    }
  }
  saveDB();
}

function applyUserBackup(chatId, payload) {
  const cid = String(chatId);

  if (!payload || typeof payload !== "object") throw new Error("Invalid backup payload");

  // Never reset the user's chosen language during restore.
  const keepLang = getStoredLang(chatId);

  if (!db.users || typeof db.users !== "object") db.users = {};
  const restoredUser = payload.user && typeof payload.user === "object" ? { ...payload.user } : {};
  restoredUser.lang = keepLang;
  db.users[cid] = restoredUser;

  // Restore campaign user-scoped maps (if present in backup)
  if (payload.campaignEntry !== undefined) {
    if (!db.campaign || typeof db.campaign !== "object") db.campaign = { enabled: false, status: "OFF" };
    if (!db.campaign.entries || typeof db.campaign.entries !== "object") db.campaign.entries = {};
    if (payload.campaignEntry === null) delete db.campaign.entries[cid];
    else db.campaign.entries[cid] = payload.campaignEntry;
  }

  if (payload.campaignSpend !== undefined) {
    if (!db.campaign || typeof db.campaign !== "object") db.campaign = { enabled: false, status: "OFF" };
    if (!db.campaign.spend || typeof db.campaign.spend !== "object") db.campaign.spend = {};
    const v = Number(payload.campaignSpend || 0);
    if (v <= 0) delete db.campaign.spend[cid];
    else db.campaign.spend[cid] = v;
  }

  if (payload.campaignWithdrawReq !== undefined) {
    if (!db.campaign || typeof db.campaign !== "object") db.campaign = { enabled: false, status: "OFF" };
    if (!db.campaign.withdrawReq || typeof db.campaign.withdrawReq !== "object") db.campaign.withdrawReq = {};
    const v = Number(payload.campaignWithdrawReq || 0);
    if (v <= 0) delete db.campaign.withdrawReq[cid];
    else db.campaign.withdrawReq[cid] = v;
  }

  if (payload.campaignOfferCount !== undefined) {
    if (!db.campaign || typeof db.campaign !== "object") db.campaign = { enabled: false, status: "OFF" };
    if (!db.campaign.offerCount || typeof db.campaign.offerCount !== "object") db.campaign.offerCount = {};
    if (payload.campaignOfferCount === null) delete db.campaign.offerCount[cid];
    else db.campaign.offerCount[cid] = payload.campaignOfferCount;
  }

  // Restore withdraw pending + cooldowns
  if (payload.pendingRedeem !== undefined) {
    if (!db.pendingRedeems || typeof db.pendingRedeems !== "object") db.pendingRedeems = {};
    if (payload.pendingRedeem === null) delete db.pendingRedeems[cid];
    else db.pendingRedeems[cid] = payload.pendingRedeem;
  }

  if (payload.redeemCooldown !== undefined) {
    if (!db.redeemCooldownByChat || typeof db.redeemCooldownByChat !== "object") db.redeemCooldownByChat = {};
    if (payload.redeemCooldown === null) delete db.redeemCooldownByChat[cid];
    else db.redeemCooldownByChat[cid] = payload.redeemCooldown;
  }

  if (payload.redeemByPhoneDay !== undefined) {
    if (!db.redeemByPhoneDay || typeof db.redeemByPhoneDay !== "object") db.redeemByPhoneDay = {};
    if (payload.redeemByPhoneDay === null) delete db.redeemByPhoneDay[cid];
    else db.redeemByPhoneDay[cid] = payload.redeemByPhoneDay;
  }

  // Restore user-scoped ledger events (withdraw history / purchases / points)
  if (payload.ledger !== undefined) {
    if (!Array.isArray(db.ledger)) db.ledger = [];
    const keep = db.ledger.filter(e => String(e?.chatId || "") !== cid);
    const add = Array.isArray(payload.ledger) ? payload.ledger : [];
    db.ledger = keep.concat(add);

    if (db.ledger.length > 20000) db.ledger = db.ledger.slice(-20000);
  }

  db = repairDB(db);
  saveDB();
}

function backupUniqueKey(payloadObj) {
  try {
    const stable = JSON.stringify(payloadObj || {});
    const h = crypto.createHash("sha256").update(stable).digest("hex");
    return "sha:" + h;
  } catch (_) {
    return "";
  }
}

// Legacy Telegram backup-file download helpers kept for compatibility
function tgHttpGetBuffer(url) {
  const https = require("https");
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

async function tgDownloadFileBuffer(fileId) {
  const https = require("https");
  const token = (db && typeof db.botToken === "string" && db.botToken.trim())
    ? db.botToken.trim()
    : String(process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || "").trim();
  if (!token) throw new Error("Telegram bot token missing (set via /settoken or TELEGRAM_TOKEN env)");

  const api = `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const meta = await new Promise((resolve, reject) => {
    https.get(api, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!j.ok) return reject(new Error("getFile failed"));
          resolve(j.result);
        } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });

  const filePath = meta.file_path;
  if (!filePath) throw new Error("file_path missing");
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  return await tgHttpGetBuffer(url);
}

function getUser(chatId) {
  const cid = String(chatId);
  db = repairDB(db);
  if (!db.users[cid]) {
    db.users[cid] = {
      phone: "",
      lang: "en",
      antiSpam: { lastAt: 0, lastSig: "" },
      lastSeen: 0,
      purchasesByDay: {},
      weeklyPurchases: {},
      redeemUnlockStart: 0,
      redeemUnlockPurchases: 0,
      redeemedCounts: {},
      inviterId: "",
      inviterSetAt: 0,
      lastReferralRewardDay: "",
      points: 0,
      totalSpentKsh: 0,
      referralSuccessCount: 0,
      referralCounted: false,
      pendingAction: null,

      // ✅ Admin moderation
      banned: false,

      // user preference: auto-delete bot messages delay (ms)
      autoDeleteMs: 24 * 60 * 60 * 1000,

      // ✅ Account types
      accountType: "normal", // normal | business
      subscriptionStart: 0,
      subscriptionExpiry: 0,

      // ✅ Business notifications
      businessIntroShown: false,        // show benefits intro only once ever
      businessReminderLastDay: "",      // YYYY-MM-DD (Kenya) last 3-day reminder sent
      businessExpiredNotifiedAt: 0,     // last expiry timestamp we already notified for

      // ✅ Profile (for leaderboards / display)
      profile: { firstName: "", lastName: "", username: "" },
      profileUpdatedAt: 0,
      createdAt: Date.now(),
      firstSeen: Date.now(),
      isAdult: false,
      qPurch20Count: 0,
    
      // ⚡ Fast Purchase (Business)
      fastPurchaseEnabled: false,


      // 🔁 Auto Retry STK (Business)
      autoRetryStkEnabled: false,

      // 🔕 Notification preferences (Business)
      stopCampaignNotifs: false,
      stopCashbackNotifs: false,
      stopReferralNotifs: false,

      // 🗑️ Auto delete toggle (Business)
      autoDelete24hEnabled: true,

      // 🧩 UI preference: hide quick actions row
      hideQuickActionsEnabled: false,
      // 🔒 UI preference: hide reply-keyboard buttons (except Help)
      // When ON: only Help button is shown; other button texts + inline actions are blocked.
      autoHideButtonsEnabled: false,
};
  }
  if (db.users[cid].pendingAction === undefined) db.users[cid].pendingAction = null;
  if (db.users[cid].banned === undefined) db.users[cid].banned = false;
  if (db.users[cid].autoDeleteMs === undefined) db.users[cid].autoDeleteMs = 24 * 60 * 60 * 1000;
  if (db.users[cid].autoHideButtonsEnabled === undefined) db.users[cid].autoHideButtonsEnabled = false;
  if (db.users[cid].lang === undefined) db.users[cid].lang = "en";


  if (db.users[cid].autoRetryStkEnabled === undefined) db.users[cid].autoRetryStkEnabled = false;
  if (db.users[cid].stopCampaignNotifs === undefined) db.users[cid].stopCampaignNotifs = false;
  if (db.users[cid].stopCashbackNotifs === undefined) db.users[cid].stopCashbackNotifs = false;
  if (db.users[cid].stopReferralNotifs === undefined) db.users[cid].stopReferralNotifs = false;
  if (db.users[cid].autoDelete24hEnabled === undefined) db.users[cid].autoDelete24hEnabled = (db.users[cid].autoDeleteMs ? true : false);
  if (db.users[cid].hideQuickActionsEnabled === undefined) db.users[cid].hideQuickActionsEnabled = false;
  if (!db.users[cid].profile || typeof db.users[cid].profile !== "object") db.users[cid].profile = { firstName: "", lastName: "", username: "" };
  if (typeof db.users[cid].profileUpdatedAt !== "number") db.users[cid].profileUpdatedAt = 0;
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


// ===================== BUSINESS SUBSCRIPTION HELPERS =====================
function isBusinessActive(chatId) {
  const u = getUser(chatId);
  if (u.accountType !== "business") return false;
  if (!u.subscriptionExpiry) return false;

  if (Date.now() > u.subscriptionExpiry) {
    // Auto-revert on expiry
    u.accountType = "normal";
    u.subscriptionStart = 0;
    u.subscriptionExpiry = 0;
    // Auto-disable Fast Purchase on expiry
    try { u.fastPurchaseEnabled = false; } catch (_) {}
    saveDB();
    return false;}
  return true;
}

function activateBusiness(chatId, planKey, plan) {
  const u = getUser(chatId);
  const now = Date.now();

  const days = Number(plan?.days || 0);
  const months = Number(plan?.months || 0);

  // weekly plans use exact days; monthly uses 30-day month approximation (keeps your old behavior)
  const durationMs =
    days > 0 ? days * 24 * 60 * 60 * 1000 : months * 30 * 24 * 60 * 60 * 1000;

  u.accountType = "business";
  activateBusinessFeatures(u);
  u.subscriptionStart = now;
  u.subscriptionExpiry = now + durationMs;

  // track the active plan (for marking / deactivation UX)
  u.businessPlanKey = String(planKey || "");
  u.businessPlanLabel = String(plan?.label || "");

  // Do NOT reset businessIntroShown (announcement should show only once ever)
  saveDB();
}

function deactivateBusiness(chatId) {
  const u = getUser(chatId);
  u.accountType = "normal";
  u.subscriptionStart = 0;
  u.subscriptionExpiry = 0;
  u.businessPlanKey = "";
  u.businessPlanLabel = "";
  disableBusinessFeatures(u);
  saveDB();
}


async function maybeShowBusinessIntroOnce(chatId) {
  const u = getUser(chatId);
  if (!isBusinessActive(chatId)) return;
  if (u.businessIntroShown) return;

  u.businessIntroShown = true;
  saveDB();

  await sendTracked(
    chatId,
    `✅ *Business Account Activated!*\n\n` +
      `🚀 Benefits unlocked for your subscription period:\n` +
      `• Unlimited referrals\n` +
      `• Unlimited rewards\n` +
      `• Unlimited number usage\n` +
      `• All limits bypassed (except Bingwa daily rule)\n\n` +
      `⚠️ Self-referral is not allowed.`,
    { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
  );
}



// ===================== ADMIN: GIVE FREE 10 DAYS BUSINESS =====================
async function giveFreeBusinessDays(targetChatId, days = 10) {
  try {
    const u = getUser(targetChatId);
    const now = Date.now();
    const durationMs = Number(days || 0) * 24 * 60 * 60 * 1000;

    // If already business and active → extend from current expiry
    if (u.accountType === "business" && Number(u.subscriptionExpiry || 0) > now) {
      u.subscriptionExpiry = Number(u.subscriptionExpiry || now) + durationMs;
    } else {
      u.accountType = "business";
            activateBusinessFeatures(u);
u.subscriptionStart = now;
      u.subscriptionExpiry = now + durationMs;
    }

    saveDB();

    const expiryStr = kenyaDateTimeFromTs(u.subscriptionExpiry);

    // Notify user
    await bot.sendMessage(
      targetChatId,
      `🎁 *FREE Business Activated!*

` +
        `You have received *${days} FREE day${Number(days) === 1 ? "" : "s"}* of Business account.

` +
        `⏳ Expiry: \`${mdEscape(expiryStr)}\`

` +
        `Enjoy unlimited benefits 🚀`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(targetChatId) }
    ).catch(() => {});

    // Notify admin
    adminNotify(`🎁 FREE Business given
User: ${targetChatId}
Days: ${days}`);

    return true;
  } catch (err) {
    console.log("giveFreeBusinessDays error:", err?.message || err);
    return false;
  }
}
// ✅ Business subscription reminders:
// - 3 days to expiry: remind once per day
// - On expiry: notify once, then revert to normal
async function runBusinessSubscriptionNotifier() {
  try {
    db = repairDB(db);
    const nowMs = Date.now();
    const today = todayKey(); // Kenya date key

    for (const [cid, u] of Object.entries(db.users || {})) {
      if (!u || !u.subscriptionExpiry) continue;

      // Expired case (still marked business)
      if (u.accountType === "business" && nowMs > u.subscriptionExpiry) {
        if (u.businessExpiredNotifiedAt !== u.subscriptionExpiry) {
          u.businessExpiredNotifiedAt = u.subscriptionExpiry;

          const expStr = kenyaDateTimeFromTs(u.subscriptionExpiry);

          // Revert immediately
          u.accountType = "normal";
              disableBusinessFeatures(u || user);
u.subscriptionStart = 0;
          u.subscriptionExpiry = 0;

          saveDB();

          await sendTracked(
            cid,
            `❌ *Business Subscription Expired*

` +
              `Your Business account expired on \`${mdEscape(expStr)}\`.

` +
              `To renew, type /sell`,
            { parse_mode: "Markdown", ...mainMenuKeyboard(cid) }
          );
        }
        continue;
      }

      // Active: remind when <= 3 days left (once per day)
      if (u.accountType === "business" && nowMs <= u.subscriptionExpiry) {
        const msLeft = u.subscriptionExpiry - nowMs;
        const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));

        if (daysLeft >= 1 && daysLeft <= 3) {
          if (u.businessReminderLastDay !== today) {
            u.businessReminderLastDay = today;
            saveDB();

            const expStr = kenyaDateTimeFromTs(u.subscriptionExpiry);

            await sendTracked(
              cid,
              `⏳ *Business Subscription Reminder*

` +
                `Your Business account will expire in *${daysLeft} day${daysLeft === 1 ? "" : "s"}*.
` +
                `Expiry: \`${mdEscape(expStr)}\`

` +
                `✅ Benefits until expiry:
` +
                `• Unlimited referrals
` +
                `• Unlimited rewards
` +
                `• Unlimited number usage

` +
                `To renew, type /sell`,
              { parse_mode: "Markdown", ...mainMenuKeyboard(cid) }
            );
          }
        }
      }
    }
  } catch (_) {}
}

function countBusinessSubscribers({ activeOnly = true } = {}) {
  db = repairDB(db);
  const now = Date.now();
  let n = 0;
  for (const cid of Object.keys(db.users || {})) {
    const u = db.users[cid];
    if (!u) continue;
    if (activeOnly) {
      if (u.accountType === "business" && Number(u.subscriptionExpiry || 0) > now) n++;
    } else {
      if (Number(u.subscriptionStart || 0) > 0 || u.accountType === "business") n++;
    }
  }
  return n;
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

  // ✅ Redeem unlock tracking (rolling 14-day window)
  bumpRedeemUnlockPurchase(chatId);
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


// ===================== REVENUE ANALYTICS =====================
// ✅ Records revenue ONLY on SUCCESS PayHero callback (idempotent via processedPayments)
function round2(n) {
  const x = Number(n || 0);
  return Math.round(x * 100) / 100;
}

function bumpBucket(map, key, amountKsh) {
  map[key] = map[key] || { revenueKsh: 0, orders: 0 };
  map[key].revenueKsh = round2(Number(map[key].revenueKsh || 0) + Number(amountKsh || 0));
  map[key].orders = Number(map[key].orders || 0) + 1;
}

function recordSuccessfulRevenue(pending) {
  // pending: { category, pkgLabel, price, ... } from pendingPayments store
  if (!pending) return;
  const amount = Number(pending.price || 0);
  if (!Number.isFinite(amount) || amount <= 0) return;

  db = repairDB(db);

  const day = todayKey(); // Kenya day key
  const wk = isoWeekKey(new Date());

  if (!db.analytics || typeof db.analytics !== "object") db.analytics = {};
  if (!db.analytics.revenueByDay) db.analytics.revenueByDay = {};
  if (!db.analytics.revenueByWeek) db.analytics.revenueByWeek = {};
  if (!db.analytics.revenueByCategoryDay) db.analytics.revenueByCategoryDay = {};
  if (!db.analytics.revenueByPackageDay) db.analytics.revenueByPackageDay = {};

  // totals
  bumpBucket(db.analytics.revenueByDay, day, amount);
  bumpBucket(db.analytics.revenueByWeek, wk, amount);

  // by category (per day)
  db.analytics.revenueByCategoryDay[day] = db.analytics.revenueByCategoryDay[day] || {};
  bumpBucket(db.analytics.revenueByCategoryDay[day], String(pending.category || "Unknown"), amount);

  // by package (per day)
  db.analytics.revenueByPackageDay[day] = db.analytics.revenueByPackageDay[day] || {};
  bumpBucket(db.analytics.revenueByPackageDay[day], String(pending.pkgLabel || "Unknown"), amount);

  saveDB();
}


function recordSuccessfulTransaction(pending, externalRef, providerRef, when) {
  // Stores per-transaction details for CSV export/audit.
  if (!pending) return;

  db = repairDB(db);
  if (!db.analytics || typeof db.analytics !== "object") db.analytics = {};
  if (!db.analytics.transactionsByDay || typeof db.analytics.transactionsByDay !== "object") db.analytics.transactionsByDay = {};

  const day = todayKey(); // Kenya day key

  const entry = {
    time: String(when || kenyaDateTime()),
    chatId: Number(pending.chatId || 0),
    category: String(pending.category || ""),
    pkgLabel: String(pending.pkgLabel || ""),
    amount: Number(pending.price || 0),
    phone254: String(pending.phone254 || ""),
    reference: String(externalRef || ""),
    provider_reference: String(providerRef || ""),
  };

  db.analytics.transactionsByDay[day] = db.analytics.transactionsByDay[day] || [];
  db.analytics.transactionsByDay[day].push(entry);

  // avoid runaway growth per day
  if (db.analytics.transactionsByDay[day].length > 5000) {
    db.analytics.transactionsByDay[day] = db.analytics.transactionsByDay[day].slice(-5000);
  }

  saveDB();
}

function sumDaysRevenue(daysBackInclusive) {
  // daysBackInclusive: 0 => today only; 7 => last 7 days INCLUDING today (window size = daysBackInclusive+1)
  db = repairDB(db);

  const out = { revenueKsh: 0, orders: 0, byCategory: {}, byPackage: {} };

  for (let i = 0; i <= daysBackInclusive; i++) {
    const day = kenyaDayKeyOffset(i);

    const dTot = db.analytics?.revenueByDay?.[day];
    if (dTot) {
      out.revenueKsh += Number(dTot.revenueKsh || 0);
      out.orders += Number(dTot.orders || 0);
    }

    const cat = db.analytics?.revenueByCategoryDay?.[day] || {};
    for (const [k, v] of Object.entries(cat)) {
      out.byCategory[k] = out.byCategory[k] || { revenueKsh: 0, orders: 0 };
      out.byCategory[k].revenueKsh += Number(v.revenueKsh || 0);
      out.byCategory[k].orders += Number(v.orders || 0);
    }

    const pkg = db.analytics?.revenueByPackageDay?.[day] || {};
    for (const [k, v] of Object.entries(pkg)) {
      out.byPackage[k] = out.byPackage[k] || { revenueKsh: 0, orders: 0 };
      out.byPackage[k].revenueKsh += Number(v.revenueKsh || 0);
      out.byPackage[k].orders += Number(v.orders || 0);
    }
  }

  out.revenueKsh = round2(out.revenueKsh);
  return out;
}

function formatBuckets(title, obj, limit = 8) {
  const rows = Object.entries(obj || {})
    .map(([k, v]) => ({ k, revenueKsh: round2(v.revenueKsh), orders: Number(v.orders || 0) }))
    .sort((a, b) => b.revenueKsh - a.revenueKsh)
    .slice(0, limit);

  if (!rows.length) return `${title}\n• (none)`;

  return `${title}\n` + rows.map((r) => `• ${r.k} — Ksh ${r.revenueKsh} (${r.orders} orders)`).join("\\n");
}

// ===================== CSV EXPORT (ADMIN) =====================
function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildRevenueExportRows(days) {
  db = repairDB(db);
  const rows = [];
  rows.push(["date", "type", "key", "orders", "revenue_ksh", "provider_reference"]);

  for (let i = days - 1; i >= 0; i--) {
    const day = kenyaDayKeyOffset(i);

    const tot = db.analytics?.revenueByDay?.[day] || { orders: 0, revenueKsh: 0 };
    rows.push([day, "TOTAL", "ALL", Number(tot.orders || 0), Number(tot.revenueKsh || 0), ""]);

    const byCat = db.analytics?.revenueByCategoryDay?.[day] || {};
    for (const [cat, v] of Object.entries(byCat)) {
      rows.push([day, "CATEGORY", cat, Number(v.orders || 0), Number(v.revenueKsh || 0), ""]);
    }

    const byPkg = db.analytics?.revenueByPackageDay?.[day] || {};
    for (const [pkg, v] of Object.entries(byPkg)) {
      rows.push([day, "PACKAGE", pkg, Number(v.orders || 0), Number(v.revenueKsh || 0), ""]);
    }

// ✅ Per-transaction rows (includes Provider Reference)
const txs = db.analytics?.transactionsByDay?.[day] || [];
for (const t of txs) {
  rows.push([
    day,
    "PAYMENT",
    String(t.reference || ""),
    1,
    Number(t.amount || 0),
    String(t.provider_reference || ""),
  ]);
}
  }

  return rows;
}

function writeRevenueCsvFile(days) {
  const safeDays = Math.max(1, Math.min(365, Number(days || 30)));
  const rows = buildRevenueExportRows(safeDays);
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\\n") + "\n";

  const filename = `revenue_export_${todayKey()}_last${safeDays}d.csv`;
  const filepath = path.join(__dirname, filename);

  fs.writeFileSync(filepath, csv, "utf8");
  return { filepath, filename, days: safeDays, rowCount: rows.length - 1 };
}


// ✅ Earn points only on SUCCESS purchase (as requested)
// ❌ Purchase points disabled
// Only referral bonus (2%) is allowed
function awardSuccessPurchasePoints(chatId, pending) {
  // ✅ Tiered cashback points on SUCCESS purchase (Kenya Shillings -> points)
  // 1–10: 1.2% | 11–150: 1.45% | 151–500: 1.7% | 501–1000: 1.9% | 1001–10000: 2%
  if (!pending) return;

  const amount = Number(pending.price || 0);
  if (!Number.isFinite(amount) || amount <= 0) return;
  // Flat cashback: Normal 1.5% on all purchases, Business 3% on all purchases
  let percent = 0.015;
  try {
    if (isBusinessActive(chatId)) percent = 0.03;
  } catch(_) {}
  const cashbackPts = amount * percent;

  if (!Number.isFinite(cashbackPts) || cashbackPts <= 0) return;


// ✅ Cashback limit: Normal users get cashback for only 2 purchases/day. Business users = unlimited.
try {
  const u = getUser(chatId);
  const today = kenyaDateNow ? kenyaDateNow() : (new Date().toISOString().slice(0, 10));
  if (!u.dailyCashback) u.dailyCashback = { date: today, count: 0 };
  if (u.dailyCashback.date !== today) {
    u.dailyCashback.date = today;
    u.dailyCashback.count = 0;
  }

  const business = isBusinessActive(chatId);

  if (!business && Number(u.dailyCashback.count || 0) >= 2) {
    // reached daily cap -> skip cashback silently
    return;
  }

  // count this cashback award
  u.dailyCashback.count = Number(u.dailyCashback.count || 0) + 1;
  saveDB();
} catch (_) {}

  // addPoints() is centi-points safe later in the file
  addPoints(chatId, cashbackPts);

  // Notify user (non-blocking)
  try {
    if (!isStopCashbackNotifs(chatId)) bot.sendMessage(
      chatId,
      `🎁 Cashback Earned!

Purchase: Ksh ${amount}
Reward: ${cashbackPts.toFixed(2)} pts`,
      { ...mainMenuKeyboard(chatId) }
    ).catch(() => {});
  } catch (_) {}
}

// ===================== REDEEM REQUESTS (ADMIN APPROVAL) =====================
function hasPendingRedeem(chatId) {
  // ✅ Admin bypasses ALL limitations
  if (isAdmin(chatId)) return false;
  db = repairDB(db);
  const r = db.pendingRedeems[String(chatId)];
  return r && r.status === "pending";
}
function setPendingRedeem(chatId, obj) {
  db = repairDB(db);
  db.pendingRedeems[String(chatId)] = obj;
  saveDB();
}
function getPendingRedeem(chatId) {
  db = repairDB(db);
  return db.pendingRedeems[String(chatId)] || null;
}
function clearPendingRedeem(chatId) {
  db = repairDB(db);
  delete db.pendingRedeems[String(chatId)];
  saveDB();
}

// ✅ Redeem cooldown (5 minutes after admin decision)
function redeemCooldownRemainingMs(chatId) {
  // ✅ Admin bypasses ALL limitations
  if (isAdmin(chatId)) return 0;
  db = repairDB(db);
  const until = Number(db.redeemCooldownByChat?.[String(chatId)] || 0);
  const rem = until - Date.now();
  return rem > 0 ? rem : 0;
}
function setRedeemCooldown(chatId, ms) {
  db = repairDB(db);
  if (!db.redeemCooldownByChat || typeof db.redeemCooldownByChat !== "object") db.redeemCooldownByChat = {};
  db.redeemCooldownByChat[String(chatId)] = Date.now() + Number(ms || 0);
  saveDB();
}

// ✅ One redeem per day per PHONE NUMBER (ONLY for 250MB item)
function redeemPhoneAlreadyUsedToday(phone254) {
  if (!phone254) return false;
  db = repairDB(db);
  const day = todayKey();
  const map = db.redeemByPhoneDay?.[day] || {};
  return !!map[String(phone254)];
}
function markRedeemPhoneUsedToday(phone254) {
  if (!phone254) return;
  db = repairDB(db);
  const day = todayKey();
  if (!db.redeemByPhoneDay || typeof db.redeemByPhoneDay !== "object") db.redeemByPhoneDay = {};
  db.redeemByPhoneDay[day] = db.redeemByPhoneDay[day] || {};
  db.redeemByPhoneDay[day][String(phone254)] = 1;
  saveDB();
}

// Mask phone for user-facing messages: 0707xxx636
function mask07(phone07) {
  const p = String(phone07 || "");
  if (/^0\d{9}$/.test(p)) return p.slice(0, 4) + "xxx" + p.slice(-3);
  return p;
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

// db is loaded above (do not reset here)

bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// PATCH: auto-translate outgoing text for ALL bot messages/edits (based on user language)
try {
  const _sendMessage = bot.sendMessage.bind(bot);
  bot.sendMessage = (chatId, text, options = {}) => {
    const opt = options || {};
    if (opt.reply_markup) opt.reply_markup = translateReplyMarkup(chatId, opt.reply_markup);
    return _sendMessage(chatId, translateOutgoing(chatId, text), opt);
  };

  const _editMessageText = bot.editMessageText.bind(bot);
  bot.editMessageText = (text, options = {}) => {
    const cid = options && (options.chat_id || (options.chatId));
        const opt = options || {};
    if (cid && opt.reply_markup) opt.reply_markup = translateReplyMarkup(cid, opt.reply_markup);
    return _editMessageText(translateOutgoing(cid, text), opt);
  };

  const _answerCallbackQuery = bot.answerCallbackQuery.bind(bot);
  bot.answerCallbackQuery = (callbackQueryId, options = {}) => {
    try {
      if (options && typeof options.text === "string" && options.__chatIdForLang) {
        options.text = translateOutgoing(options.__chatIdForLang, options.text);
        delete options.__chatIdForLang;
      }
    } catch (_) {}
    return _answerCallbackQuery(callbackQueryId, options);
  };
} catch (_) {}



// ===================== ADMIN: Set Telegram Bot Token =====================
// Usage (admin only): /settoken <your_bot_token>
// Saves into db.json as db.botToken and restarts the process (Render will restart the service).
bot.onText(/\/settoken\s+(.+)/i, async (msg, match) => {
  const chatId = msg?.chat?.id;
  if (!chatId) return;

  if (Number(chatId) !== Number(ADMIN_ID)) {
    return bot.sendMessage(chatId, "❌ Only admin can set the bot token.").catch(() => {});
  }

  const token = String(match?.[1] || "").trim();
  if (token.length < 20 || !token.includes(":")) {
    return bot.sendMessage(chatId, "❌ Invalid token format. Example: 123456:ABC...").catch(() => {});
  }

  try {
    db = repairDB(db);
    db.botToken = token;
    // Persist immediately
    try { flushDBSync(); } catch (_) { try { saveDB(); } catch (_) {} }

    await bot.sendMessage(chatId, "✅ Token saved to db.json. Restarting now…").catch(() => {});
  } catch (e) {
    console.log("/settoken error:", e?.message || e);
    return bot.sendMessage(chatId, "❌ Failed to save token. Check logs.").catch(() => {});
  }

  // Give Telegram a moment to deliver the confirmation message then restart
  setTimeout(() => process.exit(0), 800);
});


/* ===================== FORCE JOIN CHANNEL ===================== */
const FORCE_JOIN_CHANNEL = "@bingwadata";
const FORCE_JOIN_URL = "https://t.me/Bingwadatabot";
const WEEKLY_DRAW_DEEPLINK = "https://t.me/Bingwadatabot?start=weeklydraw";
const WD_BROADCAST_JOIN_KB = { reply_markup: { inline_keyboard: [[{ text: "🎉 Open Weekly Draw", url: WEEKLY_DRAW_DEEPLINK }]] } };

async function ensureJoinedChannel(chatId) {
  try {
    const m = await bot.getChatMember(FORCE_JOIN_CHANNEL, chatId);
    const s = m?.status;
    return (s === "member" || s === "administrator" || s === "creator");
  } catch (e) {
    return false;
  }
}

async function sendJoinGate(chatId) {
  try { await deleteLastJoinGate(chatId); } catch (_) {}

  const sent = await bot.sendMessage(chatId,
    "🔒 To use this bot, you must join our official channel first:",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Join Channel", url: FORCE_JOIN_URL }],
          [{ text: "🔄 I Joined", callback_data: "forcejoin:check" }]
        ]
      }
    }
  ).catch(() => null);

  try { if (sent && sent.message_id) setLastJoinGateMsgId(chatId, sent.message_id); } catch (_) {}
}



function setLastJoinGateMsgId(chatId, msgId) {
  try {
    const u = getUser(chatId);
    u.lastJoinGateMsgId = Number(msgId || 0);
    saveDB();
  } catch (_) {}
}

async function deleteLastJoinGate(chatId) {
  try {
    const u = getUser(chatId);
    const mid = Number(u.lastJoinGateMsgId || 0);
    if (mid) {
      await bot.deleteMessage(chatId, mid).catch(() => {});
      u.lastJoinGateMsgId = 0;
      saveDB();
    }
  } catch (_) {}
}

/* =============================================================== */



// ===================== AUTO-DELETE BOT MESSAGES (5 minutes) =====================


function parseDurationToMs(input) {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return null;

  // allow formats: 10s, 10sec, 10secs, 10m, 10min, 10mins, 1h, 24hr, 24hrs
  const m = s.match(/^([0-9]+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i);
  if (!m) return null;

  const n = Math.floor(Number(m[1]));
  if (!Number.isFinite(n) || n <= 0) return null;

  const unit = m[2].toLowerCase();
  let ms = 0;
  if (unit.startsWith("s")) ms = n * 1000;
  else if (unit.startsWith("m")) ms = n * 60 * 1000;
  else ms = n * 60 * 60 * 1000;

  const max = 24 * 60 * 60 * 1000; // 24h max
  if (ms > max) ms = max;
  if (ms < 1000) ms = 1000;
  return ms;
}

function formatMsShort(ms) {
  const n = Math.max(0, Number(ms || 0));
  if (!Number.isFinite(n) || n <= 0) return "off";
  const s = Math.round(n / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}min`;
  const h = Math.round(m / 60);
  return `${h}hr`;
}

function getAutoDeleteMsForChat(chatId) {
  try {
    const u = getUser(chatId);
    const max = 24 * 60 * 60 * 1000;

    // Default: OFF unless enabled (Business setting "Auto delete messages (24hrs)")
    if (!u || !u.autoDelete24hEnabled) {
      const ms = Number(u && u.autoDeleteMs);
      if (!Number.isFinite(ms) || ms <= 0) return 0;
      return Math.min(max, Math.max(1000, ms));
    }

    return max;
  } catch (_) {
    return 0;
  }
}

function scheduleAutoDelete(sentMsg, ms = 24 * 60 * 60 * 1000) {
  try { if (!ms || Number(ms) <= 0) return; } catch (_) { return; }
  try {
    if (!sentMsg || !sentMsg.chat || !sentMsg.message_id) return;
    const chat_id = sentMsg.chat.id;
    const message_id = sentMsg.message_id;
    setTimeout(() => {
      bot.deleteMessage(chat_id, message_id).catch(() => {});
    }, ms);
  } catch (_) {}
}

function _isProtectedAnnouncementText(t) {
  const s = String(t || "");
  if (!s) return false;
  // Never auto-delete: announcements, weekly draw broadcasts/updates/winners
  return (
    /\bWEEKLY\s*DRAW\b/i.test(s) ||
    /\bPREVIOUS\s*WINNERS\b/i.test(s) ||
    /\bWINNERS\b/i.test(s) ||
    /\bBROADCAST\b/i.test(s) ||
    /📢|📣/i.test(s) ||
    /ANNOUNC/i.test(s)
  );
}

function shouldAutoDeleteOutbound() {
  // Now: auto delete ALL bot messages after 24 hours
  return true;
}

// Monkey-patch sendMessage + sendPhoto to auto-delete ONLY selected messages
try {
  const _sendMessage = bot.sendMessage.bind(bot);
  bot.sendMessage = async (chatId, text, options = {}) => {
    const m = await _sendMessage(chatId, text, options);
    if (shouldAutoDeleteOutbound(text, options)) scheduleAutoDelete(m, getAutoDeleteMsForChat(chatId));
    return m;
  };

  const _sendPhoto = bot.sendPhoto.bind(bot);
  bot.sendPhoto = async (chatId, photo, options = {}) => {
    const m = await _sendPhoto(chatId, photo, options);
    const cap = (options && options.caption) ? options.caption : "";
    if (shouldAutoDeleteOutbound(cap, options)) scheduleAutoDelete(m, getAutoDeleteMsForChat(chatId));
    return m;
  };
} catch (_) {}

// ===================== BUTTON COOLDOWN (3s) =====================
const buttonCooldownMap = new Map(); // chatId -> lastTapMs
function isOnButtonCooldown(chatId) {
  const now = Date.now();
  const last = Number(buttonCooldownMap.get(String(chatId)) || 0);
  if (now - last < 3000) return true;
  buttonCooldownMap.set(String(chatId), now);
  return false;
}


// ===================== MESSAGE FLOOD PROTECTION =====================
const msgFloodMap = new Map(); // chatId -> [timestamps]
const msgFloodWarnMap = new Map(); // chatId -> lastWarnMs
function isMessageFlood(chatId) {
  const now = Date.now();
  const key = String(chatId);
  const arr = (msgFloodMap.get(key) || []).filter((t) => now - t < 3000);
  arr.push(now);
  msgFloodMap.set(key, arr);

  // 10 messages in 3s => flood
  if (arr.length >= 10) {
    const lastWarn = Number(msgFloodWarnMap.get(key) || 0);
    if (now - lastWarn > 15000) {
      msgFloodWarnMap.set(key, now);
      bot.sendMessage(chatId, "⏳ Slow down. Please wait a moment before sending more messages.").catch(() => {});
    }
    return true;
  }
  return false;
}



// ===============================================================
// 👤 USER PROFILE CAPTURE (names for leaderboards)
// ===============================================================
function upsertUserProfileFromMsg(msg) {
  try {
    if (!msg || !msg.chat) return;
    const chatId = msg.chat.id;
    const from = msg.from || {};
    const u = getUser(chatId);

    u.profile = u.profile && typeof u.profile === "object" ? u.profile : { firstName: "", lastName: "", username: "" };
    u.profile.firstName = String(from.first_name || u.profile.firstName || "").trim();
    u.profile.lastName = String(from.last_name || u.profile.lastName || "").trim();
    u.profile.username = String(from.username || u.profile.username || "").trim();
    u.profileUpdatedAt = Date.now();
    saveDB();
  } catch (_) {}
}

function getDisplayName(chatId) {
  const u = getUser(chatId);
  const p = (u && u.profile) || {};
  const uname = (p.username || "").trim();
  if (uname) return "@" + uname;
  const full = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
  if (full) return full;
  return String(chatId);
}

// Capture profile on every incoming message
bot.on("message", (msg) => {
  upsertUserProfileFromMsg(msg);
});

// ===============================================================
// 🏆 TODAY REFERRAL LEADERBOARD (Kenya Time)
// ===============================================================
function getTodayInviterLeaderboard(limit = 10) {
  db = repairDB(db);
  const day = todayKey();
  const dayMap = (db.referralsByDay && db.referralsByDay[day]) ? db.referralsByDay[day] : {};
  const sorted = Object.entries(dayMap)
    .map(([cid, count]) => ({ chatId: String(cid), count: Number(count || 0) }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
  return { day, sorted };
}

function formatTodayLeaderboard(limit = 10) {
  const { day, sorted } = getTodayInviterLeaderboard(limit);
  if (!sorted.length) {
    return `🏆 *Top Inviters Today* (\`${mdEscape(day)}\`)\n\nNo successful referrals yet today.`;
  }
  const lines = sorted.map((x, i) => {
    const name = getDisplayName(x.chatId);
    return `${i + 1}. ${mdEscape(name)} — *${mdEscape(String(x.count))}*`;
  });
  return `🏆 *Top Inviters Today* (\`${mdEscape(day)}\`)\n\n${lines.join("\n")}`;
}


// ===================== WITHDRAW HELPERS (GLOBAL) =====================
// Used by both inline buttons (ac:/dc:) and /ac /dc commands.
async function __withdrawApprove(targetId, adminChatId, adminMsgId) {
  try {
    // Normalize
    const uid = String(targetId || "").trim();
    if (!uid) {
      if (adminChatId) await bot.sendMessage(adminChatId, "❌ Invalid user id.").catch(() => {});
      return false;
    }

    db = repairDB(db);
    const req = db.pendingRedeems?.[uid];

    if (!req || req.status !== "pending" || req.type !== "withdraw") {
      if (adminChatId) await bot.sendMessage(adminChatId, "❌ No pending withdraw for that user.").catch(() => {});
      // Remove buttons + (best-effort) delete the admin request message
      if (adminChatId && adminMsgId) {
        try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminChatId, message_id: adminMsgId }); } catch (_) {}
        await bot.deleteMessage(adminChatId, adminMsgId).catch(() => {});
      }
      return false;
    }

    // Mark approved + persist
    req.status = "approved";
    db.pendingRedeems[uid] = req;
    saveDB();

    // Track withdrawal stats for /profile
    try {
      const u = getUser(uid);
      ensureTxLog(u);
      const ksh = Number(pointsToKes(req.amount || 0));
      u.withdrawStats.approvedCount = Number(u.withdrawStats.approvedCount || 0) + 1;
      u.withdrawStats.approvedKsh = Number(u.withdrawStats.approvedKsh || 0) + ksh;
      const d = kenyaDayKeyOffset(0);
      u.withdrawStats.byDay[d] = u.withdrawStats.byDay[d] || { approvedKsh: 0, declinedKsh: 0, pendingKsh: 0, approvedCount: 0, declinedCount: 0, pendingCount: 0 };
      u.withdrawStats.byDay[d].approvedKsh += ksh;
      u.withdrawStats.byDay[d].approvedCount += 1;
      saveDB();
      addUserTx(uid, { status: "success", pkgLabel: "Withdrawal", amountKsh: ksh, phone254: req.phone || "" });
    } catch (_) {}

// Weekly Draw: track successful withdrawals (we count approved withdrawals as a withdrawal action)
try {
  const c = ensureWeeklyDrawObject();
  if (c.enabled && String(c.status || "").toUpperCase() === "RUNNING") {
    const k = String(uid);
    c.withdrawReq = c.withdrawReq && typeof c.withdrawReq === "object" ? c.withdrawReq : {};
    c.withdrawReq[k] = Number(c.withdrawReq[k] || 0) + 1;
    saveDB();
  }
} catch (_) {}

    // Clear pending + cooldown (do not let these throw)
    try { clearPendingRedeem(uid); } catch (_) {}
    try { setRedeemCooldown(uid, 5 * 60 * 1000); } catch (_) {}

    const pts = Number(req.amount || 0);
    const kes = pointsToKes(req.amount);
    const phone = String(req.phone || "");

    // Notify user (FULL message)
    function maskPhoneNumber(phone) {
  if (!phone) return "N/A";

  const str = phone.toString();

  if (str.length < 7) return str; // prevent slice errors

  return str.slice(0, 4) + 'xxx' + str.slice(-3);
}

const maskedPhone = maskPhoneNumber(phone);

await bot.sendMessage(
  Number(uid),
  `✅ Withdrawal Approved!

Your withdrawal request has been successfully approved.

💰 Amount: ${pts} pts
💵 You will receive: KES ${kes}
📱 M-PESA: ${maskedPhone}

The payment will be processed shortly.
Thank you for using Bingwa Mtaani 💙`
).catch(() => {});

    // Notify admin
    if (adminChatId) {
      await bot.sendMessage(
        adminChatId,
        `✅ Withdraw approved\nUser: ${uid}\nAmount: ${pts} pts\nKES: ${kes}\nMPESA: ${phone}`
      ).catch(() => {});
    }
// Remove buttons + (best-effort) delete the admin request message
if (adminChatId && adminMsgId) {
  try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminChatId, message_id: adminMsgId }); } catch (_) {}
  await bot.deleteMessage(adminChatId, adminMsgId).catch(() => {});
}

    return true;
  } catch (err) {
    console.error("__withdrawApprove error:", err);
    if (adminChatId) await bot.sendMessage(adminChatId, "❌ Error approving withdrawal. Check Render logs.").catch(() => {});
    // Try to remove the buttons/message to stop repeated clicks
    if (adminChatId && adminMsgId) {
      try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminChatId, message_id: adminMsgId }); } catch (_) {}
      await bot.deleteMessage(adminChatId, adminMsgId).catch(() => {});
    }
    return false;
  }
}

async function __withdrawDecline(targetId, adminChatId, adminMsgId) {
  db = repairDB(db);
  const req = db.pendingRedeems?.[String(targetId)];
  if (!req || req.status !== "pending" || req.type !== "withdraw") {
    if (adminChatId) await bot.sendMessage(adminChatId, "❌ No pending withdraw for that user.").catch(() => {});
    return false;
  }

  req.status = "declined";
  db.pendingRedeems[String(targetId)] = req;
  saveDB();

  // Track withdrawal stats for /profile
  try {
    const u = getUser(targetId);
    ensureTxLog(u);
    const ksh = Number(pointsToKes(req.amount || 0));
    u.withdrawStats.declinedCount = Number(u.withdrawStats.declinedCount || 0) + 1;
    u.withdrawStats.declinedKsh = Number(u.withdrawStats.declinedKsh || 0) + ksh;
    const d = kenyaDayKeyOffset(0);
    u.withdrawStats.byDay[d] = u.withdrawStats.byDay[d] || { approvedKsh: 0, declinedKsh: 0, pendingKsh: 0, approvedCount: 0, declinedCount: 0, pendingCount: 0 };
    u.withdrawStats.byDay[d].declinedKsh += ksh;
    u.withdrawStats.byDay[d].declinedCount += 1;
    saveDB();
    addUserTx(targetId, { status: "failed", pkgLabel: "Withdrawal", amountKsh: ksh, phone254: req.phone || "" });
  } catch (_) {}


  const amt = Number(req.amount || 0);
  if (Number.isFinite(amt) && amt > 0) addPoints(Number(targetId), amt);

  clearPendingRedeem(targetId);
  setRedeemCooldown(targetId, 5 * 60 * 1000);

  await bot.sendMessage(
    Number(targetId),
    `❌ Withdrawal Declined

Your withdrawal request was declined by admin.

💰 Amount refunded: ${amt} pts
📌 Current balance: ${getPoints(targetId).toFixed(2)} pts

You can try again later.`
  ).catch(() => {});

  if (adminChatId && adminMsgId) {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminChatId, message_id: adminMsgId }).catch(() => {});
    await bot.deleteMessage(adminChatId, adminMsgId).catch(() => {});
  }
  if (req.adminMsgId) {
    await bot.deleteMessage(ADMIN_ID, req.adminMsgId).catch(() => {});
  }

  if (adminChatId) await bot.sendMessage(adminChatId, `❌ Withdraw declined for ${targetId}`).catch(() => {});
  return true;
}
// ===================== AUTO DELETE SYSTEM =====================
const lastBotMessage = new Map();
// ✅ Auto STK reminder timers (in-memory)
const stkReminderTimers = new Map();
// Global phone STK lock to prevent multi-account spam
const phoneStkLock = new Map(); // phone254 -> { until:number, ref:string }


// ✅ Auto Retry STK timers/state (in-memory)
// Key: "<chatId>:<externalRef>"  Value: { attempts: number, timers: number[] }
const autoRetryStkState = new Map();

const AUTO_RETRY_STK_DELAY_MS = 30 * 1000; // 30 seconds // 1.1 minutes
const AUTO_RETRY_STK_MAX = 2;

function autoRetryKey(chatId, externalRef) {
  return `${String(chatId)}:${String(externalRef)}`;
}

function clearAutoRetryStk(chatId, externalRef) {
  const key = autoRetryKey(chatId, externalRef);
  const st = autoRetryStkState.get(key);
  if (st && Array.isArray(st.timers)) {
    for (const t of st.timers) {
      try { clearTimeout(t); } catch (_) {}
    }
  }
  autoRetryStkState.delete(key);
}

// Schedules up to 2 retries for a pending payment reference.
// Only schedules if Auto Retry is enabled AND user is Business (auto-off when expired).
function scheduleAutoRetryStk(chatId, externalRef, reason = "") {
  try {
    if (!(typeof isAdmin === "function" && isAdmin(chatId)) && !isAutoRetryStkEnabled(chatId)) return;
  } catch (_) { return; }

  const ref = String(externalRef || "");
  if (!ref) return;

  const pending = getPendingPayment(ref);
  if (!pending) return;

  const key = autoRetryKey(chatId, ref);
  const st = autoRetryStkState.get(key) || { attempts: 0, timers: [] };

  // Already fully scheduled/used
  if (st.attempts >= AUTO_RETRY_STK_MAX) {
    autoRetryStkState.set(key, st);
    return;
  }

  // Avoid scheduling duplicate timers
  if (st.timers && st.timers.length >= (AUTO_RETRY_STK_MAX - st.attempts)) {
    autoRetryStkState.set(key, st);
    return;
  }

  const scheduleOne = (attemptNo) => {
    const tid = setTimeout(async () => {
      try {
        // Stop if succeeded already
        try { if (alreadyProcessed(ref)) { clearAutoRetryStk(chatId, ref); return; } } catch (_) {}

        const p = getPendingPayment(ref);
        if (!p) { clearAutoRetryStk(chatId, ref); return; }

        // If Business expired, auto-disable and stop
        if (!(typeof isAdmin === "function" && isAdmin(chatId)) && !isAutoRetryStkEnabled(chatId)) {
          clearAutoRetryStk(chatId, ref);
          return;
        }

        // Send STK again
        await payheroStkPush({
          amount: p.price,
          phone: p.phone254,
          externalRef: ref,
          channelId: channelIdForCategory(p.category),
        });

        // Light user notice (no scary errors)
        await bot.sendMessage(chatId, `🔁 Auto Retry STK sent (attempt ${attemptNo}/${AUTO_RETRY_STK_MAX}).
Package: ${p.pkgLabel || "N/A"} • Ksh ${p.price || ""}.
Check your phone and complete payment.`).catch(() => {});
      } catch (_) {
        // Silent on retry errors to avoid noisy chats.
      }
    }, AUTO_RETRY_STK_DELAY_MS * attemptNo);

    st.timers.push(tid);
  };

  // schedule remaining attempts
  while (st.attempts < AUTO_RETRY_STK_MAX) {
    st.attempts += 1;
    scheduleOne(st.attempts);
  }

  autoRetryStkState.set(key, st);

  // Friendly note once (best effort)
  try {
    bot.sendMessage(chatId, `⏳ Auto Retry STK is ON. I will retry in ~1.1 minutes (up to ${AUTO_RETRY_STK_MAX} times).`).catch(() => {});
  } catch (_) {}
}

async function deleteMessageSafe(chatId, messageId) {
  try {
    if (messageId) {
      await bot.deleteMessage(chatId, messageId);
    }
  } catch (e) {}
}



// ===================== USER INLINE ACTIONS =====================


bot.on("inline_query", async (q) => {
  try {
    const query = (q.query || "").trim();

    const results = [];

    // Commands/buttons
    const cmdHits = commandMatchesInline(query).slice(0, 8);
    for (const c of cmdHits) {
      results.push({
        type: "article",
        id: `cmd_${c.key}`,
        title: c.title,
        description: c.desc,
        // Send the exact command/button text to the bot chat so it triggers normal handlers.
        input_message_content: { message_text: c.text },
      });
    }

    // Categories
    const catHits = categoryMatchesInline(query).slice(0, 8);
    for (const cat of catHits) {
      results.push({
        type: "article",
        id: `cat_${base64UrlEncode(cat)}`,
        title: `📦 ${cat}`,
        description: "Open category packages",
        // Trigger text: bot will immediately open category
        input_message_content: { message_text: `#cat ${base64UrlEncode(cat)}` },
      });
    }

    // Offers
    const hits = searchOffersInline(query).slice(0, 20);
    for (const h of hits) {
      results.push({
        type: "article",
        id: `offer_${base64UrlEncode(h.category)}_${base64UrlEncode(h.label)}`,
        title: h.label,
        description: `${h.category} • Ksh ${h.price}`,
        // Trigger text: bot will immediately open Proceed / Change Number flow
        input_message_content: {
          message_text: `#buy ${base64UrlEncode(h.category)}:${base64UrlEncode(h.label)}`,
        },
      });
    }

    if (!query) {
      // Top 5 trending offers (most purchased)
      const top = getTopTrendingOffers(5);
      if (top.length) {
        for (const t of top) {
          results.push({
            type: "article",
            id: `trend_${base64UrlEncode(t.category)}_${base64UrlEncode(t.label)}`,
            title: `🔥 ${t.label}`,
            description: `${t.category} • Ksh ${t.price} • ${t.count} buys`,
            input_message_content: { message_text: `#buy ${base64UrlEncode(t.category)}:${base64UrlEncode(t.label)}` },
          });
        }
      } else {
        results.push({
          type: "article",
          id: "hint1",
          title: "🔎 Search offers (type something)…",
          description: "Examples: 2GB, 24HRS, 200 SMS, 7 DAYS, Flex",
          input_message_content: { message_text: "#help_inline" },
        });
      }
    }

    return bot.answerInlineQuery(q.id, results, { cache_time: 1 });
  } catch (e) {
    return bot.answerInlineQuery(q.id, [], { cache_time: 1 });
  }
});

bot.on("callback_query", async (q) => {
  try {
    const data = String(q.data || "");
    const chatId = q.message?.chat?.id;
    if (!chatId) {
      await bot.answerCallbackQuery(q.id, { text: "Open the bot chat to continue." }).catch(() => {});
      return;
    }

    // 🔒 Auto-hide buttons: block all inline actions except Help + the toggle itself.
    // IMPORTANT: Silent ignore (no popup text), so buttons "do nothing" while hidden.
    try {
      if (isAutoHideButtonsEnabled(chatId) && !data.startsWith("help:") && data !== "bh:toggle" && data !== "lang:toggle") {
        await bot.answerCallbackQuery(q.id).catch(() => {});
        return;
      }
    } catch (_) {}


// Force-join gate (admin bypass)
const actorId = (q.from && q.from.id) ? q.from.id : chatId;

// ===================== HELP CALLBACKS =====================
const _helpMsgId = q.message?.message_id;

if (data === "help:menu") {
  await bot.answerCallbackQuery(q.id).catch(() => {});
  await sendHelpMenu(chatId, { messageId: _helpMsgId });
  return;
}

if (data === "help:home") {
  await bot.answerCallbackQuery(q.id).catch(() => {});
  // Delete the help message to keep the chat clean, then show the main menu (reply keyboard)
  try { if (_helpMsgId) await bot.deleteMessage(chatId, _helpMsgId).catch(() => {}); } catch (_) {}
  await sendTracked(chatId, "🏠 Main Menu", { ...mainMenuKeyboard(chatId) });
  return;
}

if (data.startsWith("help:")) {
  const key = data.split(":")[1] || "support";
  await bot.answerCallbackQuery(q.id).catch(() => {});
  await sendHelpAnswer(chatId, key, { messageId: _helpMsgId });
  return;
}




// ✅ Business: Activate from Help page (INLINE button)
if (data === "biz_activate") {
  await bot.answerCallbackQuery(q.id).catch(() => {});
  bizSetView(chatId, "biz_plans");
  const header = isBusinessActive(chatId)
    ? "⚙️ *Manage Business Account*\n\nTap your ✅ active plan to deactivate, or choose another plan to subscribe."
    : "✅ *Activate Business Account*\n\nChoose a plan to subscribe:";

  const edited = await safeEditMessageText(chatId, q.message?.message_id, header, {
    parse_mode: "Markdown",
    ...businessPlansInlineKeyboard(chatId),
  });
  if (edited) return;

  await sendTracked(chatId, header, { parse_mode: "Markdown", ...businessPlansInlineKeyboard(chatId) });
  return;
}



// ✅ Business: Confirm deactivate (INLINE)
if (data.startsWith("biz_deact_yes:")) {
  await bot.answerCallbackQuery(q.id).catch(() => {});
  bizSetView(chatId, "biz_overview");
  const planKey = (data.split(":")[1] || "").trim();

  deactivateBusiness(chatId);

  const out = "✅ Business Account deactivated.\nYou are back to the normal account.";
  await safeEditMessageText(chatId, q.message?.message_id, out, {
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Back to Help", callback_data: "help:menu" }, { text: "🏠 Main Menu", callback_data: "help:home" }]] },
  }).catch(() => {});
  return;
}

if (data.startsWith("biz_deact_no:")) {
  await bot.answerCallbackQuery(q.id).catch(() => {});
  bizSetView(chatId, "biz_plans");
  const header = isBusinessActive(chatId)
    ? "⚙️ *Manage Business Account*\n\nTap your ✅ active plan to deactivate, or choose another plan to subscribe."
    : "✅ *Activate Business Account*\n\nChoose a plan to subscribe:";

  const edited = await safeEditMessageText(chatId, q.message?.message_id, header, {
    parse_mode: "Markdown",
    ...businessPlansInlineKeyboard(chatId),
  });
  if (edited) return;

  await sendTracked(chatId, header, { parse_mode: "Markdown", ...businessPlansInlineKeyboard(chatId) });
  return;
}

// ✅ Business: Back to previous page within Business flow (INLINE)
if (data === "biz_back") {
  await bot.answerCallbackQuery(q.id).catch(() => {});
  const prev = bizPrevView(chatId);

  // Default back: return to Business overview page in Help
  if (!prev || prev === "biz_overview") {
    // Re-render the Business help page with inline Activate + normal help navigation
    const text = helpAnswerText("business", chatId);
    const nav = helpAnswerKeyboard()?.reply_markup?.inline_keyboard || [];
    const inline_keyboard = [[{ text: "✅ Activate", callback_data: "biz_activate" }], ...nav];

    await safeEditMessageText(chatId, q.message?.message_id, text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard },
    }).catch(() => {});
    return;
  }

  // If coming back from confirm -> show plans
  if (prev === "biz_plans") {
    const header = isBusinessActive(chatId)
      ? "⚙️ *Manage Business Account*\n\nTap your ✅ active plan to deactivate, or choose another plan to subscribe."
      : "✅ *Activate Business Account*\n\nChoose a plan to subscribe:";

    await safeEditMessageText(chatId, q.message?.message_id, header, {
      parse_mode: "Markdown",
      ...businessPlansInlineKeyboard(chatId),
    }).catch(() => {});
    return;
  }

  return;
}

// ✅ Business: Plan selection (INLINE)
if (data.startsWith("biz_plan:")) {
  await bot.answerCallbackQuery(q.id).catch(() => {});
  const planKey = (data.split(":")[1] || "").trim();
  const plan = BUSINESS_PLANS[planKey];
  const u = getUser(chatId);

  if (!plan) {
    await bot.answerCallbackQuery(q.id, { text: "Invalid plan", show_alert: true }).catch(() => {});
    return;
  }

// If user taps the currently active plan -> ask for confirmation (avoid accidental deactivation)
if (isBusinessActive(chatId) && String(u.businessPlanKey || "") === planKey) {
  const exp = kenyaDateTimeFromTs(u.subscriptionExpiry || 0);
  const out =
    "⚠️ *Confirm Deactivation*\n\n" +
    "You tapped your active plan:\n" +
    `• *${mdEscape(String(u.businessPlanLabel || "Business Plan"))}*\n` +
    `• Expiry: \`${mdEscape(exp)}\`\n\n` +
    "Do you want to deactivate your Business Account?";

  await safeEditMessageText(chatId, q.message?.message_id, out, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Yes, Deactivate", callback_data: `biz_deact_yes:${planKey}` }],
        [{ text: "↩️ Cancel", callback_data: `biz_deact_no:${planKey}` }],
      ],
    },
  }).catch(() => {});
  return;
}

  const phone254 = getUserPhone(chatId);

  // Ask phone if missing
  if (!phone254) {
    setPendingAction(chatId, { type: "sell_business", planKey });
    await safeEditMessageText(
      chatId,
      q.message?.message_id,
      "📱 Send your phone number to pay via STK:\n• 07XXXXXXXX\n• 01XXXXXXXX\n• 2547XXXXXXXX\n• 2541XXXXXXXX",
      { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "biz_back" }, { text: "🏠 Main Menu", callback_data: "help:home" }]] } }
    ).catch(() => {});
    return;
  }

  const externalRef = makeExternalRef(chatId, "Business_Account", plan.price);

  addPendingPayment(externalRef, {
    chatId,
    category: "Business Account",
    pkgLabel: `${plan.label} (Ksh ${plan.price})`,
    phone254,
    price: plan.price,
    planKey,
  });

  await safeEditMessageText(
    chatId,
    q.message?.message_id,
    `✅ *Subscription Selected*\n\nPlan: *${mdEscape(plan.label)}*\nAmount: *Ksh ${plan.price}*\nPhone: *${mdEscape(maskPhone(phone254))}*\n\n📲 Sending STK…`,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "⬅️ Back to Help", callback_data: "help:menu" }, { text: "🏠 Main Menu", callback_data: "help:home" }]] } }
  ).catch(() => {});

  try {
    await payheroStkPush({
      amount: plan.price,
      phone: phone254,
      externalRef,
      channelId: PAYHERO_CHANNEL_ID_BUSINESS,
    });

    // Keep the same message updated
    await safeEditMessageText(
      chatId,
      q.message?.message_id,
      `✅ STK sent. Please enter your M-Pesa PIN on your phone.\n\n⏳ After payment, you will receive confirmation here.`,
      { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "biz_back" }, { text: "🏠 Main Menu", callback_data: "help:home" }]] } }
    ).catch(() => {});
  } catch (e) {
    deletePendingPayment(externalRef);
    await safeEditMessageText(
      chatId,
      q.message?.message_id,
      "❌ Failed to send STK. Please try again.",
      { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "biz_back" }, { text: "🏠 Main Menu", callback_data: "help:home" }]] } }
    ).catch(() => {});
  }

  return;
}

// ===================== BUSINESS INLINE BACKUP (ONE TAP) =====================
if (data === "biz:backup_once") {
  if (!isBusinessActive(chatId)) {
    await bot.answerCallbackQuery(q.id, { text: tr(chatId, "💼 Business only. Type /sell to upgrade.", "💼 Hii ni ya Business tu. Tuma /sell kuboresha akaunti."), __chatIdForLang: chatId }).catch(() => {});
    return;
  }

  const mid = q.message?.message_id || 0;
  const actionKey = `biz_backup_once:${chatId}:${mid}`;

  db = repairDB(db);
  db.usedInlineActions = db.usedInlineActions && typeof db.usedInlineActions === "object" ? db.usedInlineActions : {};

  if (db.usedInlineActions[actionKey]) {
    await bot.answerCallbackQuery(q.id, { text: tr(chatId, "✅ Already used. Backup button is expired.", "✅ Tayari imetumika. Kitufe cha hifadhi kimekwisha muda."), __chatIdForLang: chatId }).catch(() => {});
    return;
  }

  // Mark immediately to prevent double-taps/race
  db.usedInlineActions[actionKey] = Date.now();
  saveDB();

  await bot.answerCallbackQuery(q.id, {
    text: tr(chatId, "⏳ Creating your backup key...", "⏳ Inatengeneza funguo yako ya hifadhi...")
  }).catch(() => {});

  try {
    const created = createServerBackupKey(chatId);
    const backupKey = created.key;
    const keepLang = getLang(chatId);

    await bot.sendMessage(
      chatId,
      tr(
        chatId,
        `✅ Backup created successfully.\n\n🔐 Your restore key is:\n\`${backupKey}\`\n\n⚠️ Keep this key safely. Your account will now be cleared.\nThis key expires after 7 days.\nTo restore later, send:\n/restorebackup ${backupKey}`,
        `✅ Hifadhi imefanikiwa.\n\n🔐 Funguo yako ya kurejesha ni:\n\`${backupKey}\`\n\n⚠️ Hifadhi funguo hii vizuri. Akaunti yako sasa itafutwa.\nFunguo hii itaisha baada ya siku 7.\nKurejesha baadaye tuma:\n/restorebackup ${backupKey}`
      ),
      { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
    );

    // Clear user data after successful send
    const ok = wipeUserData(chatId);
    try { saveDB(); } catch (_) {}

    // Remove the backup button from the inline keyboard (so more taps do nothing)
    try {
      if (mid) {
        const kb = fastPurchaseHelpKeyboard(chatId).reply_markup;
        // rebuild without the backup row by temporarily masking business check
        // simplest: just remove any row with callback_data biz:backup_once
        kb.inline_keyboard = (kb.inline_keyboard || []).filter((row) => {
          try { return !(row && row[0] && row[0].callback_data === "biz:backup_once"); } catch (_) { return true; }
        });
        await bot.editMessageReplyMarkup(kb, { chat_id: chatId, message_id: mid }).catch(() => {});
      }
    } catch (_) {}

    await bot.sendMessage(chatId, tr(chatId, "✅ Backup key saved. Use /restorebackup YOUR_KEY whenever you want to restore.", "✅ Funguo ya hifadhi imehifadhiwa. Tumia /restorebackup FUNGUO_YAKO wakati wowote unapotaka kurejesha."), mainMenuKeyboard(chatId)).catch(() => {});
  } catch (e) {
    // If failed, allow retry by unmarking
    try {
      db.usedInlineActions[actionKey] = null;
      delete db.usedInlineActions[actionKey];
      saveDB();
    } catch (_) {}
    await bot.sendMessage(chatId, tr(chatId, "❌ Failed to create backup: ", "❌ Imeshindikana kutengeneza hifadhi: ") + (e?.message || e), mainMenuKeyboard(chatId)).catch(() => {});
  }
  return;
}


// ===================== FAST PURCHASE TOGGLE =====================
if (data === "fp:toggle") {
  const u = getUser(chatId);
  if (!isBusinessActive(chatId)) {
    await bot.answerCallbackQuery(q.id, { text: tr(chatId, "💼 Business only. Type /sell to upgrade.", "💼 Hii ni ya Business tu. Tuma /sell kuboresha akaunti."), __chatIdForLang: chatId }).catch(() => {});
    return;
  }

  u.fastPurchaseEnabled = !u.fastPurchaseEnabled;
  saveDB();

  await bot.answerCallbackQuery(q.id, { text: u.fastPurchaseEnabled ? "✅ Fast Purchase ON" : "⬜️ Fast Purchase OFF" }).catch(() => {});
  try {
    const mid = q.message?.message_id;
    if (mid) {
      await bot.editMessageReplyMarkup(fastPurchaseHelpKeyboard(chatId).reply_markup, { chat_id: chatId, message_id: mid }).catch(() => {});
    }
  } catch (_) {}
  return;
}


// ===================== AUTO RETRY STK TOGGLE (BUSINESS) =====================
if (data === "ar:toggle") {
  const u = getUser(chatId);
  if (!isBusinessActive(chatId)) {
    // auto-off if previously enabled
    if (u.autoRetryStkEnabled) { u.autoRetryStkEnabled = false; try { saveDB(); } catch (_) {} }
    await bot.answerCallbackQuery(q.id, { text: tr(chatId, "💼 Business only. Type /sell to upgrade.", "💼 Hii ni ya Business tu. Tuma /sell kuboresha akaunti."), __chatIdForLang: chatId }).catch(() => {});
    return;
  }

  u.autoRetryStkEnabled = !u.autoRetryStkEnabled;
  saveDB();

  await bot.answerCallbackQuery(q.id, { text: u.autoRetryStkEnabled ? "✅ Auto Retry STK ON" : "⬜️ Auto Retry STK OFF" }).catch(() => {});
  try {
    const mid = q.message?.message_id;
    if (mid) {
      await bot.editMessageReplyMarkup(fastPurchaseHelpKeyboard(chatId).reply_markup, { chat_id: chatId, message_id: mid }).catch(() => {});
    }
  } catch (_) {}
  return;
}

 // ===================== NOTIFICATION FILTERS (BUSINESS) =====================
 if (data === "nf:campaign") {
   const u = getUser(chatId);
   if (!_ensureBusinessAndResetPrefs(chatId)) {
     await bot.answerCallbackQuery(q.id, { text: tr(chatId, "💼 Business only. Type /sell to upgrade.", "💼 Hii ni ya Business tu. Tuma /sell kuboresha akaunti."), __chatIdForLang: chatId }).catch(() => {});
     return;
   }
   u.stopCampaignNotifs = !u.stopCampaignNotifs;
   saveDB();
   await bot.answerCallbackQuery(q.id, { text: u.stopCampaignNotifs ? "✅ Campaign notifications stopped" : "🔔 Campaign notifications ON" }).catch(() => {});
   try {
     const mid = q.message?.message_id;
     if (mid) await bot.editMessageReplyMarkup(fastPurchaseHelpKeyboard(chatId).reply_markup, { chat_id: chatId, message_id: mid }).catch(() => {});
   } catch (_) {}
   return;
 }

 if (data === "nf:cashback") {
   const u = getUser(chatId);
   if (!_ensureBusinessAndResetPrefs(chatId)) {
     await bot.answerCallbackQuery(q.id, { text: tr(chatId, "💼 Business only. Type /sell to upgrade.", "💼 Hii ni ya Business tu. Tuma /sell kuboresha akaunti."), __chatIdForLang: chatId }).catch(() => {});
     return;
   }
   u.stopCashbackNotifs = !u.stopCashbackNotifs;
   saveDB();
   await bot.answerCallbackQuery(q.id, { text: u.stopCashbackNotifs ? "✅ Cashback notifications stopped" : "🔔 Cashback notifications ON" }).catch(() => {});
   try {
     const mid = q.message?.message_id;
     if (mid) await bot.editMessageReplyMarkup(fastPurchaseHelpKeyboard(chatId).reply_markup, { chat_id: chatId, message_id: mid }).catch(() => {});
   } catch (_) {}
   return;
 }

 if (data === "nf:referral") {
   const u = getUser(chatId);
   if (!_ensureBusinessAndResetPrefs(chatId)) {
     await bot.answerCallbackQuery(q.id, { text: tr(chatId, "💼 Business only. Type /sell to upgrade.", "💼 Hii ni ya Business tu. Tuma /sell kuboresha akaunti."), __chatIdForLang: chatId }).catch(() => {});
     return;
   }
   u.stopReferralNotifs = !u.stopReferralNotifs;
   saveDB();
   await bot.answerCallbackQuery(q.id, { text: u.stopReferralNotifs ? "✅ Referral notifications stopped" : "🔔 Referral notifications ON" }).catch(() => {});
   try {
     const mid = q.message?.message_id;
     if (mid) await bot.editMessageReplyMarkup(fastPurchaseHelpKeyboard(chatId).reply_markup, { chat_id: chatId, message_id: mid }).catch(() => {});
   } catch (_) {}
   return;
 }

 // ===================== AUTO DELETE 24H (BUSINESS) =====================
 if (data === "ad:24h") {
   const u = getUser(chatId);
   if (!_ensureBusinessAndResetPrefs(chatId)) {
     await bot.answerCallbackQuery(q.id, { text: tr(chatId, "💼 Business only. Type /sell to upgrade.", "💼 Hii ni ya Business tu. Tuma /sell kuboresha akaunti."), __chatIdForLang: chatId }).catch(() => {});
     return;
   }
   u.autoDelete24hEnabled = !u.autoDelete24hEnabled;
   // set actual autoDeleteMs used by the bot
   u.autoDeleteMs = u.autoDelete24hEnabled ? (24 * 60 * 60 * 1000) : 0;
   saveDB();
   await bot.answerCallbackQuery(q.id, { text: u.autoDelete24hEnabled ? "✅ Auto delete set to 24hrs" : "⬜️ Auto delete OFF" }).catch(() => {});
   try {
     const mid = q.message?.message_id;
     if (mid) await bot.editMessageReplyMarkup(fastPurchaseHelpKeyboard(chatId).reply_markup, { chat_id: chatId, message_id: mid }).catch(() => {});
   } catch (_) {}
   return;
 }

 // ===================== AUTO HIDE BUTTONS (ALL USERS) =====================
 if (data === "bh:toggle") {
   const u = getUser(chatId);
   u.autoHideButtonsEnabled = !u.autoHideButtonsEnabled;
   saveDB();

   await bot.answerCallbackQuery(q.id, { text: u.autoHideButtonsEnabled ? "🔒 Buttons hidden" : "✅ Buttons visible" }).catch(() => {});
   try {
     const mid = q.message?.message_id;
     if (mid) await bot.editMessageReplyMarkup(fastPurchaseHelpKeyboard(chatId).reply_markup, { chat_id: chatId, message_id: mid }).catch(() => {});
   } catch (_) {}

   // Refresh reply keyboard state
   try {
     await bot.sendMessage(chatId, u.autoHideButtonsEnabled ? "🔒 Buttons are now hidden (only Help is shown)." : "✅ Buttons are now visible.", { ...mainMenuKeyboard(chatId) }).catch(() => {});
   } catch (_) {}
   return;


// ===================== HIDE QUICK ACTIONS (ALL USERS) =====================
if (data === "qa:toggle") {
  const u = getUser(chatId);
  const next = !u.hideQuickActionsEnabled;

  // If turning ON but there are no active quick buttons (expired/inactive), keep OFF.
  if (next) {
    let quick = [];
    try { quick = getQuickCategories(chatId) || []; } catch (_) {}
    if (!quick || quick.length === 0) {
      u.hideQuickActionsEnabled = false;
      saveDB();
      await bot.answerCallbackQuery(q.id, { text: "No active Quick Actions right now." }).catch(() => {});
      try {
        const mid = q.message?.message_id;
        if (mid) await bot.editMessageReplyMarkup(fastPurchaseHelpKeyboard(chatId).reply_markup, { chat_id: chatId, message_id: mid }).catch(() => {});
      } catch (_) {}
      return;
    }
  }

  u.hideQuickActionsEnabled = next;
  saveDB();

  await bot.answerCallbackQuery(q.id, { text: u.hideQuickActionsEnabled ? "🙈 Quick Actions hidden" : "👁 Quick Actions visible" }).catch(() => {});
  try {
    const mid = q.message?.message_id;
    if (mid) await bot.editMessageReplyMarkup(fastPurchaseHelpKeyboard(chatId).reply_markup, { chat_id: chatId, message_id: mid }).catch(() => {});
  } catch (_) {}
  return;
}
}
 

// ===================== LANGUAGE TOGGLE (ALL USERS) =====================
if (data === "lang:toggle") {
  const u = getUser(chatId);
  u.lang = (u.lang === "sw") ? "en" : "sw";
  saveDB();

  const msg = (u.lang === "sw") ? "✅ Kiswahili imewashwa" : "⬜️ Kiswahili imezimwa";
  await bot.answerCallbackQuery(q.id, { text: msg }).catch(() => {});

  try {
    const mid = q.message?.message_id;
    if (mid) {
      await bot.editMessageText(helpAnswerText("settings", chatId), {
        chat_id: chatId,
        message_id: mid,
        parse_mode: "Markdown",
        reply_markup: settingsMenuKeyboard(chatId).reply_markup,
        disable_web_page_preview: true,
      }).catch(() => {});
    }
  } catch (_) {}

  return;
}

// ======================================================================


// ===========================================================================





if (data === "forcejoin:check") {
  const ok = await ensureJoinedChannel(actorId);
  if (!ok) {
    await bot.answerCallbackQuery(q.id, { text: "❌ Not joined yet. Join then tap again." }).catch(() => {});
    await sendJoinGate(actorId);
    return;
  }
  await bot.answerCallbackQuery(q.id, { text: "✅ Verified!" }).catch(() => {});
  try { await deleteLastJoinGate(actorId); } catch (_) {}

// Reset any interrupted flow so user lands on clean home menu
try {
  sessions.delete(actorId);
  sessionHistory.delete(String(actorId));
} catch (_) {}
try {
  const u = getUser(actorId);
  if (u) u.pendingAction = null;
  saveDB();
} catch (_) {}


      await bot.sendMessage(actorId, "✅ Access granted.", mainMenuKeyboard(actorId)).catch(() => {});
  return;
}


// Weekly Draw quick-buy suggested package
if (data.startsWith("wdqbuy:")) {
  const parts = data.split(":");
  const catId = Number(parts[1]);
  const pkgIndex = Number(parts[2]);

  const category = WD_QUICK_CATS[catId];
  const list = category ? (PACKAGES[category] || []) : [];
  const pkg = (Number.isFinite(pkgIndex) && pkgIndex >= 0) ? list[pkgIndex] : null;

  if (!category || !pkg) {
    await bot.answerCallbackQuery(q.id, { text: "❌ This package is not available now. Try again.", show_alert: true }).catch(() => {});
    return;
  }

  await bot.answerCallbackQuery(q.id, { text: "📱 Enter number to continue…" }).catch(() => {});
      // Remove plan buttons (hide inline keyboard)
      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: q.message.chat.id, message_id: q.message.message_id }
        );
      } catch (_) {}

  // Use existing flow: ask for phone then proceed with STK checks
  pushPrev(chatId, sessions.get(chatId) || { step: null });
  sessions.set(chatId, { step: "phone", category, pkgKey: pkg.label, createdAt: Date.now() });

  const _baseT = weeklyDrawBaseTickets(pkg.price);
  const _totalT = weeklyDrawTicketsWithBonus(chatId, _baseT);

  return sendTracked(chatId, `📱 Enter M-PESA number for:
*${pkg.label}*

💳 After successful payment, you will receive the bundle directly to your line.
🎟 You will earn *${_totalT} ticket(s)* for the Weekly Draw.

✅ We will verify limits then send STK.`, { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) });
}


try {
  if (!(typeof isAdmin === "function" && isAdmin(actorId))) {
    const joined = await ensureJoinedChannel(actorId);
    if (!joined) {
      await bot.answerCallbackQuery(q.id, { text: "🔒 Join channel first." }).catch(() => {});
      await sendJoinGate(actorId);
      return;
    }
  }
} catch (_) {}


  


// ===== WEEKLY DRAW USER INLINE MENU =====
if (data.startsWith("wdusr:")) {
  const action = data.split(":")[1] || "";
  const c = ensureWeeklyDrawObject();

  // Opt-in is per USER (from.id), not per chatId (in case the bot is used in groups/channels)
  const actorId = String((q.from && q.from.id) ? q.from.id : chatId);

  if (!c.enabled) {
    await bot.answerCallbackQuery(q.id, { text: "Weekly Draw is not active." }).catch(() => {});
    return;
  }

  const refreshMenu = async () => {
    if (q.message && q.message.chat && q.message.message_id) {
      await bot.editMessageReplyMarkup(
        weeklyDrawUserMenuKeyboard(actorId).reply_markup,
        { chat_id: q.message.chat.id, message_id: q.message.message_id }
      ).catch(() => {});
    }
    try { startWeeklyDrawLiveUpdate(actorId, q.message?.message_id, true); } catch (_) {}
  };

  if (action === "optin") {
    setWeeklyDrawOptIn(actorId, true);
    await bot.answerCallbackQuery(q.id, { text: "🎉 Joined! You will now receive Weekly Draw updates.", show_alert: true }).catch(() => {});
    // After joining, show suggested quick-buy offers on the same Weekly Draw message (screenshot UI)
    try {
      const p = wdJoinSuggestedPayload();
      await editInlineMessage(q, p.text, p.keyboard);
    } catch (_) {
      const caption = buildWeeklyDrawMainCaption(actorId);
      await editInlineMessage(q, caption, weeklyDrawUserMenuKeyboard(actorId, "menu"));
    }
    return;
  }

  if (action === "optout") {
    setWeeklyDrawOptIn(actorId, false);
    await bot.answerCallbackQuery(q.id, { text: "😔 Left Weekly Draw. No more campaign messages.", show_alert: true }).catch(() => {});
    const caption = buildWeeklyDrawMainCaption(actorId);
    await editInlineMessage(q, caption, weeklyDrawUserMenuKeyboard(actorId, "menu"));
    return;
  }


    if (action === "more") {
    await bot.answerCallbackQuery(q.id, { text: tr(chatId,"More…","Zaidi…") }).catch(() => {});
    const txt = weeklyDrawMoreText(chatId) + weeklyDrawLastWinnersText(chatId);
    await editInlineMessage(q, txt, weeklyDrawUserMenuKeyboard(actorId, "more"));
    return;
  }

  if (action === "prev") {
    await bot.answerCallbackQuery(q.id, { text: "Previous winners" }).catch(() => {});
    const txt = weeklyDrawLastWinnersText(chatId).trim() || tr(chatId,"No previous winners yet.","Bado hakuna washindi wa awali.");
    await editInlineMessage(q, txt, weeklyDrawUserMenuKeyboard(actorId, "prev"));
    return;
  }

  
  if (action === "back") {
    await bot.answerCallbackQuery(q.id, { text: "Back" }).catch(() => {});
    // If opted-in, return to suggested offers UI; otherwise return to normal menu.
    if (isWeeklyDrawOptedIn(actorId)) {
      const p = wdJoinSuggestedPayload();
      await editInlineMessage(q, p.text, p.keyboard);
    } else {
      const caption = buildWeeklyDrawMainCaption(actorId);
      await editInlineMessage(q, caption, weeklyDrawUserMenuKeyboard(actorId, "menu"));
    }
    return;
  }

  // Used by the quick-deals keyboard "⬅️ Rudi"
  if (action === "menu") {
    await bot.answerCallbackQuery(q.id, { text: "Menu" }).catch(() => {});
    if (isWeeklyDrawOptedIn(actorId)) {
      const p = wdJoinSuggestedPayload();
      await editInlineMessage(q, p.text, p.keyboard);
    } else {
      const caption = buildWeeklyDrawMainCaption(actorId);
      await editInlineMessage(q, caption, weeklyDrawUserMenuKeyboard(actorId, "menu"));
    }
    return;
  }

if (action === "refresh") {
    await bot.answerCallbackQuery(q.id, { text: "Refreshing…" }).catch(() => {});
    await refreshMenu();
    // Re-render handled elsewhere (user can tap ${tr(chatId,"🎉 WEEKLY DRAW","🎉 DROO YA WIKI")} again)
    return;
  }

  
if (action === "claim") {
  const { rec } = getWeeklyDrawWinnerRecord(actorId);
  if (!rec) {
    await bot.answerCallbackQuery(q.id, { text: "❌ You are not among the winners.", show_alert: true }).catch(() => {});
    return;
  }

if (action === "editclaim") {
  const { rec } = getWeeklyDrawWinnerRecord(actorId);
  if (!rec) {
    await bot.answerCallbackQuery(q.id, { text: "❌ You are not among the winners.", show_alert: true }).catch(() => {});
    return;
  }
  if (rec.paid === true) {
    await bot.answerCallbackQuery(q.id, { text: "✅ Already marked as PAID.", show_alert: true }).catch(() => {});
    await refreshMenu();
    return;
  }
  await bot.answerCallbackQuery(q.id, { text: "✏️ Edit your M-PESA details", show_alert: true }).catch(() => {});
  setPendingAction(actorId, {
    type: "wd_claim",
    step: "phone",
    isEdit: true,
    msgChatId: q.message?.chat?.id,
    msgId: q.message?.message_id
  });

  await bot.sendMessage(
    actorId,
    "✏️ Send the NEW M-PESA number for payout (07XXXXXXXX / 01XXXXXXXX / 2547XXXXXXXX / 2541XXXXXXXX).\n\nType /cancel to stop."
  ).catch(() => {});
  return;
}

  if (rec.paid === true) {
    await bot.answerCallbackQuery(q.id, { text: "✅ Already marked as PAID.", show_alert: true }).catch(() => {});
    await refreshMenu();
    return;
  }
  if (rec.payoutSubmitted === true) {
    await bot.answerCallbackQuery(q.id, { text: "✅ Already submitted. Please wait for payment.", show_alert: true }).catch(() => {});
    await refreshMenu();
    return;
  }

  await bot.answerCallbackQuery(q.id, { text: "📲 Submit your M-PESA details", show_alert: true }).catch(() => {});
  // Store inline message reference so we can refresh buttons after submit
  setPendingAction(actorId, {
    type: "wd_claim",
    step: "phone",
    msgChatId: q.message?.chat?.id,
    msgId: q.message?.message_id
  });

  await bot.sendMessage(
    actorId,
    "📲 Send your M-PESA number to receive payout (07XXXXXXXX / 01XXXXXXXX / 2547XXXXXXXX / 2541XXXXXXXX).\n\nType /cancel to stop."
  ).catch(() => {});
  return;
}

await bot.answerCallbackQuery(q.id, { text: "Unknown action" }).catch(() => {});
  await refreshMenu();
  return;
}

// ===== WEEKLY DRAW ADMIN INLINE MENU =====
if (data.startsWith("wdadm:")) {
  // Admin-only
  if (!(typeof isAdmin === "function" && isAdmin(chatId))) {
    await bot.answerCallbackQuery(q.id, { text: "Admin only." }).catch(() => {});
    return;
  }

  const c = ensureWeeklyDrawObject();

  const action = data.split(":")[1] || "";
  if (action === "menu") {
    await bot.answerCallbackQuery(q.id, { text: "Menu" }).catch(() => {});
    const statusText = formatWeeklyDrawAdminStatus();
    await editInlineMessage(q, statusText, weeklyDrawAdminMenuKeyboard());
    return;
  }

  if (action === "toggle") {
    c.enabled = !c.enabled;
    if (c.enabled && (!c.status || c.status === "OFF")) c.status = "RUNNING";
    try { saveDB(); } catch (_) {}
    await bot.answerCallbackQuery(q.id, { text: c.enabled ? "Enabled" : "Hidden" }).catch(() => {});
    const statusText = formatWeeklyDrawAdminStatus();
    await editInlineMessage(q, statusText, weeklyDrawAdminMenuKeyboard());
    return;
  }




if (action === "set_name") {
  setWeeklyDrawAdminState(chatId, { mode: "set_name" });
  await bot.answerCallbackQuery(q.id, { text: "Send new campaign name." }).catch(() => {});
  await bot.sendMessage(chatId, "✏️ Send new campaign *name* now:", { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }).catch(() => {});
  return;
}

if (action === "add_media") {
  setWeeklyDrawAdminState(chatId, { mode: "add_media" });
  await bot.answerCallbackQuery(q.id, { text: "Send photo/video. Send DONE when finished." }).catch(() => {});
  await bot.sendMessage(chatId, "🖼 Send *photo/video* to add (you can send many). Send `DONE` when finished.", { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }).catch(() => {});
  return;
}

if (action === "clear_media") {
  c.media = [];
  c.image = "";
  try { saveDB(); } catch (_) {}
  await bot.answerCallbackQuery(q.id, { text: "✅ Media cleared." }).catch(() => {});
  const statusText = formatWeeklyDrawAdminStatus();
  await editInlineMessage(q, statusText, weeklyDrawAdminMenuKeyboard());
  return;
}



if (action === "reset_factory" || action === "reset_referrals" || action === "reset_balances") {
  const kind = action.replace("reset_", "");
  setWeeklyDrawAdminState(chatId, { mode: "confirm_reset", kind });
  const title = (kind === "factory") ? "FACTORY RESET (DELETE ALL DATA)"
    : (kind === "referrals") ? "RESET REFERRALS ONLY"
    : "CLEAR ALL USER BALANCES";
  const warn =
    `⚠️ ${title}\n\n` +
    `Reply with: YES\n` +
    `to confirm.\n\n` +
    `Or send /cancel to stop.`;
  await bot.answerCallbackQuery(q.id, { text: "⚠️ Type YES to confirm." }).catch(() => {});
  await bot.sendMessage(chatId, warn, { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }).catch(() => {});
  return;
}

if (action === "broadcast") {
  await bot.answerCallbackQuery(q.id, { text: "📢 Broadcasting…", show_alert: false }).catch(() => {});
  try {
    await broadcastWeeklyDrawLaunch(true); // force broadcast
    await bot.answerCallbackQuery(q.id, { text: "✅ Broadcast sent.", show_alert: false }).catch(() => {});
  } catch (e) {
    console.log("wdadm:broadcast error:", e?.message || e);
    await bot.answerCallbackQuery(q.id, { text: "❌ Broadcast failed. Check logs.", show_alert: true }).catch(() => {});
  }
  const statusText = formatWeeklyDrawAdminStatus();
  await editInlineMessage(q, statusText, weeklyDrawAdminMenuKeyboard());
  return;
}

  if (action === "status") {
    await bot.answerCallbackQuery(q.id, { text: "Status" }).catch(() => {});
    const statusText = formatWeeklyDrawAdminStatus();
    await editInlineMessage(q, statusText, weeklyDrawAdminMenuKeyboard());
    return;
  }


if (action === "quals") {
    await bot.answerCallbackQuery(q.id, { text: "Qualifications" }).catch(() => {});
    await editInlineMessage(q, "✅ Weekly Draw Qualifications (mark/unmark and set values):", weeklyDrawQualificationsKeyboard());
    return;
  }

if (action === "qual_toggle") {
    const key = data.split(":")[2] || "";
    c.qualifications = c.qualifications || {};
    c.qualifications[key] = c.qualifications[key] || { enabled: false };
    c.qualifications[key].enabled = !c.qualifications[key].enabled;
    try { saveDB(); } catch (_) {}
    await bot.answerCallbackQuery(q.id, { text: c.qualifications[key].enabled ? "Enabled" : "Disabled" }).catch(() => {});
    await editInlineMessage(q, "✅ Weekly Draw Qualifications (mark/unmark and set values):", weeklyDrawQualificationsKeyboard());
    return;
  }

if (action === "qual_set") {
    const key = data.split(":")[2] || "";
    c.qualifications = c.qualifications || {};
    c.qualifications[key] = c.qualifications[key] || { enabled: true };
  // Ensure nested config objects exist
  if (key === "bizMonths") c.qualifications.bizMonths = c.qualifications.bizMonths || { enabled: true, minMonths: 0 };
    setWeeklyDrawAdminState(chatId, { mode: "set_qual", key, messageId: q.message?.message_id });
    await bot.answerCallbackQuery(q.id, { text: "Send value" }).catch(() => {});
    await editInlineMessage(q, qualificationPromptFor(key), weeklyDrawQualificationsKeyboard());
    return;
  }
  if (action === "set_prizes") {
    setWeeklyDrawAdminState(chatId, { mode: "set_prizes", messageId: q.message?.message_id });
    await bot.answerCallbackQuery(q.id, { text: "Send prizes" }).catch(() => {});
    await editInlineMessage(q, "📝 Send prizes as: 250 150 100 (total ≤ 500).", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "wdadm:menu" }]] } });
    return;
  }

  

if (action === "set_winnerscount") {
  setWeeklyDrawAdminState(chatId, { mode: "set_winnerscount" });
  await bot.answerCallbackQuery(q.id, { text: "Send number of winners (e.g. 5)." }).catch(() => {});
  await bot.sendMessage(chatId, "👥 Send the *number of winners* to award (e.g. `5`).", { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }).catch(() => {});
  return;
}

if (action === "set_period") {
    setWeeklyDrawAdminState(chatId, { mode: "set_period", messageId: q.message?.message_id });
    await bot.answerCallbackQuery(q.id, { text: "Send period" }).catch(() => {});
    await editInlineMessage(q, "🗓 Send period as either:\n• Dates: YYYY-MM-DD YYYY-MM-DD\n• Duration: 5d, 1w, 2d 1h, 1mo, 1yr (or just 5 = 5 days)\n• Range: 5,6 (uses max)\n\nExample: 7d", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "wdadm:menu" }]] } });
    return;
  }

  
if (action === "set_image") {
    setWeeklyDrawAdminState(chatId, { mode: "set_image", messageId: q.message?.message_id });
    await bot.answerCallbackQuery(q.id, { text: "Send image" }).catch(() => {});
    await editInlineMessage(q, "🖼 Send a PHOTO now, or paste an image URL for WEEKLY DRAW.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "wdadm:menu" }]] } });
    return;
  }

if (action === "set_heading") {
    setWeeklyDrawAdminState(chatId, { mode: "set_heading", messageId: q.message?.message_id });
    await bot.answerCallbackQuery(q.id, { text: "Send heading" }).catch(() => {});
    await editInlineMessage(q, "📝 Send new heading text for WEEKLY DRAW.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "wdadm:menu" }]] } });
    return;
  }

  if (action === "restart") {
    // Reset everything (tickets/entries/winners) and start fresh
    c.entries = {};
    c.winners = [];
    c.rankCache = {};
    c.reminders = {};
    c.status = "RUNNING";
    c.enabled = true;
    const now = Date.now();
    c.startAt = now;
    // default 7 days
    c.endAt = now + 7 * 24 * 60 * 60 * 1000;
    try { saveDB(); } catch (_) {}
    broadcastWeeklyDrawLaunch(false).catch(() => {});
    setWeeklyDrawAdminState(chatId, null);
    await bot.answerCallbackQuery(q.id, { text: "Restarted" }).catch(() => {});
    const statusText = formatWeeklyDrawAdminStatus();
    await bot.sendMessage(chatId, `🔄 WEEKLY DRAW restarted.\n\n${statusText}`, weeklyDrawAdminMenuKeyboard()).catch(() => {});
    return;
  }

  if (action === "end") {
    await bot.answerCallbackQuery(q.id, { text: "Ending..." }).catch(() => {});
    await weeklyDrawFreezeAndAnnounce("🏁 Ended by admin.");
    const statusText = formatWeeklyDrawAdminStatus();
    await editInlineMessage(q, statusText, weeklyDrawAdminMenuKeyboard());
    return;
  }

  if (action === "pay") {
    await bot.answerCallbackQuery(q.id, { text: "Pay winners" }).catch(() => {});
    await editInlineMessage(q, "💰 Tap a winner to mark as Paid ✅ (confirmation required).", weeklyDrawPayWinnersKeyboard());
    return;
  }

  if (action === "toggle_paid") {
    const target = data.split(":")[2] || "";
    const winners = Array.isArray(c.winners) ? c.winners : [];
    const w = winners.find((x) => String(x.chatId) === String(target));

if (w && w.paid !== true) {
  const winName = (w.name || safeDisplayName(getUser(w.chatId), w.chatId) || String(w.chatId));
  const prizeAmt = Number(w.prize || 0);
  await bot.answerCallbackQuery(q.id, { text: "Confirm payment?", show_alert: false }).catch(() => {});
  await editInlineMessage(
    q,
    `✅ Confirm payment marked as PAID?

Winner: ${winName}
ChatId: ${w.chatId}
Amount: Ksh ${prizeAmt}

Tap ✅ Confirm Paid to proceed.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Confirm Paid", callback_data: `wdadm:toggle_paid_confirm:${target}` }],
          [{ text: "⬅️ Back", callback_data: "wdadm:pay" }]
        ]
      }
    }
  );
  return;
}

    if (w) {
      w.paid = true;

// Keep Previous Winners snapshot in sync too
if (c.lastEnded && Array.isArray(c.lastEnded.winners)) {
  const lastW = c.lastEnded.winners.find((x) => String(x.chatId) === String(target));
  if (lastW) lastW.paid = true;
}

              // 🔔 Notify admin + winner when marked paid
              try {
                const winName = (w.name || safeDisplayName(getUser(w.chatId), w.chatId) || String(w.chatId));
                const prizeAmt = Number(w.prize || 0);
                const paidAt = new Date().toISOString().replace("T"," ").slice(0,19);

                // Winner message
                bot.sendMessage(
                  String(w.chatId),
                  `✅ Payment Confirmed!

🎉 Weekly Draw payout has been marked as PAID.

Winner: ${winName}
Amount: Ksh ${prizeAmt}
Time: ${paidAt}`
                ).catch(() => {});

                // Admin message
                bot.sendMessage(
                  String(ADMIN_ID),
                  `✅ Paid Confirmed

Winner: ${winName}
ChatId: ${w.chatId}
Amount: Ksh ${prizeAmt}
Time: ${paidAt}`
                ).catch(() => {});
              } catch (_) {}
      try { saveDB(); } catch (_) {}
      await bot.answerCallbackQuery(q.id, { text: w.paid ? "Marked Paid" : "Marked Pending" }).catch(() => {});
    } else {
      await bot.answerCallbackQuery(q.id, { text: "Winner not found" }).catch(() => {});
    }
    await editInlineMessage(q, "💰 Tap a winner to mark as Paid ✅ (confirmation required).", weeklyDrawPayWinnersKeyboard());
    return;
  }

  
if (action === "toggle_paid_confirm") {
  const target = data.split(":")[2] || "";
  const winners = Array.isArray(c.winners) ? c.winners : [];
  const w = winners.find((x) => String(x.chatId) === String(target));
  if (w) {
    if (w.paid === true) {
      await bot.answerCallbackQuery(q.id, { text: "Already Paid" }).catch(() => {});
    } else {
      w.paid = true;

      // Keep Previous Winners snapshot in sync too
      if (c.lastEnded && Array.isArray(c.lastEnded.winners)) {
        const lastW = c.lastEnded.winners.find((x) => String(x.chatId) === String(target));
        if (lastW) lastW.paid = true;
      }

      // 🔔 Notify admin + winner when marked paid
      try {
        const winName = (w.name || safeDisplayName(getUser(w.chatId), w.chatId) || String(w.chatId));
        const prizeAmt = Number(w.prize || 0);
        const paidAt = new Date().toISOString().replace("T"," ").slice(0,19);

        bot.sendMessage(
          String(w.chatId),
          `✅ Payment Confirmed!\n\n🎉 Weekly Draw payout has been marked as PAID.\n\nWinner: ${winName}\nAmount: Ksh ${prizeAmt}\nTime: ${paidAt}`
        ).catch(() => {});

        bot.sendMessage(
          String(ADMIN_ID),
          `✅ Paid Confirmed\n\nWinner: ${winName}\nChatId: ${w.chatId}\nAmount: Ksh ${prizeAmt}\nTime: ${paidAt}`
        ).catch(() => {});
      } catch (_) {}

      try { saveDB(); } catch (_) {}
      await bot.answerCallbackQuery(q.id, { text: "Marked Paid ✅" }).catch(() => {});
    }
  } else {
    await bot.answerCallbackQuery(q.id, { text: "Winner not found" }).catch(() => {});
  }
  await editInlineMessage(q, "💰 Tap a winner to mark as Paid ✅ (confirmation required).", weeklyDrawPayWinnersKeyboard());
  return;
}


if (action === "reset_claim") {
  const target = data.split(":")[2] || "";
  const winners = Array.isArray(c.winners) ? c.winners : [];
  const w = winners.find((x) => String(x.chatId) === String(target));
  if (!w) {
    await bot.answerCallbackQuery(q.id, { text: "Winner not found" }).catch(() => {});
    return;
  }
  const winName = (w.name || safeDisplayName(getUser(w.chatId), w.chatId) || String(w.chatId));
  await bot.answerCallbackQuery(q.id, { text: "Confirm reset?" }).catch(() => {});
  await editInlineMessage(
    q,
    `🔄 Reset claim details for:\n${winName} (ChatId: ${w.chatId})\n\nThis will clear submitted M-PESA details and set status back to Pending.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Confirm Reset", callback_data: `wdadm:reset_claim_confirm:${target}` }],
          [{ text: "⬅️ Back", callback_data: "wdadm:pay" }]
        ]
      }
    }
  );
  return;
}

if (action === "reset_claim_confirm") {
  const target = data.split(":")[2] || "";
  const winners = Array.isArray(c.winners) ? c.winners : [];
  const w = winners.find((x) => String(x.chatId) === String(target));
  if (!w) {
    await bot.answerCallbackQuery(q.id, { text: "Winner not found" }).catch(() => {});
    return;
  }

  w.payoutSubmitted = false;
  w.payoutPhone = "";
  w.payoutName = "";
  w.paid = false;

  // keep previous snapshot synced too
  if (c.lastEnded && Array.isArray(c.lastEnded.winners)) {
    const lw = c.lastEnded.winners.find((x) => String(x.chatId) === String(target));
    if (lw) {
      lw.payoutSubmitted = false;
      lw.payoutPhone = "";
      lw.payoutName = "";
      lw.paid = false;
    }
  }

  try { saveDB(); } catch (_) {}
  await bot.answerCallbackQuery(q.id, { text: "Reset done ✅" }).catch(() => {});
  await editInlineMessage(q, "💰 Tap a winner to mark as Paid ✅ (confirmation required).", weeklyDrawPayWinnersKeyboard());
  return;
}

await bot.answerCallbackQuery(q.id, { text: "Unknown action" }).catch(() => {});
  return;
}
if (data === "ui:close") {
    await bot.answerCallbackQuery(q.id, { text: "Closed." }).catch(() => {});
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id });
    } catch (_) {}
    return;
  }

  if (data === "ui:buy_last") {
    await bot.answerCallbackQuery(q.id, { text: "Opening…" }).catch(() => {});
    const u = getUser(chatId);
    const lp = u.lastPurchase;
    if (!lp || !lp.category || !lp.pkgLabel) {
      return sendTracked(
  chatId,
  `🔗 Your Referral Details

Referral Code:
${referralCode} (copied)

Referral Command:
${referralCommand} (copied)

Referral Link:
${referralLink} (copied)

<b>Your points:</b> ${pts} pts
<b>Total successful referrals:</b> ${totalReferrals}
<b>Total earned:</b> Ksh ${Number(totalEarned || 0).toFixed(2)}

Rule: You earn when your referred user completes a successful purchase.`,
  { parse_mode: "HTML", ...mainMenuKeyboard(chatId) }
);
    }

    const pkg = findPackageByLabel(lp.category, lp.pkgLabel);
    if (!pkg) {
      return sendTracked(chatId, "❌ Last offer not available right now. Tap 🛒 Buy Offers.", { ...mainMenuKeyboard(chatId) });
    }

    const s = sessions.get(chatId) || {};
    pushPrev(chatId, s);
    s.step = "confirm";
    s.category = lp.category;
    s.pkgKey = pkg.label;
    sessions.set(chatId, s);

    const hasSaved = !!getUserPhone(chatId);
    return sendTracked(
      chatId,
      `🔁 *Buy Again*\n\nCategory: *${mdEscape(lp.category)}*\nOffer: *${mdEscape(pkg.label)}*\nPrice: *Ksh ${mdEscape(String(pkg.price))}*\n\n✅ Tap Proceed to pay or Change Number.`,
      { parse_mode: "Markdown", ...(isFastPurchaseEnabled(chatId) ? confirmKeyboardV2(chatId, s, hasSaved) : confirmKeyboard(hasSaved)) }
    );
  }

  if (data.startsWith("ui:upgrade:")) {
    await bot.answerCallbackQuery(q.id, { text: "Opening…" }).catch(() => {});
    const parts = data.split(":");
    const cat = base64UrlDecode(parts[2] || "");
    const lbl = base64UrlDecode(parts[3] || "");
    if (!cat || !lbl) return;

    const pkg = findPackageByLabel(cat, lbl);
    if (!pkg) {
      return sendTracked(chatId, "❌ Upgrade offer not available right now. Tap 🛒 Buy Offers.", { ...mainMenuKeyboard(chatId) });
    }

    const s = sessions.get(chatId) || {};
    pushPrev(chatId, s);
    s.step = "confirm";
    s.category = cat;
    s.pkgKey = pkg.label;
    sessions.set(chatId, s);

    const hasSaved = !!getUserPhone(chatId);
    return sendTracked(
      chatId,
      `🚀 *Upgrade Offer*\\n\\nCategory: *${mdEscape(cat)}*\\nOffer: *${mdEscape(pkg.label)}*\\nPrice: *Ksh ${mdEscape(String(pkg.price))}*\\n\\n✅ Tap Proceed to pay or Change Number.`,
      { parse_mode: "Markdown", ...(isFastPurchaseEnabled(chatId) ? confirmKeyboardV2(chatId, s, hasSaved) : confirmKeyboard(hasSaved)) }
    );
  }

    if (!data.startsWith("ui:")) return;
    // remove buttons after click (best effort)
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message?.message_id });
    } catch (_) {}

    const action = data.slice(3);
    // ===================== STK DELAY: RETRY / CANCEL =====================
    if (action.startsWith("stk_cancel:")) {
      const ref = action.split(":").slice(1).join(":");
      const pending = getPendingPayment(ref);

      // Stop any scheduled auto-retries for this reference
      try { clearAutoRetryStk(chatId, ref); } catch (_) {}

      if (pending) {
        deletePendingPayment(ref);
      }

      await bot.answerCallbackQuery(q.id, { text: "Cancelled" }).catch(() => {});
      return sendTracked(
        chatId,
        "❌ Pending STK request cancelled. You can start again anytime.",
        { ...mainMenuKeyboard(chatId) }
      );
    }

    if (action.startsWith("stk_retry_prompt:")) {
      const ref = action.split(":").slice(1).join(":");
      const pending = getPendingPayment(ref);

      if (!pending) {
        await bot.answerCallbackQuery(q.id, { text: "Expired" }).catch(() => {});
        return sendTracked(chatId, tr(chatId, "⚠️ This STK request expired. Please try again from 🛒 Buy Offers.", "⚠️ Ombi hili la STK limeisha. Tafadhali jaribu tena kupitia 🛒 Nunua Ofa."), {
          ...mainMenuKeyboard(chatId),
        });
      }

      await bot.answerCallbackQuery(q.id).catch(() => {});
      return sendTracked(
        chatId,
        `📲 Do you still have the M-PESA prompt open?\n\n` +
          `✅ If yes, just complete it (no need to retry).\n` +
          `❌ If no prompt, you can retry now.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ I have the prompt", callback_data: `ui:stk_have_prompt:${ref}` }],
              [{ text: "❌ No prompt, retry", callback_data: `ui:retry_stk:${ref}` }],
              [{ text: "❌ Cancel Pending", callback_data: `ui:stk_cancel:${ref}` }],
              [{ text: "🛒 Buy Offers", callback_data: "ui:buy_offers" }],
            ],
          },
        }
      );
    }

    if (action.startsWith("stk_have_prompt:")) {
      await bot.answerCallbackQuery(q.id, { text: "OK" }).catch(() => {});
      return sendTracked(
        chatId,
        "✅ Great. Complete the M-PESA prompt on your phone. Once successful, you’ll receive a confirmation here.",
        { ...mainMenuKeyboard(chatId) }
      );
    }

    if (action.startsWith("retry_stk:")) {
      const ref = action.split(":").slice(1).join(":");
      const pending = getPendingPayment(ref);

      if (!pending) {
        await bot.answerCallbackQuery(q.id, { text: "Expired" }).catch(() => {});
        return sendTracked(chatId, tr(chatId, "⚠️ This STK request expired. Please try again from 🛒 Buy Offers.", "⚠️ Ombi hili la STK limeisha. Tafadhali jaribu tena kupitia 🛒 Nunua Ofa."), {
          ...mainMenuKeyboard(chatId),
        });
      }

      // Retry automatically expires after 2 minutes to prevent abuse
      const ageMs = Date.now() - Number(pending.createdAt || 0);
      if (ageMs > STK_RETRY_EXPIRE_MS) {
        deletePendingPayment(ref);
        await bot.answerCallbackQuery(q.id, { text: "Expired" }).catch(() => {});
        return sendTracked(
          chatId,
          "⚠️ This STK retry window expired (2 minutes). Please start again from 🛒 Buy Offers.",
          { ...mainMenuKeyboard(chatId) }
        );
      }

      await bot.answerCallbackQuery(q.id, { text: "Retrying..." }).catch(() => {});

      try {
        await payheroStkPush({
          amount: pending.price,
          phone: pending.phone254,
          externalRef: ref,
          channelId: channelIdForCategory(pending.category),
        });

        return sendTracked(chatId, "📲 STK re-sent. Please check your phone.", { ...mainMenuKeyboard(chatId) });
      } catch (e) {
        return sendTracked(
          chatId,
          `⚠️ Still delayed. If no prompt appears, wait 1 minute and retry.\n\nHelp: ${HELP_PHONE}`,
          { ...mainMenuKeyboard(chatId) }
        );
      }
    }



    if (action === "buy_offers") {
      const s = { step: "category", category: null, pkgKey: null, createdAt: Date.now() };
      sessions.set(chatId, s);
      await bot.answerCallbackQuery(q.id).catch(() => {});
      return sendTracked(chatId, section("CHOOSE CATEGORY") + "✅ Choose a category:", categoriesKeyboard(chatId));
    }

    if (action === "buy_again") {
      const u = getUser(chatId);
      const lp = u.lastPurchase;
      if (!lp || !lp.category || !lp.pkgLabel) {
        await bot.answerCallbackQuery(q.id, { text: "No recent package found." }).catch(() => {});
        return;
      }
      const s = { step: "confirm", category: lp.category, pkgKey: lp.pkgLabel, createdAt: Date.now() };
      sessions.set(chatId, s);
      await bot.answerCallbackQuery(q.id).catch(() => {});
      return renderSessionSnapshot(chatId, s);
    }

    if (action === "upgrade_5gb") {
      // Upgrade path: Unlimited 2GB -> 5GB 3 DAYS
      const s = { step: "confirm", category: "Unlimited Deals", pkgKey: "Ksh 251 • 5GB 3 DAYS", createdAt: Date.now() };
      sessions.set(chatId, s);
      await bot.answerCallbackQuery(q.id).catch(() => {});
      return renderSessionSnapshot(chatId, s);
    }

    await bot.answerCallbackQuery(q.id).catch(() => {});
  } catch (e) {
    try { await bot.answerCallbackQuery(q.id).catch(() => {}); } catch (_) {}
  }
});

// ===================== ADMIN INLINE ACTIONS =====================
bot.on("callback_query", async (q) => {
  try {
    const data = String(q.data || "");

    // Ignore unrelated callbacks so other handlers don't throw
    if (!data.startsWith("redeem_") && 
        !data.startsWith("phone_") && 
        !data.startsWith("withdraw_") &&
        !data.startsWith("ac:") &&
        !data.startsWith("dc:") &&
        !data.startsWith("bcast:") &&
        !data.startsWith("rot:stop:")) {
      await bot.answerCallbackQuery(q.id).catch(() => {});
      return;
    }

    const chatId = q.message?.chat?.id;

    // Admin only
    if (!isAdmin(chatId)) {
      await bot.sendMessage(chatId, "❌ Not allowed.").catch(() => {});
      await bot.answerCallbackQuery(q.id).catch(() => {});
      return;
    }

    
    // ===================== ROTATION BROADCAST CALLBACKS =====================
    // Stop rotation
    if (data.startsWith("rot:stop:")) {
      const rid = data.split(":").slice(2).join(":");
      const ok = stopRotation(rid);

      // remove buttons from the message
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message?.message_id });
      } catch (_) {}

      await bot.answerCallbackQuery(q.id, { text: ok ? "Stopped." : "Not found." }).catch(() => {});
      if (ok) await bot.sendMessage(chatId, `✅ Rotation stopped: ${rid}`).catch(() => {});
      return;
    }

    // /bcast menu
    if (data.startsWith("bcast:")) {
      const choice = data.split(":")[1] || "";
      const st = adminState.get(String(chatId));

      // remove menu buttons
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message?.message_id });
      } catch (_) {}

      if (!st || st.step !== "await_bcast_choice") {
        await bot.answerCallbackQuery(q.id, { text: "No active broadcast menu." }).catch(() => {});
        return;
      }

      if (choice === "cancel") {
        adminState.delete(String(chatId));
        await bot.answerCallbackQuery(q.id).catch(() => {});
        await bot.sendMessage(chatId, "✅ Cancelled.").catch(() => {});
        return;
      }

      const { fromChatId, messageId, days } = st;

      try {
        if (choice === "once") {
          const result = await broadcastCopyMessage(fromChatId, messageId);
          incBroadcastStats();
          await bot.sendMessage(
            chatId,
            `📣 Broadcast sent once.\nSent: ${result.sent}\nFailed: ${result.failed}\nUsers: ${result.total}`
          ).catch(() => {});
        } else if (choice === "rot_now") {
          const rot = addRotation({ fromChatId, messageId, days });
          rot.nextRunAt = Date.now(); // start now
          saveDB();
          await bot.sendMessage(chatId, `✅ Rotation started (NOW)\nID: ${rot.id}\nDays: ${days}\nUse /rotlist to stop.`).catch(() => {});
        } else if (choice === "rot_tom") {
          const rot = addRotation({ fromChatId, messageId, days });
          rot.nextRunAt = Date.now() + 24 * 60 * 60 * 1000; // start tomorrow
          saveDB();
          await bot.sendMessage(chatId, `✅ Rotation scheduled (TOMORROW)\nID: ${rot.id}\nDays: ${days}\nUse /rotlist to stop.`).catch(() => {});
        }
      } catch (e) {
        await bot.sendMessage(chatId, `⚠️ Broadcast error: ${e?.message || e}`).catch(() => {});
      } finally {
        adminState.delete(String(chatId));
        await bot.answerCallbackQuery(q.id).catch(() => {});
      }
      return;
    }

// Withdraw quick actions via inline buttons (same behavior as /ac /dc)
    if (data.startsWith("ac:") || data.startsWith("dc:")) {
      const [cmd, targetId] = data.split(":");
      if (!targetId) {
        await bot.sendMessage(chatId, "❌ Invalid request.").catch(() => {});
        await bot.answerCallbackQuery(q.id).catch(() => {});
        return;
      }
      if (cmd === "ac") {
        await __withdrawApprove(targetId, chatId, q.message?.message_id);
        await bot.answerCallbackQuery(q.id).catch(() => {});
        return;
      }
      if (cmd === "dc") {
        await __withdrawDecline(targetId, chatId, q.message?.message_id);
        await bot.answerCallbackQuery(q.id).catch(() => {});
        return;
      }
    }

    if (!data.startsWith("redeem_") && !data.startsWith("withdraw_") && !data.startsWith("phone_") && !data.startsWith("ac:") && !data.startsWith("dc:")) return;

    const [action, reqId] = data.split(":");
    if (!reqId) {
      await bot.sendMessage(chatId, "❌ Invalid request.").catch(() => {});
      await bot.answerCallbackQuery(q.id).catch(() => {});
      return;
    }

    db = repairDB(db);
    const entries = Object.entries(db.pendingRedeems || {});
    const found = entries.find(([, r]) => r && r.reqId === reqId && r.status === "pending");
    if (!found) {
      await bot.sendMessage(chatId, "ℹ️ Request already handled.").catch(() => {});
      await bot.answerCallbackQuery(q.id).catch(() => {});
      // remove the buttons to avoid more clicks
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
      return;
    }

    const [chatKey, req] = found;
    const targetChatId = Number(chatKey);
    const cost = Number(req?.cost || 0);

    if (action === "redeem_accept") {
      req.status = "accepted";
      db.pendingRedeems[String(chatKey)] = req;
      saveDB();

      clearPendingRedeem(targetChatId);
      clearPendingAction(targetChatId);
      setRedeemCooldown(targetChatId, 5 * 60 * 1000);

      await bot.sendMessage(chatId, "✅ Redeem approved.").catch(() => {});
      await bot.answerCallbackQuery(q.id).catch(() => {});

      // remove buttons + delete admin request message
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
      await bot.deleteMessage(q.message.chat.id, q.message.message_id).catch(() => {});

  const sent = await bot.sendMessage(
        targetChatId,
        `✅ Redeem approved!\nItem: ${req.itemLabel}\nLoad To: ${mask07(req.loadTo)}\n\nYour request is being processed.`,
        { ...mainMenuKeyboard(chatId) }
      ).catch(() => {});

      // track per-user redeemed counts
      try {
        const uu = getUser(targetChatId);
        if (!uu.redeemedCounts || typeof uu.redeemedCounts !== "object") uu.redeemedCounts = {};
        const k = String(req.itemLabel || "").trim() || "Unknown";
        uu.redeemedCounts[k] = Number(uu.redeemedCounts[k] || 0) + 1;
        saveDB();
      } catch (_) {}

      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
      return;
    }

    if (action === "redeem_decline") {
      req.status = "declined";
      req.declineReason = "Cancelled";
      db.pendingRedeems[String(chatKey)] = req;
      saveDB();

      if (Number.isFinite(cost) && cost > 0) addPoints(targetChatId, cost);
      clearPendingRedeem(targetChatId);
      clearPendingAction(targetChatId);
      setRedeemCooldown(targetChatId, 5 * 60 * 1000);

      await bot.sendMessage(chatId, "❌ Redeem declined / cancelled.").catch(() => {});
      await bot.answerCallbackQuery(q.id).catch(() => {});

      // remove buttons + delete admin request message
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
      await bot.deleteMessage(q.message.chat.id, q.message.message_id).catch(() => {});

  const sent = await bot.sendMessage(
        targetChatId,
        `❌ Redeem request cancelled.\n\nReserved points refunded: ${cost} pts\nCurrent balance: ${getPoints(targetChatId).toFixed(2)} pts`,
        { ...mainMenuKeyboard(chatId) }
      ).catch(() => {});
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
      return;
    }
  } catch (_) {
    try {
      await bot.sendMessage(q.message?.chat?.id, "❌ Error processing request. Please try again.").catch(() => {});
      console.error("Callback error:", _);
      await bot.answerCallbackQuery(q.id).catch(() => {});
    } catch (_) {}
  }
});

// ===================== ADMIN INLINE ACTIONS (WITHDRAW) =====================
bot.on("callback_query", async (q) => {
  try {
    const chatId = q.message?.chat?.id;
    const data = String(q.data || "");

    // Admin only
    if (!isAdmin(chatId)) return;

    if (!data.startsWith("withdraw_")) return;

    const [action, reqId] = data.split(":");
    if (!reqId) {
      await bot.sendMessage(chatId, "❌ Invalid request.").catch(() => {});
      await bot.answerCallbackQuery(q.id).catch(() => {});
      return;
    }

    db = repairDB(db);
    const entries = Object.entries(db.pendingRedeems || {});
    const found = entries.find(([, r]) => r && r.reqId === reqId && r.status === "pending" && r.type === "withdraw");

    if (!found) {
      await bot.sendMessage(chatId, "ℹ️ Request already handled.").catch(() => {});
      await bot.answerCallbackQuery(q.id).catch(() => {});
      // remove the buttons to avoid more clicks
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
      return;
    }

    const [chatKey, req] = found;
    const targetChatId = Number(chatKey);
    const amountPts = Number(req?.amount || 0);

    if (action === "withdraw_accept") {
      req.status = "approved";
      db.pendingRedeems[String(chatKey)] = req;
      saveDB();

      // track withdrawals in analytics/ledger if helper exists
      try { if (typeof trackWithdrawalApproval === "function") trackWithdrawalApproval(req); } catch (_) {}

      clearPendingRedeem(targetChatId);
      setRedeemCooldown(targetChatId, 5 * 60 * 1000);

      await bot.sendMessage(chatId, "✅ Withdrawal approved.").catch(() => {});
      await bot.answerCallbackQuery(q.id).catch(() => {});

      // remove buttons + delete admin request message
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
      await bot.deleteMessage(q.message.chat.id, q.message.message_id).catch(() => {});

      await bot.sendMessage(
        targetChatId,
        `✅ Withdrawal Approved\n\nAmount: ${amountPts} pts\nKES Sent: ${pointsToKes(amountPts)}\nMPESA: ${mask07(req.phone)}\n\nYour withdrawal is being processed.`,
        { ...mainMenuKeyboard(targetChatId) }
      ).catch(() => {});

      // remove buttons
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
      return;
    }

    if (action === "withdraw_decline") {
      req.status = "declined";
      db.pendingRedeems[String(chatKey)] = req;
      saveDB();

      // refund points
      if (Number.isFinite(amountPts) && amountPts > 0) addPoints(targetChatId, amountPts);

      clearPendingRedeem(targetChatId);
      setRedeemCooldown(targetChatId, 5 * 60 * 1000);

      await bot.sendMessage(chatId, "❌ Withdrawal declined.").catch(() => {});
      await bot.answerCallbackQuery(q.id).catch(() => {});

      // remove buttons + delete admin request message
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
      await bot.deleteMessage(q.message.chat.id, q.message.message_id).catch(() => {});

      await bot.sendMessage(
        targetChatId,
        `❌ Withdrawal Declined\n\nAmount refunded: ${amountPts} pts\nCurrent balance: ${getPoints(targetChatId).toFixed(2)} pts`,
        { ...mainMenuKeyboard(targetChatId) }
      ).catch(() => {});

      // remove buttons
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
      return;
    }

    await bot.answerCallbackQuery(q.id).catch(() => {});
  } catch (_) {
    try {
      await bot.sendMessage(q.message?.chat?.id, "❌ Error processing request. Please try again.").catch(() => {});
      console.error("Callback error:", _);
      await bot.answerCallbackQuery(q.id).catch(() => {});
    } catch (_) {}
  }
});





// ===================== HELP (FAQ MENU) =====================
const HELP_TOPICS = [
  { key: "buy",    icon: "🛒", title: "How to buy offers" },
  { key: "payments", icon: "💳", title: "Payments & STK issues" },
  { key: "weekly_draw", icon: "🎉", title: "Weekly Draw / campaigns" },
  { key: "winners", icon: "🏆", title: "Winners & announcements" },
  { key: "withdraw", icon: "💸", title: "Withdraw points (min + rules)" },
  { key: "redeem", icon: "🎁", title: "Redeem rewards" },
  { key: "inline", icon: "🔎", title: "Inline search (fast search)" },
  { key: "referrals", icon: "👥", title: "Referrals (legit rules)" },
  { key: "penalties", icon: "⚠️", title: "Penalties & limitations" },
  { key: "business", icon: "🏢", title: "Business account" },
  { key: "cmds", icon: "⚙️", title: "Commands & settings" },
  { key: "support", icon: "📞", title: "Support / contact" },
];

function helpMenuKeyboard() {
  const rows = [
    [
      { text: "🛒 Buying", callback_data: "help:buy" },
      { text: "💳 Payments", callback_data: "help:payments" },
    ],
    [
      { text: "🎉 Weekly Draw", callback_data: "help:weekly_draw" },
      { text: "🏆 Winners", callback_data: "help:winners" },
    ],
    [
      { text: "💸 Withdraw", callback_data: "help:withdraw" },
      { text: "🎁 Redeem", callback_data: "help:redeem" },
    ],
    [
      { text: "🔎 Inline Search", callback_data: "help:inline" },
      { text: "👥 Referrals", callback_data: "help:referrals" },
    ],
    [
      { text: "⚠️ Rules", callback_data: "help:penalties" },
      { text: "🏢 Business", callback_data: "help:business" },
    ],
    [
      { text: "⚙️ Commands & Settings", callback_data: "help:cmds" },
      { text: "📞 Support", callback_data: "help:support" },
    ],
    [
      { text: "🏠 Main Menu", callback_data: "help:home" },
    ],
  ];

  return { reply_markup: { inline_keyboard: rows } };
}

function helpAnswerKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⬅️ Back to Help", callback_data: "help:menu" },
          { text: "🏠 Main Menu", callback_data: "help:home" },
        ],
      ],
    },
  };
}

function cmdsEntryKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "⚙️ Settings", callback_data: "help:settings" }],
        [{ text: "⬅️ Back to Help", callback_data: "help:menu" }, { text: "🏠 Main Menu", callback_data: "help:home" }],
      ],
    },
  };
}

function helpMenuText() {
  return (
    "❓ *Help Center*\n\n" +
    "Tap a question below to see the full explanation.\n\n" +
    "💡 Tip: You can also search offers using inline: `@"+(process.env.BOT_USERNAME||"YourBotUsername")+" 1GB`"
  );
}


function helpAnswerText(key, chatId) {
  const u = getUser(chatId);
  const lang = (u && (u.lang || u.language)) || "en";

  const bonusPct = Math.round(Number(REFERRAL?.BONUS_PERCENT || 0) * 100) || 2;
  const bonusDays = Number(REFERRAL?.EXPIRY_DAYS || 30) || 30;

  const spendUnlock = Number(MIN_WITHDRAW_SPEND || 300) || 300;
  // Withdraw menu offers start at 25 pts in this bot
  const minPoints = 25;
  const rateStr = "100 points = 70 Ksh (1 point = 0.7 Ksh)";

  const baseSupportEn = `📞 *Support:* ${HELP_PHONE}`;
  const baseSupportSw = `📞 *Msaada:* ${HELP_PHONE}`;

  if (lang === "sw") {
    switch (key) {
      case "buy":
        return (
          "🛒 *Jinsi ya kununua ofa*\n\n" +
          "1) Gonga *🛒 Nunua Ofa*\n" +
          "2) Chagua kategoria (mfano: 📦 Bingwa Deals / ✉️ SMS / 📞 Minutes / ♾ Unlimited)\n" +
          "3) Chagua ofa unayotaka\n" +
          "4) Weka namba ya simu (07XXXXXXXX)\n" +
          "5) Thibitisha na ulipie kwa M-Pesa STK\n\n" +
          "💡 *Kidokezo:* Ukiwa na *Fast Purchase* (Ununuzi wa Haraka) imewashwa, hatua za uthibitisho hupunguzwa.\n\n" +
          baseSupportSw
        );

      case "payments":
        return (
          "💳 *Malipo (STK Push)*\n\n" +
          "• Utapokea STK kwenye simu yako — weka PIN na uthibitishe.\n" +
          "• Ikiwa STK imechelewa/kushindikana, washa *Auto Retry STK* ili bot ijaribu tena.\n" +
          "• Usipoona STK, hakikisha M-Pesa iko sawa na simu ina mtandao.\n\n" +
          baseSupportSw
        );

      case "withdraw":
        return (
          "💸 *Kutoa pointi*\n\n" +
          `• Kiwango: *${rateStr}*\n` +
          `• Kiwango cha chini: *${minPoints} points*\n` +
          `• Ili kufungua kutoa, tumia angalau: *${spendUnlock} Ksh* kwenye ununuzi.\n\n` +
          "Hatua:\n" +
          "1) Gonga *💸 Toa Pointi*\n" +
          "2) Chagua kiasi\n" +
          "3) Thibitisha\n\n" +
          baseSupportSw
        );

      case "referrals":
        return (
          "🔗 *Rufaa*\n\n" +
          "• Shiriki link/ID yako ya rufaa.\n" +
          `• Unapata bonus: *${bonusPct}%* kwa manunuzi ya mtu uliyemleta.\n` +
          `• Bonus huisha baada ya: *${bonusDays} siku*.\n\n` +
          "Gonga *🔗 Rufaa Zangu* kuona link yako, waliokuja, na bonus zako.\n\n" +
          baseSupportSw
        );

      case "profile":
        return (
          "👤 *Wasifu*\n\n" +
          "Hapa utaona:\n" +
          "• Namba yako\n" +
          "• Pointi zako\n" +
          "• Jumla ya manunuzi\n" +
          "• Hali ya mipangilio (Fast Purchase, Auto Retry STK, n.k.)\n\n" +
          "Gonga *👤 Wasifu Wangu*.\n\n" +
          baseSupportSw
        );

      case "cmds":
        return (
          "📌 *Amri muhimu*\n\n" +
          "• /start — Anza upya\n" +
          "• /help — Msaada\n" +
          "• /buy — Nunua ofa\n" +
          "• /profile — Wasifu\n" +
          "• /withdraw — Toa pointi\n" +
          "• /ref — Rufaa\n\n" +
          "💡 Unaweza pia kutumia vitufe kwenye menyu.\n\n" +
          baseSupportSw
        );

      case "settings":
        return (
          "⚙️ *Karibu kwenye Mipangilio*\n\n" +
          "Washa/Zima chaguo hapa chini ili kubadilisha jinsi bot inavyofanya kazi:\n\n" +
          "• *Fast Purchase* — Nunua haraka bila hatua nyingi za uthibitisho.\n" +
          "• *Auto Retry STK* — Jaribu STK tena kiotomatiki ikishindikana/ikichelewa.\n" +
          "• *Stop Notifications* — Zima arifa za kampeni/cashback/promo.\n" +
          "• *Auto Delete (24hrs)* — Ujumbe wa bot ufutwe baada ya saa 24.\n" +
          "• *Auto Hide Buttons* — Ficha vitufe baada ya kutumia ili chat iwe safi.\n" +
          "• *Hide Quick Actions* — Ondoa Quick Actions kwenye menyu kuu.\n" +
          "• *Kiswahili* — Badilisha lugha yote ya bot iwe Kiswahili.\n\n" +
          "💡 *Kidokezo:* Kama huoni vitufe, sasisha Telegram au anzisha upya app.\n\n" +
          baseSupportSw
        );

      case "inline":
        return (
          "🧩 *Vitufe vya haraka (Inline)*\n\n" +
          "Vitufe hivi huonekana chini ya ujumbe (mfano Settings/Retry/Confirm).\n" +
          "Kama havionekani:\n" +
          "• Sasisha Telegram\n" +
          "• Funga na ufungue tena app\n\n" +
          baseSupportSw
        );

      case "redeem":
        return (
          "🎁 *Kukomboa (Redeem)*\n\n" +
          "Tumia pointi zako kubadilisha kuwa pesa (withdraw) au ofa maalum.\n" +
          "Fuata hatua kwenye menyu ya *💸 Toa Pointi*.\n\n" +
          baseSupportSw
        );

      case "penalties":
        return (
          "⚠️ *Adhabu / Vikwazo*\n\n" +
          "Matumizi mabaya (spam/udanganyifu) yanaweza kusababisha kufungwa kwa akaunti au kuondolewa kwa pointi.\n\n" +
          baseSupportSw
        );

      case "weekly_draw":
        return (
          "🎟️ *Droo ya kila wiki*\n\n" +
          "Kuna promosheni za droo kwa watumiaji wanaonunua mara kwa mara. Angalia matangazo ya kampeni.\n\n" +
          baseSupportSw
        );

      case "winners":
        return (
          "🏆 *Washindi*\n\n" +
          "Washindi huwekwa kwenye tangazo la kampeni (kama lipo). Angalia sehemu ya Campaign/Announcements.\n\n" +
          baseSupportSw
        );

      case "business":
        return (
          "🏢 *Business / Admin*\n\n" +
          "Hii ni sehemu ya mipangilio ya biashara (backup/auto-delete n.k.). Kama huoni, huenda akaunti yako si ya biashara.\n\n" +
          baseSupportSw
        );

      default:
        return "ℹ️ *Msaada*\n\nChagua kipengele kwenye menyu ya Help.\n\n" + baseSupportSw;
    }
  }

  // ENGLISH (default)
  switch (key) {
    case "buy":
      return (
        "🛒 *How to buy offers*\n\n" +
        "1) Tap *🛒 Buy Offers*\n" +
        "2) Choose a category (e.g. 📦 Bingwa Deals / ✉️ SMS / 📞 Minutes / ♾ Unlimited)\n" +
        "3) Select an offer\n" +
        "4) Enter phone number (07XXXXXXXX)\n" +
        "5) Confirm and pay via M-Pesa STK\n\n" +
        "💡 *Tip:* If *Fast Purchase* is ON, confirmation steps are reduced.\n\n" +
        baseSupportEn
      );

    case "payments":
      return (
        "💳 *Payments (STK Push)*\n\n" +
        "• You’ll receive an STK prompt on your phone — enter PIN to confirm.\n" +
        "• If STK delays/fails, enable *Auto Retry STK* so the bot retries.\n" +
        "• If you don’t see STK, check M-Pesa status and network.\n\n" +
        baseSupportEn
      );

    case "withdraw":
      return (
        "💸 *Withdrawing points*\n\n" +
        `• Rate: *${rateStr}*\n` +
        `• Minimum: *${minPoints} points*\n` +
        `• Unlock rule: Spend at least *${spendUnlock} Ksh* on purchases.\n\n` +
        "Steps:\n" +
        "1) Tap *💸 Withdraw Points*\n" +
        "2) Choose amount\n" +
        "3) Confirm\n\n" +
        baseSupportEn
      );

    case "referrals":
      return (
        "🔗 *Referrals*\n\n" +
        "• Share your referral link/ID.\n" +
        `• You earn: *${bonusPct}%* bonus on purchases made by users you refer.\n` +
        `• Bonus expires after: *${bonusDays} days*.\n\n` +
        "Tap *🔗 My Referral* to view your link, joins, and earnings.\n\n" +
        baseSupportEn
      );

    case "profile":
      return (
        "👤 *My Profile*\n\n" +
        "You can see:\n" +
        "• Your phone number\n" +
        "• Your points\n" +
        "• Total spend\n" +
        "• Your settings status (Fast Purchase, Auto Retry STK, etc.)\n\n" +
        "Tap *👤 My Profile*.\n\n" +
        baseSupportEn
      );

    case "cmds":
      return (
        "📌 *Important commands*\n\n" +
        "• /start — Restart\n" +
        "• /help — Help\n" +
        "• /buy — Buy offers\n" +
        "• /profile — Profile\n" +
        "• /withdraw — Withdraw points\n" +
        "• /ref — Referral\n\n" +
        "💡 You can also use the menu buttons.\n\n" +
        baseSupportEn
      );

    case "settings":
      return (
        "⚙️ *Welcome to Settings*\n\n" +
        "Toggle the options below to customize how the bot works for you:\n\n" +
        "• *Fast Purchase* – Instantly buy data without confirmation steps.\n" +
        "• *Auto Retry STK* – Automatically retries the STK push if payment fails or times out.\n" +
        "• *Stop Notifications* – Disable campaign, cashback, and promotional alerts.\n" +
        "• *Auto Delete (24hrs)* – Bot messages will automatically disappear after 24 hours.\n" +
        "• *Auto Hide Buttons* – Hides menu buttons after use to keep the chat clean.\n" +
        "• *Hide Quick Actions* – Removes the quick action menu from the main screen.\n" +
        "• *Kiswahili* – Switch the bot language to Swahili.\n\n" +
        "💡 *Tip:* If you don't see buttons, update Telegram or restart the app.\n\n" +
        baseSupportEn
      );

    case "inline":
      return (
        "🧩 *Inline buttons*\n\n" +
        "These buttons appear under messages (e.g. Settings/Retry/Confirm).\n" +
        "If you don’t see them:\n" +
        "• Update Telegram\n" +
        "• Restart the app\n\n" +
        baseSupportEn
      );

    case "redeem":
      return (
        "🎁 *Redeem*\n\n" +
        "Use your points to withdraw or access special offers.\n" +
        "Follow the steps under *💸 Withdraw Points*.\n\n" +
        baseSupportEn
      );

    case "penalties":
      return (
        "⚠️ *Penalties / Restrictions*\n\n" +
        "Abuse (spam/fraud) may lead to account restrictions or point deductions.\n\n" +
        baseSupportEn
      );

    case "weekly_draw":
      return (
        "🎟️ *Weekly draw*\n\n" +
        "Some campaigns include weekly draws for active buyers. Check campaign announcements.\n\n" +
        baseSupportEn
      );

    case "winners":
      return (
        "🏆 *Winners*\n\n" +
        "Winners are posted in campaign announcements (when available).\n\n" +
        baseSupportEn
      );

    case "business":
      return (
        "🏢 *Business / Admin*\n\n" +
        "Business-only settings (backup/auto-delete etc.). If you don't see them, your account may not be business-enabled.\n\n" +
        baseSupportEn
      );

    default:
      return "ℹ️ *Help*\n\nChoose an item from the Help menu.\n\n" + baseSupportEn;
  }
}


async function safeEditMessageText(chatId, messageId, text, opts = {}) {
  if (!messageId) return null;
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      disable_web_page_preview: true,
      ...opts,
    });
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : "";
    // Ignore harmless edit errors
    if (msg.includes("message is not modified") || msg.includes("MESSAGE_NOT_MODIFIED")) return null;
    // If the message is too old / not editable, fall back to sending a new one
    return null;
  }
}


/**
 * ===================== PROFILE (User Stats) =====================
 * /profile — show user's stats in one message (masked sensitive data)
 */
function ensureTxLog(u) {
  if (!u || typeof u !== "object") return;
  if (!Array.isArray(u.txLog)) u.txLog = [];
  if (!u.joinedAt) u.joinedAt = Date.now();
  if (!u.withdrawStats || typeof u.withdrawStats !== "object") {
    u.withdrawStats = { approvedCount: 0, approvedKsh: 0, declinedCount: 0, declinedKsh: 0, byDay: {} };
  }
  if (!u.pointsEarnedByDay || typeof u.pointsEarnedByDay !== "object") u.pointsEarnedByDay = {};
  if (!Number.isFinite(Number(u.pointsEarnedTotal))) u.pointsEarnedTotal = 0;
}

function addUserTx(chatId, tx) {
  try {
    const u = getUser(chatId);
    ensureTxLog(u);
    u.txLog.unshift({ ts: Date.now(), ...tx });
    // keep last 100
    if (u.txLog.length > 100) u.txLog = u.txLog.slice(0, 100);
    saveDB();
  } catch (_) {}
}

function kenyaDateOnlyFromTs(ts) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
  } catch (_) {
    return new Date(ts).toISOString().slice(0,10);
  }
}

function shortKenyaTime(ts) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Nairobi", hour: "2-digit", minute: "2-digit" }).format(new Date(ts));
  } catch (_) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
  }
}

function fmtTxLine(tx) {
  const ok = tx.status === "success";
  const icon = ok ? "✅" : (tx.status === "pending" ? "🕚" : "❌");
  const label = String(tx.pkgLabel || tx.offer || "Offer").trim();
  const dur = tx.duration ? ` ${tx.duration}` : "";
  const price = Number(tx.amountKsh || tx.price || 0);
  return `${icon} ${label}${dur} @${price}ksh`;
}

function computeTopPackage(u) {
  try {
    // Prefer stats structure if present
    if (u?.stats?.packages && typeof u.stats.packages === "object") {
      let best = null;
      for (const [k,v] of Object.entries(u.stats.packages)) {
        const n = Number(v || 0);
        if (!best || n > best.n) best = { k, n };
      }
      if (best) return { label: best.k, count: best.n };
    }
    if (u?.stats?.favourite?.pkgLabel) return { label: u.stats.favourite.pkgLabel, count: Number(u.stats.favourite.count||0) };
  } catch (_) {}
  return null;
}

function sumWonSoFar(chatId) {
  try {
    const c = ensureWeeklyDrawObject();
    const winners = Array.isArray(c.winners) ? c.winners : [];
    let total = 0;
    let count = 0;
    for (const w of winners) {
      if (String(w.chatId) === String(chatId)) {
        count += 1;
        total += Number(w.prize || 0);
      }
    }
    return { count, totalKsh: total };
  } catch (_) {
    return { count: 0, totalKsh: 0 };
  }
}

async function showUserProfile(chatId) {
  const u = getUser(chatId);
  ensureTxLog(u);

  const day = kenyaDayKeyOffset(0);
  const yday = kenyaDayKeyOffset(1);

  const pointsBal = Number(u.points || 0);
  const pointsEarnToday = Number(u.pointsEarnedByDay[day] || 0);
  const pointsEarnYday = Number(u.pointsEarnedByDay[yday] || 0);
  const pointsEarnTotal = Number(u.pointsEarnedTotal || 0);

  const totalSpent = Number(u.totalSpentKsh || 0);
  const totalPurchases = Number(u.totalPurchases || 0);

  const topPkg = computeTopPackage(u);
  const savedPhone = getUserPhone(chatId);
  const risk = (typeof getRiskProfile === "function") ? getRiskProfile(chatId) : { riskScore: 0 };
  const riskScore = Number(risk?.riskScore || 0);

  const isBiz = (typeof isBusinessActive === "function") ? !!isBusinessActive(chatId) : false;
  const acctStatus = isBiz ? "BUSINESS 💼" : "NORMAL ✅";

  const exp = u.subscriptionExpiry ? kenyaDateTimeFromTs(u.subscriptionExpiry) : null;
  // ✅ Profile fix: joined date should always show a real value for existing users.
  // Prefer joinedAt if present, otherwise fall back to createdAt/firstSeen/profileUpdatedAt.
  const joinedTs = Number(u.joinedAt || u.createdAt || u.firstSeen || u.profileUpdatedAt || 0);
  const joined = joinedTs ? kenyaDateTimeFromTs(joinedTs) : "N/A";

  // Transactions list limit
  const txLimit = isBiz ? 15 : 3;
  const lastTx = (u.txLog || []).slice(0, txLimit);
  const txTag = isBiz ? "BUSINESS" : "NORMAL";
  const txLines = lastTx.length
    ? lastTx.map(t => `• [${txTag}] ${fmtTxLine(t)} (${shortKenyaTime(t.ts)})`).join("\n")
    : "• (no recent transactions)";

  // Numbers used today (masked)
  const numbersLimit = isBiz ? 10 : 3;
  const todaysPhones = [];
  for (const t of (u.txLog || [])) {
    if (kenyaDateOnlyFromTs(t.ts) !== day) continue;
    const ph = String(t.phone254 || "");
    if (!ph) continue;
    if (!todaysPhones.includes(ph)) todaysPhones.push(ph);
    if (todaysPhones.length >= numbersLimit) break;
  }
  const phoneTag = isBiz ? "BUSINESS" : "NORMAL";
  const phonesLine = todaysPhones.length
    ? todaysPhones.map(p => `• [${phoneTag}] ${maskPhone(p)}`).join("\n")
    : "• (none today)";

  // Withdraw status today + totals
  const ws = u.withdrawStats || { approvedCount: 0, approvedKsh: 0, declinedCount: 0, declinedKsh: 0, byDay: {} };
  const todayW = ws.byDay?.[day] || { approvedKsh: 0, declinedKsh: 0, pendingKsh: 0, approvedCount: 0, declinedCount: 0, pendingCount: 0 };
  const pendingReq = db?.pendingRedeems?.[String(chatId)];
  let pendingLine = "";
  if (pendingReq && pendingReq.type === "withdraw" && pendingReq.status === "pending") {
    const ksh = Number(pointsToKes(pendingReq.amount || 0));
    pendingLine = `\n• 🕚 Pending: Ksh ${ksh}`;
  }

  // Weekly draw stats
  let tickets = 0;
  let opted = false;
  try {
    const c = ensureWeeklyDrawObject();
    tickets = Number((c.entries || {})[String(chatId)] || 0);
    opted = (typeof isWeeklyDrawOptedIn === "function") ? !!isWeeklyDrawOptedIn(chatId) : false;
  } catch (_) {}
  const won = sumWonSoFar(chatId);

  const name = safeDisplayName(u, chatId);
  const msg =
`👤 *My Profile*

🆔 Telegram ID: \`${mdEscape(String(chatId))}\`
👤 Name: *${mdEscape(name)}*
📅 Joined: \`${mdEscape(joined)}\`

📱 Saved number: *${mdEscape(savedPhone ? maskPhone(savedPhone) : "Not set")}*
⭐ Favourite package: *${mdEscape(topPkg ? topPkg.label : "N/A")}*${topPkg ? ` (x${topPkg.count})` : ""}

💰 *Earnings (points)*
• Today: *${pointsEarnToday} pts*
• Yesterday: *${pointsEarnYday} pts*
• Total earned: *${pointsEarnTotal} pts*
• Current balance: *${pointsBal} pts*

🛒 *Purchases*
• Total purchases: *${totalPurchases}*
• Total spend: *Ksh ${totalSpent}*

💸 *Withdrawals*
• Approved total: *Ksh ${Number(ws.approvedKsh || 0)}* (x${Number(ws.approvedCount || 0)})
• Declined total: *Ksh ${Number(ws.declinedKsh || 0)}* (x${Number(ws.declinedCount || 0)})
• Today approved: *Ksh ${Number(todayW.approvedKsh || 0)}* ✅
• Today declined: *Ksh ${Number(todayW.declinedKsh || 0)}* ❌${pendingLine}

🎟 *Weekly Draw*
• Status: *${opted ? "JOINED ✅" : "NOT JOINED"}*
• Tickets: *${tickets}*
• Won so far: *${won.count} time(s), Ksh ${won.totalKsh}*

🛡 Risk score: *${riskScore}*
👔 Account: *${acctStatus}*${isBiz && exp ? `\n⏳ Business expiry: \`${mdEscape(exp)}\`` : ""}

📞 *Numbers used today*
${phonesLine}

🧾 *Last ${txLimit} transactions*
${txLines}
`;

  return sendTracked(chatId, msg, { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) });
}
async function sendHelpMenu(chatId, ctx = {}) {
  const text = helpMenuText();
  const opts = { parse_mode: "Markdown", ...helpMenuKeyboard() };

  // Prefer single-message UX: edit existing help message when possible
  const edited = await safeEditMessageText(chatId, ctx.messageId, text, opts);
  if (edited) return edited;

  // Fallback: send a fresh help message
  return sendTracked(chatId, text, opts);
}

async function sendHelpAnswer(chatId, key, ctx = {}) {
  const text = helpAnswerText(key, chatId);

  // Special: Business help should show ONLY an inline Activate button (no normal keyboard).
  // We keep the same inline navigation buttons as other help pages.
  if (key === "business") {
    bizSetView(chatId, "biz_overview");
    // Build the normal Help inline keyboard (Back to Help / Main Menu) then add Activate on top.
    const nav = helpAnswerKeyboard()?.reply_markup?.inline_keyboard || [];
    const inline_keyboard = [[{ text: "✅ Activate", callback_data: "biz_activate" }], ...nav];

    const edited = await safeEditMessageText(chatId, ctx.messageId, text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard },
    });
    if (edited) return edited;

    return sendTracked(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard },
    });
  }

  const opts =
    key === "cmds"
      ? { parse_mode: "Markdown", ...cmdsEntryKeyboard() }
      : key === "settings"
        ? { parse_mode: "Markdown", ...settingsMenuKeyboard(chatId) }
        : { parse_mode: "Markdown", ...helpAnswerKeyboard() };

  const edited = await safeEditMessageText(chatId, ctx.messageId, text, opts);
  if (edited) return edited;

  return sendTracked(chatId, text, opts);
}





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
}// ===================== CUSTOM PACKAGES (ADMIN ADD-ONS) =====================
// Saved in db.customPackages and merged into PACKAGES at startup.
function applyCustomPackages() {
  db = repairDB(db);
  const custom = db.customPackages || {};
  for (const [cat, list] of Object.entries(custom)) {
    if (!Array.isArray(list)) continue;
    if (!PACKAGES[cat]) PACKAGES[cat] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const label = String(item.label || "").trim();
      const price = Number(item.price || 0);
      if (!label || !Number.isFinite(price) || price <= 0) continue;
      // Avoid duplicates by label
      if (!PACKAGES[cat].some((x) => x && x.label === label)) {
        PACKAGES[cat].push({ label, price });
      }
    }
  }
}

// Apply once on boot
try { applyCustomPackages(); } catch (_) {}
;



// ===================== WEEKLY DRAW JOIN SUGGESTED PACKAGES =====================
const WD_QUICK_CATS = ["SMS Offers", "Bingwa Deals", "Unlimited Deals", "Flex Deals"];

// Prefer specific popular deals (fallback will randomize from category lists)
const WD_QUICK_PREFS = [
  { category: "SMS Offers", label: "Ksh 30 • 1000 SMS 7 DAYS" },
  { category: "Bingwa Deals", label: "Ksh 20 • 250MB 24HRS" },
  { category: "Unlimited Deals", label: "Ksh 110 • 2GB 24HRS" },
  { category: "Flex Deals", label: "Ksh 20 • Flex 350 (2HRS)" },
];

function wdPickSuggestedOffers(count = 4) {
  const picks = [];

  function addOffer(category, pkgIndex) {
    const pkg = (PACKAGES[category] || [])[pkgIndex];
    if (!pkg) return;
    const catId = WD_QUICK_CATS.indexOf(category);
    if (catId < 0) return;
    const key = `${catId}:${pkgIndex}`;
    if (picks.some(p => p.key === key)) return;
    picks.push({ key, catId, category, pkgIndex, label: pkg.label, price: pkg.price });
  }

  // try preferred first
  for (const p of WD_QUICK_PREFS) {
    const list = PACKAGES[p.category] || [];
    const idx = list.findIndex(x => x && x.label === p.label);
    if (idx >= 0) addOffer(p.category, idx);
    if (picks.length >= count) break;
  }

  // fill remaining with random from allowed categories
  const cats = WD_QUICK_CATS.slice().sort(() => Math.random() - 0.5);
  for (const c of cats) {
    const list = PACKAGES[c] || [];
    if (!list.length) continue;
    // pick a random item
    const idx = Math.floor(Math.random() * list.length);
    addOffer(c, idx);
    if (picks.length >= count) break;
  }

  return picks.slice(0, count);
}

function wdSuggestedOffersKeyboard(offers) {
  const rows = [];

  // Match the UI shown in the screenshot: MORE + PREVIOUS WINNERS above quick deals
  try {
    rows.push([{ text: tr(chatId, "ℹ️ MORE…", "ℹ️ ZAIDI…"), callback_data: "wdusr:more" }]);
    rows.push([{ text: tr(chatId, "🏆 PREVIOUS WINNERS", "🏆 WASHINDI WALIOPITA"), callback_data: "wdusr:prev" }]);
  } catch (_) {}

  const btns = (offers || []).map(o => ({
    text: `⚡ ${o.label}`,
    callback_data: `wdqbuy:${o.catId}:${o.pkgIndex}`,
  }));
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  rows.push([{ text: tr(chatId, "🛒 View All Offers", "🛒 Tazama Ofa Zote"), callback_data: "ui:buy_offers" }]);
  rows.push([{ text: tr(chatId, "⬅️ Rudi", "⬅️ Rudi"), callback_data: "wdusr:menu" }]);
  return { reply_markup: { inline_keyboard: rows } };
}


function wdJoinSuggestedPayload() {
  const offers = wdPickSuggestedOffers(4);
  const msg =
    `${tr(chatId,"🎉 WEEKLY DRAW","🎉 DROO YA WIKI")}\n` +
    `${tr(chatId,'✅ You are opted in (you will receive updates).','✅ Umejiunga (utapokea taarifa).')}\n\n` +
    `${tr(chatId,'🔥 Boost your tickets now by buying a quick deal below.','🔥 Ongeza tiketi zako sasa kwa kununua ofa ya haraka hapa chini.')}\n` +
    `${tr(chatId,'🏆 Buy any deal and you might win up to *Ksh 1500* weekly.','🏆 Nunua ofa yoyote na unaweza kushinda hadi *Ksh 1500* kila wiki.')}\n\n` +
    `${tr(chatId,'👇 Choose one package:','👇 Chagua ofa moja:')}`;
  return { text: msg, keyboard: wdSuggestedOffersKeyboard(offers) };
}

// ===================== END WEEKLY DRAW JOIN SUGGESTED PACKAGES =====================

// ===================== STATE =====================
const sessions = new Map();
// Session history for "⬅ Prev" (per chat)
const sessionHistory = new Map(); // chatId -> [{...sessionSnapshot}]
const adminState = new Map();
const broadcastAlbums = new Map(); // media_group_id -> { chatId, items: [msg], timer }
const supportState = new Map();
const adminReplyState = new Map();

// Global prev button label
const PREV_BTN = "⬅ Prev";

function cloneSession(s) {
  if (!s || typeof s !== "object") return null;
  return {
    step: s.step || null,
    category: s.category || null,
    pkgKey: s.pkgKey || null,
    createdAt: Number(s.createdAt || Date.now()),
  };
}

function pushPrev(chatId, s) {
  const key = String(chatId);
  const arr = sessionHistory.get(key) || [];
  const snap = cloneSession(s);
  if (!snap) return;

  // avoid duplicate consecutive snapshots
  const last = arr[arr.length - 1];
  if (last && last.step === snap.step && last.category === snap.category && last.pkgKey === snap.pkgKey) return;

  arr.push(snap);
  if (arr.length > 20) arr.splice(0, arr.length - 20);
  sessionHistory.set(key, arr);
}

function popPrev(chatId) {
  const key = String(chatId);
  const arr = sessionHistory.get(key) || [];
  const snap = arr.pop() || null;
  sessionHistory.set(key, arr);
  return snap;
}

async function renderSessionSnapshot(chatId, snap) {
  // If snapshot is missing, go to main menu
  if (!snap || !snap.step) {
    sessions.delete(chatId);
    return sendTracked(chatId, "✅ Main menu:", { ...mainMenuKeyboard(chatId) });
  }

  // Restore session
  const s = { ...snap, createdAt: Date.now() };
  sessions.set(chatId, s);

  if (s.step === "category") {
    return sendTracked(chatId, section("CHOOSE CATEGORY") + "✅ Choose a category:", categoriesKeyboard(chatId));
  }

  if (s.step === "package") {
    if (!s.category) return sendTracked(chatId, section("CHOOSE CATEGORY") + "✅ Choose a category:", categoriesKeyboard(chatId));
    return sendTracked(chatId, section(String(s.category || "").toUpperCase()) + `👇 ${s.category} packages:`, packagesKeyboard(s.category));
  }

  if (s.step === "confirm") {
    if (!s.category) return sendTracked(chatId, section("CHOOSE CATEGORY") + "✅ Choose a category:", categoriesKeyboard(chatId));
    const pkg = findPackageByLabel(s.category, s.pkgKey);
    if (!pkg) return sendTracked(chatId, section(String(s.category || "").toUpperCase()) + `👇 ${s.category} packages:`, packagesKeyboard(s.category));

    const savedPhone = getUserPhone(chatId);
    const hasSaved = !!savedPhone;

    const msgText =
      `✅ Selected:\n*${pkg.label}*\n\n` +
      (hasSaved ? `📱 Saved number: *${maskPhone(savedPhone)}*\n\n` : `📱 Paste number.\n\n`) +
      (isFastPurchaseEnabled(chatId)
        ? `Choose a number below or tap ➕ Add Number.\n\nChoose:
• ✅ Proceed (use saved number)
• 📞 Change Number`
        : `Choose:\n• ✅ Proceed (use saved number)\n• 📞 Change Number`);

    const kb = isFastPurchaseEnabled(chatId)
      ? confirmKeyboardV2(chatId, s, hasSaved)
      : confirmKeyboard(hasSaved);

    return sendTracked(chatId, msgText, { parse_mode: "Markdown", ...kb });
  }

  if (s.step === "phone") {
    return sendTracked(
      chatId,
      "📱 Send your phone number:\n• 07XXXXXXXX\n• 01XXXXXXXX\n• 2547XXXXXXXX\n• 2541XXXXXXXX",




      confirmKeyboard(false)
    );
  }

  // Fallback
  return sendTracked(chatId, "✅ Main menu:", { ...mainMenuKeyboard(chatId) });
}

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


// Kenya time/date for a specific timestamp (ms)
function kenyaDateTimeFromTs(ts) {
  const t = Number(ts || 0);
  if (!t) return "N/A";
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
    }).format(new Date(t));
  } catch (_) {
    return new Date(t).toLocaleString();
  }
}


function kenyaDateTimeCompactFromTs(ts) {
  const t = Number(ts || 0);
  if (!t) return "N/A";
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Nairobi",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(new Date(t));
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
    const day = get("day");
    const month = get("month");
    const year = get("year");
    const hour = get("hour");
    const minute = get("minute");
    const period = get("dayPeriod").toUpperCase();
    return `${day}-${month}-${year} at ${hour}:${minute}${period}`;
  } catch (_) {
    return kenyaDateTimeFromTs(t);
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

// ===================== QUICK BUTTONS + ABUSE PROTECTION =====================
function ensureUserStats(u) {
  if (!u) return;
  if (!u.stats || typeof u.stats !== "object") u.stats = {};
  if (!u.stats.categoryCounts || typeof u.stats.categoryCounts !== "object") u.stats.categoryCounts = {};
  if (!u.stats.lastPurchaseAt) u.stats.lastPurchaseAt = 0;
  if (!u.stats.phoneCounts || typeof u.stats.phoneCounts !== "object") u.stats.phoneCounts = {};
  if (!u.stats.packageCounts || typeof u.stats.packageCounts !== "object") u.stats.packageCounts = {};
  if (!u.stats.favourite || typeof u.stats.favourite !== "object") u.stats.favourite = { phone254: "", pkgLabel: "", category: "", amount: 0, channelId: 0, phoneCount: 0, pkgCount: 0 };
}





function getFavouritePackageForCategory(u, category) {
  try {
    ensureUserStats(u);
    const cat = String(category || "");
    const kc = u.stats.packageCounts || {};
    let best = null;
    for (const [k, cnt] of Object.entries(kc)) {
      const parts = String(k).split("||");
      const kCat = parts[0] || "";
      if (kCat !== cat) continue;
      const n = Number(cnt || 0);
      if (!best || n > best.count) {
        best = {
          category: kCat,
          pkgLabel: parts[1] || "",
          amount: Number(parts[2] || 0) || 0,
          channelId: Number(parts[3] || 0) || 0,
          count: n,
        };
      }
    }
    return best;
  } catch (_) {
    return null;
  }
}

function recomputeUserFavourite(u) {
  try {
    ensureUserStats(u);
    const pc = u.stats.phoneCounts || {};
    const kc = u.stats.packageCounts || {};

    let topPhone = "";
    let topPhoneCount = 0;
    for (const [ph, cnt] of Object.entries(pc)) {
      const n = Number(cnt || 0);
      if (n > topPhoneCount) {
        topPhoneCount = n;
        topPhone = ph;
      }
    }

    let topKey = "";
    let topKeyCount = 0;
    for (const [k, cnt] of Object.entries(kc)) {
      const n = Number(cnt || 0);
      if (n > topKeyCount) {
        topKeyCount = n;
        topKey = k;
      }
    }

    // topKey format: category||pkgLabel||amount||channelId
    let fav = u.stats.favourite || {};
    if (topKey) {
      const parts = String(topKey).split("||");
      fav.category = parts[0] || "";
      fav.pkgLabel = parts[1] || "";
      fav.amount = Number(parts[2] || 0) || 0;
      fav.channelId = Number(parts[3] || 0) || 0;
      fav.pkgCount = topKeyCount;
    }
    if (topPhone) {
      fav.phone254 = topPhone;
      fav.phoneCount = topPhoneCount;
    }

    u.stats.favourite = fav;
  } catch (_) {}
}

function recordSuccessfulPurchase(chatId, category, pkgLabel = "", phone254 = "", amount = 0, channelId = 0) {
  const u = getUser(chatId);
  ensureUserStats(u);

  const c = String(category || "");
  u.stats.categoryCounts[c] = Number(u.stats.categoryCounts[c] || 0) + 1;

  const ph = String(phone254 || "");
  if (ph) u.stats.phoneCounts[ph] = Number(u.stats.phoneCounts[ph] || 0) + 1;

  const lbl = String(pkgLabel || "");
  const a = Number(amount || 0) || 0;
  const ch = Number(channelId || 0) || 0;
  if (c && lbl) {
    const key = `${c}||${lbl}||${a}||${ch}`;
    u.stats.packageCounts[key] = Number(u.stats.packageCounts[key] || 0) + 1;
  }

  u.stats.lastPurchaseAt = Date.now();
  recomputeUserFavourite(u);
  saveDB();
}


function ensureOfferTrends() {
  db = repairDB(db);
  if (!db.offerTrends || typeof db.offerTrends !== "object") db.offerTrends = {};
  saveDB();
}

function trendKey(category, pkgLabel) {
  return `${String(category || "")}||${String(pkgLabel || "")}`;
}

function recordOfferTrend(category, pkgLabel) {
  try {
    ensureOfferTrends();
    const k = trendKey(category, pkgLabel);
    db.offerTrends[k] = Number(db.offerTrends[k] || 0) + 1;
    saveDB();
  } catch (_) {}
}

function getTopTrendingOffers(limit = 5) {
  ensureOfferTrends();
  const entries = Object.entries(db.offerTrends || {});
  entries.sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
  const top = [];
  for (const [k, cnt] of entries) {
    const [category, pkgLabel] = k.split("||");
    if (!category || !pkgLabel) continue;
    const pkg = findPackageByLabel(category, pkgLabel);
    if (!pkg) continue;
    top.push({ category, label: pkg.label, price: pkg.price, count: Number(cnt || 0) });
    if (top.length >= limit) break;
  }
  return top;
}


function isQuickMenuActive(chatId) {
  const u = getUser(chatId);
  ensureUserStats(u);
  const last = Number(u.stats.lastPurchaseAt || 0);
  if (!last) return false;
  return (Date.now() - last) <= (2 * 24 * 60 * 60 * 1000); // 2 days
}

function getQuickCategories(chatId) {
  const u = getUser(chatId);
  ensureUserStats(u);
  if (!isQuickMenuActive(chatId)) return [];
  const counts = u.stats.categoryCounts || {};
  const quick = [];
  // show if purchased 3+ times
  if (Number(counts["SMS Offers"] || 0) >= 2) quick.push({ text: "⚡ Quick SMS", category: "SMS Offers" });
  if (Number(counts["Unlimited Deals"] || 0) >= 2) quick.push({ text: "⚡ Quick Unlimited", category: "Unlimited Deals" });
  if (Number(counts["Bingwa Deals"] || 0) >= 2) quick.push({ text: "⚡ Quick Bingwa", category: "Bingwa Deals" });
  if (Number(counts["Minutes"] || 0) >= 2) quick.push({ text: "⚡ Quick Minutes", category: "Minutes" });
  if (Number(counts["Flex Deals"] || 0) >= 2) quick.push({ text: "⚡ Quick Flex", category: "Flex Deals" });
  if (Number(counts["Bonga Points"] || 0) >= 2) quick.push({ text: "⚡ Quick Bonga", category: "Bonga Points" });

return quick;

}

function ensureStkAbuse() {
  db = repairDB(db);
  if (!db.stkAbuse || typeof db.stkAbuse !== "object") db.stkAbuse = {};
  saveDB();
}

function getStkAbuseKey(chatId, phone254) {
  return `${chatId}:${String(phone254 || "")}`;
}

function isStkBlocked(chatId, phone254) {
  ensureStkAbuse();
  const key = getStkAbuseKey(chatId, phone254);
  const rec = db.stkAbuse[key];
  const until = Number(rec?.blockedUntil || 0);
  return until && Date.now() < until ? until : 0;
}

function noteStkFailure(chatId, phone254) {
  ensureStkAbuse();
  const key = getStkAbuseKey(chatId, phone254);
  const now = Date.now();
  const rec = db.stkAbuse[key] || { failures: [], blockedUntil: 0 };
  const windowMs = 10 * 60 * 1000; // 10 min
  rec.failures = (rec.failures || []).filter(ts => now - Number(ts || 0) <= windowMs);
  rec.failures.push(now);

  // Block if 5+ failures in 10 minutes
  if (rec.failures.length >= 5) {
    rec.blockedUntil = now + (5 * 60 * 1000); // 5 min
    rec.failures = []; // reset after block
  }

  db.stkAbuse[key] = rec;
  saveDB();
}

function clearStkFailures(chatId, phone254) {
  ensureStkAbuse();
  const key = getStkAbuseKey(chatId, phone254);
  if (db.stkAbuse[key]) {
    db.stkAbuse[key].failures = [];
    db.stkAbuse[key].blockedUntil = 0;
    saveDB();
  }
}

function base64UrlEncode(s) {
  return Buffer.from(String(s || ""), "utf8").toString("base64url");
}

function base64UrlDecode(s) {
  try { return Buffer.from(String(s || ""), "base64url").toString("utf8"); } catch { return ""; }
}


function pickUpsell(category, pkgLabel, price, chatId = null, phone254 = null) {
  // Returns { category, pkgLabel, price } if a matching upsell exists in current PACKAGES.
  const cat = String(category || "");
  const lbl = String(pkgLabel || "");
  const p = Number(price || 0);

  const findByKeywords = (categoryName, keywords = []) => {
    const arr = (PACKAGES || {})[categoryName] || [];
    const kws = keywords.map(k => String(k).toLowerCase());
    for (const pkg of arr) {
      const hay = String(pkg.label || "").toLowerCase();
      if (kws.every(k => hay.includes(k))) return { category: categoryName, pkgLabel: pkg.label, price: pkg.price };
    }
    return null;
  };

  const findByLabel = (categoryName, exactLabel) => {
    const arr = (PACKAGES || {})[categoryName] || [];
    const ex = String(exactLabel || "");
    for (const pkg of arr) {
      if (String(pkg.label) === ex) return { category: categoryName, pkgLabel: pkg.label, price: pkg.price };
    }
    return null;
  };

  // SMS ladder: 20 -> 200 -> 1000
  if (cat === "SMS Offers") {
    if (p === 5 || lbl.toLowerCase().includes("20 sms")) {
      return findByLabel("SMS Offers", "Ksh 10 • 200 SMS 24HRS") || findByKeywords("SMS Offers", ["200 sms"]);
    }
    if (p === 10 || lbl.toLowerCase().includes("200 sms")) {
      return findByLabel("SMS Offers", "Ksh 30 • 1000 SMS 7 DAYS") || findByKeywords("SMS Offers", ["1000 sms"]);
    }
    return null;
  }

  // Bingwa -> Unlimited cross-sell
  if (cat === "Bingwa Deals") {
    if (p === 21 || lbl.toLowerCase().includes("1gb 1hr")) {
      return findByLabel("Unlimited Deals", "Ksh 52 • 1.5GB 3HRS") || findByKeywords("Unlimited Deals", ["1.5gb", "3hrs"]);
    }
    return findByLabel("Unlimited Deals", "Ksh 110 • 2GB 24HRS") || findByKeywords("Unlimited Deals", ["2gb", "24hrs"]);
  }

  // Unlimited ladder + Bingwa big recommendation
  if (cat === "Unlimited Deals") {
    if (p === 23 || lbl.toLowerCase().includes("1gb 1hr")) {
      return findByLabel("Unlimited Deals", "Ksh 110 • 2GB 24HRS") || findByKeywords("Unlimited Deals", ["2gb", "24hrs"]);
    }

    if (p === 110 || lbl.toLowerCase().includes("2gb 24hrs")) {
      if (phone254 && typeof canBuyBingwaToday === "function" && canBuyBingwaToday(phone254)) {
        return findByLabel("Bingwa Deals", "Ksh 700 • 6GB 7 DAYS") || findByKeywords("Bingwa Deals", ["6gb", "7"]);
      }
      return findByLabel("Unlimited Deals", "Ksh 251 • 5GB 3 DAYS") || findByKeywords("Unlimited Deals", ["5gb", "3"]);
    }

    if (phone254 && typeof canBuyBingwaToday === "function" && canBuyBingwaToday(phone254)) {
      return findByLabel("Bingwa Deals", "Ksh 299 • 2.5GB 7 DAYS") || findByKeywords("Bingwa Deals", ["2.5gb", "7"]);
    }
  }

  return null;
}


// ===================== INLINE SEARCH =====================
function escapeMd(s) {
  return String(s || "").replace(/[_*\[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

function getAllOffersFlat() {
  // Flattens PACKAGES into: { category, label, price }
  const out = [];
  for (const [category, arr] of Object.entries(PACKAGES || {})) {
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      if (!p || !p.label) continue;
      out.push({ category, label: p.label, price: p.price });
    }
  }
  return out;
}

function searchOffersInline(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];

  const all = getAllOffersFlat();

  // Basic token matching (supports "2gb", "24hrs", "sms", "7 days", price like "110")
  const tokens = q.split(/\s+/g).filter(Boolean);

  return all.filter((x) => {
    const hay = `${x.category} ${x.label} ${x.price}`.toLowerCase();
    return tokens.every(t => hay.includes(t));
  });
}

function categoryMatchesInline(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const cats = Object.keys(PACKAGES || {});
  return cats.filter(c => c.toLowerCase().includes(q));
}

function commandMatchesInline(query) {
  const q = String(query || "").trim().toLowerCase();
  const cmds = [
    { key: "help", title: "ℹ️ Help", desc: "Show help & support", text: "ℹ️ Help" },
    { key: "status", title: "📟 Status", desc: "Check pending STK", text: "/status" },
    { key: "menu", title: "🏠 Main Menu", desc: "Open main menu", text: "/start" },
    { key: "profile", title: "👤 My Profile", desc: "View your profile & stats", text: "/profile" },
    { key: "referral", title: "🔗 My Referral", desc: "Get your referral link", text: "🔗 My Referral" },
    { key: "withdraw", title: "💸 Withdraw Points", desc: "Withdraw your points", text: "💸 Withdraw Points" },
    { key: "buy", title: "🛒 Buy Offers", desc: "Browse all offers", text: "🛒 Buy Offers" },
  ];
  return cmds.filter(c => c.key.includes(q) || c.title.toLowerCase().includes(q));
}


const COMMANDS_LIST = [
  { cmd: "/start", desc: "Show welcome + main menu" },
  { cmd: "/status", desc: "Check pending STK status" },
  { cmd: "/menu", desc: "Open main menu (same as /start)" },
  { cmd: "/help", desc: "Help & support" },
  { cmd: "/profile", desc: "View your profile & stats" },
  { cmd: "/fastpurchase", desc: "Toggle Fast Purchase (Business only)" },

  { cmd: "🛒 Buy Offers", desc: "Browse all categories & packages" },
  { cmd: "🔎 Search Offers", desc: "Search offers inside bot (if enabled)" },
  { cmd: "🔁 Buy Again", desc: "Repeat your last successful purchase" },
  { cmd: "💸 Withdraw Points", desc: "Withdraw cashback points" },
  { cmd: "🔗 My Referral", desc: "Get referral link & stats" },
  { cmd: "🔄 Resend STK", desc: "Resend last STK prompt (if available)" },

  // Admin-only
  { cmd: "/admin", desc: "Admin menu / shortcuts (admin only)", adminOnly: true },
  { cmd: "/report", desc: "Show admin daily summary (admin only)", adminOnly: true },
  { cmd: "/commands", desc: "Show this command list (admin only)", adminOnly: true },
];

// ==========================================================
// ===========================================================================


function maskPhone(phone254) {
  const full = formatTo07(phone254);
  if (!full || full.length < 10) return full;
  return full.slice(0,4) + "xxx" + full.slice(-3);
}


// ===================== FAST PURCHASE (BUSINESS) =====================
function isFastPurchaseEnabled(chatId) {
  const u = getUser(chatId);
  // Business only; auto-off when business expires (isBusinessActive will revert account)
  if (typeof isBusinessActive === "function") {
    if (!isBusinessActive(chatId)) {
      if (u.fastPurchaseEnabled) {
        u.fastPurchaseEnabled = false;
        saveDB();
      }
      return false;
    }
  }
  return !!u.fastPurchaseEnabled;
}

function getRecentPhonesFromTxLog(chatId, limit = 10) {
  const u = getUser(chatId);
  const uniq = [];
  // Prefer saved phone first
  try {
    const saved = String(getUserPhone(chatId) || "");
    if (saved) uniq.push(saved);
  } catch (_) {}

  for (const t of (u.txLog || [])) {
    const ph = String(t?.phone254 || "");
    if (!ph) continue;
    if (!uniq.includes(ph)) uniq.push(ph);
    if (uniq.length >= limit) break;
  }
  return uniq.slice(0, limit);
}

// ===================== LANGUAGE (EN/SW) =====================
function getLang(chatId) {
  try {
    const u = getUser(chatId);
    const lang = (u && typeof u.lang === "string") ? u.lang : "en";
    return (lang === "sw") ? "sw" : "en";
  } catch (_) {
    return "en";
  }
}

function tr(chatId, enText, swText) {
  return getLang(chatId) === "sw" ? swText : enText;
}

function isBtn(text, enText, swText) {
  return text === enText || text === swText;
}

function langToggleMark(chatId) {
  return getLang(chatId) === "sw" ? "✅" : "⬜️";
}

// Light-weight translation layer for messages that are still hardcoded in English.
// (Keeps bot stable; keys we explicitly translate are handled with tr() above.)

function translateReplyMarkup(chatId, replyMarkup) {
  if (!replyMarkup || getLang(chatId) !== "sw") return replyMarkup;
  try {
    const rm = JSON.parse(JSON.stringify(replyMarkup)); // deep clone

    const tx = (v) => (typeof v === "string" ? translateOutgoing(chatId, v) : v);

    // Inline keyboard (array of button objects)
    if (Array.isArray(rm.inline_keyboard)) {
      rm.inline_keyboard = rm.inline_keyboard.map((row) =>
        Array.isArray(row)
          ? row.map((btn) => {
              if (btn && typeof btn.text === "string") btn.text = tx(btn.text);
              return btn;
            })
          : row
      );
    }

    // Reply keyboard (array of strings OR button objects depending on how it's constructed)
    if (Array.isArray(rm.keyboard)) {
      rm.keyboard = rm.keyboard.map((row) =>
        Array.isArray(row)
          ? row.map((btn) => {
              if (typeof btn === "string") return tx(btn);
              if (btn && typeof btn.text === "string") btn.text = tx(btn.text);
              return btn;
            })
          : row
      );
    }

    return rm;
  } catch (_) {
    return replyMarkup;
  }
}

function translateOutgoing(chatId, text) {
  if (getLang(chatId) !== "sw") return text;
  if (typeof text !== "string") return text;

  // Exact / safe replacements (avoid over-aggressive regex).
  const repl = [
    ["⚙️ *Welcome to Settings*", "⚙️ *Karibu kwenye Mipangilio*"],
    ["Toggle the options below to customize how the bot works for you:", "Washa/Zima chaguo hapa chini ili kubadilisha jinsi bot inavyofanya kazi:"],
    ["📞 *Support:*", "📞 *Msaada:*"],
    ["📞 *Support*", "📞 *Msaada*"],
    ["Tip: If you don't see buttons, update Telegram or restart the app.", "Kidokezo: Kama huoni vitufe, sasisha Telegram au anzisha upya app."],
    ["⬅️ Back to Commands & Settings", "⬅️ Rudi kwa Amri & Mipangilio"],
    ["⬅️ Back to Help", "⬅️ Rudi kwa Msaada"],
    ["🏠 Main Menu", "🏠 Menyu Kuu"],
    ["⚙️ Settings", "⚙️ Mipangilio"],
    ["👋 Hello", "👋 Habari"],
    ["🛒 Buy Offers", "🛒 Nunua Ofa"],
    ["👤 My Profile", "👤 Wasifu Wangu"],
    ["Telegram ID:", "Telegram ID:"],
    ["Name:", "Jina:"],
    ["Joined:", "Umejiunga:"],
    ["Saved number:", "Namba iliyohifadhiwa:"],
    ["Favourite package:", "Kifurushi unachopenda:"],
    ["Earnings (points)", "Mapato (pointi)"],
    ["Earnings (pointi)", "Mapato (pointi)"],
    ["Today:", "Leo:"],
    ["Yesterday:", "Jana:"],
    ["Total earned:", "Jumla uliyopata:"],
    ["Current balance:", "Salio la sasa:"],
    ["Purchases", "Manunuzi"],
    ["Total purchases:", "Jumla ya manunuzi:"],
    ["Total spend:", "Jumla uliyotumia:"],
    ["Withdrawals", "Miamala ya kutoa"],
    ["Approved total:", "Jumla iliyoidhinishwa:"],
    ["Declined total:", "Jumla iliyokataliwa:"],
    ["Today approved:", "Leo imeidhinishwa:"],
    ["Today declined:", "Leo imekataliwa:"],
    ["Weekly Draw", "Droo ya Wiki"],
    ["Status:", "Hali:"],
    ["NOT JOINED", "HUJAJIUNGA"],
    ["💸 Withdraw Points", "💸 Toa Pointi"],
    ["🔗 My Referral", "🔗 Rufaa Zangu"],
    ["ℹ️ Help", "ℹ️ Msaada"],
    ["🎉 WEEKLY DRAW", "🎉 DROO YA WIKI"],
    ["🙈 Hide Quick Actions", "🙈 Ficha Vitendo vya Haraka"],
    ["Select a package:", "Chagua kifurushi:"],
    ["✨ CHOOSE CATEGORY", "✨ CHAGUA KUNDI"],
    ["CHOOSE CATEGORY", "CHAGUA KUNDI"],
    ["Tap a category button", "Gusa kitufe cha kundi"],
    ["✅ Choose a category:", "✅ Chagua kundi:"],
    ["✅ Chagua kundi:", "✅ Chagua kundi:"],
    ["Auto Retry STK is ON.", "Jaribio la STK kiotomatiki LIMEWASHWA."],
    ["I will retry in", "Nitajaribu tena baada ya"],
    ["minutes (up to 2 times).", "dakika (hadi mara 2)."],
    ["Auto Retry STK sent", "STK imetumwa tena kiotomatiki"],
    ["Package:", "Kifurushi:"],
    ["Check your phone and complete payment.", "Angalia simu yako ukamilishe malipo."],
    ["When payment is successful you will receive a confirmation message here.", "Malipo yakifanikiwa utapata uthibitisho hapa."],
    ["If delay:", "Ukiwa na ucheleweshaji:"],
    ["Choose a category", "Chagua kundi"],
    ["Available categories:", "Makundi yaliyopo:"],
    ["Added", "Imeongezwa"],
    ["plan(s)", "mpango"],
    ["Errors:", "Makosa:"],
    ["Failed:", "Imeshindikana:"],
    ["Help / delays:", "Msaada / ucheleweshaji:"],
    ["Tap", "Gusa"],
    ["Buy Offers to purchase.", "Nunua Ofa kufanya manunuzi."],
    ["Commands & Settings", "Amri & Mipangilio"],
    ["My Profile", "Wasifu Wangu"],
    ["Withdraw Points", "Toa Pointi"],
    ["My Referral", "Rufaa Zangu"],
    ["Search offers inline:", "Tafuta ofa kwenye laini:"],
    ["Search Offers", "Tafuta Ofa"],
    ["Proceed", "Endelea"],
    ["Change Number", "Badilisha Nambari"],
    ["Enter your M-PESA number", "Weka nambari yako ya M-PESA"],
    ["Please enter your M-PESA number", "Tafadhali weka nambari yako ya M-PESA"],
    ["Payment cancelled", "Malipo yameghairiwa"],
    ["✅ Payment Confirmed", "✅ Malipo Yamethibitishwa"],
    ["Payment Confirmed", "Malipo Yamethibitishwa"],
    ["Payment confirmed", "Malipo yamethibitishwa"],
    ["Payment Thibitishaed", "Malipo yamethibitishwa"],
    ["Your payment has been received and your request is being processed.", "Malipo yako yamepokelewa na ombi lako linafanyiwa kazi."],
    ["Cashback Earned!", "Cashback Imepatikana!"],
    ["Purchase:", "Manunuzi:"],
    ["Reward:", "Zawadi:"],
    ["Reminder: You haven't completed the payment yet.", "Kumbusho: Bado hujakamilisha malipo."],
    ["Resend STK", "Tuma tena STK"],
    ["if you didn't receive the prompt.", "kama hukupata ujumbe wa STK."],
    ["Gusa 🔁 Resend STK if you didn\'t receive the prompt.", "Gusa 🔁 Tuma tena STK kama hukupata ujumbe wa STK."],

    ["Payment failed", "Malipo yameshindwa"],
    ["Payment successful", "Malipo yamefanikiwa"],
    ["Order received", "Oda imepokelewa"],
    ["Referral", "Rufaa"],
    ["points", "pointi"],
    ["Support:", "Msaada:"],
      ["❓ *Help Center*", "❓ *Kituo cha Msaada*"],
    ["Tap a question below to see the full explanation.", "Gonga swali hapa chini kuona maelezo kamili."],
    ["🛒 *How to buy offers*", "🛒 *Jinsi ya kununua ofa*"],
    ["💳 *Payments (STK Push)*", "💳 *Malipo (STK Push)*"],
    ["💸 *Withdrawing points*", "💸 *Kutoa pointi*"],
    ["🔗 *Referrals*", "🔗 *Rufaa*"],
    ["👤 *My Profile*", "👤 *Wasifu Wangu*"],
    ["📌 *Important commands*", "📌 *Amri muhimu*"],
    ["🧩 *Inline buttons*", "🧩 *Vitufe vya Inline*"],
    ["🎁 *Redeem*", "🎁 *Kukomboa*"],
    ["⚠️ *Penalties / Restrictions*", "⚠️ *Adhabu / Vikwazo*"],
    ["🎟️ *Weekly draw*", "🎟️ *Droo ya kila wiki*"],
    ["🏆 *Winners*", "🏆 *Washindi*"],
    ["🏢 *Business / Admin*", "🏢 *Business / Admin*"],
    ["Choose a category", "Chagua kategoria"],
    ["Select an offer", "Chagua ofa"],
    ["Enter phone number", "Weka namba ya simu"],
    ["Phone number", "Namba ya simu"],
    ["Cancel", "Ghairi"],
    ["✅ I have the prompt", "✅ Nimepata STK"],
    ["🔁 Retry STK", "🔁 Rudia STK"],
    ["❌ Cancel Pending", "❌ Ghairi Inayosubiri"],
    ["⚠️ *STK Request Delayed*", "⚠️ *STK Imechelewa*"],
    ["If you receive the M-PESA prompt, complete it.", "Ukipata ujumbe wa M-PESA, kamilisha malipo."],
    ["If no prompt appears within 1 minute:", "Kama hakuna STK ndani ya dakika 1:"],
    ["✅ Payment received", "✅ Malipo yamepokelewa"],
    ["Payment failed", "Malipo yameshindikana"],
    ["Insufficient points", "Pointi hazitoshi"],
    ["Insufficient balance", "Salio halitoshi"],
    ["Try again", "Jaribu tena"],
    ["Back", "Rudi"],
    ["Next", "Endelea"],
    ["Gusa a question below to see the full explanation.", "Gonga swali hapa chini kuona maelezo kamili."],
    ["💡 Tip: You can also search offers using inline:", "💡 Kidokezo: Unaweza pia kutafuta ofa kwa kutumia inline:"],
    ["Tip: You can also search offers using inline:", "Kidokezo: Unaweza pia kutafuta ofa kwa kutumia inline:"],
    ["Buying", "Kununua"],
    ["Payments", "Malipo"],
    ["Winners", "Washindi"],
    ["Withdraw", "Kutoa"],
    ["Redeem", "Kukomboa"],
    ["Inline Search", "Tafuta Inline"],
    ["Referrals", "Rufaa"],
    ["Rules", "Sheria"],
    ["Business", "Biashara"],
    ["🔁 Buy Again", "🔁 Nunua Tena"],
    ["🚀 Upgrade:", "🚀 Boresha:"],
    ["Upgrade:", "Boresha:"],
    ["STK request expired. Please try again if you still want to pay.", "Ombi la STK limeisha. Tafadhali jaribu tena kama bado unataka kulipa."],
    ["⬅️ Prev", "⬅️ Nyuma"],
    ["⬅ Prev", "⬅ Nyuma"],
    ["Welcome", "Karibu"],
    ["Settings", "Mipangilio"],
    ["Help", "Msaada"],
    ["Support", "Msaada"],
    ["Stop campaign", "Zima Matangazo"],
    ["Stop cashback", "Zima Cashback"],
    ["Stop referrals", "Zima Rufaa"],
    ["Auto delete", "Futa kiotomatiki"],
    ["Auto hide buttons", "Ficha vitufe kiotomatiki"],
    ["Hide Quick Actions", "Ficha Quick Actions"],
    ["Fast Purchase ON", "Ununuzi Haraka WASHWA"],
    ["Fast Purchase OFF", "Ununuzi Haraka IMEZIMWA"],
    ["Auto Retry STK ON", "Auto Retry STK WASHWA"],
    ["Auto Retry STK OFF", "Auto Retry STK IMEZIMWA"],
    ["✅ Main menu:", "✅ Menyu kuu:"],
    ["Invite Friends & Earn Points!", "Alika Marafiki & Pata Pointi!"],
    ["Rufaa Bonus:", "Bonasi ya Rufaa:"],
    ["Earn 2% pointi from every successful purchase your friend makes (for 30 days).", "Pata 2% ya pointi kutoka kwa kila ununuzi uliofanikiwa ambao rafiki yako anafanya (kwa siku 30)."],
    ["Earn 2% points from every successful purchase your friend makes (for 30 days).", "Pata 2% ya pointi kutoka kwa kila ununuzi uliofanikiwa ambao rafiki yako anafanya (kwa siku 30)."],
    ["Gusa a button below to share your invite link instantly", "Gusa kitufe hapa chini kushiriki kiungo chako cha mwaliko papo hapo"],
    ["Tap a button below to share your invite link instantly", "Gusa kitufe hapa chini kushiriki kiungo chako cha mwaliko papo hapo"],
    ["🛒 Buying", "🛒 Kununua"],
    ["💳 Payments", "💳 Malipo"],
    ["🎉 Droo ya Wiki", "🎉 Droo ya Wiki"],
    ["🏆 Winners", "🏆 Washindi"],
    ["💸 Withdraw", "💸 Kutoa"],
    ["🎁 Redeem", "🎁 Kukomboa"],
    ["🎁 Redeem Points", "🎁 Kukomboa Pointi"],

    ["🔎 Inline Search", "🔎 Tafuta Inline"],
    ["👥 Referrals", "👥 Rufaa"],
    ["⚠️ Rules", "⚠️ Sheria"],
    ["🏢 Business", "🏢 Biashara"],
    ["⚙️ Amri & Mipangilio", "⚙️ Amri & Mipangilio"],
    ["Earn rewards while buying cheap offers!", "Pata zawadi unaponunua ofa nafuu!"],
    ["Turn your small purchases into real rewards!", "Badilisha manunuzi madogo kuwa zawadi halisi!"],
    ["Join Bingwa Data Bot today and compete for weekly cash prizes", "Jiunge na Bingwa Data Bot leo ushindanie zawadi za pesa kila wiki"],
    ["Your Stats", "Takwimu Zako"],
    ["Total successful referrals:", "Jumla ya rufaa zilizofanikiwa:"],
    ["Earned so far from referrals:", "Uliyopata hadi sasa kutoka kwa rufaa:"],
    ["Today's referral earnings:", "Mapato ya rufaa ya leo:"],
    ["Your pointi balance:", "Salio lako la pointi:"],
    ["Tap a button below to share your invite link instantly", "Gusa kitufe hapa chini kushiriki kiungo chako cha mwaliko papo hapo"],
    ["Weekly prizes available — don’t miss out!", "Zawadi za kila wiki zipo — usikose!"],
    ["Share on Telegram", "Shiriki Telegram"],
    ["Share on WhatsApp", "Shiriki WhatsApp"],
    ["Copy Link", "Nakili Kiungo"],
    ["Copy this link:", "Nakili kiungo hiki:"],
    ["Your balance:", "Salio lako:"],
    ["⭐ Your points:", "⭐ Pointi zako:"],
    ["Use \"🎁 Redeem Points\" to redeem.", "Tumia \"🎁 Kukomboa Pointi\" kukomboa."],
    ["Choose amount to withdraw:", "Chagua kiasi cha kutoa:"],
    ["Withdrawal Locked", "Kutoa Kumezuiwa"],
    ["You must spend at least Ksh", "Lazima utumie angalau Ksh"],
    ["before making a withdrawal request.", "kabla ya kuomba kutoa."],
    ["Total spent:", "Jumla iliyotumika:"],
    ["Remaining to unlock:", "Imebaki kufungua:"],
    ["Keep buying to unlock withdrawals.", "Endelea kununua ili kufungua kutoa."],
    ["We miss you!", "Tumekukosa!"],
    ["Come back today and grab your best offer.", "Rudi leo uchukue ofa yako bora."],
    ["Tip: Share your referral link to earn points on every successful purchase!", "Kidokezo: Shiriki kiungo chako cha rufaa upate pointi kwa kila ununuzi uliofanikiwa!"],
    ["Prev", "Nyuma"],

    // Purchase + STK / transaction texts
    ["✨ CHOOSE CATEGORY", "✨ CHAGUA KUNDI"],
    ["✅ Choose a category:", "✅ Chagua kundi:"],
    ["Tap a category button:", "Gusa kitufe cha kundi:"],
    ["Tap a package button:", "Gusa kitufe cha kifurushi:"],
    ["Choose a number below or tap ➕ New Number:", "Chagua nambari hapa chini au gusa ➕ Namba Mpya:"],
    ["STK Triggered", "STK Imeanzishwa"],
    ["✅ STK sent!", "✅ STK imetumwa!"],
    ["STK sent!", "STK imetumwa!"],
    ["When payment is successful you will receive a confirmation message here.", "Malipo yakifanikiwa utapokea ujumbe wa uthibitisho hapa."],
    ["Check your phone and complete payment.", "Angalia simu yako ukamilishe malipo."],
    ["Payment was not completed at", "Malipo hayajakamilika tarehe"],
    ["Auto Retry STK is enabled. I will resend the STK prompt automatically.", "Jaribio Tena la STK limewashwa. Nitatuma tena STK kiotomatiki."],
    ["Auto Retry STK is ON.", "Jaribio Tena la STK LIKO WAZI."],
    ["Auto Retry STK sent", "Jaribio Tena la STK limetumwa"],
    ["I will retry in", "Nitajaribu tena baada ya"],
    ["minutes (up to 2 times).", "dakika (hadi mara 2)."],
    ["Package:", "Kifurushi:"],
    ["Offer:", "Ofa:"],
    ["Phone:", "Simu:"],
    ["Amount:", "Kiasi:"],
    ["Channel:", "Njia:"],
    ["Ref:", "Rejea:"],
    ["Time:", "Muda:"],
    ["If delay:", "Ikiwa kuna ucheleweshaji:"],
];

  let out = text;
  for (const [a, b] of repl) out = out.split(a).join(b);
  // Pattern-based translations (for dynamic values)
  out = out
    .replace(/Not enough pointi\.\s*You have\s*([0-9.]+)\s*pts/gi, "Pointi hazitoshi. Una $1 pts")
    .replace(/Your balance:\s*([0-9.]+)\s*pts/gi, "Salio lako: $1 pts")
    .replace(/Your balance:\s*([0-9.]+)\s*pointi/gi, "Salio lako: $1 pointi")
    .replace(/Choose amount to withdraw:\s*/gi, "Chagua kiasi cha kutoa:\n")
    .replace(/\bUnlimited Deals\b/gi, "Ofa Zisizo na Kikomo")
    .replace(/\bMinutes\b/gi, "Dakika")
    .replace(/\bSMS Offers\b/gi, "Ofa za SMS")
    .replace(/\bBonga Points\b/gi, "Pointi za Bonga")
    .replace(/\bFlex Deals\b/gi, "Ofa za Flex")
    .replace(/\bpackages:\b/gi, "vifurushi:")
    // Convert (2HRS)/(24HRS) etc into Swahili
    .replace(/\((\d+)\s*HRS?\)/gi, "(Saa $1)")
    .replace(/\bHRS\b/gi, "Saa")
;

  return out;
}

function fastPurchaseToggleMark(chatId) {
  return isFastPurchaseEnabled(chatId) ? "✅" : "⬜️";
}


// ===================== AUTO RETRY STK (BUSINESS) =====================
// Auto-retry STK (Business accounts only): retry after 1.1 minutes, up to 2 times.
// Auto-off when Business expires.
function isAutoRetryStkEnabled(chatId) {
  const u = getUser(chatId);
  // Business only; auto-off when business expires (same behavior as Fast Purchase)
  if (typeof isBusinessActive === "function") {
    if (!isBusinessActive(chatId)) {
      if (u.autoRetryStkEnabled) {
        u.autoRetryStkEnabled = false;
        saveDB();
      }
      return false;
    }
  }
  return !!u.autoRetryStkEnabled;
}

function autoRetryToggleMark(chatId) {
  return isAutoRetryStkEnabled(chatId) ? "✅" : "⬜️";
}

// ===================== NOTIFICATION FILTERS (BUSINESS) =====================
// When Business expires: auto-clear all stop-* flags (restore default notifications ON).
function _ensureBusinessAndResetPrefs(chatId) {
  const u = getUser(chatId);
  if (typeof isBusinessActive === "function") {
    if (!isBusinessActive(chatId)) {
      let changed = false;
      if (u.autoRetryStkEnabled) { u.autoRetryStkEnabled = false; changed = true; }
      if (u.stopCampaignNotifs) { u.stopCampaignNotifs = false; changed = true; }
      if (u.stopCashbackNotifs) { u.stopCashbackNotifs = false; changed = true; }
      if (u.stopReferralNotifs) { u.stopReferralNotifs = false; changed = true; }
      if (u.autoDelete24hEnabled) { u.autoDelete24hEnabled = false; changed = true; }
      // Also restore autodelete setting to OFF (0) if you want default behavior.
      if (u.autoDeleteMs && Number(u.autoDeleteMs) > 0) { u.autoDeleteMs = 0; changed = true; }
      if (changed) { try { saveDB(); } catch (_) {} }
      return false;
    }
  }
  return true;
}

function isStopCampaignNotifs(chatId) {
  const u = getUser(chatId);
  if (!_ensureBusinessAndResetPrefs(chatId)) return false;
  return !!u.stopCampaignNotifs;
}
function isStopCashbackNotifs(chatId) {
  const u = getUser(chatId);
  if (!_ensureBusinessAndResetPrefs(chatId)) return false;
  return !!u.stopCashbackNotifs;
}
function isStopReferralNotifs(chatId) {
  const u = getUser(chatId);
  if (!_ensureBusinessAndResetPrefs(chatId)) return false;
  return !!u.stopReferralNotifs;
}
function isAutoDelete24hEnabled(chatId) {
  const u = getUser(chatId);
  if (!_ensureBusinessAndResetPrefs(chatId)) return false;
  return !!u.autoDelete24hEnabled;
}

function markOnOff(enabled) { return enabled ? "✅" : "⬜️"; }

function campaignNotifsMark(chatId) { return markOnOff(isStopCampaignNotifs(chatId)); }
function cashbackNotifsMark(chatId) { return markOnOff(isStopCashbackNotifs(chatId)); }
function referralNotifsMark(chatId) { return markOnOff(isStopReferralNotifs(chatId)); }
function autoDelete24hMark(chatId) { return markOnOff(isAutoDelete24hEnabled(chatId)); }

function isHideQuickActionsEnabled(chatId) {
  const u = getUser(chatId);
  return !!u.hideQuickActionsEnabled;
}
function hideQuickActionsMark(chatId) { return markOnOff(isHideQuickActionsEnabled(chatId)); }

// ===========================================================================

// ===================== AUTO HIDE BUTTONS (ALL USERS) =====================
function isAutoHideButtonsEnabled(chatId) {
  const u = getUser(chatId);
  return !!u.autoHideButtonsEnabled;
}

function autoHideButtonsMark(chatId) {
  return markOnOff(isAutoHideButtonsEnabled(chatId));
}
// ===========================================================================

// ==========================================================
function settingsMenuKeyboard(chatId) {
  return {
    reply_markup: {
      inline_keyboard: [
[
  { text: `${langToggleMark(chatId)} Kiswahili`, callback_data: "lang:toggle" },
],
[
  { text: `${fastPurchaseToggleMark(chatId)} ${tr(chatId,"Fast Purchase","Ununuzi Haraka")}`, callback_data: "fp:toggle" },
  { text: `${autoRetryToggleMark(chatId)} ${tr(chatId,"Auto Retry STK","Rudia STK Kiotomatiki")}`, callback_data: "ar:toggle" },
],
[
  { text: `${campaignNotifsMark(chatId)} ${tr(chatId,"Stop campaign","Zima Matangazo")}`, callback_data: "nf:campaign" },
  { text: `${cashbackNotifsMark(chatId)} ${tr(chatId,"Stop cashback","Zima Cashback")}`, callback_data: "nf:cashback" },
],
[
  { text: `${referralNotifsMark(chatId)} ${tr(chatId,"Stop referral","Zima Rufaa")}`, callback_data: "nf:referral" },
  { text: `${autoDelete24hMark(chatId)} ${tr(chatId,"Auto delete (24hrs)","Futa kiotomatiki (Saa 24)")}`, callback_data: "ad:24h" },
],
[
  { text: `${autoHideButtonsMark(chatId)} ${tr(chatId,"Auto hide buttons","Ficha Vitufe Kiotomatiki")}`, callback_data: "bh:toggle" },
  { text: `${hideQuickActionsMark(chatId)} ${tr(chatId,"Hide Quick Actions","Ficha Vitendo vya Haraka")}`, callback_data: "qa:toggle" },
],

...(isBusinessActive(chatId) ? [[{ text: tr(chatId,"💾 Backup (Auto-Delete)","💾 Hifadhi Nakala (Futa Kiotomatiki)"), callback_data: "biz:backup_once" }]] : []),

[{ text: tr(chatId,"⬅️ Back to Commands & Settings","⬅️ Rudi kwa Amri & Mipangilio"), callback_data: "help:cmds" }, { text: tr(chatId,"🏠 Main Menu","🏠 Menyu Kuu"), callback_data: "help:home" }],
[{ text: tr(chatId,"⬅️ Back to Help","⬅️ Rudi kwa Msaada"), callback_data: "help:menu" }],
      ],
    },
  };
}

// Backwards compatibility (older code paths)
function fastPurchaseHelpKeyboard(chatId) {
  return settingsMenuKeyboard(chatId);
}function fastPurchasePhoneKeyboard(chatId, s, limit = 10) {
  const phones = getRecentPhonesFromTxLog(chatId, limit);
  const rows = [];
  s.fpPhoneMap = {};

  for (const p of phones) {
    const label = `📱 ${maskPhone(p)}`;
    // Avoid collisions
    if (s.fpPhoneMap[label]) continue;
    s.fpPhoneMap[label] = p;
    rows.push([label]);
  }

  rows.push(["➕ New Number"]);
  rows.push([PREV_BTN, "🏠 Main Menu"]);

  return { reply_markup: { keyboard: rows, resize_keyboard: true, one_time_keyboard: false } };
}
// ==========================================================


// Anti-spam signature
function makeSig({ category, pkgLabel, phone254 }) {
  return `${category}||${pkgLabel}||${phone254}`;
}

function ensurePhoneAccountLinks() {
  db = repairDB(db);
  if (!db.phoneAccountLinks || typeof db.phoneAccountLinks !== "object") {
    db.phoneAccountLinks = {};
    saveDB();
  }
}

function getLinkedAccountsForPhone(phone254) {
  ensurePhoneAccountLinks();
  const key = String(phone254 || "");
  const arr = db.phoneAccountLinks[key];
  return Array.isArray(arr) ? arr : [];
}

function setLinkedAccountsForPhone(phone254, arr) {
  ensurePhoneAccountLinks();
  const key = String(phone254 || "");
  db.phoneAccountLinks[key] = Array.isArray(arr) ? arr : [];
  saveDB();
}

function ensurePhoneLinkApprovals() {
  db = repairDB(db);
  if (!db.phoneLinkApprovals || typeof db.phoneLinkApprovals !== "object") {
    db.phoneLinkApprovals = {};
    saveDB();
  }
}

function makeApprovalId() {
  return `APR-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function createPhoneLinkApproval({ chatId, phone254 }) {
  ensurePhoneLinkApprovals();
  const id = makeApprovalId();
  db.phoneLinkApprovals[id] = {
    id,
    chatId: Number(chatId),
    phone254: String(phone254 || ""),
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
  };
  saveDB();
  return db.phoneLinkApprovals[id];
}

function getPhoneLinkApproval(id) {
  ensurePhoneLinkApprovals();
  const r = db.phoneLinkApprovals[String(id || "")];
  if (!r) return null;
  if (r.expiresAt && Date.now() > Number(r.expiresAt)) {
    r.status = "expired";
    saveDB();
    return null;
  }
  return r;
}

function setPhoneLinkApprovalStatus(id, status) {
  ensurePhoneLinkApprovals();
  const r = db.phoneLinkApprovals[String(id || "")];
  if (!r) return null;
  r.status = status;
  r.updatedAt = Date.now();
  saveDB();
  return r;
}


function unlinkAccountFromPhone(chatId, phone254) {
  if (!phone254) return;
  const list = getLinkedAccountsForPhone(phone254)
    .filter(x => x && String(x.chatId) !== String(chatId));
  setLinkedAccountsForPhone(phone254, list);
}

function linkAccountToPhone(chatId, phone254) {
  // ✅ Admin bypass
  if (isAdmin(chatId)) return { ok: true, linked: true, total: 999 };

  const p = String(phone254 || "");
  if (!p) return { ok: false, reason: "invalid_phone" };

  // If user had a previous linked phone, unlink to "return the slot"
  const u = getUser(chatId);
  const prev = String(u.lastLinkedPhone || "");
  if (prev && prev !== p) {
    unlinkAccountFromPhone(chatId, prev);
  }

  const now = Date.now();
  let list = getLinkedAccountsForPhone(p);

  // Already linked -> refresh lastUsedAt
  const idx = list.findIndex(x => x && String(x.chatId) === String(chatId));
  if (idx >= 0) {
    list[idx].lastUsedAt = now;
    setLinkedAccountsForPhone(p, list);
    u.lastLinkedPhone = p;
    saveDB();
    return { ok: true, linked: false, total: list.length };
  }

  // Strict limit: max 4 accounts per phone number (4th requires admin approval)
  if (!isBusinessActive(chatId) && list.length >= 4) {
    const appr = createPhoneLinkApproval({ chatId, phone254: p });
    // notify admin
    notifyAdmin(
      `🛂 *Phone Approval Request*
` +
      `Phone: *${mdEscape(maskPhone(p))}*
` +
      `Requester ChatID: \`${mdEscape(String(chatId))}\`

` +
      `Approve will free 1 slot (oldest) and link this account.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Approve", callback_data: `phone_appr:approve:${appr.id}` }],
            [{ text: "❌ Deny", callback_data: `phone_appr:deny:${appr.id}` }],
          ],
        },
      }
    ).catch(() => {});
    return { ok: false, reason: "needs_approval", approvalId: appr.id, total: list.length };
  }

  // Link new account
  list.push({ chatId: Number(chatId), lastUsedAt: now });
  setLinkedAccountsForPhone(p, list);

  u.lastLinkedPhone = p;
  saveDB();

  return { ok: true, linked: true, total: list.length };
}


function linkedAccountsLabelForPhone(phone254) {
  const list = getLinkedAccountsForPhone(phone254)
    .slice()
    .sort((a, b) => Number(b.lastUsedAt || 0) - Number(a.lastUsedAt || 0));
  if (!list.length) return "(none)";
  return list.map((x, i) => `• Account ${i + 1}: ${mdEscape(String(x.chatId))}`).join("\\n");
}

function checkAndMarkSpam(chatId, sig, phone254) {
  // ✅ Phone/account linking limits removed (only Bingwa daily rule remains elsewhere).
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
  const p = db.pendingPayments[String(externalRef)] || null;
  if (p && isPendingExpired(p)) {
    delete db.pendingPayments[String(externalRef)];
    saveDB();
    return null;
  }
  return p;
}
function deletePendingPayment(externalRef) {
  db = repairDB(db);
  delete db.pendingPayments[String(externalRef)];
  saveDB();
}

function isPendingExpired(p, ttlMs = 10 * 60 * 1000) {
  const ts = Number(p?.createdAt || 0);
  if (!ts) return true;
  return Date.now() - ts > ttlMs;
}

function cleanExpiredPendingPayments() {
  db = repairDB(db);
  const ttl = 10 * 60 * 1000; // 10 minutes
  let changed = false;
  for (const [ref, p] of Object.entries(db.pendingPayments || {})) {
    if (!p || isPendingExpired(p, ttl)) {
      // notify user once when STK expires
      try {
        const cid = Number(p?.chatId || 0);
        if (cid) {
          const phone07 = mask07(formatTo07(String(p?.phone254 || "")));
          const pkgLabel = String(p?.pkgLabel || "N/A");
          const requestedAt = kenyaDateTimeCompactFromTs(p?.createdAt || 0);
          bot.sendMessage(
            cid,
            tr(
              cid,
              `⌛ STK request expired on ${phone07}. Package: ${pkgLabel} requested on ${requestedAt}. Please try again if you still want to pay.`,
              `⌛ Ombi la STK limeisha kwa namba ${phone07}. Kifurushi: ${pkgLabel} kiliombwa tarehe ${requestedAt}. Tafadhali jaribu tena kama bado unataka kulipa.`
            )
          ).catch(() => {});
        }
      } catch (_) {}

      delete db.pendingPayments[ref];
      changed = true;
    }
  }
  if (changed) saveDB();
}

function findRecentPendingForSameRequest({ chatId, phone254, category, pkgLabel, withinMs = 2 * 60 * 1000 }) {
  db = repairDB(db);
  const cid = Number(chatId || 0);
  const ph = String(phone254 || "");
  const cat = String(category || "");
  const lbl = String(pkgLabel || "");
  const now = Date.now();

  for (const [ref, p] of Object.entries(db.pendingPayments || {})) {
    if (!p) continue;
    if (Number(p.chatId || 0) !== cid) continue;
    if (String(p.phone254 || "") !== ph) continue;
    if (String(p.category || "") !== cat) continue;
    if (String(p.pkgLabel || "") !== lbl) continue;
    const ts = Number(p.createdAt || 0);
    if (ts && now - ts <= withinMs && !isPendingExpired(p)) {
      return { ref, pending: p };
    }
  }
  return null;
}

function getLatestPendingForChat(chatId) {
  cleanExpiredPendingPayments();
  db = repairDB(db);
  const cid = Number(chatId || 0);
  let best = null;
  for (const [ref, p] of Object.entries(db.pendingPayments || {})) {
    if (!p) continue;
    if (isPendingExpired(p)) continue;
    if (Number(p.chatId || 0) !== cid) continue;
    const ts = Number(p.createdAt || 0);
    if (!best || ts > Number(best.createdAt || 0)) {
      best = { ref, ...p };
    }
  }
  return best;
}


function hasActivePendingStkForChat(chatId) {
  const p = getLatestPendingForChat(chatId);
  return p && p.ref ? p : null;
}


function isStkDelayedError(err) {
  const s = String(err?.message || err || "").toLowerCase();
  return s.includes("504") || s.includes("gateway timeout") || s.includes("timeout");
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



async function initiatePurchaseStk(chatId, s, pkg, phone254, receivingPhone254 = null) {
  const phone = String(phone254 || "");
  if (!phone) return sendTracked(chatId, "❌ Missing phone.", { ...mainMenuKeyboard(chatId) });

  // ✅ Bingwa once per day per phone (hard block)
  if (!isAdmin(chatId) && s.category === "Bingwa Deals" && bingwaAlreadyPurchasedToday(phone)) {
    sessions.delete(chatId);
    return sendTracked(
      chatId,
      `🚫 *Bingwa Deals limit reached*\nNumber: *${maskPhone(phone)}*\nThis number already bought Bingwa today.\n\nUse a different number or try again tomorrow.`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
    );
  }

  const sig = makeSig({ category: s.category, pkgLabel: pkg.label, phone254: phone });
  const recent = findRecentPendingForSameRequest({ chatId, phone254: phone, category: s.category, pkgLabel: pkg.label, withinMs: 2 * 60 * 1000 });
  if (recent) {
    return sendTracked(
      chatId,
      `⚠️ *STK already sent recently*\n\nIf you receive the M-PESA prompt, complete it.\n\nIf no prompt appears within 1 minute:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ I have the prompt", callback_data: `ui:stk_have_prompt:${recent.ref}` }],
            [{ text: "🔁 Retry STK", callback_data: `retry_stk:${recent.ref}` }],
            [{ text: "❌ Cancel Pending", callback_data: `ui:stk_cancel:${recent.ref}` }],
            [{ text: "🛒 Buy Offers", callback_data: "buy_offers" }],
          ],
        },
      }
    );
  }

  const spam = checkAndMarkSpam(chatId, sig, phone);
  if (!spam.ok && spam.reason === "phone_needs_approval") {
    return sendTracked(
      chatId,
      `🛂 This phone number is already linked to 4 accounts.\n\n✅ An approval request has been sent to admin.\nPlease wait for approval, then try again.\n\n☎️ Help: ${HELP_PHONE}`,
      { ...mainMenuKeyboard(chatId) }
    );
  }
  if (!spam.ok && spam.reason === "phone_account_limit") {
    return sendTracked(
      chatId,
      `⚠️ This phone number is already linked to 4 accounts.\n\nUse a different number or contact support.\n\n☎️ Help: ${HELP_PHONE}`,
      { ...mainMenuKeyboard(chatId) }
    );
  }
  if (!spam.ok) return sendTracked(chatId, spam.reason, { ...mainMenuKeyboard(chatId) });

  const blockedUntil = isStkBlocked(chatId, phone);
  if (blockedUntil) {
    const secs = Math.ceil((blockedUntil - Date.now()) / 1000);
    return sendTracked(chatId, `⛔ STK temporarily blocked due to repeated failures.\nTry again in ${secs}s.`, { ...mainMenuKeyboard(chatId) });
  }

  
// ✅ Prevent multiple users from spamming STK to the same phone at the same time
try {
  const now = Date.now();
  const lk = phoneStkLock.get(phone);
  if (lk && lk.until > now && lk.ref) {
    return sendTracked(
      chatId,
      `⏳ STK is already pending for *${maskPhone(phone)}*.\n\nPlease wait ~30s and complete the existing prompt.`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
    );
  }
  // lock for 30s
  phoneStkLock.set(phone, { until: now + 30 * 1000, ref: "PENDING" });
  setTimeout(() => {
    try {
      const cur = phoneStkLock.get(phone);
      if (cur && cur.until <= Date.now()) phoneStkLock.delete(phone);
    } catch (_) {}
  }, 31 * 1000);
} catch (_) {}
await sendTracked(chatId, "🔔 Sending STK push… Check your phone.");

  const ref = makeExternalRef(chatId, s.category, pkg.price);
  try { phoneStkLock.set(phone, { until: Date.now() + 30 * 1000, ref }); } catch (_) {}
  const channelId = channelIdForCategory(s.category);

  addPendingPayment(ref, { chatId, category: s.category, pkgLabel: pkg.label, phone254: phone, receivingPhone254: String(receivingPhone254 || s?.receivingPhone254 || phone || ""), price: pkg.price });

  // Notify admin (non-blocking)
  try {
    await notifyAdmin(
      `💳 *STK Triggered*\n` +
        `ChatID: \`${mdEscape(chatId)}\`\n` +
        `Offer: *${mdEscape(pkg.label)}*\n` +
        `Phone: *${mdEscape(formatTo07(phone))}*\n` +
        `Amount: *Ksh ${mdEscape(pkg.price)}*\n` +
        `Channel: *${mdEscape(channelId)}*\n` +
        `Ref: \`${mdEscape(ref)}\`\n` +
        `Time: ${mdEscape(nowISO())}`
    );
  } catch (_) {}

  try {
    await payheroStkPush({ amount: pkg.price, phone, externalRef: ref, channelId });

    // ✅ Auto reminder after 2 minutes if payment not completed
    try {
      if (stkReminderTimers.has(ref)) {
        clearTimeout(stkReminderTimers.get(ref));
        stkReminderTimers.delete(ref);
      }
      const t = setTimeout(async () => {
        try {
          const stillPending = getPendingPayment(ref);
          if (!stillPending) return;
          if (alreadyProcessed(ref) || alreadyProcessed(`FAIL-${ref}`)) return;
          await sendTracked(
            chatId,
            `⏳ Reminder: You haven't completed the payment yet.\n\nTap 🔄 Resend STK if you didn't receive the prompt.\n\nHelp: ${HELP_PHONE}`,
            { ...mainMenuKeyboard(chatId) }
          );
        } catch (_) {}
      }, 2 * 60 * 1000);
      stkReminderTimers.set(ref, t);
    } catch (_) {}

    sessions.delete(chatId);

    return sendTracked(
      chatId,
      `✅ STK sent!\n\nOffer: ${pkg.label}\nPay: Ksh ${pkg.price}\nFrom: ${maskPhone(phone)}\nChannel: ${channelId}\nRef: ${ref}\nTime: ${nowISO()}\n\nWhen payment is successful you will receive a confirmation message here.\n\nIf delay: ${HELP_PHONE}`,
      { ...mainMenuKeyboard(chatId) }
    );
  } catch (err) {
    if (isStkDelayedError(err)) {
      await notifyAdmin(
        `⚠️ *STK Delayed*\nChatID: \`${mdEscape(chatId)}\`\nRef: \`${mdEscape(ref)}\`\nError: \`${mdEscape(String(err.message || err))}\``
      );
      // Auto Retry STK (Business)
      try { if (isAutoRetryStkEnabled(chatId) || (typeof isAdmin==="function" && isAdmin(chatId))) scheduleAutoRetryStk(chatId, ref, "delayed"); } catch (_) {}

      return sendTracked(
        chatId,
        `⚠️ *STK Request Delayed*\n\nIf you receive the M-PESA prompt, complete it.\n\nIf no prompt appears within 1 minute:`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ I have the prompt", callback_data: `ui:stk_have_prompt:${ref}` }],
              [{ text: "🔁 Retry STK", callback_data: `retry_stk:${ref}` }],
              [{ text: "❌ Cancel Pending", callback_data: `ui:stk_cancel:${ref}` }],
              [{ text: "🛒 Buy Offers", callback_data: "buy_offers" }],
            ],
          },
        }
      );
    }

    // Mark failure and apply block logic (reuse existing logic)
    try { markStkFailure(chatId, phone); } catch (_) {}

    // Auto Retry STK (Business) — for cancelled/delayed/not-sent scenarios
    try { if (isAutoRetryStkEnabled(chatId) || (typeof isAdmin==="function" && isAdmin(chatId))) scheduleAutoRetryStk(chatId, ref, "not_sent"); } catch (_) {}

    return sendTracked(chatId, `❌ STK failed: ${String(err?.message || err)}`, { ...mainMenuKeyboard(chatId) });
  }
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

async function sendTracked(chatId, text, options = {}) {
  // Keep main welcome message permanently
  const isWelcomeMessage = text && text.startsWith("👋 Hello");

  if (!isWelcomeMessage) {
    const prev = lastBotMessage.get(chatId);
    await deleteMessageSafe(chatId, prev);
  }

  const sent = await bot.sendMessage(chatId, text, options);

  // Only track non-welcome messages
  if (!isWelcomeMessage) {
    lastBotMessage.set(chatId, sent.message_id);
  }

  return sent;
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
    

  const sent = await bot.sendMessage(ADMIN_ID, text, { parse_mode: "Markdown" });
  } catch (e) {
    console.log("notifyAdmin failed:", e?.message || e);
    try {
      

  const sent = await bot.sendMessage(ADMIN_ID, String(text));
    } catch (_) {}
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ===================== BROADCAST HELPERS =====================
function buildReferralLeaderboardText(limit = 5) {
  db = repairDB(db);
  const entries = Object.entries(db.users || {})
    .filter(([cid]) => String(cid) !== String(ADMIN_ID))
    .map(([cid, u]) => ({ cid, referrals: Number(u.referralSuccessCount || 0), points: Number(u.points || 0) }))
    .filter(x => x.referrals > 0)
    .sort((a, b) => b.referrals - a.referrals)
    .slice(0, limit);
  if (!entries.length) return "🏆 *Top Referrers This Week*\n\n(No referrals yet)";
  const lines = entries.map((x, i) => `${i + 1}. \`${mdEscape(x.cid)}\` — *${x.referrals}* referrals`);
  return `🏆 *Top Referrers This Week*\n\n${lines.join("\n")}\n\nKeep sharing your referral link to earn points!`;
}

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

// ===================== ROTATION BROADCAST (DAILY RESEND) =====================
// Stores admin-scheduled rotations in db.scheduledBroadcasts
// Each rotation re-sends the SAME copied message once per day until expires.
// Commands:
//   - /bcast [days]   (reply to message) -> buttons: send once / rotate start now / rotate start tomorrow
//   - /rotlist        -> list active rotations with STOP buttons
//
// NOTE: Rotations are admin-only.

function msDay() { return 24 * 60 * 60 * 1000; }

function makeRotId() {
  return `ROT-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function addRotation({ fromChatId, messageId, days }) {
  db = repairDB(db);
  const now = Date.now();
  const safeDays = Math.max(1, Math.min(365, Number(days || 7)));
  const rot = {
    id: makeRotId(),
    fromChatId: Number(fromChatId),
    messageId: Number(messageId),
    days: safeDays,
    createdAt: now,
    nextRunAt: now,
    expiresAt: now + safeDays * msDay(),
    active: true,
    runs: 0,
  };
  db.scheduledBroadcasts.push(rot);
  saveDB();
  return rot;
}

function stopRotation(id) {
  db = repairDB(db);
  const rid = String(id || "").trim();
  if (!rid) return false;
  const r = (db.scheduledBroadcasts || []).find(x => x && x.id === rid);
  if (!r) return false;
  r.active = false;
  r.stoppedAt = Date.now();
  saveDB();
  return true;
}

function listActiveRotations() {
  db = repairDB(db);
  return (db.scheduledBroadcasts || [])
    .filter(r => r && r.active)
    .sort((a, b) => Number(a.nextRunAt || 0) - Number(b.nextRunAt || 0));
}

async function runDueRotations() {
  try {
    db = repairDB(db);
    const now = Date.now();

    const list = db.scheduledBroadcasts || [];
    let changed = false;

    for (const r of list) {
      if (!r || !r.active) continue;

      const expiresAt = Number(r.expiresAt || 0);
      if (expiresAt && now >= expiresAt) {
        r.active = false;
        r.stoppedAt = now;
        changed = true;
        continue;
      }

      const nextRunAt = Number(r.nextRunAt || 0);
      if (!nextRunAt || now < nextRunAt) continue;

      // Execute broadcast (copy message) to all users
      try {
        const result = await broadcastCopyMessage(r.fromChatId, r.messageId);
        incBroadcastStats();
        r.runs = Number(r.runs || 0) + 1;
        r.lastRunAt = now;
        r.lastResult = { sent: result.sent, failed: result.failed, total: result.total };
        // schedule next run
        r.nextRunAt = now + msDay();
        changed = true;

        // Notify admin (non-blocking)
        try {
          await notifyAdmin(
            `🔁 *Rotation Broadcast Sent*
` +
            `ID: \`${mdEscape(r.id)}\`
` +
            `Runs: *${mdEscape(String(r.runs))}*
` +
            `Sent: *${mdEscape(String(result.sent))}* / ${mdEscape(String(result.total))}
` +
            `Failed: *${mdEscape(String(result.failed))}*
` +
            `Next: \`${mdEscape(kenyaDateTimeFromTs(r.nextRunAt))}\``
          );
        } catch (_) {}
      } catch (e) {
        // On error: postpone 10 minutes to avoid tight loops
        r.lastError = String(e?.message || e);
        r.lastRunAt = now;
        r.nextRunAt = now + 10 * 60 * 1000;
        changed = true;
      }
    }

    // Keep db from growing forever (keep last 200 rotations)
    if (list.length > 200) {
      // Keep most recent entries (based on createdAt)
      db.scheduledBroadcasts = list
        .slice()
        .sort((a, b) => Number(b?.createdAt || 0) - Number(a?.createdAt || 0))
        .slice(0, 200);
      changed = true;
    }

    if (changed) saveDB();
  } catch (e) {
    console.log("runDueRotations error:", e?.message || e);
  }
}


// ===================== AUTO DAILY ADMIN REPORT (ADMIN) =====================
// Sends a daily summary at 8:00 PM Kenya time.
async function sendDailyAdminReportIfDue() {
  try {
    if (!ADMIN_ID) return;
    db = repairDB(db);

    const day = todayKey();
    if (db.stats.lastDailyReportDay === day) return;

    // Kenya time HH:MM
    let hhmm = "";
    try {
      hhmm = new Intl.DateTimeFormat("en-KE", {
        timeZone: "Africa/Nairobi",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date());
    } catch (_) {
      const d = new Date();
      hhmm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }

    // Trigger around 20:00 - 20:02
    if (!(hhmm >= "20:00" && hhmm <= "20:02")) return;

    const data = sumDaysRevenue(0);
    const aov = data.orders ? round2(data.revenueKsh / data.orders) : 0;

    const msg =
      `📊 *Daily Report* (Kenya)
` +
      `Date: \`${mdEscape(day)}\`

` +
      `Revenue: *Ksh ${mdEscape(String(data.revenueKsh))}*
` +
      `Orders: *${mdEscape(String(data.orders))}*
` +
      `AOV: *Ksh ${mdEscape(String(aov))}*

` +
      `Business active subscribers: *${mdEscape(String(countBusinessSubscribers({ activeOnly: true })))}*
` +
      `${formatBuckets("📦 *By Category*", data.byCategory, 8)}

` +
      `${formatBuckets("🏷️ *Top Packages*", data.byPackage, 8)}`;

    await notifyAdmin(msg);

    db.stats.lastDailyReportDay = day;
    saveDB();
  } catch (e) {
    console.log("sendDailyAdminReportIfDue error:", e?.message || e);
  }
}

// Check every 60s
setInterval(() => {
  sendDailyAdminReportIfDue().catch(() => {});
}, 60 * 1000);

// Run rotation scheduler every 60 seconds
setInterval(() => {
  runDueRotations().catch(() => {});
}, 60 * 1000);

// ✅ Check business subscription reminders/expiry every hour
setInterval(() => {
  runBusinessSubscriptionNotifier().catch(() => {});
}, 60 * 60 * 1000);

// Run once shortly after startup
setTimeout(() => {
  runBusinessSubscriptionNotifier().catch(() => {});
}, 15 * 1000);

// ===================== KEYBOARDS =====================
function mainMenuKeyboard(chatId = null) {
  // If enabled: show ONLY Help button on reply keyboard.
  // (Users can still access settings via Help → Commands & Settings)
  try {
    if (chatId && isAutoHideButtonsEnabled(chatId)) {
      return { reply_markup: { keyboard: [[tr(chatId,"ℹ️ Help","ℹ️ Msaada")]], resize_keyboard: true } };
    }
  } catch (_) {}

  const keyboard = [];

  // WEEKLY DRAW (global visibility)
  if (db.campaign && db.campaign.enabled === true) {
    keyboard.push([tr(chatId,"🎉 WEEKLY DRAW","🎉 DROO YA WIKI")]);
  }

  keyboard.push([tr(chatId,"🛒 Buy Offers","🛒 Nunua Ofa")]);

  if (chatId) {

// Quick buttons (hide if no purchase in 2 days)
const quick = getQuickCategories(chatId);

// Auto turn OFF the hide-toggle if quick actions are inactive/expired
try {
  const u = getUser(chatId);
  if ((!quick || quick.length === 0) && u.hideQuickActionsEnabled) {
    u.hideQuickActionsEnabled = false;
    saveDB();
  }
} catch (_) {}

// Show quick buttons unless user hid them
if (quick && quick.length > 0) {
  const u = getUser(chatId);
  if (!u.hideQuickActionsEnabled) {
    for (const q of quick) keyboard.push([q.text]);
    // Show Hide button only when quick buttons are currently visible
    keyboard.push([tr(chatId,"🙈 Hide Quick Actions","🙈 Ficha Vitendo vya Haraka")]);
  }
}
  }

  keyboard.push(
    [tr(chatId,"👤 My Profile","👤 Wasifu Wangu"), tr(chatId,"💸 Withdraw Points","💸 Toa Pointi")],
    [tr(chatId,"🔗 My Referral","🔗 Rufaa Zangu"), tr(chatId,"ℹ️ Help","ℹ️ Msaada")]
  );

// Admin shortcut
if (chatId && (typeof isAdmin === "function" && isAdmin(chatId))) {
  keyboard.push([tr(chatId,"🎛 WEEKLY DRAW ADMIN","🎛 ADMIN WA DROO")]);
}

  return { reply_markup: { keyboard, resize_keyboard: true } };
}

function categoriesKeyboard(chatId = null) {
  return {
    reply_markup: {
      keyboard: [
        [tr(chatId,"📦 Bingwa Deals","📦 Bingwa Deals"), tr(chatId,"∞ Unlimited Deals","∞ Ofa Zisizo na Kikomo")],
        [tr(chatId,"✉️ SMS Offers","✉️ Ofa za SMS"), tr(chatId,"📞 Minutes","📞 Dakika")],
        [tr(chatId,"⭐ Bonga Points","⭐ Pointi za Bonga"), tr(chatId,"🌀 Flex Deals","🌀 Ofa za Flex")],
        [PREV_BTN],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}


function openCategoryQuick(chatId, category) {
  const s = sessions.get(chatId) || {};
  pushPrev(chatId, s);
  s.step = "category";
  s.category = String(category || "");
  s.pkgKey = null;
  sessions.set(chatId, s);
  return sendTracked(chatId, `✅ *${mdEscape(s.category)}*\n\nSelect a package:`, { parse_mode: "Markdown", ...packagesKeyboard(s.category) });
}


function tierRank(price) {
  const p = Number(price || 0);
  if (p >= 1 && p <= 100) return 0;       // top
  if (p >= 101 && p <= 499) return 1;     // middle
  if (p >= 500 && p <= 10000) return 2;   // bottom
  return 3; // unknown/outside
}

function sortPackagesByTier(list) {
  const arr = Array.isArray(list) ? [...list] : [];
  arr.sort((a, b) => {
    const ra = tierRank(a?.price);
    const rb = tierRank(b?.price);
    if (ra !== rb) return ra - rb;
    // within same tier sort by price ascending then label
    const pa = Number(a?.price || 0);
    const pb = Number(b?.price || 0);
    if (pa !== pb) return pa - pb;
    return String(a?.label || "").localeCompare(String(b?.label || ""));
  });
  return arr;
}

function packagesKeyboard(category) {
  const list = sortPackagesByTier(PACKAGES[category] || []);
  const rows = [];
  for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2).map((x) => x.label));
  rows.push([PREV_BTN, "🏠 Main Menu"]);
  return { reply_markup: { keyboard: rows, resize_keyboard: true, one_time_keyboard: false } };
}

function confirmKeyboard(hasSavedPhone) {
  const rows = [];
  if (hasSavedPhone) rows.push(["✅ Proceed", "📞 Change Number"]);
  rows.push([PREV_BTN, "🏠 Main Menu"]);
  return { reply_markup: { keyboard: rows, resize_keyboard: true, one_time_keyboard: false } };
}

/**
 * Confirm keyboard with phone picker when ⚡ Fast Purchase is enabled.
 * Shows:
 *  - recent numbers (masked) selectable
 *  - ➕ Add Number
 *  - ✅ Proceed / 📞 Change Number
 *  - Prev
 */
function confirmKeyboardV2(chatId, s, hasSavedPhone) {
  // Default
  if (!chatId || !s || !isFastPurchaseEnabled(chatId)) return confirmKeyboard(hasSavedPhone);

  const rows = [];
  s.fpPhoneMap = s.fpPhoneMap || {};
  const phones = getRecentPhonesFromTxLog(chatId, 10);

  for (const p of phones) {
    const label = `📱 ${maskPhone(p)}`;
    if (s.fpPhoneMap[label]) continue;
    s.fpPhoneMap[label] = p;
    rows.push([label]);
  }

  rows.push(["➕ Add Number"]);
  // Fast Purchase: hide Proceed/Change Number; selecting a number triggers STK automatically
  rows.push([PREV_BTN, "🏠 Main Menu"]);

  return { reply_markup: { keyboard: rows, resize_keyboard: true, one_time_keyboard: false } };
}

// ✅ Reusable: proceed with purchase (STK) using the saved phone & current session data
async function proceedPurchase(chatId, s) {
  const savedPhone = getUserPhone(chatId);
  if (!savedPhone) {
    pushPrev(chatId, s);
    s.step = "phone";
    sessions.set(chatId, s);
    return sendTracked(
      chatId,
      "📱 Send your phone number:\n• 07XXXXXXXX\n• 01XXXXXXXX\n• 2547XXXXXXXX\n• 2541XXXXXXXX",




      confirmKeyboard(false)
    );
  }

  const pkg = findPackageByLabel(s.category, s.pkgKey);
  if (!pkg) {
    sessions.delete(chatId);
    return sendTracked(chatId, "⚠️ Offer not found. Please try again.", { ...mainMenuKeyboard(chatId) });
  }

  if (!s.receivingPhone254) {
    pushPrev(chatId, s);
    s.step = "receiving_phone";
    sessions.set(chatId, s);
    return sendTracked(
      chatId,
      `📥 Send receiving number:
• 07XXXXXXXX
• 01XXXXXXXX
• 2547XXXXXXXX
• 2541XXXXXXXX

STK will still be sent to: *${mdEscape(maskPhone(savedPhone))}*`,
      { parse_mode: "Markdown", ...confirmKeyboard(true) }
    );
  }

  // Use the bot's original STK flow (pending store, channel, retries, etc.)
  return initiatePurchaseStk(chatId, s, pkg, savedPhone, s.receivingPhone254);
}




function redeemKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["1️⃣ 20 free SMS (5 pts)"],
        ["2️⃣ 250MB free (20 pts)"],
        ["3️⃣ 20mins midnight free (25 pts)"],
        ["⬅ Back", PREV_BTN, "🏠 Main Menu"],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}



function withdrawKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["25 pts", "50 pts"],
        ["100 pts", "250 pts"],
        ["500 pts", "1000 pts"],
        ["2000 pts"],
        ["⬅ Back", PREV_BTN, "🏠 Main Menu"],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

function yesNoKeyboard() {
  return {
    reply_markup: {
      keyboard: [["✅ Confirm", "❌ Cancel"]],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}


function sellKeyboard(chatId) {
  const u = getUser(chatId);
  const active = isBusinessActive(chatId);
  const activeKey = String(u.businessPlanKey || "");

  const row = (key) => {
    const p = BUSINESS_PLANS[key];
    if (!p) return null;
    const label = `${p.label} — Ksh ${p.price}`;
    const marked = active && activeKey === key ? `✅ ${label}` : `💼 ${label}`;
    return [marked];
  };

  const kb = [];
  const r1 = row("BUS_W1"); if (r1) kb.push(r1);
  const r2 = row("BUS_1M"); if (r2) kb.push(r2);
  const r3 = row("BUS_3M"); if (r3) kb.push(r3);

  kb.push(["⬅️ Back to Help", "🏠 Main Menu"]);
return {
    reply_markup: {
      keyboard: kb,
      resize_keyboard: true,
    },
  };
}


// ===== Business UI state helpers (for Back to previous page) =====
function bizSetView(chatId, view) {
  const u = getUser(chatId);
  u.bizUI = u.bizUI || {};
  u.bizUI.view = view;
  // stack for back navigation
  if (!Array.isArray(u.bizUI.stack)) u.bizUI.stack = [];
  if (!u.bizUI.stack.length || u.bizUI.stack[u.bizUI.stack.length - 1] !== view) {
    u.bizUI.stack.push(view);
    if (u.bizUI.stack.length > 10) u.bizUI.stack.shift();
  }
  saveDB();
}

function bizPrevView(chatId) {
  const u = getUser(chatId);
  u.bizUI = u.bizUI || {};
  if (!Array.isArray(u.bizUI.stack) || u.bizUI.stack.length < 2) return null;
  // pop current
  u.bizUI.stack.pop();
  const prev = u.bizUI.stack[u.bizUI.stack.length - 1] || null;
  u.bizUI.view = prev;
  saveDB();
  return prev;
}

function bizCurrentView(chatId) {
  const u = getUser(chatId);
  return (u.bizUI && u.bizUI.view) ? u.bizUI.view : null;
}
// ===== End Business UI state helpers =====

function businessPlansInlineKeyboard(chatId) {
  const u = getUser(chatId);
  const rows = [];

  for (const planKey of ["BUS_W1", "BUS_1M", "BUS_3M"]) {
    const plan = BUSINESS_PLANS[planKey];
    if (!plan) continue;

    const isActive = isBusinessActive(chatId) && String(u.businessPlanKey || "") === planKey;

    const label =
      (isActive ? "✅ " : "💼 ") +
      `${plan.label} — Ksh ${plan.price}`;

    rows.push([{ text: label, callback_data: `biz_plan:${planKey}` }]);
  }

  // Back to previous Business page + Main Menu
  rows.push([{ text: "⬅️ Back", callback_data: "biz_back" }, { text: "🏠 Main Menu", callback_data: "help:home" }]);

  return { reply_markup: { inline_keyboard: rows } };
}



// ===================== REDEEM ELIGIBILITY =====================
// ✅ Redeem unlock rules (FULL SYSTEM):
// - Requires at least 10 total purchases (lifetime)
// - Additionally: requires 15 purchases within the current 14-day redeem window
// - The 14-day window resets automatically (even if there are no purchases)
// - Admin bypasses all redeem restrictions

const REDEEM_MIN_TOTAL_PURCHASES = 10;
const REDEEM_UNLOCK_PURCHASES_REQUIRED = 15;
const REDEEM_UNLOCK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function ensureRedeemUnlockWindow(u) {
  if (!u) return;
  const now = Date.now();
  const start = Number(u.redeemUnlockStart || 0);

  if (!start) {
    u.redeemUnlockStart = now;
    u.redeemUnlockPurchases = Number(u.redeemUnlockPurchases || 0);
    return;
  }

  if (now - start >= REDEEM_UNLOCK_WINDOW_MS) {
    u.redeemUnlockStart = now;
    u.redeemUnlockPurchases = 0;
  }
}

function bumpRedeemUnlockPurchase(chatId) {
  const u = getUser(chatId);
  ensureRedeemUnlockWindow(u);
  u.redeemUnlockPurchases = Number(u.redeemUnlockPurchases || 0) + 1;
  saveDB();
}

function redeemUnlockStatus(u) {
  ensureRedeemUnlockWindow(u);
  const count = Number(u.redeemUnlockPurchases || 0);
  const start = Number(u.redeemUnlockStart || 0);
  const now = Date.now();
  const end = start ? start + REDEEM_UNLOCK_WINDOW_MS : now + REDEEM_UNLOCK_WINDOW_MS;
  const msLeft = Math.max(0, end - now);
  const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
  return { count, daysLeft };
}

function getTotalPurchases(u) {
  const m = (u && u.purchasesByDay) || {};
  return Object.values(m).reduce((a, b) => a + Number(b || 0), 0);
}

function canRedeemNow(chatId) {
// Business account bypasses redeem lock requirements (except Bingwa daily rule)
if (isBusinessActive(chatId)) {
  return {
    ok: true,
    totalPurchases: REDEEM_MIN_TOTAL_PURCHASES,
    unlockPurchases: REDEEM_UNLOCK_PURCHASES_REQUIRED,
    daysLeft: 0,
  };
}

  if (isAdmin(chatId)) {
    return { ok: true, totalPurchases: 999999, unlockPurchases: 999999, daysLeft: 14 };
  }

  const u = getUser(chatId);
  const totalPurchases = getTotalPurchases(u);
  const st = redeemUnlockStatus(u);

  const ok = totalPurchases >= REDEEM_MIN_TOTAL_PURCHASES && st.count >= REDEEM_UNLOCK_PURCHASES_REQUIRED;
  return { ok, totalPurchases, unlockPurchases: st.count, daysLeft: st.daysLeft };
}
// ===================== TEXTS =====================
function section(title) {
  return `━━━━━━━━━━━━━━\n✨ ${title}\n━━━━━━━━━━━━━━\n`;
}

function welcomeText(name) {
  return (
    `👋 Hello ${name || "there"}, welcome to *Bingwa Mtaani Data Services*.

` +
    `⚡ This bot helps you buy *Data bundles*, *Unlimited offers*, *SMS packages*, *Minutes*, *Bonga Points* and *Flex deals* easily via STK — even if you have Okoa Jahazi debt.

` +
    `✅ Choose what you need:
` +
    `• 📦 Bingwa Deals (limited)
` +
    `• ∞ Unlimited Deals
` +
    `• ✉️ SMS Offers
` +
    `• 📞 Minutes
` +
    `• ⭐ Bonga Points
` +
    `• 🌀 Flex Deals

` +
    `🎁 Earn points via referrals and redeem.

` +
    `⚠️ *Bingwa Deals rule:* *Once per day per phone number* (ONLY after success).

` +
    `✅ Tap 🛒 *Buy Offers* to purchase.

` +
    `☎️ Help / delays: *${HELP_PHONE}*`
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
    lines.push(PACKAGES[cat].map((x) => `• ${x.label}`).join("\\n"));
    lines.push("");
  }
  lines.push(`\n✅ Tap 🛒 *Buy Offers* to purchase.`);
  return lines.join("\n");
}

function categoryNameFromButton(text) {
  const t = String(text || "").trim().toLowerCase();

  // Accept both English + Swahili button labels (and partial matches).
  // We intentionally use includes() checks to be resilient to emojis/prefixes.
  if ((t.includes("bingwa") && t.includes("deals")) || (t.includes("bingwa") && t.includes("deal"))) return "Bingwa Deals";

  // Unlimited Deals: "∞ Unlimited Deals" / "∞ Ofa Zisizo na Kikomo"
  if ((t.includes("unlimited") && t.includes("deals")) || (t.includes("zisizo") && t.includes("kikomo")) || t.includes("kikomo")) return "Unlimited Deals";

  // SMS Offers: "✉️ SMS Offers" / "✉️ Ofa za SMS"
  if (t.includes("sms") || (t.includes("ofa") && t.includes("sms"))) return "SMS Offers";

  // Minutes: "📞 Minutes" / "📞 Dakika"
  if (t.includes("minutes") || t.includes("dakika")) return "Minutes";

  // Bonga Points: "⭐ Bonga Points" / "⭐ Pointi za Bonga"
  if (t.includes("bonga") || (t.includes("pointi") && t.includes("bonga"))) return "Bonga Points";

  // Flex Deals: "🌀 Flex Deals" / "🌀 Ofa za Flex"
  if (t.includes("flex") || (t.includes("ofa") && t.includes("flex"))) return "Flex Deals";

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
    u.inviterSetAt = Date.now();
    saveDB();

    // Notify inviter + admin (unless inviter disabled referral notifications)
    try {
      if (!isStopReferralNotifs(inviter)) {
        bot.sendMessage(
          Number(inviter),
          `🎉 New referral joined!

Someone joined using your link.
✅ When they make a successful purchase, you earn referral points.`
        ).catch(() => {});
      }
    } catch (_) {}

    try {
      if (!isStopReferralNotifs(inviter)) {
        notifyAdmin(
          `👥 *New Referral Join*
Inviter: \`${mdEscape(inviter)}\`
New user: \`${mdEscape(chatId)}\`
Time: \`${mdEscape(kenyaDateTime())}\``
        );
      }
    } catch (_) {}
  }
}

// ✅ Referral bonus credit ONLY on SUCCESS callback; bonus = 2% of amount paid
function maybeRewardInviterOnSuccessPurchase(buyerChatId, amountKsh, when) {
  const buyer = getUser(buyerChatId);
  const inviterId = buyer.inviterId;
  if (!inviterId) return;


  // ✅ SECRET: inviter earns only for first REFERRAL.EXPIRY_DAYS after referral was set
  const setAt = Number(buyer.inviterSetAt || 0);
  const maxAgeMs = Number(REFERRAL.EXPIRY_DAYS || 30) * 24 * 60 * 60 * 1000;
  if (!setAt || Date.now() - setAt > maxAgeMs) return;
  const amt = Number(amountKsh || 0);
  if (!Number.isFinite(amt) || amt <= 0) return;

  const bonus = amt * REFERRAL.BONUS_PERCENT;
  if (!Number.isFinite(bonus) || bonus <= 0) return;

  addPoints(inviterId, bonus);
// ✅ Count unique successful referrals for redeem eligibility (only first success per referred user)
if (!buyer.referralCounted) {
  const inv = getUser(inviterId);
  inv.referralSuccessCount = Number(inv.referralSuccessCount || 0) + 1;
  buyer.referralCounted = true;
  saveDB();
}

const cleanBonus = parseFloat(bonus.toFixed(2));



const inv = getUser(inviterId);
inv.referralEarningsTotal = Number(inv.referralEarningsTotal || 0) + cleanBonus;
inv.referralEarningsByDay = inv.referralEarningsByDay && typeof inv.referralEarningsByDay === "object" ? inv.referralEarningsByDay : {};
const dayKey = kenyaDayKey();
inv.referralEarningsByDay[dayKey] = Number(inv.referralEarningsByDay[dayKey] || 0) + cleanBonus;
saveDB();

if (!isStopReferralNotifs(inviterId)) notifyAdmin(
  `🎯 *Referral Reward*\n` +
  `Inviter: \`${mdEscape(inviterId)}\`\n` +
  `Buyer: \`${mdEscape(buyerChatId)}\`\n` +
  `Purchase: *Ksh ${mdEscape(amt)}*\n` +
  `Bonus: *${mdEscape(cleanBonus)}pts*\n` +
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
    

  const sent = await bot.sendMessage(
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
  if (t.startsWith("3")) return REDEEM_ITEMS[2];
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
      // ✅ Some PayHero callbacks use `Status: true/false`
      payload?.Status ||
      body?.payment_status ||
      body?.status ||
      body?.Status ||
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
    try { if (pending && pending.phone254) phoneStkLock.delete(String(pending.phone254)); } catch (_) {}

  const details =
    pending && pending.pkgLabel
      ? `Offer: ${pending.pkgLabel}\nFrom: ${maskPhone(pending.phone254)}\nAmount: Ksh ${pending.price}`
      : "";

  // Auto Retry STK (Business): keep pending and auto-retry instead of ending the flow immediately
  
// ✅ If user cancelled the M-PESA prompt, DO NOT auto-retry. Stop retries and clear pending.
const isUserCancelled =
  statusTextStr.includes("cancel") ||
  statusTextStr.includes("cancelled") ||
  statusTextStr.includes("canceled") ||
  statusTextStr.includes("request cancelled") ||
  statusTextStr.includes("user cancelled");
if (isUserCancelled) {
  try { clearAutoRetryStk(chatId, externalRef); } catch (_) {}
  try { if (pending && pending.phone254) phoneStkLock.delete(String(pending.phone254)); } catch (_) {}
  if (pending) deletePendingPayment(externalRef);
  await sendTracked(
    chatId,
    `❌ Payment cancelled at ${when}.\n` +
      (details ? `${details}\n` : "") +
      `No retry will be sent.\n\nHelp: ${HELP_PHONE}`,
    { ...mainMenuKeyboard(chatId) }
  );
  return;
}
const canAutoRetry = pending && (typeof isAdmin === "function" && isAdmin(chatId) ? true : isAutoRetryStkEnabled(chatId));
  if (canAutoRetry) {
    // Keep pending so retries can reuse the same reference
    scheduleAutoRetryStk(chatId, externalRef, "payment_failed");
    const msg =
      `⚠️ Payment was not completed at ${when}.
` +
      (details ? `${details}
` : "") +
      `🔁 Auto Retry STK is enabled. I will resend the STK prompt automatically.

Help: ${HELP_PHONE}`;
    await sendTracked(chatId, msg, { ...mainMenuKeyboard(chatId) });
    return;
  }

  try { if (pending && pending.phone254) phoneStkLock.delete(String(pending.phone254)); } catch (_) {}
  if (pending) deletePendingPayment(externalRef);

  const out = tr(
    chatId,
    `❌ Payment Failed

` +
      `Your transaction was not completed.

` +
      `📦 Offer: Ksh ${Number(pending?.price || 0)} • ${String(pending?.pkgLabel || "").trim()}
` +
      `📱 Number: ${maskPhone(pending?.phone254 || "")}
` +
      `💰 Amount: Ksh ${Number(pending?.price || 0)}

` +
      `Please try again. If the problem continues, contact support.

` +
      `📞 Support: ${HELP_PHONE}`,
    `❌ Malipo Hayakufanikiwa

` +
      `Muamala wako haukukamilika.

` +
      `📦 Ofa: Ksh ${Number(pending?.price || 0)} • ${String(pending?.pkgLabel || "").trim()}
` +
      `📱 Namba: ${maskPhone(pending?.phone254 || "")}
` +
      `💰 Kiasi: Ksh ${Number(pending?.price || 0)}

` +
      `Tafadhali jaribu tena. Ikiwa tatizo linaendelea, wasiliana na msaada.

` +
      `📞 Msaada: ${HELP_PHONE}`
  );

try {
    addUserTx(chatId, { status: "failed", pkgLabel: pending?.pkgLabel || "", amountKsh: pending?.price || 0, phone254: pending?.phone254 || "" });
  } catch (_) {}
  await sendTracked(chatId, out, { ...mainMenuKeyboard(chatId) });
  return;
}

    // Prevent double-processing if PayHero retries (SUCCESS)
    if (alreadyProcessed(externalRef)) return;

    // mark processed FIRST (idempotent)
    markProcessed(externalRef);
    // Stop any scheduled auto-retries
    try { clearAutoRetryStk(chatId, externalRef); } catch (_) {}
    try { db = repairDB(db); if (orderKey) db.processedOrders[orderKey] = Date.now(); } catch (_) {}

    // If we have pending payment, apply rules + stats
    const pending = getPendingPayment(externalRef);
    try { if (pending && pending.phone254) phoneStkLock.delete(String(pending.phone254)); } catch (_) {}


    // ✅ PENDING VERIFICATION (amount/phone)
    // If PayHero callback does not match what we requested, treat as failed to prevent fraud/misroutes.
    const cbAmount = Number(payload?.amount || payload?.Amount || body?.amount || body?.Amount || 0);
    const cbPhone = String(payload?.phone_number || payload?.PhoneNumber || payload?.phone || body?.phone_number || body?.phone || "").replace(/\s+/g, "");
    if (pending) {
      const expectedAmount = Number(pending.price || 0);
      const expectedPhone = String(pending.phone254 || "").replace(/\s+/g, "");
      const amountOk = !cbAmount || !expectedAmount ? true : cbAmount === expectedAmount;
      const phoneOk = !cbPhone || !expectedPhone ? true : cbPhone.endsWith(expectedPhone) || expectedPhone.endsWith(cbPhone);
      if (!amountOk || !phoneOk) {
        // Mark as failed (idempotent)
        const failKey = `FAIL-${externalRef}`;
        if (!alreadyProcessed(failKey)) {
          markProcessed(failKey);
          deletePendingPayment(externalRef);
          try { addUserTx(chatId, { status: "failed", pkgLabel: pending?.pkgLabel || "", amountKsh: pending?.price || cbAmount || 0, phone254: pending?.phone254 || cbPhone || "" }); } catch (_) {}
          await sendTracked(chatId, `❌ Payment verification failed at ${when}.\n\nYour payment details did not match the request. Please contact support.\n\nHelp: ${HELP_PHONE}`, { ...mainMenuKeyboard(chatId) });
          await notifyAdmin(
            `⚠️ *Callback Verification Failed*\n` +
            `ChatID: \`${mdEscape(chatId)}\`\n` +
            `External Ref: \`${mdEscape(externalRef)}\`\n` +
            `Expected Amount: *Ksh ${mdEscape(expectedAmount)}*\n` +
            `Callback Amount: *Ksh ${mdEscape(cbAmount)}*\n` +
            `Expected Phone: *${mdEscape(formatTo07(expectedPhone))}*\n` +
            `Callback Phone: *${mdEscape(String(cbPhone || "N/A"))}*\n` +
            `Time: \`${mdEscape(when)}\``
          );
        }
        return;
      }
    }

    if (pending) {
      // ✅ Lock phone only after SUCCESS payment
      try {
        if (pending.phone254) markPhoneUsage(chatId, pending.phone254);
      } catch (_) {}

      // ✅ Revenue analytics (SUCCESS only)
      recordSuccessfulRevenue(pending);

      // ✅ Store per-transaction provider reference for CSV export
      recordSuccessfulTransaction(pending, externalRef, mpesaOut, when);

      // ✅ Bingwa locks only after SUCCESS
      if (pending.category === "Bingwa Deals" && pending.phone254) {
        markBingwaPurchasedToday(pending.phone254);
      }
      if (pending.pkgLabel) incPurchaseStats(chatId, pending.pkgLabel);
      // NOTE: totalSpentKsh is updated once later (after totalPurchases increment) to avoid double counting.

      // ✅ Bonus: After every 5 successful purchases above Ksh 20 -> +5 pts
      if (pending?.category !== "Business Account" && pending.price > 20) {
        const u = getUser(chatId);
        u.bonusEligibleCount = Number(u.bonusEligibleCount || 0) + 1;
        if (u.bonusEligibleCount % 5 === 0) {
          addPoints(chatId, 5);
        }
        saveDB();
      }
      // ✅ Earn points + referral bonus ONLY on SUCCESS data offers (NOT Business subscription)
      if (pending?.category !== "Business Account") {
        // ✅ Earn points ONLY on success purchase (as requested)
        awardSuccessPurchasePoints(chatId, pending);

        // ✅ Referral bonus ONLY on success, 2% of amount (callback-confirmed time)
        maybeRewardInviterOnSuccessPurchase(chatId, pending.price, when);
      }

// ✅ If this is a Business subscription purchase, activate subscription
if (pending && pending.category === "Business Account") {
  const plan = BUSINESS_PLANS[pending.planKey];
  if (plan) {
    activateBusiness(chatId, pending.planKey, plan);
    await maybeShowBusinessIntroOnce(chatId);
  }
}

      try {
        await sendAdminPaymentSms({
          payingPhone254: pending?.phone254 || "",
          receivingPhone254: pending?.receivingPhone254 || pending?.phone254 || ""
        });
      } catch (_) {}

      deletePendingPayment(externalRef);
    }

    // ✅ Notify user (ONLY ONE MESSAGE on success)
    // Also track purchases and show Reference + Package + Total Purchases
    const user = getUser(chatId);
    try { user.orders = Array.isArray(user.orders) ? user.orders : []; } catch (_) {}
    const totalPurchases = Number(user.totalPurchases || 0) + 1;
    user.totalPurchases = totalPurchases;
    user.totalSpentKsh = Number(user.totalSpentKsh || 0) + Number(pending?.price || 0);
    try {
      user.orders.unshift({ when: Date.now(), ref: externalRef, amount, category: pending?.category || "", phone: pending?.phone254 || "", status: "PAID" });
      user.orders = user.orders.slice(0, 10);
    } catch (_) {}
    saveDB();

    const referenceNumber = externalRef;
    const packageName = pending?.pkgLabel || "Unknown Package";
    try { addUserTx(chatId, { status: "success", pkgLabel: packageName, amountKsh: Number(pending?.price || 0), phone254: String(pending?.phone254 || "") }); } catch (_) {}

    const businessExtra =
      pending?.category === "Business Account"
        ? (() => {
            const u = getUser(chatId);
            const exp = u.subscriptionExpiry ? kenyaDateTimeFromTs(u.subscriptionExpiry) : "N/A";
            return (
              `

💼 *Business Account Active*
` +
              `Expiry: \`${mdEscape(exp)}\`

` +
              `🚀 Benefits (during active subscription):
` +
              `• Unlimited referrals
` +
              `• Unlimited rewards
` +
              `• Unlimited number usage
` +
              `• All limits bypassed

` +
              `⚠️ Bingwa daily rule remains.
` +
              `⚠️ Never refer yourself.`
            );
          })()
        : "";

    const successMsg =
      `✅ *Payment Confirmed*

` +
      `🆔 Reference: *${referenceNumber}*
` +
      `📦 Package: *${packageName}*
` +
      `💰 Amount: Ksh ${pending?.price || 0}
` +
      `🛒 Total Purchases: *${totalPurchases}*

` +
      `Your payment has been received and your request is being processed.` +
      businessExtra;

    // ✅ Save last successful purchase for 🔁 Buy Again (data offers only)
    try {
      if (pending && pending.category !== "Business Account") {
        const uu = getUser(chatId);
        uu.lastPurchase = {
          category: pending.category,
          pkgLabel: pending.pkgLabel,
          price: pending.price,
          at: Date.now(),
          phone254: pending.phone254 || null,
        };
        try {
      user.orders.unshift({ when: Date.now(), ref: externalRef, amount, category: pending?.category || "", phone: pending?.phone254 || "", status: "PAID" });
      user.orders = user.orders.slice(0, 10);
    } catch (_) {}
    saveDB();

        // Update quick stats and clear STK failures
        recordSuccessfulPurchase(chatId, pending.category, pending.pkgLabel, pending.phone254, pending.price, channelIdForCategory(pending.category));
        recordOfferTrend(pending.category, pending.pkgLabel);
        clearStkFailures(chatId, pending.phone254);
      }
    } catch (_) {}
// Inline action buttons (Upgrade + Buy Again + Buy Offers)
    const uu2 = getUser(chatId);
    const canBuyLast = !!(uu2.lastPurchase && uu2.lastPurchase.category && uu2.lastPurchase.pkgLabel);

    const upsell = pickUpsell(pending?.category, pending?.pkgLabel, pending?.price, chatId, pending?.phone254);
    const upsellPkg = upsell ? findPackageByLabel(upsell.category, upsell.pkgLabel) : null;

    const inline_keyboard = [];

    if (upsellPkg) {
      inline_keyboard.push([
        { text: `🚀 Upgrade: ${String(upsellPkg.label).split('•')[1]?.trim() || (upsellPkg.price + ' Ksh')}`, callback_data: `ui:upgrade:${base64UrlEncode(upsell.category)}:${base64UrlEncode(upsellPkg.label)}` }
      ]);
    }

    if (canBuyLast) {
      inline_keyboard.push([{ text: "🔁 Buy Again", callback_data: "ui:buy_last" }]);
    }

    inline_keyboard.push([{ text: "🛒 Buy Offers", callback_data: "buy_offers" }]);
    inline_keyboard.push([{ text: "❌ Cancel", callback_data: "ui:close" }]);
    
    // ✅ Notify user
    if (pending?.category === "Business Account") {
      // Business: no inline buttons, no data upsell recommendations
      await sendTracked(chatId, successMsg, { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) });
    } else {
      await sendTracked(chatId, successMsg, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard }
      });
    }



// ${tr(chatId,"🎉 WEEKLY DRAW","🎉 DROO YA WIKI")}: after every successful purchase (when campaign ON), show tickets + qualification status
try {
  const c = ensureWeeklyDrawObject();
  if (c.enabled === true && String(c.status || "").toUpperCase() === "RUNNING") {
    // Count qualification purchases (>=20 KSH)
    try {
      const uqd = getUser(chatId);
      uqd.qPurch20Count = Number(uqd.qPurch20Count || 0) + ((Number(pending?.price||0) >= 20) ? 1 : 0);
      if (uqd.createdAt === undefined || !uqd.createdAt) uqd.createdAt = uqd.createdAt || Date.now();
      try {
      user.orders.unshift({ when: Date.now(), ref: externalRef, amount, category: pending?.category || "", phone: pending?.phone254 || "", status: "PAID" });
      user.orders = user.orders.slice(0, 10);
    } catch (_) {}
    saveDB();
    } catch (_) {}

// Track offer hits for optional "Specific Offer" qualification
try {
  const c2 = ensureWeeklyDrawObject();
  const k = String(chatId);
  const label = String(pending?.pkgKey || pending?.title || pending?.offer || pending?.package || "").trim();
  if (label) {
    c2.offerCount = c2.offerCount && typeof c2.offerCount === "object" ? c2.offerCount : {};
    c2.offerCount[k] = c2.offerCount[k] && typeof c2.offerCount[k] === "object" ? c2.offerCount[k] : {};
    c2.offerCount[k][label] = Number(c2.offerCount[k][label] || 0) + 1;
    try { try {
      user.orders.unshift({ when: Date.now(), ref: externalRef, amount, category: pending?.category || "", phone: pending?.phone254 || "", status: "PAID" });
      user.orders = user.orders.slice(0, 10);
    } catch (_) {}
    saveDB(); } catch (_) {}
  }
} catch (_) {}

    await maybeAutoEndWeeklyDraw();
    await maybeBroadcastEndSoon3Days();

    const t = addWeeklyDrawTicketsFromPurchase(chatId, Number(pending?.price || 0), String(pending?.category || ""));
    const qualTxt = weeklyDrawQualificationText(chatId);


    // Show earned tickets, totals, countdown, and remaining requirements (dynamic)
    const msg =
      `🎟 WEEKLY DRAW UPDATE

` +
      `Tickets earned: ${t.earned}
` +
      `Total tickets: ${t.total}
` +
      `⏳ Ends in: ${getCampaignCountdown()}

` +
      qualTxt;

    if (isWeeklyDrawOptedIn(chatId) && !isStopCampaignNotifs(chatId)) {
      await bot.sendMessage(chatId, msg, mainMenuKeyboard(chatId)).catch(() => {});
    }

    // Near-qualification nudge (after 2 days in bot, close to qualifying)
    await maybeSendNearQualifyReminder(chatId);
    // Rank-change motivation (only near end of campaign)
    await weeklyDrawRankChangeNotify();
  }
} catch (_) {}

// ✅ Notify admin (success notification with Reference + Package + Total Purchases)
    await notifyAdmin(
      `✅ *Payment Confirmed*\n` +
        `ChatID: \`${mdEscape(chatId)}\`\n` +
        `Reference: \`${mdEscape(externalRef)}\`\n` +
        `Provider Reference: \`${mdEscape(mpesaOut)}\`\n` +
        `Package: \`${mdEscape(packageName)}\`\n` +
        `Amount: *Ksh ${mdEscape(String(pending?.price || 0))}*\n` +
        `Total Purchases: \`${mdEscape(String(totalPurchases))}\`\n` +
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
  try { if (isMessageFlood(chatId)) return; } catch (_) {}

  const chatId = msg.chat.id;


// Auto-delete user input messages (only when user is in an active input/session flow)
try {
  const s = sessions.get(chatId);
  const isAwaitingInput = !!(s && s.step);
  const adminState = isAdmin(chatId) ? getWeeklyDrawAdminState(chatId) : null;
  const isAdminAwaiting = !!(adminState && adminState.mode);
  const isUserText = msg && msg.text && !String(msg.text).trim().startsWith("/");
  if (isUserText && (isAwaitingInput || isAdminAwaiting)) {
    // delete after a short delay so user can see what they sent
    setTimeout(() => deleteMessageSafe(chatId, msg.message_id), 2500);
  }
} catch (_) {}

  updateUserProfileFromMsg(chatId, msg);
  const text = (msg.text || "").trim();

  // ===================== AUTO HIDE BUTTONS (FAIL-SAFE COMMAND) =====================
  // Usage:
  //   /buttons on
  //   /buttons off
  //   /buttons toggle
  const buttonsCmd = text.match(/^\/buttons(?:@\w+)?(?:\s+(on|off|toggle))?$/i);
  if (buttonsCmd) {
    const u = getUser(chatId);
    const mode = String(buttonsCmd[1] || "toggle").toLowerCase();
    if (mode === "on") u.autoHideButtonsEnabled = true;
    else if (mode === "off") u.autoHideButtonsEnabled = false;
    else u.autoHideButtonsEnabled = !u.autoHideButtonsEnabled;
    saveDB();
    await sendTracked(
      chatId,
      u.autoHideButtonsEnabled
        ? "🔒 Auto hide buttons is *ON*. Only ℹ️ Help will show.\n\nTo disable: Help → Commands & Settings → Auto hide buttons (except Help)\n(or type /buttons off)"
        : "✅ Auto hide buttons is *OFF*. All buttons are visible.",
      { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
    );
    return;
  }

  // If buttons are hidden, block all other actions (including manual typing), except Help.
  // IMPORTANT: Silent ignore (no reply) until unhidden.
  const isHelpEntry = (text === "ℹ️ Help" || /^\/help/i.test(text) || /^help$/i.test(text));
  try {
    if (isAutoHideButtonsEnabled(chatId) && !isHelpEntry) {
      return; // ignore completely
    }
  } catch (_) {}

  




// ===================== USER BACKUP (AUTO-CLEAR): /mybackup =====================
if (text === "/mybackup" || text === "/backup" || text === "/mybackupreset" || text === "/backupreset") {
  try {
    const created = createServerBackupKey(chatId);
    const backupKey = created.key;
    const keepLang = getStoredLang(chatId);

    const ok = wipeUserData(chatId);
    try { saveDB(); } catch (_) {}

    await bot.sendMessage(
      chatId,
      ok
        ? tr(chatId,
            `✅ Backup created successfully.\n\n🔐 Your restore key is:\n\`${backupKey}\`\n\n⚠️ Save this key safely. Your account has now been cleared.\nThis key expires after 7 days.\nTo restore anytime, send:\n/restorebackup ${backupKey}`,
            `✅ Hifadhi imefanikiwa.\n\n🔐 Funguo yako ya kurejesha ni:\n\`${backupKey}\`\n\n⚠️ Hifadhi funguo hii vizuri. Akaunti yako sasa imefutwa.\nFunguo hii itaisha baada ya siku 7.\nKurejesha wakati wowote tuma:\n/restorebackup ${backupKey}`
          )
        : tr(chatId,
            `⚠️ Backup key created but clearing data failed.\n\nYour restore key is:\n\`${backupKey}\`\n\nPlease contact admin before trying again.`,
            `⚠️ Funguo ya hifadhi imetengenezwa lakini kufuta taarifa kumeshindikana.\n\nFunguo yako ya kurejesha ni:\n\`${backupKey}\`\n\nTafadhali wasiliana na admin kabla ya kujaribu tena.`
          ),
      { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
    ).catch(()=>{});
  } catch (e) {
    await bot.sendMessage(chatId, tr(chatId, "❌ Failed to create backup: ", "❌ Imeshindikana kutengeneza hifadhi: ") + (e?.message || e)).catch(()=>{});
  }
  return;
}


// ===================== USER RESTORE: /restorebackup =====================
{
  const restoreMatch = text.match(/^\/(?:restorebackup|restore)(?:\s+([A-Z0-9-]+))?$/i);
  if (restoreMatch) {
    const suppliedKey = String(restoreMatch[1] || "").trim().toUpperCase();

    if (!suppliedKey) {
      const u = getUser(chatId);
      u.pendingAction = { type: "await_restore_backup_key", at: Date.now() };
      saveDB();
      await bot.sendMessage(
        chatId,
        tr(chatId, "🔐 Send your backup restore key now.\n\nExample:\nBINGWA-R6TG-8JSR-ON08-0220-2607", "🔐 Tuma funguo yako ya kurejesha sasa.\n\nMfano:\nBINGWA-R6TG-8JSR-ON08-0220-2607"),
        mainMenuKeyboard(chatId)
      ).catch(()=>{});
      return;
    }

    try {
      await bot.sendMessage(chatId, tr(chatId, "⏳ Restoring your backup...", "⏳ Inarejesha hifadhi yako..."), mainMenuKeyboard(chatId)).catch(()=>{});

      const rec = backupKeyInfo(suppliedKey);
      if (!rec || !rec.payload) throw new Error(tr(chatId, "Invalid backup key.", "Funguo ya hifadhi si sahihi."));
      if (isBackupAlreadyUsed(suppliedKey)) throw new Error(tr(chatId, "This backup key has already been used.", "Funguo hii ya hifadhi tayari imetumika."));
      if (isBackupExpired(rec)) throw new Error(tr(chatId, "This backup key has expired.", "Funguo hii ya hifadhi imeisha muda."));

      try { wipeUserData(chatId); } catch (_) {}
      applyUserBackup(chatId, rec.payload);
      markBackupUsed(suppliedKey, chatId);

      const u = getUser(chatId);
      u.pendingAction = null;
      saveDB();

      await bot.sendMessage(chatId, tr(chatId, "✅ Backup restored successfully.", "✅ Hifadhi imerejeshwa kikamilifu."), mainMenuKeyboard(chatId)).catch(()=>{});
    } catch (e) {
      await bot.sendMessage(chatId, tr(chatId, "❌ Restore failed: ", "❌ Imeshindikana kurejesha: ") + (e?.message || e), mainMenuKeyboard(chatId)).catch(()=>{});
      try {
        const u = getUser(chatId);
        u.pendingAction = null;
        saveDB();
      } catch (_) {}
    }
    return;
  }
}

try {
  const u = getUser(chatId);
  if (u?.pendingAction?.type === "await_restore_backup_key" && text && !String(text).startsWith("/")) {
    const suppliedKey = String(text || "").trim().toUpperCase();

    try {
      await bot.sendMessage(chatId, tr(chatId, "⏳ Restoring your backup...", "⏳ Inarejesha hifadhi yako..."), mainMenuKeyboard(chatId)).catch(()=>{});

      const rec = backupKeyInfo(suppliedKey);
      if (!rec || !rec.payload) throw new Error(tr(chatId, "Invalid backup key.", "Funguo ya hifadhi si sahihi."));
      if (isBackupAlreadyUsed(suppliedKey)) throw new Error(tr(chatId, "This backup key has already been used.", "Funguo hii ya hifadhi tayari imetumika."));
      if (isBackupExpired(rec)) throw new Error(tr(chatId, "This backup key has expired.", "Funguo hii ya hifadhi imeisha muda."));

      try { wipeUserData(chatId); } catch (_) {}
      applyUserBackup(chatId, rec.payload);
      markBackupUsed(suppliedKey, chatId);

      u.pendingAction = null;
      saveDB();

      await bot.sendMessage(chatId, tr(chatId, "✅ Backup restored successfully.", "✅ Hifadhi imerejeshwa kikamilifu."), mainMenuKeyboard(chatId)).catch(()=>{});
      return;
    } catch (e) {
      await bot.sendMessage(chatId, tr(chatId, "❌ Restore failed: ", "❌ Imeshindikana kurejesha: ") + (e?.message || e), mainMenuKeyboard(chatId)).catch(()=>{});
      u.pendingAction = null;
      saveDB();
      return;
    }
  }
} catch (e) {
  await bot.sendMessage(chatId, tr(chatId, "❌ Restore failed: ", "❌ Imeshindikana kurejesha: ") + (e?.message || e)).catch(()=>{});
  try {
    const u = getUser(chatId);
    u.pendingAction = null;
    saveDB();
  } catch (_) {}
  return;
}

// ===================== /deactivatebiz =====================
if (text.startsWith("/deactivatebiz")) {
  if (!isAdmin(chatId)) {
    await bot.sendMessage(chatId, "❌ Admin only command.").catch(() => {});
    return;
  }

  const parts = String(text || "").split(" ").filter(Boolean);
  if (parts.length < 2) {
    await bot.sendMessage(chatId, "Usage:\n/deactivatebiz <userId>").catch(() => {});
    return;
  }

  const targetId = Number(parts[1]);
  if (!Number.isFinite(targetId)) {
    await bot.sendMessage(chatId, "❌ Invalid user ID.").catch(() => {});
    return;
  }

  const ok = await deactivateBusinessAccount(targetId);
  await bot.sendMessage(
    chatId,
    ok ? `✅ Business account deactivated for ${targetId}` : "❌ Failed to deactivate Business."
  ).catch(() => {});
  return;
}
// ===================== GLOBAL BACK BUTTONS =====================
  // ✅ Prev (multi-step /sell -> buy offers flow uses sessionHistory snapshots)
  if (text === PREV_BTN || text === "⬅ Prev" || text === "⬅ Nyuma" || text === "⬅️ Nyuma") {
    try {
      const snap = popPrev(chatId);
      return renderSessionSnapshot(chatId, snap);
    } catch (_) {
      try { sessions.delete(chatId); } catch (_) {}
      return sendTracked(chatId, "🏠 Main Menu", { ...mainMenuKeyboard(chatId) });
    }
  }

  // ✅ Back (used by /sell menu keyboard). If user is NOT in an active session step, go home.
  if (text === "⬅ Back" || text === "⬅️ Back" || text === "⬅ Rudi" || text === "⬅️ Rudi") {
    try {
      const s0 = sessions.get(chatId);
      if (!s0 || !s0.step) {
        try { clearPendingAction(chatId); } catch (_) {}
        return sendTracked(chatId, "🏠 Main Menu", { ...mainMenuKeyboard(chatId) });
      }
      // If there is an active session, let existing flow-specific back handlers run below.
    } catch (_) {
      try { clearPendingAction(chatId); } catch (_) {}
      return sendTracked(chatId, "🏠 Main Menu", { ...mainMenuKeyboard(chatId) });
    }
  }
  // ================================================================

// ✅ Back to Help (reply keyboard)
if (text === "⬅️ Back to Help" || text === "⬅ Back to Help") {
  try { clearPendingAction(chatId); } catch (_) {}
  try { sessions.delete(chatId); } catch (_) {}
  await sendHelpMenu(chatId);
  return;
}

// ✅ Main Menu (reply keyboard)
if (text === "🏠 Main Menu") {
  try { clearPendingAction(chatId); } catch (_) {}
  try { sessions.delete(chatId); } catch (_) {}
  await sendTracked(chatId, "🏠 Main Menu", { ...mainMenuKeyboard(chatId) });
  return;
}




// ✅ Ban gate
try {
  if (!isAdmin(chatId)) {
    const u = getUser(chatId);
    if (u && u.banned) {
      await bot.sendMessage(chatId, "⛔ You are blocked from using this bot. Contact support/admin.").catch(() => {});
      return;
    }
  }
} catch (_) {}



// Force-join gate (allow /start without joining)
try {
  if (!/^\/start\b/i.test(text)) {
    const actorId = chatId;
    if (!(typeof isAdmin === "function" && isAdmin(actorId))) {
      const joined = await ensureJoinedChannel(actorId);
      if (!joined) {
        await sendJoinGate(actorId);
        return;
      }
    }
  }
} catch (_) {}


// ===================== ADMIN: FREE BUSINESS 10 DAYS =====================
  if (text.startsWith("/freebiz")) {
    if (!isAdmin(chatId)) {
      await bot.sendMessage(chatId, "❌ Admin only command.").catch(() => {});
      return;
    }

    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      await bot.sendMessage(chatId, "Usage:\n/freebiz <userId>").catch(() => {});
      return;
    }

    const targetId = Number(parts[1]);
    if (!Number.isFinite(targetId)) {
      await bot.sendMessage(chatId, "❌ Invalid user ID.").catch(() => {});
      return;
    }

    const ok = await giveFreeBusinessDays(targetId, 10);
    if (ok) {
      await bot.sendMessage(chatId, `✅ 10 FREE Business days granted to ${targetId}`).catch(() => {});
    } else {
      await bot.sendMessage(chatId, "❌ Failed to grant Business. Check logs.").catch(() => {});
    }
    return;
  }



// ===================== INLINE TRIGGERS (no buttons) =====================
  // When user picks an inline result, Telegram sends a normal message to the bot chat.
  // We use short trigger texts to jump directly to the right flow.
  if (text === "#help_inline") {
    return sendTracked(
      chatId,
      "🔎 Inline Search Tips:\n\nType in any chat:\n• @YourBot 2GB\n• @YourBot 24HRS\n• @YourBot SMS\n\nPick a result and I will open the purchase flow automatically.",
      { ...mainMenuKeyboard(chatId) }
    );
  }

  if (text.startsWith("#cat ")) {
    const enc = text.slice(5).trim();
    const cat = base64UrlDecode(enc);
    if (cat) return openCategoryQuick(chatId, cat);
  }

  if (text.startsWith("#buy ")) {
    const payload = text.slice(5).trim();
    const parts = payload.split(":");
    const cat = base64UrlDecode(parts[0] || "");
    const lbl = base64UrlDecode(parts[1] || "");
    if (cat && lbl) {
      const pkg = findPackageByLabel(cat, lbl);
      if (!pkg) {
        return sendTracked(chatId, "❌ Offer not available right now. Tap 🛒 Buy Offers.", { ...mainMenuKeyboard(chatId) });
      }

      const s = sessions.get(chatId) || {};
      pushPrev(chatId, s);
      s.step = "confirm";
      s.category = cat;
      s.pkgKey = pkg.label;
      sessions.set(chatId, s);

      const hasSaved = !!getUserPhone(chatId);
      return sendTracked(
        chatId,
        `🛒 *Selected Offer*\\n\\nCategory: *${escapeMd(cat)}*\\nOffer: *${escapeMd(pkg.label)}*\\nPrice: *Ksh ${escapeMd(String(pkg.price))}*\\n\\n✅ Tap Proceed to pay or Change Number.`,
        { parse_mode: "Markdown", ...(isFastPurchaseEnabled(chatId) ? confirmKeyboardV2(chatId, s, hasSaved) : confirmKeyboard(hasSaved)) }
      );
    }
  }
  // ======================================================================
// ===================== ADMIN: LIST ALL COMMANDS =====================
  if (isAdmin(chatId) && (text === "/commands" || text === "/cmds" || text === "/")) {
    const lines = ["🧰 *Bot Commands & Buttons*"];

    const adminLines = [];
    const userLines = [];

    for (const c of COMMANDS_LIST) {
      const row = `• \`${c.cmd}\` — ${mdEscape(c.desc)}`;
      if (c.adminOnly) adminLines.push(row);
      else userLines.push(row);
    }

    lines.push("\n*User commands/buttons:*");
    lines.push(...userLines);

    lines.push("\n*Admin-only:*");
    lines.push(...adminLines);

    return sendTracked(chatId, lines.join("\n"), { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) });
  }
  // ===================================================================


  // ensure user exists + lastSeen
  getUser(chatId);
  touchLastSeen(chatId);

  // ✅ IMPORTANT: /start should NOT delete previous messages (requested)
  const isStartCmd = /^\/start(?:@\w+)?(?:\s|$)/i.test(text);

  // Deep link guard (extra safety)
  if (/^\/start(?:@\w+)?\s+weeklydraw\s*$/i.test(String(text || "").trim())) {
    try { await showWeeklyDrawMenu(chatId, { forceNew: true }); } catch (_) { await showWeeklyDrawMenu(chatId); }
    return;
  }


// Deep link: /start weeklydraw should open Weekly Draw ONLY (no welcome/referral /start messages)
if (isStartCmd) {
  const startArgs = text.replace(/^\/start(?:@\w+)?\b/i, "").trim();
  if (/^weeklydraw$/i.test(startArgs)) {
    try {
      await showWeeklyDrawMenu(chatId, { forceNew: true });
    } catch (_) {
      await showWeeklyDrawMenu(chatId);
    }
    return;
  }
}


  

  // ===================== ADMIN COMMANDS =====================
  if (/^\/admin(?:@\w+)?$/i.test(text)) {
    if (!isAdmin(chatId)) {
      await bot.sendMessage(chatId, "⛔ Not authorized.").catch(() => {});
      return;
    }
    const msg = `👑 *Admin Commands*

• `/admin` — show this menu
• `/stats` — revenue + users + purchases
• `/backup` — download database backup (db.json)

*Moderation*
• `/ban <chat_id>` — block a user
• `/unban <chat_id>` — unblock a user

*Weekly Draw Admin*
• `/weeklydraw_admin` — open weekly draw admin panel

Tip: Use the bot's admin panel buttons for Weekly Draw settings, broadcast, paying winners, and resets.`;
    await bot.sendMessage(chatId, msg, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎛 Weekly Draw Admin", callback_data: "wdadm:menu" }],
          [{ text: "📊 Stats", callback_data: "admin:stats" }, { text: "🗄 Backup", callback_data: "admin:backup" }],
        ],
      },
    }).catch(() => {});
    return;
  }

  if (/^\/stats(?:@\w+)?$/i.test(text)) {
    if (!isAdmin(chatId)) {
      await bot.sendMessage(chatId, "⛔ Not authorized.").catch(() => {});
      return;
    }
    try {
      const usersCount = Object.keys((db && db.users) ? db.users : {}).length;

      // Purchases count
      let purchasesCount = 0;
      try {
        if (db && db.stats && Number.isFinite(Number(db.stats.totalPurchases))) purchasesCount = Number(db.stats.totalPurchases);
      } catch (_) {}
      if (!purchasesCount) {
        try {
          const tx = (db && db.analytics && db.analytics.transactionsByDay) ? db.analytics.transactionsByDay : {};
          purchasesCount = Object.values(tx).reduce((a, b) => a + Number(b || 0), 0);
        } catch (_) {}
      }

      // Revenue total
      let revenue = 0;
      try {
        const rev = (db && db.analytics && db.analytics.revenueByDay) ? db.analytics.revenueByDay : {};
        revenue = Object.values(rev).reduce((a, b) => a + Number(b || 0), 0);
      } catch (_) {}

      const txt = `📊 *Bot Stats*\n\n👥 Users: *${usersCount}*\n🧾 Purchases: *${purchasesCount}*\n💰 Revenue: *Ksh ${revenue.toFixed(2)}*\n`;
      await bot.sendMessage(chatId, txt, { parse_mode: "Markdown" }).catch(() => {});
    } catch (_) {
      await bot.sendMessage(chatId, "⚠️ Could not compute stats.").catch(() => {});
    }
    return;
  }

  if (/^\/backup(?:@\w+)?$/i.test(text)) {
    if (!isAdmin(chatId)) {
      await bot.sendMessage(chatId, "⛔ Not authorized.").catch(() => {});
      return;
    }
    try {
      await bot.sendDocument(chatId, DB_FILE, { caption: "🗄 Database backup (db.json)" }).catch(async () => {
        // fallback: write temp
        const tmp = path.join(__dirname, `db_backup_${Date.now()}.json`);
        try { fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); } catch (_) {}
        await bot.sendDocument(chatId, tmp, { caption: "🗄 Database backup (generated)" }).catch(() => {});
      });
    } catch (_) {
      await bot.sendMessage(chatId, "⚠️ Backup failed.").catch(() => {});
    }
    return;
  }

  // /ban <chat_id>  | /unban <chat_id>
  if (/^\/(ban|unban)(?:@\w+)?\b/i.test(text)) {
    if (!isAdmin(chatId)) {
      await bot.sendMessage(chatId, "⛔ Not authorized.").catch(() => {});
      return;
    }
    const parts = text.split(/\s+/).filter(Boolean);
    const cmd = parts[0].toLowerCase().replace(/^\//, "").split("@")[0];
    const target = parts[1] ? String(parts[1]).trim() : "";
    if (!target || !/^\d+$/.test(target)) {
      await bot.sendMessage(chatId, `Usage:\n/ban <chat_id>\n/unban <chat_id>`).catch(() => {});
      return;
    }
    const u = getUser(target);
    u.banned = (cmd === "ban");
    try { saveDB(); } catch (_) {}

    await bot.sendMessage(chatId, u.banned ? `✅ Banned ${target}` : `✅ Unbanned ${target}`).catch(() => {});
    // notify user (optional)
    try {
      await bot.sendMessage(target, u.banned ? "⛔ You have been blocked by admin." : "✅ You have been unblocked. You can use the bot again.").catch(() => {});
    } catch (_) {}
    return;
  }
  

// ===================== USER COMMAND: /autodelete =====================
// Usage: /autodelete 10min  | /autodelete 1h | /autodelete 24hr | /autodelete off
if (/^\/autodelete(?:@\w+)?\b/i.test(text)) {
  // Business-only (admins always allowed)
  if (!(typeof isAdmin === "function" && isAdmin(chatId)) && !(typeof isBusinessActive === "function" && isBusinessActive(chatId))) {
    await bot.sendMessage(chatId, "⛔ /autodelete is available for *Business* accounts only.\n\nTo upgrade, type /sell", { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }).catch(() => {});
    return;
  }
  const parts = String(text).trim().split(/\s+/);
  const arg = (parts[1] || "").trim().toLowerCase();

  if (!arg) {
    const cur = formatMsShort(getAutoDeleteMsForChat(chatId));
    await bot.sendMessage(
      chatId,
      `🧹 Auto-delete bot messages is set to: *${cur}*\n\n` +
      `Set it with:\n` +
      `• /autodelete 10min\n` +
      `• /autodelete 1h\n` +
      `• /autodelete 24hr\n` +
      `• /autodelete 1s\n\n` +
      `Max is 24hr.`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
    return;
  }

  if (arg === "off" || arg === "0" || arg === "disable") {
    // we still need a value; set to max (24h) to effectively keep long
    const u = getUser(chatId);
    u.autoDeleteMs = 24 * 60 * 60 * 1000;
    try { saveDB(); } catch (_) {}
    await bot.sendMessage(chatId, "✅ Auto-delete set to *24hr* (maximum).", { parse_mode: "Markdown" }).catch(() => {});
    return;
  }

  const ms = parseDurationToMs(arg);
  if (!ms) {
    await bot.sendMessage(chatId, "❌ Invalid duration. Examples: 1s, 10min, 1h, 24hr (max 24hr).").catch(() => {});
    return;
  }

  const u = getUser(chatId);
  u.autoDeleteMs = ms;
  try { saveDB(); } catch (_) {}

  await bot.sendMessage(chatId, `✅ Auto-delete set to *${formatMsShort(ms)}* for bot messages.`, { parse_mode: "Markdown" }).catch(() => {});
  return;
}
// ===================== END /autodelete =====================

// ===================== END ADMIN COMMANDS =====================

// ✅ /start cooldown (5 seconds) to reduce spam
  if (isStartCmd && !isAdmin(chatId)) {
    const last = startCooldownByChat.get(String(chatId)) || 0;
    const now = Date.now();
    if (last && now - last < START_COOLDOWN_MS) {
      const wait = Math.ceil((START_COOLDOWN_MS - (now - last)) / 1000);
      await bot.sendMessage(chatId, `⏳ Please wait ${wait}s and try /start again.`).catch(() => {});
      return;
    }
    startCooldownByChat.set(String(chatId), now);
  }

  // ✅ /status: show pending STK status (helps users + reduces support calls)
  if (/^\/status$/i.test(text)) {
    const p = getLatestPendingForChat(chatId);
    if (!p) {
      await sendTracked(chatId, `✅ No pending STK request found.

📱 *Linked accounts for this number (max 4):*
${linkedAccountsLabelForPhone(u.lastLinkedPhone || "")}`, { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) });
      return;
    }

    const ageMs = Date.now() - Number(p.createdAt || 0);
    const ageSec = Math.max(0, Math.floor(ageMs / 1000));
    const ageLabel = ageSec < 60 ? `${ageSec}s` : `${Math.floor(ageSec / 60)}m ${ageSec % 60}s`;

    const out =
      `📲 *STK Status*\n` +
      `• Offer: *${mdEscape(p.pkgLabel || "N/A")}*\n` +
      `• Amount: *Ksh ${mdEscape(p.price)}*\n` +
      `• Phone: *${mdEscape(maskPhone(p.phone254 || ""))}*\n` +
      `• Ref: \`${mdEscape(p.ref || p.externalRef || p.reference || p.external_reference || "") || mdEscape(p.ref || "")}\`\n` +
      `• Age: *${ageLabel}*\n\n` +
      `📱 *Linked accounts for this number (max 4):*\n${mdEscape(linkedAccountsLabelForPhone(u.lastLinkedPhone || ""))}\n\n` +
      `If you have the M-PESA prompt, complete it.\n` +
      `If no prompt appears, you can retry or cancel.`;

    await sendTracked(chatId, out, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔁 Retry STK", callback_data: `ui:stk_retry_prompt:${p.ref || p.externalRef || p.reference || p.external_reference || ""}` }],
          [{ text: "❌ Cancel Pending", callback_data: `ui:stk_cancel:${p.ref || p.externalRef || p.reference || p.external_reference || ""}` }],
          [{ text: "🛒 Buy Offers", callback_data: "ui:buy_offers" }],
        ],
      },
    });
    return;
  }

// ✅ /sell: Business subscription (PayHero STK)
if (/^\/sell$/i.test(text)) {
  const u = getUser(chatId);

  if (isBusinessActive(chatId)) {
    const exp = kenyaDateTimeFromTs(u.subscriptionExpiry);
    await sendTracked(
      chatId,
      `✅ You are on *Business Account*.\n\n` +
        `Plan: *${mdEscape(String(u.businessPlanLabel || "Business"))}*\n` +
        `Expiry: \`${mdEscape(exp)}\`\n\n` +
        `Tap *Manage Plans* below to switch plan or deactivate by tapping your ✅ active plan.`,
      {
        parse_mode: "Markdown",
        reply_markup: { keyboard: [["⚙️ Manage Plans"], ["⬅️ Back to Help", "🏠 Main Menu"]], resize_keyboard: true },
      }
    );
    return;
  }

  await sendTracked(
    chatId,
    `🏢 *Business Account*\n\n` +
      `Business users get:\n` +
      `• Unlimited referrals\n` +
      `• Unlimited rewards\n` +
      `• Fewer limitations\n` +
      `• +5% Weekly Draw ticket bonus\n` +
      `• Extra settings\n` +
      `• Unlimited withdrawals\n\n` +
      `To activate: tap *Activate* below (or type /sell).`,
    {
      parse_mode: "Markdown",
      reply_markup: { keyboard: [["✅ Activate"], ["⬅️ Back to Help", "🏠 Main Menu"]], resize_keyboard: true },
    }
  );
  return;
}




// ✅ Business Account: Activate / Manage (reply keyboard buttons)
if (text === "✅ Activate" || text === "⚙️ Manage Plans") {
  const u = getUser(chatId);

  const header = isBusinessActive(chatId)
    ? "⚙️ *Manage Business Account*\n\nTap your ✅ active plan to deactivate, or choose another plan to subscribe."
    : "✅ *Activate Business Account*\n\nChoose a plan to subscribe:";

  await sendTracked(chatId, header, { parse_mode: "Markdown", ...sellKeyboard(chatId) });
  return;
}

// ✅ /changenumber: Save/Change user's phone number (no payment flow)
if (/^\/changenumber$/i.test(text)) {
  await sendTracked(
    chatId,
    "📞 *Change Number*\n\nSend your new Safaricom number (07/01/2547/2541 format).\n\nType /cancel to stop.",
    { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
  );
  setPendingAction(chatId, { type: "change_number" });
  return;
}


// ✅ /orders: show last 5 paid orders
if (/^\/orders$/i.test(text)) {
  const u = getUser(chatId);
  const arr = Array.isArray(u.orders) ? u.orders : [];
  if (!arr.length) {
    await sendTracked(chatId, "ℹ️ No recent orders yet.", { ...mainMenuKeyboard(chatId) });
    return;
  }
  const top = arr.slice(0, 5);
  const out = [];
  out.push("🧾 Recent Orders (last 5)");
  for (const o of top) {
    const dt = new Date(Number(o.when || 0)).toISOString().replace("T"," ").slice(0,19);
    out.push(`• ${dt} — Ksh ${Number(o.amount||0)} — ${String(o.category||"")}`);
  }
  await sendTracked(chatId, out.join("\n"), { ...mainMenuKeyboard(chatId) });
  return;
}


// Plan selection buttons for /sell (subscribe / switch / deactivate)
const _bizPlanButtons = [
  "💼 Business 1 Week — Ksh 56",
  "💼 Business 1 Month — Ksh 105",
  "💼 Business 3 Months — Ksh 260",
  "✅ Business 1 Week — Ksh 56",
  "✅ Business 1 Month — Ksh 105",
  "✅ Business 3 Months — Ksh 260",
];

if (_bizPlanButtons.includes(text)) {
  const u = getUser(chatId);

  const normalized = text.replace(/^✅\s*/, "").replace(/^💼\s*/, "").trim();
  let planKey = "";
  if (normalized.includes("1 Week")) planKey = "BUS_W1";
  else if (normalized.includes("1 Month")) planKey = "BUS_1M";
  else if (normalized.includes("3 Months")) planKey = "BUS_3M";

  const plan = BUSINESS_PLANS[planKey];

  if (!plan) {
    await sendTracked(chatId, "❌ Invalid plan. Type /sell again.", { ...mainMenuKeyboard(chatId) });
    return;
  }

  // If user taps the currently active plan (marked ✅) -> deactivate business account
  if (text.startsWith("✅") && isBusinessActive(chatId) && String(u.businessPlanKey || "") === planKey) {
    deactivateBusiness(chatId);
    await sendTracked(
      chatId,
      "✅ Business Account deactivated. You are back to the normal account.",
      { ...mainMenuKeyboard(chatId) }
    );
    return;
  }

  const phone254 = getUserPhone(chatId);
  if (!phone254) {
    setPendingAction(chatId, { type: "sell_business", planKey });
    await sendTracked(
      chatId,
      "📱 Send your phone number to pay via STK:\n• 07XXXXXXXX\n• 01XXXXXXXX\n• 2547XXXXXXXX\n• 2541XXXXXXXX",
      { ...mainMenuKeyboard(chatId) }
    );
    return;
  }

  const externalRef = makeExternalRef(chatId, "Business_Account", plan.price);

  addPendingPayment(externalRef, {
    chatId,
    category: "Business Account",
    pkgLabel: `${plan.label} (Ksh ${plan.price})`,
    phone254,
    price: plan.price,
    planKey,
  });

  await sendTracked(
    chatId,
    `✅ *Subscription Selected*\n\nPlan: *${mdEscape(plan.label)}*\nAmount: *Ksh ${plan.price}*\nPhone: *${mdEscape(maskPhone(phone254))}*\n\n📲 Sending STK…`,
    { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
  );

  try {
await payheroStkPush({
  amount: plan.price,
  phone: phone254,
  externalRef,
  channelId: PAYHERO_CHANNEL_ID_BUSINESS,
});

await sendTracked(
  chatId,
  `✅ STK sent. Please enter your M-Pesa PIN on your phone.\n\n⏳ After payment, you will receive confirmation here.`,
  { ...mainMenuKeyboard(chatId) }
);
  } catch (e) {
deletePendingPayment(externalRef);
await sendTracked(
  chatId,
  "❌ Failed to send STK. Please try again.",
  { ...mainMenuKeyboard(chatId) }
);
  }

  return;
}


// ✅ /report (admin): show summary including Business subscribers
if (/^\/report$/i.test(text)) {
  if (!isAdmin(chatId)) {
    await sendTracked(chatId, "❌ Not authorized.", { ...mainMenuKeyboard(chatId) });
    return;
  }

  const activeBiz = countBusinessSubscribers({ activeOnly: true });
  const totalBiz = countBusinessSubscribers({ activeOnly: false });
  const totalUsers = Object.keys((db && db.users) ? db.users : {}).length;

  const today = sumDaysRevenue(0);
  const yday = sumDaysRevenue(1);

  const msg =
    `📊 *Admin Report* (Kenya)\n` +
    `Date: \`${mdEscape(todayKey())}\`\n\n` +
    `👥 Users: *${mdEscape(String(totalUsers))}*\n` +
    `💼 Business active: *${mdEscape(String(activeBiz))}*\n` +
    `💼 Business total (ever): *${mdEscape(String(totalBiz))}*\n\n` +
    `💰 Today Revenue: *Ksh ${mdEscape(String(today.revenueKsh))}* (Orders: *${mdEscape(String(today.orders))}*)\n` +
    `💰 Yesterday Revenue: *Ksh ${mdEscape(String(yday.revenueKsh))}* (Orders: *${mdEscape(String(yday.orders))}*)\n\n` +
    `${formatBuckets("📦 *Today By Category*", today.byCategory, 8)}\n\n` +
    `${formatBuckets("🏷️ *Today Top Packages*", today.byPackage, 8)}`;

  await sendTracked(chatId, msg, { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) });
  return;
}

// ✅ /addplan (admin): add a package to any category
// Usage examples:
//   /addplan Bingwa Deals | Ksh 12 • 100MB 1HR | 12
//   /addplan SMS Offers | Ksh 5 • 20 SMS 24HRS | 5
// Notes:
//   - Category MUST match an existing category name exactly (case-insensitive match supported).
//   - Uses "|" separator for safety.
// ✅ /addplan (admin): add one or many packages to any category
// Usage (single line):
//   /addplan SMS Offers | Ksh 5 • 20 SMS 24HRS | 5
// Usage (multi-line in ONE message):
//   /addplan SMS Offers | Ksh 5 • 20 SMS 24HRS | 5
//   /addplan Bingwa Deals | Ksh 12 • 100MB 1HR | 12
if (/(^|\n)\/addplan(?:@\w+)?\b/i.test(text)) {
  if (!isAdmin(chatId)) {
    await sendTracked(chatId, "❌ Not authorized.", { ...mainMenuKeyboard(chatId) });
    return;
  }

  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const addLines = lines.filter((l) => /^\/addplan(?:@\w+)?\b/i.test(l));

  if (addLines.length === 0) {
    await sendTracked(chatId, "⚠️ No /addplan lines found.", { ...mainMenuKeyboard(chatId) });
    return;
  }

  const catsList = Object.keys(PACKAGES || {});
  const catsText = catsList.join(", ");

  let ok = 0;
  const errors = [];

  for (const line of addLines) {
    try {
      const raw = line.replace(/^\/addplan(?:@\w+)?/i, "").trim();
      const parts = raw.split("|").map((x) => String(x || "").trim()).filter(Boolean);

      if (parts.length < 3) {
        errors.push(`• Invalid format: ${mdEscape(line)}`);
        continue;
      }

      const catInput = parts[0];
      const label = parts.slice(1, parts.length - 1).join(" | ").trim();
      const priceStr = parts[parts.length - 1].replace(/[^\d.]/g, "");
      const price = Number(priceStr);

      const catKey = Object.keys(PACKAGES || {}).find((c) => String(c).toLowerCase() === String(catInput).toLowerCase());
      if (!catKey) {
        errors.push(`• Unknown category: ${mdEscape(catInput)}`);
        continue;
      }
      if (!label) {
        errors.push(`• Missing label: ${mdEscape(catKey)}`);
        continue;
      }
      if (!Number.isFinite(price) || price <= 0) {
        errors.push(`• Invalid price for ${mdEscape(catKey)}: ${mdEscape(String(parts[parts.length - 1]))}`);
        continue;
      }

      // Add to runtime PACKAGES (avoid duplicates by label)
      if (!PACKAGES[catKey]) PACKAGES[catKey] = [];
      if (!PACKAGES[catKey].some((x) => x && String(x.label) === label)) {
        PACKAGES[catKey].push({ label, price });
        PACKAGES[catKey] = sortPackagesByTier(PACKAGES[catKey]);
      }

      // Persist to DB
      db = repairDB(db);
      if (!db.customPackages[catKey]) db.customPackages[catKey] = [];
      // Avoid duplicates in custom list too
      if (!db.customPackages[catKey].some((x) => x && String(x.label) === label)) {
        db.customPackages[catKey].push({ label, price });
        db.customPackages[catKey] = sortPackagesByTier(db.customPackages[catKey]);
      }
      ok++;
    } catch (e) {
      errors.push(`• Failed: ${mdEscape(line)} (${mdEscape(String(e.message || e))})`);
    }
  }

  saveDB();

  let msg =
    `✅ Added *${ok}* plan(s).\n\n` +
    `Available categories:\n${mdEscape(catsText)}`;

  if (errors.length > 0) {
    msg += `\n\n⚠️ Errors:\n${errors.slice(0, 15).join("\n")}`;
    if (errors.length > 15) msg += `\n...and ${errors.length - 15} more`;
  }

  await sendTracked(chatId, msg, { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) });
  return;
}



// ✅ /removeoffer (admin): remove a previously added custom offer
// Usage:
//   /removeoffer SMS Offers | Ksh 5 • 20 SMS 24HRS
//   /removeoffer Bingwa Deals | Ksh 12 • 100MB 1HR
if (/^\/removeoffer(?:@\w+)?\b/i.test(text)) {
  if (!isAdmin(chatId)) {
    await sendTracked(chatId, "❌ Not authorized.", { ...mainMenuKeyboard(chatId) });
    return;
  }

  const raw = text.replace(/^\/removeoffer(?:@\w+)?/i, "").trim();
  const parts = raw.split("|").map((x) => String(x || "").trim()).filter(Boolean);

  if (parts.length < 2) {
    await sendTracked(
      chatId,
      "🗑️ *Remove Offer*\n\nUse:\n`/removeoffer Category | Package Label`\n\nExample:\n`/removeoffer SMS Offers | Ksh 5 • 20 SMS 24HRS`",
      { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
    );
    return;
  }

  const catInput = parts[0];
  const labelInput = parts.slice(1).join(" | ").trim();

  const catKey = Object.keys(PACKAGES || {}).find((c) => String(c).toLowerCase() === String(catInput).toLowerCase());
  if (!catKey) {
    await sendTracked(chatId, `❌ Unknown category: *${mdEscape(catInput)}*`, { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) });
    return;
  }

  db = repairDB(db);
  const list = Array.isArray(db.customPackages?.[catKey]) ? db.customPackages[catKey] : [];
  const before = list.length;

  const remaining = list.filter((x) => String(x?.label || "").toLowerCase() !== String(labelInput).toLowerCase());
  const removed = before - remaining.length;

  db.customPackages[catKey] = sortPackagesByTier(remaining);
  saveDB();

  // Remove from runtime PACKAGES too (only exact label matches, case-insensitive)
  if (Array.isArray(PACKAGES?.[catKey])) {
    PACKAGES[catKey] = sortPackagesByTier(PACKAGES[catKey].filter((x) => String(x?.label || "").toLowerCase() !== String(labelInput).toLowerCase()));
  }

  if (removed <= 0) {
    await sendTracked(
      chatId,
      `⚠️ No matching custom offer found in *${mdEscape(catKey)}*.\n\nLabel:\n*${mdEscape(labelInput)}*`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
    );
    return;
  }

  await sendTracked(
    chatId,
    `✅ Removed *${removed}* offer(s) from *${mdEscape(catKey)}*.\n\n• *${mdEscape(labelInput)}*`,
    { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
  );
  return;
}

// ✅ /addedoffers (admin): list offers added via /addplan
// Usage:
//   /addedoffers
//   /addedoffers SMS Offers
if (/^\/addedoffers(?:@\w+)?\b/i.test(text)) {
  if (!isAdmin(chatId)) {
    await sendTracked(chatId, "❌ Not authorized.", { ...mainMenuKeyboard(chatId) });
    return;
  }

  const raw = text.replace(/^\/addedoffers(?:@\w+)?/i, "").trim();
  const wantCat = raw ? raw.toLowerCase() : "";

  db = repairDB(db);
  const custom = db.customPackages || {};

  const cats = Object.keys(custom).filter((c) => Array.isArray(custom[c]) && custom[c].length > 0);
  const matchedCats = wantCat ? cats.filter((c) => String(c).toLowerCase() === wantCat) : cats;

  if (matchedCats.length === 0) {
    await sendTracked(chatId, "ℹ️ No added offers found.", { ...mainMenuKeyboard(chatId) });
    return;
  }

  let out = "🧾 *Added Offers*\n";
  for (const c of matchedCats) {
    const list = (custom[c] || []).filter((x) => x && x.label);
    if (list.length === 0) continue;
    out += `\n\n*${mdEscape(c)}*`;
    for (const it of list.slice(0, 50)) {
      out += `\n• ${mdEscape(String(it.label))} — *Ksh ${mdEscape(String(it.price || ""))}*`;
    }
    if (list.length > 50) out += `\n...and ${list.length - 50} more`;
  }

  await sendTracked(chatId, out, { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) });
  return;
}


// ✅ /resendstk <chatId> (admin): resend last pending STK prompt
if (/^\/resendstk\s+\d+$/i.test(text)) {
  if (!isAdmin(chatId)) {
    await sendTracked(chatId, "❌ Not authorized.", { ...mainMenuKeyboard(chatId) });
    return;
  }




// ✅ /credit <chatId> <tickets> <pts> <reason...> (admin)
if (/^\/credit\s+\d+\s+-?\d+\s+-?\d+/i.test(text)) {
  if (!isAdmin(chatId)) {
    await sendTracked(chatId, "❌ Not authorized.", { ...mainMenuKeyboard(chatId) });
    return;
  }
  const parts = String(text).trim().split(/\s+/);
  const targetId = Number(parts[1] || 0);
  const tickets = Number(parts[2] || 0);
  const pts = Number(parts[3] || 0);
  const reason = parts.slice(4).join(" ").trim() || "manual";
  if (!targetId) {
    await sendTracked(chatId, "❌ Invalid target.", { ...mainMenuKeyboard(chatId) });
    return;
  }
  const u = getUser(targetId);
  u.tickets = Number(u.tickets || 0) + tickets;
  u.points = Number(u.points || 0) + pts;
  try { u.orders = Array.isArray(u.orders) ? u.orders : []; } catch (_) {}
  try { u.orders.unshift({ when: Date.now(), ref: "MANUAL", amount: 0, category: `ADMIN CREDIT (${reason})`, phone: "", status: "CREDIT" }); u.orders = u.orders.slice(0,10); } catch (_) {}
  try { saveDB(); } catch (_) {}
  await sendTracked(chatId, `✅ Credited ${targetId}: tickets ${tickets}, pts ${pts}.`, { ...mainMenuKeyboard(chatId) });
  await bot.sendMessage(targetId, `✅ Admin credited your account.\nTickets: ${tickets}\nPoints: ${pts}\nReason: ${reason}`).catch(() => {});
  return;
}

// ✅ /refaudit <chatId> (admin): referral audit summary
if (/^\/refaudit\s+\d+$/i.test(text)) {
  if (!isAdmin(chatId)) {
    await sendTracked(chatId, "❌ Not authorized.", { ...mainMenuKeyboard(chatId) });
    return;
  }
  const targetId = Number(String(text).trim().split(/\s+/)[1] || 0);
  db = repairDB(db);
  const a = db.referralAudit[String(targetId)] || null;
  if (!a) {
    await sendTracked(chatId, "ℹ️ No referral audit data for that user.", { ...mainMenuKeyboard(chatId) });
    return;
  }
  const lines = [];
  lines.push(`👥 Referral Audit for ${targetId}`);
  lines.push(`Total referred: ${a.totalReferred || 0}`);
  lines.push(`Successful purchases: ${a.successfulPurchases || 0}`);
  lines.push(`Unique phones counted: ${a.uniquePhones || 0}`);
  await sendTracked(chatId, lines.join("\n"), { ...mainMenuKeyboard(chatId) });
  return;
}

  const targetId = Number(String(text).trim().split(/\s+/)[1] || 0);
  const pend = getLatestPendingForChat(targetId);
  if (!pend) {
    await sendTracked(chatId, "❌ No pending STK found for that user.", { ...mainMenuKeyboard(chatId) });
    return;
  }
  try {
    await payheroStkPush({
      amount: Number(pend.price || 0),
      phone: String(pend.phone254 || ""),
      externalRef: String(pend.ref || ""),
      channelId: PAYHERO_CHANNEL_ID_DATA,
    });
    await sendTracked(chatId, `✅ Resent STK to ${targetId}.`, { ...mainMenuKeyboard(chatId) });
  } catch (e) {
    await sendTracked(chatId, `❌ Resend failed: ${mdEscape(e?.message || e)}`, { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) });
  }
  return;
}





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
    // ===================== USER REDEEM COMMAND =====================
    // Usage: /redeem <amount> <phone>
    // Allowed amounts: 5, 20, 25
    const redeemCmd = text.match(/^\/redeem\s+(\d+)\s+(\S+)$/i);
    if (redeemCmd && !isAdmin(chatId)) {
      const amount = Number(redeemCmd[1]);
      const phoneInput = redeemCmd[2];

      if (![5, 20, 25].includes(amount)) {
        return sendTracked(
          chatId,
          "❌ Invalid redeem amount.\n\nAllowed amounts:\n5 pts → 20 SMS\n20 pts → 250MB\n25 pts → 20 mins midnight",
          { ...mainMenuKeyboard(chatId) }
        );
      }

      const phone254 = normalizePhone(phoneInput);
      if (!phone254) {
        return sendTracked(chatId, "❌ Invalid phone number. Use 07 / 01 / 2547 / 2541 format.", {
          ...mainMenuKeyboard(chatId),
        });
      }

      let item;
      if (amount === 5) item = REDEEM_ITEMS[0];
      if (amount === 20) item = REDEEM_ITEMS[1];
      if (amount === 25) item = REDEEM_ITEMS[2];

      const st = canRedeemNow(chatId);
      if (!st.ok) {
        return sendTracked(
          chatId,
          `🔒 Redeem locked

Requirements:
• Total purchases: ${st.totalPurchases}/${REDEEM_MIN_TOTAL_PURCHASES}
• Purchases in current cycle: ${st.unlockPurchases}/${REDEEM_UNLOCK_PURCHASES_REQUIRED}
• Cycle resets in: ${st.daysLeft} day(s)`,
          { ...mainMenuKeyboard(chatId) }
        );
      }

      const rem = redeemCooldownRemainingMs(chatId);
      if (rem > 0) {
        const mins = Math.ceil(rem / 60000);
        return sendTracked(chatId, `⏳ Please wait ${mins} minute(s) before sending another redeem request.`, {
          ...mainMenuKeyboard(chatId),
        });
      }

      if (hasPendingRedeem(chatId)) {
        return sendTracked(chatId, "⏳ You already have a pending redeem request.", {
          ...mainMenuKeyboard(chatId),
        });
      }

      const balance = getPoints(chatId);
      if (balance < amount) {
        return sendTracked(
          chatId,
          `❌ Not enough points.\nYou have: ${balance.toFixed(2)} pts\nNeed: ${amount} pts`,
          { ...mainMenuKeyboard(chatId) }
        );
      }

      if (item.key === "FREE_250MB" && !isBusinessActive(chatId) && redeemPhoneAlreadyUsedToday(phone254)) {
        return sendTracked(
          chatId,
          "🚫 This phone number already redeemed 250MB today. Try again tomorrow.",
          { ...mainMenuKeyboard(chatId) }
        );
      }

      deductPoints(chatId, amount);

      const reqId = `RDM-${Date.now()}-${chatId}`;
      const u = getUser(chatId);

      const req = {
        reqId,
        chatId,
        name: `${msg.from?.first_name || ""} ${msg.from?.last_name || ""}`.trim(),
        itemKey: item.key,
        itemLabel: item.label,
        cost: amount,
        loadTo: formatTo07(phone254),
        totalReferrals: Number(u.referralSuccessCount || 0),
        totalSpent: Number(u.totalSpentKsh || 0),
        time: kenyaDateTime(),
        status: "pending",
      };

      setPendingRedeem(chatId, req);

      if (item.key === "FREE_250MB") markRedeemPhoneUsedToday(phone254);

      

  const sent = await bot.sendMessage(
        ADMIN_ID,
        `🎁 Redeem Request
User: ${chatId}
Item: ${item.label}
Cost: ${amount} pts
Load To: ${formatTo07(phone254)}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Accept", callback_data: `redeem_accept:${reqId}` }],
              [{ text: "❌ Cancel", callback_data: `redeem_decline:${reqId}` }],
            ],
          },
        }
      );

      return sendTracked(
        chatId,
        `✅ Redemption request submitted!

Item: ${item.label}
Load to: ${maskPhone(phone254)}
Points reserved: ${amount}
Remaining: ${getPoints(chatId).toFixed(2)} pts

Waiting for admin approval…`,
        { ...mainMenuKeyboard(chatId) }
      );
    }

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
        ...mainMenuKeyboard(chatId),
      });

      // Points + inline search (inline mode in current chat)
      const pts = getPoints(chatId);
      return sendTracked(chatId, `⭐ Your points: *${pts.toFixed(2)}*

💡 Tip: You can also search offers using inline:`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "🔎 Search Offers", switch_inline_query_current_chat: "" }]],
        },
      });
    }

    // /help
    if (/^\/help$/i.test(text)) {
      return sendTracked(chatId, helpText(), { ...mainMenuKeyboard(chatId) });
    }

    if (/^\/profile(?:@\w+)?$/i.test(text) || text === "👤 My Profile") {
      return showUserProfile(chatId);
    }

    // /buy
    if (/^\/buy$/i.test(text)) {
      sessions.set(chatId, { step: "category", category: null, pkgKey: null, createdAt: Date.now() });
      await sendBannerIfAvailable(chatId);
      return sendTracked(chatId, section("CHOOSE CATEGORY") + "✅ Choose a category:", categoriesKeyboard(chatId));
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
      
      
// ===================== WITHDRAW QUICK COMMANDS =====================
// Usage:
//   /ac <chatId>  -> approve latest pending withdraw for that user
//   /dc <chatId>  -> decline latest pending withdraw for that user (refund points)

async function __withdrawApprove(targetId, adminChatId, adminMsgId) {
  db = repairDB(db);
  const req = db.pendingRedeems?.[String(targetId)];
  if (!req || req.status !== "pending" || req.type !== "withdraw") {
    await bot.sendMessage(adminChatId, "❌ No pending withdraw for that user.").catch(() => {});
    return false;
  }

  req.status = "approved";
  db.pendingRedeems[String(targetId)] = req;
  saveDB();

  // track withdrawals in analytics/ledger if helper exists
  try { if (typeof trackWithdrawalApproval === "function") trackWithdrawalApproval(req); } catch (_) {}

  clearPendingRedeem(targetId);
  setRedeemCooldown(targetId, 5 * 60 * 1000);

  // Notify user (FULL message)
  await bot.sendMessage(
    Number(targetId),
    `✅ Withdrawal Approved!

Your withdrawal request has been successfully approved.

💰 Amount: ${Number(req.amount || 0)} pts
💵 You will receive: KES ${pointsToKes(req.amount)}
📱 M-PESA: ${req.phone}

The payment will be processed shortly.
Thank you for using Bingwa Mtaani 💙`,
  ).catch(() => {});

  // Delete admin request message + remove buttons
  if (adminChatId && adminMsgId) {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminChatId, message_id: adminMsgId }).catch(() => {});
    await bot.deleteMessage(adminChatId, adminMsgId).catch(() => {});
  }
  if (req.adminMsgId) {
    await bot.deleteMessage(ADMIN_ID, req.adminMsgId).catch(() => {});
  }

  await bot.sendMessage(adminChatId, `✅ Withdraw approved for ${targetId}`).catch(() => {});
  return true;
}

async function __withdrawDecline(targetId, adminChatId, adminMsgId) {
  db = repairDB(db);
  const req = db.pendingRedeems?.[String(targetId)];
  if (!req || req.status !== "pending" || req.type !== "withdraw") {
    await bot.sendMessage(adminChatId, "❌ No pending withdraw for that user.").catch(() => {});
    return false;
  }

  req.status = "declined";
  db.pendingRedeems[String(targetId)] = req;
  saveDB();

  // Track withdrawal stats for /profile
  try {
    const u = getUser(targetId);
    ensureTxLog(u);
    const ksh = Number(pointsToKes(req.amount || 0));
    u.withdrawStats.declinedCount = Number(u.withdrawStats.declinedCount || 0) + 1;
    u.withdrawStats.declinedKsh = Number(u.withdrawStats.declinedKsh || 0) + ksh;
    const d = kenyaDayKeyOffset(0);
    u.withdrawStats.byDay[d] = u.withdrawStats.byDay[d] || { approvedKsh: 0, declinedKsh: 0, pendingKsh: 0, approvedCount: 0, declinedCount: 0, pendingCount: 0 };
    u.withdrawStats.byDay[d].declinedKsh += ksh;
    u.withdrawStats.byDay[d].declinedCount += 1;
    saveDB();
    addUserTx(targetId, { status: "failed", pkgLabel: "Withdrawal", amountKsh: ksh, phone254: req.phone || "" });
  } catch (_) {}


  const amt = Number(req.amount || 0);
  if (Number.isFinite(amt) && amt > 0) addPoints(targetId, amt);

  clearPendingRedeem(targetId);
  setRedeemCooldown(targetId, 5 * 60 * 1000);

  await bot.sendMessage(
    Number(targetId),
    `❌ Withdrawal Declined

Your withdrawal request was declined by admin.

💰 Amount refunded: ${amt} pts
📌 Current balance: ${getPoints(targetId).toFixed(2)} pts

You can try again later.`,
  ).catch(() => {});

  if (adminChatId && adminMsgId) {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminChatId, message_id: adminMsgId }).catch(() => {});
    await bot.deleteMessage(adminChatId, adminMsgId).catch(() => {});
  }
  if (req.adminMsgId) {
    await bot.deleteMessage(ADMIN_ID, req.adminMsgId).catch(() => {});
  }

  await bot.sendMessage(adminChatId, `❌ Withdraw declined for ${targetId}`).catch(() => {});
  return true;
}

const acMatch = text.match(/^\/ac\s+(\d+)$/i);
if (acMatch) {
  const targetId = acMatch[1];
  await __withdrawApprove(targetId, chatId, null);
  return;
}

const dcMatch = text.match(/^\/dc\s+(\d+)$/i);
if (dcMatch) {
  const targetId = dcMatch[1];
  db = repairDB(db);

  const req = db.pendingRedeems?.[String(targetId)];
  if (!req || req.status !== "pending" || req.type !== "withdraw") {
    return sendTracked(chatId, "❌ No pending withdraw for that user.");
  }

  req.status = "declined";
  db.pendingRedeems[String(targetId)] = req;
  saveDB();

  // Track withdrawal stats for /profile
  try {
    const u = getUser(targetId);
    ensureTxLog(u);
    const ksh = Number(pointsToKes(req.amount || 0));
    u.withdrawStats.declinedCount = Number(u.withdrawStats.declinedCount || 0) + 1;
    u.withdrawStats.declinedKsh = Number(u.withdrawStats.declinedKsh || 0) + ksh;
    const d = kenyaDayKeyOffset(0);
    u.withdrawStats.byDay[d] = u.withdrawStats.byDay[d] || { approvedKsh: 0, declinedKsh: 0, pendingKsh: 0, approvedCount: 0, declinedCount: 0, pendingCount: 0 };
    u.withdrawStats.byDay[d].declinedKsh += ksh;
    u.withdrawStats.byDay[d].declinedCount += 1;
    saveDB();
    addUserTx(targetId, { status: "failed", pkgLabel: "Withdrawal", amountKsh: ksh, phone254: req.phone || "" });
  } catch (_) {}


  const amt = Number(req.amount || 0);
  if (Number.isFinite(amt) && amt > 0) addPoints(targetId, amt);

  clearPendingRedeem(targetId);
  setRedeemCooldown(targetId, 5 * 60 * 1000);

  

  const sent = await bot.sendMessage(
    Number(targetId),
    `❌ Withdrawal Declined\n\nAmount refunded: ${amt} pts\nCurrent balance: ${getPoints(targetId).toFixed(2)} pts`,
    { ...mainMenuKeyboard(chatId) }
  ).catch(() => {});

  
  // ✅ Auto-delete the admin withdraw request message
  if (req.adminMsgId) {
    await bot.deleteMessage(ADMIN_ID, req.adminMsgId).catch(() => {});
  }

return sendTracked(chatId, `❌ Withdraw declined for ${targetId}`);
}

const apm = text.match(/^\/addpoints\s+(\d+)\s+([0-9.]+)$/i);
      if (apm) {
        const targetId = apm[1];
        const amount = Number(apm[2]);
        if (!Number.isFinite(amount) || amount <= 0) {
          return sendTracked(chatId, "❌ Invalid amount.");
        }
        addPoints(targetId, amount);
        return sendTracked(chatId, `✅ Added ${amount} pts to ${targetId}`);
      }

      const rpm = text.match(/^\/removepoints\s+(\d+)\s+([0-9.]+)$/i);
      if (rpm) {
        const targetId = rpm[1];
        const amount = Number(rpm[2]);
        if (!Number.isFinite(amount) || amount <= 0) {
          return sendTracked(chatId, "❌ Invalid amount.");
        }
        deductPoints(targetId, amount);
        return sendTracked(chatId, `✅ Removed ${amount} pts from ${targetId}`);
      }

      const spm = text.match(/^\/setpoints\s+(\d+)\s+([0-9.]+)$/i);
      if (spm) {
        const targetId = spm[1];
        const amount = Number(spm[2]);
        if (!Number.isFinite(amount) || amount < 0) {
          return sendTracked(chatId, "❌ Invalid amount.");
        }
        const u = getUser(targetId);
        u.points = amount;
        saveDB();
        return sendTracked(chatId, `✅ Set ${targetId} points to ${amount}`);
      }


      if (/^\/users$/i.test(text)) {
        db = repairDB(db);
        const total = Object.keys(db.users || {}).filter((id) => String(id) !== String(ADMIN_ID)).length;
        return sendTracked(chatId, `👥 Total users: ${total}`);
      }

      // /refstatus <chatId>  (ADMIN) — shows referral lock + expiry status (not shown to users)
      const rsm = text.match(/^\/refstatus\s+(\d+)$/i);
      if (rsm) {
        const targetId = String(rsm[1]);
        const tu = getUser(targetId);

        if (!tu.inviterId) {
          return sendTracked(chatId, `ℹ️ User ${targetId} has no inviter set.`);
        }

        const setAt = Number(tu.inviterSetAt || 0);
        const maxMs = Number(REFERRAL.EXPIRY_DAYS || 30) * 24 * 60 * 60 * 1000;
        const ageMs = setAt ? (Date.now() - setAt) : 0;
        const expired = !setAt || ageMs > maxMs;
        const daysLeft = expired ? 0 : Math.ceil((maxMs - ageMs) / (24 * 60 * 60 * 1000));

        const out =
          `🔎 Referral Status\n` +
          `User: ${targetId}\n` +
          `Inviter: ${tu.inviterId}\n` +
          `Set at: ${kenyaDateTimeFromTs(setAt)}\n` +
          `Expiry: ${Number(REFERRAL.EXPIRY_DAYS || 30)} day(s)\n` +
          `Status: ${expired ? "EXPIRED (no earnings)" : `ACTIVE (${daysLeft} day(s) left)`}`;

        return sendTracked(chatId, out);
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


// ===================== REVENUE ANALYTICS (ADMIN) =====================
const revMatch = text.match(/^\/revenue(?:\s+(\d+))?$/i);
if (revMatch) {
  const days = Math.max(0, Math.min(90, Number(revMatch[1] || 0))); // 0=today, max 90
  const data = sumDaysRevenue(days);
  const aov = data.orders ? round2(data.revenueKsh / data.orders) : 0;

  const header =
    `💰 *Revenue Analytics*\n` +
    `Window: *${days === 0 ? "Today" : `Last ${days} day(s)`}*\n\n` +
    `Revenue: *Ksh ${data.revenueKsh}*\n` +
    `Orders: *${data.orders}*\n` +
    `AOV: *Ksh ${aov}*\n\n`;

  const byCat = formatBuckets("📦 *By Category*", data.byCategory, 10);
  const byPkg = formatBuckets("🏷️ *Top Packages*", data.byPackage, 10);

  return sendTracked(chatId, header + byCat + "\n\n" + byPkg, { parse_mode: "Markdown" });
}

if (/^\/revenueweek$/i.test(text)) {
  db = repairDB(db);
  const wk = isoWeekKey(new Date());
  const x = db.analytics?.revenueByWeek?.[wk] || { revenueKsh: 0, orders: 0 };
  const aov = x.orders ? round2(Number(x.revenueKsh || 0) / Number(x.orders || 0)) : 0;

  return sendTracked(
    chatId,
    `🗓️ *Revenue This Week* (${wk})\n\nRevenue: *Ksh ${round2(x.revenueKsh)}*\nOrders: *${Number(x.orders || 0)}*\nAOV: *Ksh ${aov}*`,
    { parse_mode: "Markdown" }
  );
}

const topOffers = text.match(/^\/topoffers(?:\s+(\d+))?$/i);
if (topOffers) {
  const days = Math.max(0, Math.min(90, Number(topOffers[1] || 7)));
  const data = sumDaysRevenue(days);

  const rows = Object.entries(data.byPackage || {})
    .map(([k, v]) => ({ k, revenueKsh: round2(v.revenueKsh), orders: Number(v.orders || 0) }))
    .sort((a, b) => b.revenueKsh - a.revenueKsh)
    .slice(0, 15);

  if (!rows.length) return sendTracked(chatId, "No revenue data yet.");

  const lines = rows.map((r, i) => `${i + 1}. ${r.k} — *Ksh ${r.revenueKsh}* (${r.orders})`).join("\\n");
  return sendTracked(chatId, `🏆 *Top Offers (last ${days} day(s))*\n\n${lines}`, { parse_mode: "Markdown" });
}

const exportRev = text.match(/^\/exportrevenue(?:\s+(\d+))?$/i);
if (exportRev) {
  const days = Number(exportRev[1] || 30);
  try {
    const { filepath, filename, days: usedDays, rowCount } = writeRevenueCsvFile(days);

    await bot.sendDocument(chatId, filepath, {
      caption: `📎 Revenue CSV export\nWindow: last ${usedDays} day(s)\nRows: ${rowCount}`,
    });

    // cleanup file to avoid disk growth
    try { fs.unlinkSync(filepath); } catch (_) {}

    return sendTracked(chatId, `✅ Export sent: ${filename}`);
  } catch (e) {
    return sendTracked(chatId, `⚠️ Export failed: ${e?.message || e}`);
  }
}


if (/^\/pending$/i.test(text)) {
  db = repairDB(db);
  const pending = Object.entries(db.pendingRedeems || {})
    .filter(([, r]) => r && r.status === "pending")
    .slice(0, 25);

  if (!pending.length) return sendTracked(chatId, "✅ No pending redeem requests.");

  for (const [, r] of pending) {
    const adminText =
      `🎁 *Redeem Request*\n` +
      `ChatID: \`${mdEscape(r.chatId)}\`\n` +
      `User: *${mdEscape(r.name || "User")}*\n` +
      `Item: *${mdEscape(r.itemLabel)}*\n` +
      `Cost: *${mdEscape(r.cost)} pts*\n` +
      `Load To: *${mdEscape(r.loadTo)}*\n` +
      `Time: \`${mdEscape(r.time || "")}\`\n\n` +
      `Approve or cancel:`;

    // eslint-disable-next-line no-await-in-loop
    

  const sent = await bot.sendMessage(chatId, adminText, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Accept", callback_data: `redeem_accept:${r.reqId}` }],
          [{ text: "❌ Cancel", callback_data: `redeem_decline:${r.reqId}` }],
        ],
      },
    });
  }
  return;
}


// ===================== ADMIN: ROTATION BROADCAST MENU =====================
// Usage: reply to any message then type:
//   /bcast        (defaults to 7 days rotation options)
//   /bcast 14     (rotation options use 14 days)
const bcastMatch = text.match(/^\/bcast(?:\s+(\d+))?$/i);
if (bcastMatch) {
  const days = Math.max(1, Math.min(365, Number(bcastMatch[1] || 7)));

  if (!msg.reply_to_message?.message_id) {
    return sendTracked(chatId, "Reply to the message you want to broadcast, then send:\n/bcast 7");
  }

  const fromChatId = msg.reply_to_message.chat.id;
  const messageId = msg.reply_to_message.message_id;

  adminState.set(String(chatId), {
    step: "await_bcast_choice",
    fromChatId,
    messageId,
    days,
    createdAt: Date.now(),
  });

  return bot.sendMessage(chatId, `Choose broadcast mode (rotation = ${days} day(s)) :`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚀 Send Immediately (No Rotation)", callback_data: "bcast:once" }],
        [{ text: `🔁 Rotation Daily (Start Now) — ${days}d`, callback_data: "bcast:rot_now" }],
        [{ text: `⏭️ Rotation Daily (Start Tomorrow) — ${days}d`, callback_data: "bcast:rot_tom" }],
        [{ text: "❌ Cancel", callback_data: "bcast:cancel" }],
      ],
    },
  });
}

// List rotations with stop buttons
if (/^\/rotlist$/i.test(text)) {
  const active = listActiveRotations();
  if (!active.length) return sendTracked(chatId, "No active rotations.");

  for (const r of active) {
    const next = kenyaDateTimeFromTs(r.nextRunAt || 0);
    const exp = kenyaDateTimeFromTs(r.expiresAt || 0);
    const runs = Number(r.runs || 0);

    // eslint-disable-next-line no-await-in-loop
    await bot.sendMessage(
      chatId,
      `🔁 Rotation ID: ${r.id}\nRuns: ${runs}\nNext: ${next}\nExpires: ${exp}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🛑 Rotation OFF / Stop rotation", callback_data: `rot:stop:${r.id}` }],
          ],
        },
      }
    ).catch(() => {});
  }
  return;
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
      return sendTracked(chatId, "✅ Support closed.", { ...mainMenuKeyboard(chatId) });
    }

    await forwardToAdminWithUserTag(msg);
    return sendTracked(chatId, "✅ Sent to support. We will reply here.\nSend more or /cancel to stop.", {
      ...mainMenuKeyboard(chatId),
    });
  }

  
// ===================== ACTIONS FLOW (REDEEM ONLY) =====================
  const act = getPendingAction(chatId);




  // ===================== PENDING ACTIONS (PHONE INPUT) =====================
  // Handles flows where the bot asked user to "send phone number"
  if (act && act.type === "change_number") {
    // User is updating their saved number
    if (/^\s*\/cancel\s*$/i.test(text) || text === "❌ Cancel") {
      clearPendingAction(chatId);
      await sendTracked(chatId, "✅ Cancelled.", { ...mainMenuKeyboard(chatId) });
      return;
    }

    const phone = normalizePhone(text);
    if (!phone) {
      await sendTracked(
        chatId,
        "❌ Invalid phone format.\n\nSend:\n• 07XXXXXXXX\n• 01XXXXXXXX\n• 2547XXXXXXXX\n• 2541XXXXXXXX\n\nType /cancel to stop.",
        { ...mainMenuKeyboard(chatId) }
      );
      return;
    }

    setUserPhone(chatId, phone);
    clearPendingAction(chatId);

    await sendTracked(chatId, `✅ Number saved: *${mdEscape(maskPhone(phone))}*`, {
      parse_mode: "Markdown",
      ...mainMenuKeyboard(chatId),
    });
    return;
  }

  if (act && act.type === "sell_business") {
    if (/^\s*\/cancel\s*$/i.test(text) || text === "❌ Cancel") {
      clearPendingAction(chatId);
      await sendTracked(chatId, "✅ Cancelled.", { ...mainMenuKeyboard(chatId) });
      return;
    }

    const planKey = String(act.planKey || "");
    const plan = BUSINESS_PLANS[planKey];
    if (!plan) {
      clearPendingAction(chatId);
      await sendTracked(chatId, "❌ Plan expired. Type /sell again.", { ...mainMenuKeyboard(chatId) });
      return;
    }

    const phone254 = normalizePhone(text);
    if (!phone254) {
      await sendTracked(
        chatId,
        "❌ Invalid phone format.\n\nSend:\n• 07XXXXXXXX\n• 01XXXXXXXX\n• 2547XXXXXXXX\n• 2541XXXXXXXX",
        { ...mainMenuKeyboard(chatId) }
      );
      return;
    }

    // Save number for future use
    setUserPhone(chatId, phone254);
    clearPendingAction(chatId);

    const externalRef = makeExternalRef(chatId, "Business_Account", plan.price);

    addPendingPayment(externalRef, {
      chatId,
      category: "Business Account",
      pkgLabel: `${plan.label} (Ksh ${plan.price})`,
      phone254,
      price: plan.price,
      planKey,
    });

    await sendTracked(
      chatId,
      `✅ *Subscription Selected*\n\nPlan: *${mdEscape(plan.label)}*\nAmount: *Ksh ${plan.price}*\nPhone: *${mdEscape(maskPhone(phone254))}*\n\n📲 Sending STK…`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
    );

    try {
      await payheroStkPush({
        amount: plan.price,
        phone: phone254,
        externalRef,
        channelId: PAYHERO_CHANNEL_ID_BUSINESS,
      });

      await sendTracked(
        chatId,
        `✅ STK sent. Please enter your M-Pesa PIN on your phone.\n\n⏳ After payment, you will receive confirmation here.`,
        { ...mainMenuKeyboard(chatId) }
      );
      return;
    } catch (e) {
      deletePendingPayment(externalRef);
      await sendTracked(chatId, `❌ STK failed: ${mdEscape(e?.message || e)}\n\nHelp: ${HELP_PHONE}`, {
        parse_mode: "Markdown",
        ...mainMenuKeyboard(chatId),
      });
      return;
    }
  }
  // =================== END PENDING ACTIONS (PHONE INPUT) ====================
// ===================== WEEKLY DRAW ADMIN INPUT (typed/sent after tapping admin buttons) =====================
const _wdState = isAdmin(chatId) ? getWeeklyDrawAdminState(chatId) : null;
if (isAdmin(chatId) && _wdState && _wdState.mode) {
  const c = ensureWeeklyDrawObject();

  // cancel admin input
  if (/^\s*\/cancel\s*$/i.test(text)) {
    setWeeklyDrawAdminState(chatId, null);
    const statusText = formatWeeklyDrawAdminStatus();
    await editAdminStateMessage(chatId, _wdState, `❌ Cancelled.\n\n${statusText}`, weeklyDrawAdminMenuKeyboard());
    return;
  }

  if (_wdState.mode === "set_name") {
    const nm = String(text || "").trim();
    if (!nm) {
      await editAdminStateMessage(chatId, _wdState, "❌ Name cannot be empty. Send name text (or /cancel).", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "wdadm:menu" }]] } });
      return;
    }
    c.name = nm.slice(0, 40);
    if (!c.heading) c.heading = c.name;
    try { saveDB(); } catch (_) {}
    setWeeklyDrawAdminState(chatId, null);
    const statusText = formatWeeklyDrawAdminStatus();
    await editAdminStateMessage(chatId, _wdState, `✅ Name updated.\n\n${statusText}`, weeklyDrawAdminMenuKeyboard());
    return;
  }

  if (_wdState.mode === "set_heading") {
    const h = String(text || "").trim();
    if (!h) {
      await editAdminStateMessage(chatId, _wdState, "❌ Heading cannot be empty. Send heading text (or /cancel).", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "wdadm:menu" }]] } });
      return;
    }
    c.heading = h.slice(0, 80);
    try { saveDB(); } catch (_) {}
    setWeeklyDrawAdminState(chatId, null);
    const statusText = formatWeeklyDrawAdminStatus();
    await editAdminStateMessage(chatId, _wdState, `✅ Heading updated.\n\n${statusText}`, weeklyDrawAdminMenuKeyboard());
    return;
  }

  if (_wdState.mode === "set_winnerscount") {
    const n = Number(String(text || "").trim());
    if (!Number.isFinite(n) || n < 1 || n > 50) {
      await editAdminStateMessage(chatId, _wdState, "❌ Invalid number. Send a number between 1 and 50 (e.g. 5).", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "wdadm:menu" }]] } });
      return;
    }
    c.winnersCount = Math.floor(n);
    try { saveDB(); } catch (_) {}
    setWeeklyDrawAdminState(chatId, null);
    const statusText = formatWeeklyDrawAdminStatus();
    await editAdminStateMessage(chatId, _wdState, `✅ Winners count set to *${c.winnersCount}*.\n\n${statusText}`, { parse_mode: "Markdown", ...weeklyDrawAdminMenuKeyboard() });
    return;
  }

  if (_wdState.mode === "set_image") {
    let img = "";
    if (msg.photo && Array.isArray(msg.photo) && msg.photo.length) {
      img = msg.photo[msg.photo.length - 1].file_id;
    } else if (typeof text === "string" && /^https?:\/\//i.test(text.trim())) {
      img = text.trim();
    }
    if (!img) {
      await editAdminStateMessage(chatId, _wdState, "❌ Send a PHOTO or an IMAGE URL (or /cancel).", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "wdadm:menu" }]] } });
      return;
    }
    c.image = img;
    try { saveDB(); } catch (_) {}
    setWeeklyDrawAdminState(chatId, null);
    const statusText = formatWeeklyDrawAdminStatus();
    await editAdminStateMessage(chatId, _wdState, `✅ Image updated.\n\n${statusText}`, weeklyDrawAdminMenuKeyboard());
    return;
  }

  if (_wdState.mode === "set_qual") {
    const key = String(_wdState.key || "");
    if (!key) {
      setWeeklyDrawAdminState(chatId, null);
      await bot.sendMessage(chatId, "❌ Missing qualification key. Tap Set again.", mainMenuKeyboard(chatId)).catch(() => {});
      return;
    }

    const res = setQualificationValue(c, key, text);
    if (!res || !res.ok) {
      await editAdminStateMessage(
        chatId,
        _wdState,
        `❌ ${res && res.err ? res.err : 'Invalid value.'}

${qualificationPromptFor(key)}

Send again or /cancel.`,
        weeklyDrawQualificationsKeyboard()
      );
      return;
    }

    try { saveDB(); } catch (_) {}
    setWeeklyDrawAdminState(chatId, null);
    await editAdminStateMessage(chatId, _wdState, "✅ Updated.\n\n✅ Weekly Draw Qualifications (mark/unmark and set values):", weeklyDrawQualificationsKeyboard());
    return;
  }




if (_wdState.mode === "confirm_reset") {
  const kind = String(_wdState.kind || "");
  const t = String(text || "").trim();

  if (!/^YES$/i.test(t)) {
    await bot.sendMessage(chatId, "❌ Cancelled. Nothing was changed.", mainMenuKeyboard(chatId)).catch(() => {});
    setWeeklyDrawAdminState(chatId, null);
    return;
  }

  // Confirmed
  if (kind === "factory") {
    // wipe everything (fresh bot)
    db.users = {};
    db.bingwaByPhone = {};
    db.pendingPayments = {};
    db.pendingRedeems = {};
    db.redeemByPhoneDay = {};
    db.redeemCooldownByChat = {};
    db.processedPayments = {};
    db.referralsByDay = {};
    db.scheduledBroadcasts = [];
    db.phoneCooldown = {};
    db.stats = { totalPurchases: 0, totalBroadcasts: 0, lastLeaderboardWeek: "", lastDailyReportDay: "" };
    db.analytics = { revenueByDay: {}, revenueByWeek: {}, revenueByCategoryDay: {}, revenueByPackageDay: {}, transactionsByDay: {} };
    // keep weekly draw campaign settings (optional). If you want fully new weekly draw too, uncomment:
    // db.campaign = null;
  } else if (kind === "referrals") {
    // reset referral-related fields only
    for (const [cid, u] of Object.entries(db.users || {})) {
      if (!u || typeof u !== "object") continue;
      u.inviterId = "";
      u.inviterSetAt = 0;
      u.lastReferralRewardDay = "";
      u.referralSuccessCount = 0;
      u.referralCounted = false;
    }
    db.referralsByDay = {};
  } else if (kind === "balances") {
    // clear user balances (points)
    for (const [cid, u] of Object.entries(db.users || {})) {
      if (!u || typeof u !== "object") continue;
      u.points = 0;
    }
    db.pendingRedeems = {};
  }

  try { saveDB(); } catch (_) {}
  setWeeklyDrawAdminState(chatId, null);

  await bot.sendMessage(chatId, "✅ Done.", mainMenuKeyboard(chatId)).catch(() => {});
  return;
}

  // If mode not recognized, clear it to avoid stuck state
  setWeeklyDrawAdminState(chatId, null);
}
// ===================== END WEEKLY DRAW ADMIN INPUT =====================
// ===================== REDEEM DISABLED =====================
  if (isBtn(text, "🎁 Redeem Points", "🎁 Kukomboa Pointi")) {
    return sendTracked(chatId, "🚫 Redeem is disabled.", { ...mainMenuKeyboard(chatId) });
  }
  if (text === "1️⃣ 20 free SMS (5 pts)" || text === "2️⃣ 250MB free (20 pts)" || text === "3️⃣ 20mins midnight free (25 pts)") {
    return sendTracked(chatId, "🚫 Redeem is disabled.", { ...mainMenuKeyboard(chatId) });
  }

  // ===================== PREV (GLOBAL) =====================
  if (text === PREV_BTN) {
    // Prefer session history snapshots
    const snap = popPrev(chatId);
    if (snap) return renderSessionSnapshot(chatId, snap);

    // Fallback: if user is currently in a purchase session, go back one logical step
    const sNow = sessions.get(chatId);
    if (sNow && sNow.step) {
      if (sNow.step === "confirm") return renderSessionSnapshot(chatId, { ...cloneSession(sNow), step: "package" });
      if (sNow.step === "phone") return renderSessionSnapshot(chatId, { ...cloneSession(sNow), step: "confirm" });
      if (sNow.step === "package") return renderSessionSnapshot(chatId, { ...cloneSession(sNow), step: "category", pkgKey: null });
      if (sNow.step === "category") return renderSessionSnapshot(chatId, { step: null });
    }
    return sendTracked(chatId, "✅ Main menu:", { ...mainMenuKeyboard(chatId) });
  }






  

// ===================== QUICK ACTIONS: auto-buy most used package + most used number =====================
try {
  const quick = getQuickCategories(chatId) || [];
  const hit = quick.find(q => q && q.text === text && q.category);
  if (hit && hit.category) {
    const u = getUser(chatId);
    ensureUserStats(u);

    const favPkg = getFavouritePackageForCategory(u, hit.category);
    if (!favPkg || !favPkg.pkgLabel || !favPkg.amount) {
      // fallback to category list if we can't detect favourite package
      pushPrev(chatId, sessions.get(chatId) || { step: null });
      sessions.set(chatId, { step: "package", category: hit.category, pkgKey: null, createdAt: Date.now() });
      await sendBannerIfAvailable(chatId);
      return sendTracked(chatId, section(String(hit.category || "").toUpperCase()) + `👇 ${hit.category} packages:`, packagesKeyboard(hit.category));
    }

    const savedPhone = (u.stats?.favourite?.phone254) || getUserPhone(chatId);
    if (!savedPhone) {
      // ask for number (use existing flow)
      pushPrev(chatId, sessions.get(chatId) || { step: null });
      sessions.set(chatId, { step: "phone", category: hit.category, pkgKey: favPkg.pkgLabel, createdAt: Date.now() });
      return sendTracked(chatId, "📱 Paste number to continue:", { ...mainMenuKeyboard(chatId) });
    }

    // Prevent multiple pending STKs (Business exempt; quick categories are not Business)
    try {
      const isBiz = (typeof isBusinessActive === "function" && isBusinessActive(chatId));
      if (!isBiz) {
        const pend = hasActivePendingStkForChat(chatId);
        if (pend) {
          return sendTracked(chatId, "⏳ You already have a pending STK request. Please complete it or wait for it to expire (10 minutes) before starting a new one.", { ...mainMenuKeyboard(chatId) });
        }
      }
    } catch (_) {}

    const category = String(favPkg.category);
    const pkgLabel = String(favPkg.pkgLabel);
    const amount = Number(favPkg.amount || 0);
    const phone254 = String(savedPhone);
    const channelId = Number(favPkg.channelId || 0) || channelIdForCategory(category);

    const externalRef = makeExternalRef(chatId, category.replace(/\s+/g, "_"), amount);

    addPendingPayment(externalRef, {
      chatId,
      category,
      pkgLabel,
      phone254,
      price: amount,
    });

    await sendTracked(
      chatId,
      `⚡ Quick Purchase\n\nPackage: *${mdEscape(pkgLabel)}*\nCategory: *${mdEscape(category)}*\nAmount: *Ksh ${mdEscape(String(amount))}*\nPhone: *${mdEscape(maskPhone(phone254))}*\n\n📲 Sending STK…`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
    );

    try {
      await payheroStkPush({ amount, phone: phone254, externalRef, channelId });
      return;
    } catch (e) {
      deletePendingPayment(externalRef);
      return sendTracked(chatId, `❌ STK failed: ${mdEscape(e?.message || e)}\n\nHelp: ${HELP_PHONE}`, { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) });
    }
  }
} catch (_) {}

if (isBtn(text,"🛒 Buy Offers","🛒 Nunua Ofa")) {
    pushPrev(chatId, sessions.get(chatId) || { step: null });
    sessions.set(chatId, { step: "category", category: null, pkgKey: null, createdAt: Date.now() });
    await sendBannerIfAvailable(chatId);
    await sendTracked(chatId, packagesOverviewText(), { parse_mode: "Markdown" });
    return sendTracked(chatId, section("CHOOSE CATEGORY") + "✅ Choose a category:", categoriesKeyboard(chatId));
  }


  // ===================== WEEKLY DRAW (BUTTON / COMMAND) =====================
  // Handles both English and Swahili menu labels
  if (isBtn(text, tr(chatId,"🎉 WEEKLY DRAW","🎉 DROO YA WIKI")) || /^\/weeklydraw(?:@\w+)?$/i.test(text) || /^droo ya wiki$/i.test(text)) {
    try { clearPendingAction(chatId); } catch (_) {}
    try { sessions.delete(chatId); } catch (_) {}
    try { stopWeeklyDrawLiveUpdate(chatId); } catch (_) {}
    return openWeeklyDrawUserMenu(chatId);
  }



  
  if (text === "🔄 Resend STK") {
    db = repairDB(db);

    // find latest pending payment for this user
    const entries = Object.entries(db.pendingPayments || {}).reverse();
    const found = entries.find(([ref, p]) => Number(p.chatId) === Number(chatId));

    if (!found) {
      return sendTracked(chatId, "❌ No recent pending STK found.", { ...mainMenuKeyboard(chatId) });
    }

    const [ref, pending] = found;
    const now = Date.now();
    const lastAt = Number(db.phoneCooldown?.[pending.phone254] || 0);

    // respect 1 minute cooldown per number (admin bypass)
    if (!isAdmin(chatId) && lastAt && now - lastAt < 60 * 1000) {
      const wait = Math.ceil((60 * 1000 - (now - lastAt)) / 1000);
      return sendTracked(chatId, `⏳ You must wait ${wait}s before resending STK.`, { ...mainMenuKeyboard(chatId) });
    }

    try {
      await payheroStkPush({
        amount: pending.price,
        phone: pending.phone254,
        externalRef: ref,
        channelId: channelIdForCategory(pending.category),
      });

      db.phoneCooldown[pending.phone254] = now;
      saveDB();

      return sendTracked(chatId, "✅ STK resent successfully. Check your phone.", { ...mainMenuKeyboard(chatId) });
    } catch (err) {
      return sendTracked(chatId, `⚠️ Resend failed: ${err.message}`, { ...mainMenuKeyboard(chatId) });
    }
  }


if (text === "🔁 Buy Again" || text === "🔁 Nunua Tena") {
    const u = getUser(chatId);
    const lp = u.lastPurchase;

    if (!lp || !lp.category || !lp.pkgLabel) {
      return sendTracked(chatId, "ℹ️ No previous purchase found yet. Buy any offer first.", { ...mainMenuKeyboard(chatId) });
    }

    // Re-use the normal confirm flow so Proceed / Change Number works.
    const s2 = sessions.get(chatId) || {};
    pushPrev(chatId, s2);

    s2.step = "confirm";
    s2.category = lp.category;
    s2.pkgKey = lp.pkgLabel;

    sessions.set(chatId, s2);

    const pkg = findPackageByLabel(s2.category, s2.pkgKey);
    if (!pkg) {
      sessions.delete(chatId);
      return sendTracked(chatId, "❌ Last offer not found in current packages list. Tap 🛒 Buy Offers.", { ...mainMenuKeyboard(chatId) });
    }

    const hasSaved = !!getUserPhone(chatId);

    return sendTracked(
      chatId,
      `🔁 *Buy Again*

Category: *${mdEscape(s2.category)}*
Offer: *${mdEscape(pkg.label)}*
Price: *Ksh ${mdEscape(String(pkg.price))}*

✅ Tap Proceed to pay or Change Number.`,
      { parse_mode: "Markdown", ...(isFastPurchaseEnabled(chatId) ? confirmKeyboardV2(chatId, s, hasSaved) : confirmKeyboard(hasSaved)) }
    );
  }







// ===================== REFERRAL LINK =====================

if (isBtn(text,"🔗 My Referral","🔗 Rufaa Zangu")) {
  const BOT_USERNAME = process.env.BOT_USERNAME || "";
  const referralLink = `https://t.me/${BOT_USERNAME}?start=${chatId}`;

  const description = `💰 Turn your small purchases into real rewards!
🔥 Earn rewards while buying cheap offers!
Join Bingwa Data Bot today and compete for weekly cash prizes 🏆💸`;

  // Share (description first, then link)
  const tgShareUrl = `https://t.me/share/url?text=${encodeURIComponent(`${description}\n\n${referralLink}`)}`;
  const waShareUrl = `https://wa.me/?text=${encodeURIComponent(`${description}\n\n${referralLink}`)}`;

  // Referral stats
  const me = getUser(chatId);
  const totalRefs = Number(me.referralSuccessCount || 0);
  const earnedTotal = Number(me.referralEarningsTotal || 0);
  const todayKey = kenyaDayKey();
  const earnedToday = Number((me.referralEarningsByDay && me.referralEarningsByDay[todayKey]) || 0);
  const ptsBal = Number(getPoints(chatId) || 0);

  const bonusPct = Math.round(Number(REFERRAL.BONUS_PERCENT || 0) * 100);
  const bonusDays = Number(REFERRAL.EXPIRY_DAYS || 0);

  const msg =
    `🚀 *Invite Friends & Earn Points!*\n\n` +
    `🎁 *Referral Bonus:* Earn *${bonusPct}%* points from every successful purchase your friend makes (for *${bonusDays} days*).\n\n` +
    `📊 *Your Stats*\n` +
    `👥 Total successful referrals: *${totalRefs}*\n` +
    `💰 Earned so far from referrals: *${earnedTotal.toFixed(2)} pts*\n` +
    `📅 Today's referral earnings: *${earnedToday.toFixed(2)} pts*\n` +
    `💎 Your points balance: *${ptsBal.toFixed(2)} pts*\n\n` +
    `Tap a button below to share your invite link instantly 👇\n` +
    `🔥 Weekly prizes available — don’t miss out!`;

  await sendTracked(chatId, msg, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📤 Share on Telegram", url: tgShareUrl }],
        [{ text: "💬 Share on WhatsApp", url: waShareUrl }],
        [{ text: "📋 Copy Link", callback_data: "copy_ref_link" }],
        [{ text: "🏠 Main Menu", callback_data: "ref:home" }]
      ]
    }
  });

  return;
}

// ===================== HELP MENU (BUTTON) =====================
if (isBtn(text,"ℹ️ Help","ℹ️ Msaada") || /^\/help\b/i.test(text) || /^help$/i.test(text) || /^msaada$/i.test(text)) {
  await sendHelpMenu(chatId);
  return;
}

// ===================== PROFILE (BUTTON) =====================
// NOTE: "👤 My Profile" is a reply-keyboard button (normal text message), not a callback query.
// It MUST be handled outside the text.startsWith("/") command-only block.
if (isBtn(text,"👤 My Profile","👤 Wasifu Wangu") || /^\/profile(?:@\w+)?$/i.test(text) || /^wasifu wangu$/i.test(text)) {
  return showUserProfile(chatId);
}




// ===================== WITHDRAW FLOW =====================

if (isBtn(text,"💸 Withdraw Points","💸 Toa Pointi")) {
  const u = getUser(chatId);
  const savedPhone = getUserPhone(chatId);

  if (!savedPhone) {
    return sendTracked(chatId, "📱 Please save your phone number first before withdrawing.", { ...mainMenuKeyboard(chatId) });
  }

  // ✅ Admin bypasses ALL limitations
  if (!isAdmin(chatId) && Number(u.totalSpentKsh || 0) < MIN_WITHDRAW_SPEND) {
    const spent = Number(u.totalSpentKsh || 0);
    const remaining = MIN_WITHDRAW_SPEND - spent;
    return sendTracked(
      chatId,
      `🚫 Kutoa Kumezuiwa

` +
      `Lazima uwe umetumia angalau *Ksh ${MIN_WITHDRAW_SPEND}* kabla ya kuweza kutoa pointi.

` +
      `💰 Umetumia: Ksh ${spent}
` +
      `🟡 Bado Inahitajika: Ksh ${remaining}

` +
      `Endelea kununua ofa ili kufungua huduma ya kutoa.`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
    );
  }

  return sendTracked(
    chatId,
    `💸 Withdraw Points

Your balance: ${getPoints(chatId).toFixed(2)} pts

Choose amount to withdraw:`,
    withdrawKeyboard()
  );
}

if (["25 pts", "50 pts", "100 pts", "250 pts", "500 pts", "1000 pts", "2000 pts"].includes(text)) {
  const amount = Number(text.split(" ")[0]);
  const bal = getPoints(chatId);
  const phone07 = formatTo07(getUserPhone(chatId));
  const u = getUser(chatId);

  // ✅ Admin bypasses ALL limitations
  if (!isAdmin(chatId) && Number(u.totalSpentKsh || 0) < MIN_WITHDRAW_SPEND) {
    const spent = Number(u.totalSpentKsh || 0);
    const remaining = MIN_WITHDRAW_SPEND - spent;
    return sendTracked(chatId, `🚫 Kutoa Kumezuiwa

` +
      `Lazima uwe umetumia angalau *Ksh ${MIN_WITHDRAW_SPEND}* kabla ya kuweza kutoa pointi.

` +
      `💰 Umetumia: Ksh ${spent}
` +
      `🟡 Bado Inahitajika: Ksh ${remaining}

` +
      `Endelea kununua ofa ili kufungua huduma ya kutoa.`, { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) });
  }

  if (bal < amount) {
    return sendTracked(chatId, `❌ Not enough points. You have ${bal} pts`, { ...mainMenuKeyboard(chatId) });
  }

  if (hasPendingRedeem(chatId)) {
    return sendTracked(chatId, "⏳ You already have a pending request.", { ...mainMenuKeyboard(chatId) });
  }

  deductPoints(chatId, amount);

  const reqId = `WD-${Date.now()}-${chatId}`;

  const req = {
    reqId,
    chatId,
    type: "withdraw",
    amount,
    phone: phone07,
    status: "pending",
    time: kenyaDateTime(),
  };

  setPendingRedeem(chatId, req);

  

const sent = await bot.sendMessage(
  ADMIN_ID,
  `💸 *Withdraw Request*

User: \`${chatId}\`
Amount: *${amount} pts*
KES to Send: *${pointsToKes(amount)}*
MPESA: *${phone07}*

Approve withdrawal?

Quick Approve:
/ac ${chatId}

Quick Decline:
/dc ${chatId}`,
  {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `ac:${chatId}` },
          { text: "❌ Decline", callback_data: `dc:${chatId}` },
        ],
      ],
    },
  }
);
// ✅ Save admin message id so it can be auto-deleted after /ac or /dc
try {
  db = repairDB(db);
  if (db.pendingRedeems && db.pendingRedeems[String(chatId)]) {
    db.pendingRedeems[String(chatId)].adminMsgId = sent.message_id;
    saveDB();
  }
} catch (_) {}
return sendTracked(
    chatId,
    `⏳ Withdrawal request submitted.
Amount: ${amount} pts
You will receive: KES ${pointsToKes(amount)}
MPESA: ${mask07(phone07)}

Waiting for admin approval.`,
    { ...mainMenuKeyboard(chatId) }
  );
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
    return sendTracked(chatId, "⏱️ Session expired. Tap 🛒 Buy Offers again.", { ...mainMenuKeyboard(chatId) });
  }

  try {
    // BACK
    if (text === "⬅ Back" || text === "⬅️ Back" || text === "⬅ Rudi" || text === "⬅️ Rudi") {
      if (s.step === "phone" || s.step === "confirm") {
        s.step = "package";
        sessions.set(chatId, s);
        return sendTracked(chatId, `✅ Choose a ${s.category} package:`, packagesKeyboard(s.category));
      }
      s.step = "category";
      s.category = null;
      s.pkgKey = null;
      sessions.set(chatId, s);
      return sendTracked(chatId, section("CHOOSE CATEGORY") + "✅ Choose a category:", categoriesKeyboard(chatId));
    }


    // FAST PURCHASE PHONE PICK (reply keyboard buttons)
    if (s.step === "fast_phone_pick") {
      // Go back to packages
      if (text === PREV_BTN || text === "⬅ Prev" || text === "⬅ Nyuma" || text === "⬅️ Nyuma") {
        s.step = "package";
        sessions.set(chatId, s);
        return sendTracked(chatId, `👇 ${s.category} packages:`, packagesKeyboard(s.category));
      }

      // Ask for a new number
      if (text === "➕ New Number" || text === "+ New Number" || text === "➕ Namba Mpya" || text === "+ Namba Mpya") {
        s.step = "phone";
        sessions.set(chatId, s);
        return sendTracked(
          chatId,
          "📱 Send your phone number:\n• 07XXXXXXXX\n• 01XXXXXXXX\n• 2547XXXXXXXX\n• 2541XXXXXXXX",
          confirmKeyboard(false)
        );
      }

      // Pick one of the masked numbers (label -> phone map)
      if (s.fpPhoneMap && s.fpPhoneMap[text]) {
        const pkg = findPackageByLabel(s.category, s.pkgKey);
        if (!pkg) {
          s.step = "package";
          sessions.set(chatId, s);
          return sendTracked(chatId, "Tap a package button:", packagesKeyboard(s.category));
        }
        const phone254 = s.fpPhoneMap[text];
        // Clear session so user is not stuck on this screen
        sessions.delete(chatId);
        try { await bot.sendMessage(chatId, `📲 Sending STK push… (${maskPhone(phone254)})`); } catch (_) {}
        try { await initiatePurchaseStk(chatId, { ...s }, pkg, phone254); } catch (e) {
          return sendTracked(chatId, `❌ Failed to send STK. Try again.\n\nHelp: ${HELP_PHONE}`, { ...mainMenuKeyboard(chatId) });
        }
        return;
      }

      // If user typed a number directly while on this screen
      if (/^(?:0?7\d{8}|0?1\d{8}|2547\d{8}|2541\d{8})$/.test(text.replace(/\s+/g,""))) {
        const pkg = findPackageByLabel(s.category, s.pkgKey);
        if (!pkg) {
          s.step = "package";
          sessions.set(chatId, s);
          return sendTracked(chatId, "Tap a package button:", packagesKeyboard(s.category));
        }
        sessions.delete(chatId);
        return initiatePurchaseStk(chatId, { ...s }, pkg, normalizePhone(text));
      }

      // Otherwise ignore and re-show picker
      return sendTracked(chatId, "Choose a number below or tap ➕ New Number:", fastPurchasePhoneKeyboard(chatId, s, 10));
    }

    // STEP 1: CATEGORY
    if (s.step === "category") {
      const category = categoryNameFromButton(text);
      if (!category) return sendTracked(chatId, "Tap a category button:", categoriesKeyboard(chatId));
      if (!PACKAGES[category]) return sendTracked(chatId, "Tap a category button:", categoriesKeyboard(chatId));

      pushPrev(chatId, s);
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

  pushPrev(chatId, s);
  s.pkgKey = pkg.label;
  if (isFastPurchaseEnabled(chatId)) {
  s.step = "fast_phone_pick";
} else {
  s.step = "confirm";
}
  sessions.set(chatId, s);
sessions.set(chatId, s);

  // ⚡ Fast Purchase flow (Business): choose number then send STK immediately (no confirm screen)
  if (s.step === "fast_phone_pick") {
    const msg = `⚡ *Fast Purchase ON*

Offer: *${pkg.label}*

Choose a number below or tap ➕ New Number:`;
    return sendTracked(chatId, msg, { parse_mode: "Markdown", ...fastPurchasePhoneKeyboard(chatId, s, 10) });
  }


  const savedPhone = getUserPhone(chatId);
  const hasSaved = !!savedPhone;

  const msgText =
    `✅ Selected:\n*${pkg.label}*\n\n` +
    (hasSaved 
      ? `📱 Saved number: *${maskPhone(savedPhone)}*\n\n` 
      : `📱 Paste new number.\n\n`) +
    `Choose:
• ✅ Proceed (use saved number)
• 📞 Change Number`;

  return sendTracked(chatId, msgText, { 
    parse_mode: "Markdown", 
    ...confirmKeyboardV2(chatId, s, hasSaved) 
  });
}  // ✅ THIS WAS MISSING
    // STEP 3: CONFIRM
    if (s.step === "confirm") {
      const pkg = findPackageByLabel(s.category, s.pkgKey);
      if (!pkg) {
        sessions.delete(chatId);
        return sendTracked(chatId, "❌ Package missing. Tap 🛒 Buy Offers again.", { ...mainMenuKeyboard(chatId) });
      }

      if (isBtn(text, "📞 Change Number", "📞 Badilisha Nambari")) {
        pushPrev(chatId, s);
        s.step = "phone";
        sessions.set(chatId, s);
        return sendTracked(
          chatId,
          "📱 Send your phone number:\n• 07XXXXXXXX\n• 01XXXXXXXX\n• 2547XXXXXXXX\n• 2541XXXXXXXX",
          confirmKeyboard(false)
        );
      }


// ⚡ Fast Purchase: allow selecting a recent number directly on the confirm screen
if (s.step === "confirm" && isFastPurchaseEnabled(chatId) && s.fpPhoneMap && s.fpPhoneMap[text]) {
  const picked = s.fpPhoneMap[text];
  if (picked) {
    setUserPhone(chatId, picked);
    const pkg2 = findPackageByLabel(s.category, s.pkgKey);
    const savedPhone2 = getUserPhone(chatId);
    const hasSaved2 = !!savedPhone2;

    const msgText2 =
      `✅ Selected:\n*${pkg2 ? pkg2.label : s.pkgKey}*\n\n` +
      (hasSaved2 ? `📱 Saved number: *${maskPhone(savedPhone2)}*\n\n` : `📱 Paste number.\n\n`) +
      `Choose a number below or tap ➕ Add Number.\n\n` +
      `Choose:
• ✅ Proceed (use saved number)
• 📞 Change Number`;

    return sendTracked(chatId, msgText2, { parse_mode: "Markdown", ...confirmKeyboardV2(chatId, s, hasSaved2) });
  }
}

// ⚡ Fast Purchase: Add Number from confirm screen (same as Change Number flow)
if (s.step === "confirm" && isFastPurchaseEnabled(chatId) && (text === "➕ Add Number" || text === "➕ New Number" || text === "+ New Number")) {
  pushPrev(chatId, s);
  s.step = "phone";
  sessions.set(chatId, s);
  return sendTracked(
    chatId,
    "📱 Send your phone number:\n• 07XXXXXXXX\n• 01XXXXXXXX\n• 2547XXXXXXXX\n• 2541XXXXXXXX",
    confirmKeyboardV2(chatId, s, false)
  );
}
      if (isBtn(text, "✅ Proceed", "✅ Endelea")) {
        return proceedPurchase(chatId, s);
      }


      // accept phone typed here
      const phoneMaybe = normalizePhone(text);
      if (phoneMaybe) {
        setUserPhone(chatId, phoneMaybe);

        // ✅ Bingwa once per day per phone (hard block ONLY when entering phone)
if (!isAdmin(chatId) && s.category === "Bingwa Deals" && bingwaAlreadyPurchasedToday(phoneMaybe)) {
  sessions.delete(chatId);
  return sendTracked(
    chatId,
    `🚫 *Bingwa Deals limit reached*\nNumber: *${maskPhone(phoneMaybe)}*\nThis number already bought Bingwa today.\n\nUse a different number or try again tomorrow.`,
    { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
  );
}

await sendTracked(
  chatId,
  `✅ Saved number: ${maskPhone(phoneMaybe)}\nNow tap ✅ Proceed.`,
  {
    ...confirmKeyboard(true),
  }
);
return;
}

return sendTracked(
  chatId,
  "Choose ✅ Proceed or 📞 Change Number.",
  confirmKeyboard(!!getUserPhone(chatId))
);
}

// STEP 4A: RECEIVING PHONE INPUT
if (s.step === "receiving_phone") {
  // Allow Proceed after the receiving number has already been saved.
  if (isBtn(text, "✅ Proceed", "✅ Endelea")) {
    if (!s.receivingPhone254) {
      return sendTracked(
        chatId,
        "❌ Enter receiving number first.\nUse: 07XXXXXXXX / 01XXXXXXXX / 2547XXXXXXXX / 2541XXXXXXXX",
        confirmKeyboard(!!getUserPhone(chatId))
      );
    }
    s.step = "confirm";
    sessions.set(chatId, s);
    return proceedPurchase(chatId, s);
  }

  if (isBtn(text, "📞 Change Number", "📞 Badilisha Nambari")) {
    pushPrev(chatId, s);
    s.step = "phone";
    sessions.set(chatId, s);
    return sendTracked(
      chatId,
      "📱 Send your phone number:\n• 07XXXXXXXX\n• 01XXXXXXXX\n• 2547XXXXXXXX\n• 2541XXXXXXXX",
      confirmKeyboard(false)
    );
  }

  const receivingPhone = normalizePhone(text);
  if (!receivingPhone) {
    return sendTracked(
      chatId,
      "❌ Invalid receiving number.\nUse: 07XXXXXXXX / 01XXXXXXXX / 2547XXXXXXXX / 2541XXXXXXXX",
      confirmKeyboard(!!getUserPhone(chatId))
    );
  }

  s.receivingPhone254 = receivingPhone;
  // Move back to confirm so Proceed works normally after saving the receiving number.
  s.step = "confirm";
  sessions.set(chatId, s);

  return sendTracked(
    chatId,
    `✅ Receiving number saved: *${maskPhone(receivingPhone)}*

Now tap ✅ Proceed to send STK to *${maskPhone(getUserPhone(chatId) || "")}*`,
    { parse_mode: "Markdown", ...confirmKeyboard(!!getUserPhone(chatId)) }
  );
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
  if (!isAdmin(chatId) && s.category === "Bingwa Deals" && bingwaAlreadyPurchasedToday(phone)) {
    sessions.delete(chatId);
    return sendTracked(
      chatId,
      `🚫 *Bingwa Deals limit reached*\nNumber: *${maskPhone(phone)}*\nThis number already bought Bingwa today.\n\nUse a different number or try again tomorrow.`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
    );
  }

  pushPrev(chatId, s);
  s.step = "confirm";
  sessions.set(chatId, s);

  const pkg = findPackageByLabel(s.category, s.pkgKey);
  if (!pkg) {
    sessions.delete(chatId);
    return sendTracked(
      chatId,
      "❌ Package missing. Tap 🛒 Buy Offers again.",
      { ...mainMenuKeyboard(chatId) }
    );
  }

  return sendTracked(
    chatId,
    `✅ Number saved: *${maskPhone(phone)}*\n\nSelected: *${pkg.label}*\n\nTap ✅ Proceed to send STK.`,
    {
      parse_mode: "Markdown",
      ...confirmKeyboard(true),
    }
  );
}

} catch (err) {
  sessions.delete(chatId);
  return sendTracked(
    chatId,
    `⚠️ Error: ${err.message}\n\nHelp: ${HELP_PHONE}`,
    { ...mainMenuKeyboard(chatId) }
  );
}
});

// ===================== STARTUP LOG =====================

// ===================== AUTO DELETE SYSTEM =====================


// ===================== PERIODIC TASKS =====================
// ✅ Weekly Leaderboard (every Monday) + Inactivity Nudge (3+ days)
setInterval(async () => {
  try {
    db = repairDB(db);
    const now = new Date();
    const dayKey = todayKey();
    const weekKey = isoWeekKey(now);

    // Weekly leaderboard broadcast on Monday (Kenya time). Send once per week.
    // Monday = 1 (in Kenya, using local Date is fine because server should run in UTC but dayKey uses Kenya timezone)
    const isMonday = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Nairobi", weekday: "short" }).format(now).toLowerCase().startsWith("mon");
    if (isMonday && db.stats.lastLeaderboardWeek !== weekKey) {
      const text = buildReferralLeaderboardText(5);
      const userIds = getAllUserIds();
      for (const uid of userIds) {
        // eslint-disable-next-line no-await-in-loop
        await bot.sendMessage(uid, text, { parse_mode: "Markdown", ...mainMenuKeyboard(uid) }).catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        await sleep(35);
      }
      db.stats.lastLeaderboardWeek = weekKey;
      saveDB();
    }

    // Inactivity nudge: if user has not been seen for 3+ days, send once per day.
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    for (const [cid, u] of Object.entries(db.users || {})) {
      if (String(cid) === String(ADMIN_ID)) continue;
      const lastSeen = Number(u.lastSeen || 0);
      if (!lastSeen) continue;
      if (Date.now() - lastSeen < threeDaysMs) continue;
      if (String(u.lastNudgeDay || "") === String(dayKey)) continue;

      u.lastNudgeDay = dayKey;
      saveDB();

      // eslint-disable-next-line no-await-in-loop
      await bot.sendMessage(
        Number(cid),
        tr(
          Number(cid),
          `👋 We miss you!\n\nCome back today and grab your best offer.\n\n🎁 Tip: Share your referral link to earn points on every successful purchase!`,
          `👋 Tumekukosa!\n\nRudi leo uchukue ofa yako bora.\n\n🎁 Kidokezo: Shiriki link yako ya rufaa upate pointi kwa kila ununuzi uliokamilika!`
        ),
        { ...mainMenuKeyboard(Number(cid)) }
      ).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await sleep(35);
    }
  } catch (e) {
    // silent
  }
}, 60 * 60 * 1000); // hourly

console.log("✅ Bingwa Mtaani PayHero STK bot running");



// ===============================================================
// 🔥 ENHANCED LEDGER + NET REVENUE ANALYTICS EXTENSION
// (Non-breaking patch – safely extends existing logic)
// ===============================================================

// --- Ensure analytics container exists ---
if (!db.analytics || typeof db.analytics !== "object") {
  db.analytics = {};
  saveDB();
}

// --- Ensure analytics.withdrawalsByDay exists ---
if (!db.analytics.withdrawalsByDay || typeof db.analytics.withdrawalsByDay !== "object") {
  db.analytics.withdrawalsByDay = {};
  saveDB();
}

// --- Simple Ledger (append-only, pruned automatically) ---
if (!Array.isArray(db.ledger)) {
  db.ledger = [];
  saveDB();
}

function addLedgerEvent(evt) {
  db = repairDB(db);
  db.ledger.push({
    ts: Date.now(),
    ...evt
  });

  // keep last 20k events
  if (db.ledger.length > 20000) {
    db.ledger = db.ledger.slice(-20000);
  }

  saveDB();
}

// --- Track withdrawals by day ---
function bumpWithdrawalsByDay(dayKey, kshAmount) {
  db.analytics.withdrawalsByDay[dayKey] =
    db.analytics.withdrawalsByDay[dayKey] || { count: 0, ksh: 0 };

  db.analytics.withdrawalsByDay[dayKey].count += 1;
  db.analytics.withdrawalsByDay[dayKey].ksh += Number(kshAmount || 0);

  saveDB();
}

// --- Wrap existing revenue success tracking ---
const __originalRecordSuccessfulRevenue = recordSuccessfulRevenue;
recordSuccessfulRevenue = function (pending) {
  if (pending) {
    addLedgerEvent({
      type: "ORDER_SUCCESS",
      chatId: String(pending.chatId || ""),
      ref: String(pending.pkgLabel || ""),
      amountKsh: Number(pending.price || 0),
      category: pending.category,
      pkg: pending.pkgLabel
    });
  }
  __originalRecordSuccessfulRevenue(pending);
};

// --- Wrap addPoints & deductPoints for ledger logging ---
const __originalAddPoints = addPoints;
addPoints = function (chatId, pts) {
  addLedgerEvent({
    type: "POINTS_ADD",
    chatId: String(chatId),
    points: Number(pts || 0)
  });

  // Track user earnings by day for /profile
  try {
    const u = getUser(chatId);
    ensureTxLog(u);
    const day = kenyaDayKeyOffset(0);
    const p = Number(pts || 0);
    u.pointsEarnedTotal = Number(u.pointsEarnedTotal || 0) + p;
    u.pointsEarnedByDay[day] = Number(u.pointsEarnedByDay[day] || 0) + p;
    saveDB();
  } catch (_) {}

  __originalAddPoints(chatId, pts);
};

const __originalDeductPoints = deductPoints;
deductPoints = function (chatId, pts) {
  addLedgerEvent({
    type: "POINTS_DEDUCT",
    chatId: String(chatId),
    points: Number(pts || 0)
  });
  __originalDeductPoints(chatId, pts);
};

// --- Track withdrawal approvals in ledger ---
function trackWithdrawalApproval(req) {
  if (!req) return;

  const day = todayKey();
  const kshAmount = Number(pointsToKes(req.amount || 0));

  bumpWithdrawalsByDay(day, kshAmount);

  addLedgerEvent({
    type: "WITHDRAW_APPROVED",
    chatId: String(req.chatId),
    amountPts: Number(req.amount || 0),
    amountKsh: kshAmount,
    phone: req.phone
  });
}

// Hook into /ac command by wrapping bot.on message handler
bot.on("message", async (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  const text = (msg.text || "").trim();

  const acMatch = text.match(/^\/ac\s+(\d+)$/i);
  if (!acMatch) return;

  const targetId = acMatch[1];
  db = repairDB(db);
  const req = db.pendingRedeems?.[String(targetId)];

  if (req && req.status === "approved") {
    trackWithdrawalApproval(req);
  }
});

// --- NET REVENUE COMMAND ---
bot.on("message", async (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  const text = (msg.text || "").trim();

  const netMatch = text.match(/^\/net(?:\s+(\d+))?$/i);
  if (!netMatch) return;

  const days = Math.max(0, Math.min(90, Number(netMatch[1] || 7)));
  const revenue = sumDaysRevenue(days);

  let withdrawalsKsh = 0;
  let withdrawalCount = 0;

  for (let i = 0; i <= days; i++) {
    const day = kenyaDayKeyOffset(i);
    const w = db.analytics.withdrawalsByDay?.[day];
    if (w) {
      withdrawalsKsh += Number(w.ksh || 0);
      withdrawalCount += Number(w.count || 0);
    }
  }

  const net = Number(revenue.revenueKsh || 0) - withdrawalsKsh;

  await bot.sendMessage(
    msg.chat.id,
    `📈 Net Summary (Last ${days} day(s))\n\n` +
    `Gross Revenue: Ksh ${revenue.revenueKsh}\n` +
    `Orders: ${revenue.orders}\n` +
    `Withdrawals: Ksh ${withdrawalsKsh} (${withdrawalCount})\n` +
    `Net: Ksh ${net}`
  );
});

console.log("🔥 Enhanced withdrawal & revenue tracking loaded");




// ===============================================================
// 💎 INTEGER-SAFE CENTI-POINTS UPGRADE (NO FLOAT DRIFT)
// ===============================================================

// All points are now stored internally as integer centi-points.
// 1.00 pt = 100 internal units.

// --- Migration: convert old float points to centi-points ---
(function migratePointsToCenti() {
  db = repairDB(db);
  let migrated = 0;

  for (const [cid, u] of Object.entries(db.users || {})) {
    if (typeof u.pointsC !== "number") {
      const oldPts = Number(u.points || 0);
      u.pointsC = Math.round(oldPts * 100);
      delete u.points; // remove float storage
      migrated++;
    }
  }

  if (migrated > 0) {
    console.log("✅ Migrated users to centi-points:", migrated);
    saveDB();
  }
})();

// --- Helpers ---
function ptsToInternal(pts) {
  return Math.round(Number(pts || 0) * 100);
}

function internalToPts(val) {
  return Number(val || 0) / 100;
}

// --- Override addPoints ---
const __addPointsFloat = addPoints;
addPoints = function (chatId, pts) {
  const u = getUser(chatId);
  u.pointsC = Number(u.pointsC || 0) + ptsToInternal(pts);
  saveDB();

  addLedgerEvent({
    type: "POINTS_ADD",
    chatId: String(chatId),
    pointsC: ptsToInternal(pts)
  });
};

// --- Override deductPoints ---
const __deductPointsFloat = deductPoints;
deductPoints = function (chatId, pts) {
  const u = getUser(chatId);
  u.pointsC = Number(u.pointsC || 0) - ptsToInternal(pts);
  if (u.pointsC < 0) u.pointsC = 0;
  saveDB();

  addLedgerEvent({
    type: "POINTS_DEDUCT",
    chatId: String(chatId),
    pointsC: ptsToInternal(pts)
  });
};

// --- Override getPoints ---
getPoints = function (chatId) {
  const u = getUser(chatId);
  return internalToPts(u.pointsC || 0);
};

console.log("💎 Centi-points system active (integer-safe mode)");




// ===============================================================
// 📊 REAL PROFIT MARGIN ANALYTICS
// ===============================================================

// You can configure your estimated cost per category here.
// These represent your TRUE backend cost per order in KSH.
const COST_CONFIG = {
  "Bingwa Deals": 0.88,      // 88% cost → 12% margin
  "Unlimited Deals": 0.90,
  "SMS Offers": 0.85,
  "Minutes": 0.87,
  "Bonga Points": 0.92,
  "Flex Deals": 0.89
};

function calculateProfitMetrics(days) {
  const revenue = sumDaysRevenue(days);
  let totalCost = 0;

  for (let i = 0; i <= days; i++) {
    const day = kenyaDayKeyOffset(i);
    const byCat = db.analytics?.revenueByCategoryDay?.[day] || {};
    
    for (const [cat, data] of Object.entries(byCat)) {
      const costRate = COST_CONFIG[cat] || 0.9;
      totalCost += Number(data.revenueKsh || 0) * costRate;
    }
  }

  const grossRevenue = Number(revenue.revenueKsh || 0);
  const grossProfit = grossRevenue - totalCost;
  const marginPercent = grossRevenue > 0 
      ? ((grossProfit / grossRevenue) * 100) 
      : 0;

  return {
    grossRevenue,
    totalCost,
    grossProfit,
    marginPercent: Math.round(marginPercent * 100) / 100
  };
}

// ===================== ADMIN COMMAND: /profit =====================
bot.on("message", async (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  const text = (msg.text || "").trim();

  const match = text.match(/^\/profit(?:\s+(\d+))?$/i);
  if (!match) return;

  const days = Math.max(0, Math.min(90, Number(match[1] || 7)));
  const metrics = calculateProfitMetrics(days);

  await bot.sendMessage(
    msg.chat.id,
    `📊 Profit Analytics (Last ${days} day(s))\n\n` +
    `Gross Revenue: Ksh ${metrics.grossRevenue.toFixed(2)}\n` +
    `Estimated Cost: Ksh ${metrics.totalCost.toFixed(2)}\n` +
    `Gross Profit: Ksh ${metrics.grossProfit.toFixed(2)}\n` +
    `Profit Margin: ${metrics.marginPercent}%`
  );
});

console.log("📊 Profit margin analytics enabled");




// ===============================================================
// 🚩 PERMANENT SINGLE ACCOUNT PER PHONE LOCK
// ===============================================================

// Each phone number can only be used by ONE Telegram account until admin approves override.
// If another account attempts to use it, admin approval is required.

if (!db.phoneAccountUsage || typeof db.phoneAccountUsage !== "object") {
  db.phoneAccountUsage = {};
  saveDB();
}

if (!db.pendingPhoneOverrides || typeof db.pendingPhoneOverrides !== "object") {
  db.pendingPhoneOverrides = {};
  saveDB();
}

if (!db.phoneOverrideApprovals || typeof db.phoneOverrideApprovals !== "object") {
  db.phoneOverrideApprovals = {};
  saveDB();
}

const PHONE_LOCK_WINDOW_MS = Infinity; // kept for compatibility (lock is permanent until admin override)

function canUsePhone(chatId, phone254) {
  // ✅ Allow admin and business users to reuse phone without lock
  try {
    if (typeof isAdmin === "function" && isAdmin(chatId)) return { ok: true };
    if (typeof isBusinessActive === "function" && isBusinessActive(chatId)) return { ok: true };
  } catch (_) {}

  const rec = db.phoneAccountUsage[phone254];
  if (!rec) return { ok: true };

  const sameUser = String(rec.chatId) === String(chatId);
  if (sameUser) return { ok: true };

  const approvedChatId = String(db.phoneOverrideApprovals?.[phone254] || "");
  if (approvedChatId && approvedChatId === String(chatId)) return { ok: true, overrideApproved: true };

  // 🔒 Permanent lock: requires admin approval to switch the lock owner
  return { ok: false, lockedBy: rec.chatId };
}

function markPhoneUsage(chatId, phone254) {
  db.phoneAccountUsage[phone254] = {
    chatId: String(chatId),
    lastUsed: Date.now()
  };
  try {
    if (db.phoneOverrideApprovals && db.phoneOverrideApprovals[phone254]) {
      delete db.phoneOverrideApprovals[phone254];
    }
  } catch (_) {}
  saveDB();
}

// Wrap existing phone usage marking inside successful STK send
const __originalMarkBingwaPurchasedToday = markBingwaPurchasedToday;
markBingwaPurchasedToday = function (phone254) {
  const result = __originalMarkBingwaPurchasedToday(phone254);
  return result;
};

// Hook into STK send process by wrapping payheroStkPush call indirectly via usage mark
const __originalPayheroStkPush = payheroStkPush;
payheroStkPush = async function (payload) {
  const phone = payload.phone;
  const chatId = payload.externalRef?.split("-").pop();

  const check = canUsePhone(chatId, phone);

  if (!check.ok) {
    const overrideId = `PH-${Date.now()}-${chatId}`;

    db.pendingPhoneOverrides[overrideId] = {
      phone,
      requestingChatId: chatId,
      lockedBy: check.lockedBy,
      status: "pending",
      time: kenyaDateTime()
    };
    saveDB();

    await bot.sendMessage(
      ADMIN_ID,
      `🚩 Phone Reuse Alert

Phone: ${formatTo07(phone)}
Requested By: ${chatId}
Currently Locked By: ${check.lockedBy}

Approve override?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Approve", callback_data: `phone_approve:${overrideId}` }],
            [{ text: "❌ Decline", callback_data: `phone_decline:${overrideId}` }]
          ]
        }
      }
    );

    const maskedPhone = mask07(formatTo07(phone));
    throw new Error(tr(chatId, `⚠️ This phone number ${maskedPhone} is locked to another account. An approval request has been sent to admin.`, `⚠️ Namba hii ${maskedPhone} imefungwa kwenye akaunti nyingine. Ombi la idhini limetumwa kwa admin.`));
  }

  return __originalPayheroStkPush(payload);
};

// Handle admin approval callbacks
bot.on("callback_query", async (q) => {
  const data = String(q.data || "");
  if (!isAdmin(q.message?.chat?.id)) return;

  if (!data.startsWith("phone_")) return;

  const [action, overrideId] = data.split(":");
  const req = db.pendingPhoneOverrides[overrideId];
  if (!req) return;

  if (action === "phone_approve") {
    req.status = "approved";

    // ✅ Do NOT lock immediately on admin approval.
    // Approval only allows the next purchase attempt.
    // The phone lock is transferred ONLY after successful payment callback.
    db.phoneOverrideApprovals[req.phone] = String(req.requestingChatId);
    saveDB();

    await bot.sendMessage(
      Number(req.requestingChatId),
      tr(req.requestingChatId, `✅ Admin approved phone usage override. You may proceed.`, `✅ Admin ameidhinisha matumizi ya namba hii. Unaweza kuendelea.`),
      { reply_markup: { remove_keyboard: true } }
    ).catch(() => {});

    await bot.sendMessage(q.message.chat.id, "✅ Phone override approved.").catch(() => {});
  }

  if (action === "phone_decline") {
    req.status = "declined";
    try { if (db.phoneOverrideApprovals && db.phoneOverrideApprovals[req.phone]) delete db.phoneOverrideApprovals[req.phone]; } catch (_) {}

    const maskedPhone = mask07(formatTo07(req.phone));
    await bot.sendMessage(
      Number(req.requestingChatId),
      tr(req.requestingChatId, `❌ Phone usage denied. This number ${maskedPhone} is locked to another account.`, `❌ Matumizi ya namba yamekataliwa. Namba hii ${maskedPhone} imefungwa kwenye akaunti nyingine.`)
    ).catch(() => {});

    await bot.sendMessage(q.message.chat.id, "❌ Phone override declined.").catch(() => {});
  }

  saveDB();

  // remove buttons + delete admin request message
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
  await bot.deleteMessage(q.message.chat.id, q.message.message_id).catch(() => {});
  await bot.answerCallbackQuery(q.id).catch(() => {});
});

console.log("🚩 Permanent phone lock system enabled");




// ===============================================================
// 🚨 ADVANCED RISK PROTECTION LAYER
// - 7 override attempts → 1 day withdrawal cooldown
// - Dynamic risk score per account
// ===============================================================

if (!db.riskProfiles || typeof db.riskProfiles !== "object") {
  db.riskProfiles = {};
}

const WITHDRAW_LOCK_24H_MS = 24 * 60 * 60 * 1000;
const MAX_OVERRIDE_ATTEMPTS = 7;

function getRiskProfile(chatId) {
  db.riskProfiles[chatId] = db.riskProfiles[chatId] || {
    overrideAttempts: 0,
    withdrawalLockUntil: 0,
    riskScore: 0
  };
  return db.riskProfiles[chatId];
}

function increaseRisk(chatId, points) {
  const profile = getRiskProfile(chatId);
  profile.riskScore += Number(points || 0);
  saveDB();
}

function registerOverrideAttempt(chatId) {
  const profile = getRiskProfile(chatId);
  profile.overrideAttempts += 1;
  increaseRisk(chatId, 5);

  if (profile.overrideAttempts >= MAX_OVERRIDE_ATTEMPTS) {
    profile.withdrawalLockUntil = Date.now() + WITHDRAW_LOCK_24H_MS;
    increaseRisk(chatId, 20);
  }

  saveDB();
}

function isWithdrawalLocked(chatId) {
  const profile = getRiskProfile(chatId);
  return Date.now() < Number(profile.withdrawalLockUntil || 0);
}

// Hook override detection
const __originalCanUsePhone = canUsePhone;
canUsePhone = function(chatId, phone254) {
  const result = __originalCanUsePhone(chatId, phone254);

  if (!result.ok) {
    registerOverrideAttempt(chatId);
  }

  return result;
};

// Hook withdrawal process
const __originalWithdrawHandler = bot.listeners("message").slice();

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // 🔒 Auto-hide buttons: ignore manual withdrawal option texts while hidden
  try { if (!isAdmin(chatId) && isAutoHideButtonsEnabled(chatId)) return; } catch (_) {}

  // 🔒 Auto-hide buttons: ignore manual withdrawal option texts while hidden
  try { if (!isAdmin(chatId) && isAutoHideButtonsEnabled(chatId)) return; } catch (_) {}

  if (!["25 pts","50 pts","100 pts","250 pts","500 pts","1000 pts","2000 pts"].includes(text)) return;

  if (isWithdrawalLocked(chatId)) {
    const profile = getRiskProfile(chatId);
    const hoursLeft = Math.ceil((profile.withdrawalLockUntil - Date.now()) / (1000*60*60));

    await bot.sendMessage(
      chatId,
      `🚫 Withdrawal temporarily locked due to suspicious activity.

Time remaining: ${hoursLeft} hour(s).
Risk Score: ${profile.riskScore}`
    );
    return;
  }
});

// ===================== ADMIN RISK COMMAND =====================
bot.on("message", async (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  const text = (msg.text || "").trim();

  const match = text.match(/^\/risk\s+(\d+)$/i);
  if (!match) return;

  const targetId = match[1];
  const profile = getRiskProfile(targetId);

  await bot.sendMessage(
    msg.chat.id,
    `🚨 Risk Profile for ${targetId}

Override Attempts: ${profile.overrideAttempts}
Risk Score: ${profile.riskScore}
Withdrawal Locked: ${Date.now() < profile.withdrawalLockUntil ? "YES" : "NO"}`
  );
});

console.log("🚨 Advanced risk protection enabled");




// ===============================================================
// 🚨 AUTO ADMIN ALERT + 72HR WITHDRAW BLOCK (RISK > 70)
// ===============================================================

const RISK_ALERT_THRESHOLD = 70;
const TEMP_BLOCK_72H_MS = 72 * 60 * 60 * 1000;

function checkAndApplyRiskBlock(chatId) {
  const profile = getRiskProfile(chatId);

  if (profile.riskScore > RISK_ALERT_THRESHOLD) {

    // Apply 72hr temporary withdraw block
    profile.withdrawalLockUntil = Date.now() + TEMP_BLOCK_72H_MS;
    saveDB();

    // Notify admin once per escalation
    bot.sendMessage(
      ADMIN_ID,
      `🚨 HIGH RISK ALERT

User: ${chatId}
Risk Score: ${profile.riskScore}

User has been temporarily blocked from withdrawals for 72 hours.`
    ).catch(()=>{});
  }
}

// Enhance increaseRisk to auto-check threshold
const __originalIncreaseRisk = increaseRisk;
increaseRisk = function(chatId, points) {
  __originalIncreaseRisk(chatId, points);
  checkAndApplyRiskBlock(chatId);
};

// ===================== ADMIN BLOCK / UNBLOCK =====================

bot.on("message", async (msg) => {
  if (!isAdmin(msg.chat.id)) return;

  const text = (msg.text || "").trim();

  // Manual block
  const blockMatch = text.match(/^\/block\s+(\d+)$/i);
  if (blockMatch) {
    const targetId = blockMatch[1];
    const profile = getRiskProfile(targetId);

    profile.withdrawalLockUntil = Date.now() + TEMP_BLOCK_72H_MS;
    saveDB();

    await bot.sendMessage(msg.chat.id, `⛔ User ${targetId} blocked for 72 hours.`);
    return;
  }

  // Manual unblock
  const unblockMatch = text.match(/^\/unblock\s+(\d+)$/i);
  if (unblockMatch) {
    const targetId = unblockMatch[1];
    const profile = getRiskProfile(targetId);

    profile.withdrawalLockUntil = 0;
    saveDB();

    await bot.sendMessage(msg.chat.id, `✅ User ${targetId} unblocked.`);
    return;
  }
});

console.log("🚨 Auto risk alert + 72hr block system enabled");




// ===============================================================
// 🧠 ADVANCED RISK DECAY + STK FAILURE RISK + REFERRAL PROTECTION
// ===============================================================

if (!db.phoneReferralLock || typeof db.phoneReferralLock !== "object") {
  db.phoneReferralLock = {};
  saveDB();
}

// ---------- 1️⃣ RISK DECAY AFTER SUCCESSFUL PURCHASE ----------
// Risk reduces slowly after successful payments (anti-permanent penalty)

function reduceRiskAfterSuccess(chatId) {
  const profile = getRiskProfile(chatId);
  if (!profile) return;

  // Reduce 3 risk points per successful purchase
  profile.riskScore = Math.max(0, profile.riskScore - 3);

  // Slowly reduce override attempts
  if (profile.overrideAttempts > 0) {
    profile.overrideAttempts -= 1;
  }

  saveDB();
}

// Hook into successful revenue recording
const __originalRecordRevenueRiskHook = recordSuccessfulRevenue;
recordSuccessfulRevenue = function(pending) {
  if (pending && pending.chatId) {
    reduceRiskAfterSuccess(pending.chatId);
  }
  __originalRecordRevenueRiskHook(pending);
};


// ---------- 2️⃣ STK FAILURE INCREASES RISK ----------

function increaseRiskOnStkFailure(chatId) {
  const profile = getRiskProfile(chatId);
  profile.riskScore += 4;  // +4 per failed STK
  saveDB();
}

// Hook into failure branch via ledger failure event
const __originalAddLedgerEventRisk = addLedgerEvent;
addLedgerEvent = function(evt) {
  if (evt && evt.type === "ORDER_FAILED" && evt.chatId) {
    increaseRiskOnStkFailure(evt.chatId);
  }
  __originalAddLedgerEventRisk(evt);
};

// ✅ Leaderboard tracking: count successful referral rewards per Kenya day
const __originalAddLedgerEventLeaderboard = addLedgerEvent;
addLedgerEvent = function(evt) {
  try {
    if (evt && evt.type === "REFERRAL_REWARD" && evt.chatId) {
      db = repairDB(db);
      const day = todayKey();
      db.referralsByDay = db.referralsByDay || {};
      db.referralsByDay[day] = db.referralsByDay[day] || {};
      const key = String(evt.chatId);
      db.referralsByDay[day][key] = Number(db.referralsByDay[day][key] || 0) + 1;
      saveDB();
    }
  } catch (_) {}
  __originalAddLedgerEventLeaderboard(evt);
};


// ---------- 3️⃣ 24HR REFERRAL REWARD LOCK PER PHONE ----------
// If phone used on Account A today, Account B cannot generate referral reward using same phone

const REFERRAL_PHONE_LOCK_MS = 24 * 60 * 60 * 1000;

function canRewardReferral(phone254, buyerChatId) {
  const rec = db.phoneReferralLock[phone254];
  if (!rec) return true;

  const sameUser = String(rec.chatId) === String(buyerChatId);
  const within24h = Date.now() - rec.ts < REFERRAL_PHONE_LOCK_MS;

  if (!within24h) return true;
  if (sameUser) return true;

  return false;
}

function markReferralPhone(phone254, buyerChatId) {
  db.phoneReferralLock[phone254] = {
    chatId: String(buyerChatId),
    ts: Date.now()
  };
  saveDB();
}

// Hook referral reward logic
const __originalReferralReward = maybeRewardInviterOnSuccessPurchase;
maybeRewardInviterOnSuccessPurchase = function(buyerChatId, amountKsh, when) {

  const buyer = getUser(buyerChatId);
  const phone = buyer.phone;

  if (!phone) {
    return __originalReferralReward(buyerChatId, amountKsh, when);
  }

  if (!canRewardReferral(phone, buyerChatId)) {
    // Block referral reward if same phone used on different account within 24h
    return;
  }

  markReferralPhone(phone, buyerChatId);
  __originalReferralReward(buyerChatId, amountKsh, when);
};

console.log("🧠 Advanced risk decay + STK failure risk + referral phone protection enabled");




// ===============================================================
// 🔒 REFERRAL REWARD ONLY FOR FIRST ACCOUNT PER PHONE (LIFETIME)
// - Phone can be used by multiple accounts
// - Referral reward only allowed for FIRST account that used the phone
// ===============================================================

if (!db.phoneFirstAccount || typeof db.phoneFirstAccount !== "object") {
  db.phoneFirstAccount = {};
  saveDB();
}

// When a user saves or uses a phone, register first owner if not already set
function registerFirstAccountForPhone(phone254, chatId) {
  if (!phone254) return;

  if (!db.phoneFirstAccount[phone254]) {
    db.phoneFirstAccount[phone254] = {
      firstChatId: String(chatId),
      ts: Date.now()
    };
    saveDB();
  }
}

// Hook into phone usage (after normalization & saving)
const __originalSetUserPhone = setUserPhone;
setUserPhone = function(chatId, phone254) {
  __originalSetUserPhone(chatId, phone254);
  registerFirstAccountForPhone(phone254, chatId);
};

// Override referral reward logic
const __originalReferralRewardFirstOnly = maybeRewardInviterOnSuccessPurchase;
maybeRewardInviterOnSuccessPurchase = function(buyerChatId, amountKsh, when) {

  const buyer = getUser(buyerChatId);
  const phone = buyer.phone;

  if (!phone) {
    return __originalReferralRewardFirstOnly(buyerChatId, amountKsh, when);
  }

  const firstOwner = db.phoneFirstAccount[phone];

  // If this buyer is NOT the first account that used this phone → no referral reward
  if (firstOwner && String(firstOwner.firstChatId) !== String(buyerChatId)) {
    return; // block referral reward
  }

  __originalReferralRewardFirstOnly(buyerChatId, amountKsh, when);
};

console.log("🔒 Referral rewards now restricted to FIRST account per phone (lifetime).");




// ===============================================================
// 🔄 REFERRAL REWARD: FIRST ACCOUNT PER PHONE PER DAY ONLY
// - Phone can be used by multiple accounts
// - Referral reward only for FIRST account that used that phone TODAY
// - Resets automatically next day
// ===============================================================

if (!db.phoneDailyFirstAccount || typeof db.phoneDailyFirstAccount !== "object") {
  db.phoneDailyFirstAccount = {};
  saveDB();
}

function getTodayKeySafe() {
  try {
    return todayKey(); // use existing system day key
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function registerDailyFirstAccount(phone254, chatId) {
  if (!phone254) return;

  const dayKey = getTodayKeySafe();

  db.phoneDailyFirstAccount[phone254] = db.phoneDailyFirstAccount[phone254] || {};

  if (!db.phoneDailyFirstAccount[phone254][dayKey]) {
    db.phoneDailyFirstAccount[phone254][dayKey] = {
      firstChatId: String(chatId),
      ts: Date.now()
    };
    saveDB();
  }
}

function isDailyFirstAccount(phone254, chatId) {
  const dayKey = getTodayKeySafe();
  const rec = db.phoneDailyFirstAccount?.[phone254]?.[dayKey];
  if (!rec) return true;
  return String(rec.firstChatId) === String(chatId);
}

// Override referral reward logic again (daily based)
const __originalReferralRewardDaily = maybeRewardInviterOnSuccessPurchase;
maybeRewardInviterOnSuccessPurchase = function(buyerChatId, amountKsh, when) {

  const buyer = getUser(buyerChatId);
  const phone = buyer.phone;

  if (!phone) {
    return __originalReferralRewardDaily(buyerChatId, amountKsh, when);
  }

  if (!isDailyFirstAccount(phone, buyerChatId)) {
    // Block referral reward for second/third accounts same day
    return;
  }

  registerDailyFirstAccount(phone, buyerChatId);

  __originalReferralRewardDaily(buyerChatId, amountKsh, when);
};

console.log("🔄 Referral rewards now restricted to FIRST account per phone per DAY.");




// ===============================================================
// 🌙 AUTOMATIC MIDNIGHT RESET (KENYA TIME)
// Cleans previous day referral locks automatically
// ===============================================================

let __lastReferralDayKey = null;

function getCurrentDayKeySafe() {
  try {
    return todayKey(); // uses your existing Kenya day system
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function cleanupOldReferralDayData() {
  const currentDay = getCurrentDayKeySafe();

  if (__lastReferralDayKey === null) {
    __lastReferralDayKey = currentDay;
    return;
  }

  if (__lastReferralDayKey !== currentDay) {
    // Day changed → wipe all previous day referral locks
    if (db.phoneDailyFirstAccount && typeof db.phoneDailyFirstAccount === "object") {
      for (const phone of Object.keys(db.phoneDailyFirstAccount)) {
        const dayEntries = db.phoneDailyFirstAccount[phone];
        if (dayEntries && typeof dayEntries === "object") {
          // Keep only current day entry
          if (dayEntries[currentDay]) {
            db.phoneDailyFirstAccount[phone] = {
              [currentDay]: dayEntries[currentDay]
            };
          } else {
            delete db.phoneDailyFirstAccount[phone];
          }
        }
      }
      saveDB();
    }

    console.log("🌙 Midnight reset: referral daily locks cleared.");
    __lastReferralDayKey = currentDay;
  }
}

// Check every 10 minutes
setInterval(cleanupOldReferralDayData, 10 * 60 * 1000);

// Initialize tracker
__lastReferralDayKey = getCurrentDayKeySafe();




// ===============================================================
// ✅ DAILY REFERRAL LOCK ACTIVATES ONLY AFTER FIRST SUCCESSFUL PURCHASE
// - Phone can be used freely
// - Referral lock for the day only applies AFTER a successful payment
// ===============================================================

// Override referral logic to ensure lock only happens on SUCCESS
const __originalReferralRewardSuccessOnly = maybeRewardInviterOnSuccessPurchase;

maybeRewardInviterOnSuccessPurchase = function(buyerChatId, amountKsh, when) {

  const buyer = getUser(buyerChatId);
  const phone = buyer.phone;

  if (!phone) {
    return __originalReferralRewardSuccessOnly(buyerChatId, amountKsh, when);
  }

  const dayKey = getCurrentDayKeySafe();

  db.phoneDailyFirstAccount = db.phoneDailyFirstAccount || {};
  db.phoneDailyFirstAccount[phone] = db.phoneDailyFirstAccount[phone] || {};

  const existing = db.phoneDailyFirstAccount[phone][dayKey];

  // If no successful purchase recorded yet today → allow & register
  if (!existing) {
    db.phoneDailyFirstAccount[phone][dayKey] = {
      firstChatId: String(buyerChatId),
      ts: Date.now()
    };
    saveDB();
    return __originalReferralRewardSuccessOnly(buyerChatId, amountKsh, when);
  }

  // If already registered today
  if (String(existing.firstChatId) === String(buyerChatId)) {
    return __originalReferralRewardSuccessOnly(buyerChatId, amountKsh, when);
  }

  // Different account same day AFTER a successful purchase → block referral
  return;
};

console.log("✅ Daily referral lock now activates only after FIRST successful purchase.");




// ===============================================================
// 💰 TIERED REFERRAL COMMISSION SYSTEM
// ===============================================================
// 1.2%  → 1 - 10 Ksh
// 1.5%  → 11 - 150 Ksh
// 2%    → 151 - 500 Ksh
// 2.5%  → 501 - 1000 Ksh
// 3%    → 1001 - 10000 Ksh
// ===============================================================

function getReferralRate(amountKsh) {
  const amt = Number(amountKsh || 0);

  if (amt >= 1 && amt <= 10) return 0.012;
  if (amt >= 11 && amt <= 150) return 0.015;
  if (amt >= 151 && amt <= 500) return 0.02;
  if (amt >= 501 && amt <= 1000) return 0.025;
  if (amt >= 1001 && amt <= 10000) return 0.03;

  return 0; // outside defined tiers
}

// Override referral reward logic to apply tiered percentage
const __originalReferralRewardTiered = maybeRewardInviterOnSuccessPurchase;

maybeRewardInviterOnSuccessPurchase = function(buyerChatId, amountKsh, when) {

  const buyer = getUser(buyerChatId);
  if (!buyer || !buyer.invitedBy) {
    return; // no inviter
  }

  const inviterId = buyer.invitedBy;
  const rate = getReferralRate(amountKsh);

  if (rate <= 0) {
    return;
  }

  const rewardKsh = Number(amountKsh) * rate;

  // Convert Ksh reward to points using your existing conversion logic
  const rewardPoints = kesToPoints ? kesToPoints(rewardKsh) : rewardKsh;

  addPoints(inviterId, rewardPoints);

  addLedgerEvent({
    type: "REFERRAL_REWARD",
    chatId: String(inviterId),
    buyer: String(buyerChatId),
    amountKsh: Number(amountKsh),
    rewardKsh: rewardKsh,
    rate: rate
  });

  if (!isStopReferralNotifs(inviterId)) bot.sendMessage(
    inviterId,
    `🎉 Referral Bonus Earned!

` +
    `Purchase: Ksh ${amountKsh}
` +
    `Rate: ${(rate * 100).toFixed(2)}%
` +
    `Reward: Ksh ${rewardKsh.toFixed(2)}`
  ).catch(()=>{});
};

console.log("💰 Tiered referral commission system enabled.");




// ===============================================================
// 💳 ENFORCE MINIMUM 300 KSH TOTAL SPEND BEFORE WITHDRAWAL
// ===============================================================

const MIN_WITHDRAW_SPEND_KSH = 300;

// Helper to calculate total lifetime spend
function getTotalUserSpend(chatId) {
  const user = getUser(chatId);
  return Number(user.totalSpentKsh || 0);
}

// Hook withdrawal amount selection
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  const withdrawOptions = ["25 pts","50 pts","100 pts","250 pts","500 pts","1000 pts","2000 pts"];
  if (!withdrawOptions.includes(text)) return;

  const totalSpent = getTotalUserSpend(chatId);

  if (totalSpent < MIN_WITHDRAW_SPEND_KSH && !isAdmin(chatId)) {
    await bot.sendMessage(
      chatId,
      `🚫 Withdrawal Locked

You must spend at least *Ksh 300* before making a withdrawal request.

Your Total Spend: Ksh ${totalSpent}`,
      { parse_mode: "Markdown" }
    );
    return;
  }
});

console.log("💳 Minimum 300 KSH withdrawal requirement enforced.");



// ============================================================================
// ✅ PATCH: Referral + Business Limits + WEEKLY DRAW button visibility (2026-02-28)
// - Normal referral: 1–50 Ksh => 1.5%, 51+ => 2%
// - Business referral: if (active subscription + 3+ purchases) AND amount>=20 => tiered rate by successful refs during subscription
//   tiers: 0–29 2%, 30+ 2.5%, 100+ 3%, 140+ 3.5%, 200+ 4%, 250+ 4.5%
//   amount < 20 => normal rate (and does NOT count toward business tier counter)
// - Normal daily referral limit: 15 NEW successful referrals/day (business unlimited)
// - Business bypasses phone reuse/approval limits (but NOT admin commands)
// - Home menu: "${tr(chatId,"🎉 WEEKLY DRAW","🎉 DROO YA WIKI")}" (ALL CAPS) shows ABOVE other buttons only when admin enables it
// ============================================================================

(function applyPatch_2026_02_28() {
  try {
    // ---------- Points conversion (ensure exists) ----------
    const __KES_PER_POINT = 0.7;
    if (typeof pointsToKes !== "function") {
      global.pointsToKes = function pointsToKes(pts) { return Number(pts || 0) * __KES_PER_POINT; };
    }
    if (typeof kesToPoints !== "function") {
      global.kesToPoints = function kesToPoints(kes) { return Number(kes || 0) / __KES_PER_POINT; };
    }

    // ---------- Limit bypass helper ----------
    function isLimitBypass(chatId) {
      return !!(typeof isAdmin === "function" && isAdmin(chatId)) || !!(typeof isBusinessActive === "function" && isBusinessActive(chatId));
    }

    // ---------- Business perks unlock: 3+ successful purchases ----------
    function isBusinessPerksUnlocked(chatId) {
      const u = (typeof getUser === "function") ? getUser(chatId) : null;
      return !!u && Number(u.totalPurchases || 0) >= 3;
    }

    // ---------- Campaign visibility (WEEKLY DRAW button) ----------
    if (!db.campaign || typeof db.campaign !== "object") {
      db.campaign = { enabled: false, status: "OFF", heading: "WEEKLY DRAW", startAt: 0, endAt: 0, prizes: { first: 250, second: 150, third: 100 }, winners: [] };
      try { saveDB(); } catch (_) {}
    }

    // Override main menu keyboard to show WEEKLY DRAW on top when enabled
    const __origMainMenuKeyboard = (typeof mainMenuKeyboard === "function") ? mainMenuKeyboard : null;
    global.mainMenuKeyboard = function mainMenuKeyboard(chatId = null) {
      // If enabled: show ONLY Help button on reply keyboard.
      try {
        if (chatId && isAutoHideButtonsEnabled(chatId)) {
          return { reply_markup: { keyboard: [[tr(chatId,"ℹ️ Help","ℹ️ Msaada")]], resize_keyboard: true } };
        }
      } catch (_) {}

      // Build base keyboard similar to existing
      const keyboard = [];

      // ✅ WEEKLY DRAW first (only when enabled globally)
      if (db.campaign && db.campaign.enabled === true) {
        keyboard.push([tr(chatId,"🎉 WEEKLY DRAW","🎉 DROO YA WIKI")]);
      }

      // Keep original structure if available; otherwise default minimal
      if (chatId && typeof getQuickCategories === "function") {
        keyboard.push([tr(chatId,"🛒 Buy Offers","🛒 Nunua Ofa")]);
        const quick = getQuickCategories(chatId);
        for (const q of (quick || [])) keyboard.push([q.text]);
        keyboard.push(["👤 My Profile", "💸 Withdraw Points"]);
        keyboard.push(["🔗 My Referral", "ℹ️ Help"]);
      } else if (__origMainMenuKeyboard) {
        // Use original and just ensure WEEKLY DRAW is on top
        const base = __origMainMenuKeyboard(chatId);
        const baseKb = base?.reply_markup?.keyboard;
        if (Array.isArray(baseKb)) {
          // remove any duplicate WEEKLY DRAW rows if present
          const cleaned = baseKb.filter(row => !(Array.isArray(row) && row.length === 1 && (row[0] === "🎉 WEEKLY DRAW" || row[0] === "🎉 DROO YA WIKI")));
          keyboard.push(...cleaned);
        } else {
          keyboard.push(["🛒 Buy Offers"], ["👤 My Profile", "💸 Withdraw Points"], ["🔗 My Referral", "ℹ️ Help"]);
        }
      } else {
        keyboard.push(["🛒 Buy Offers"], ["👤 My Profile", "💸 Withdraw Points"], ["🔗 My Referral", "ℹ️ Help"]);
      }

      return { reply_markup: { keyboard, resize_keyboard: true } };
    };

    // Basic WEEKLY DRAW screen (visible only when enabled). Full campaign logic can be added later safely.
    bot.on("message", async (msg) => {
      const chatId = msg.chat.id;
      const text = (msg.text || "").trim();

      // 🔒 Auto-hide buttons: block weekly draw/menu actions while hidden (help is handled elsewhere)
      try { if (!isAdmin(chatId) && isAutoHideButtonsEnabled(chatId)) return; } catch (_) {}

      // Admin-only Weekly Draw control panel (hidden for non-admins)
      if (text === "🎛 WEEKLY DRAW ADMIN" || /^\/weeklydraw_admin$/i.test(text)) {
        if (!(typeof isAdmin === "function" && isAdmin(chatId))) {
          return bot.sendMessage(chatId, "⛔ Admin only.", mainMenuKeyboard(chatId)).catch(() => {});
        }
        const statusText = formatWeeklyDrawAdminStatus();
        return bot.sendMessage(chatId, statusText, weeklyDrawAdminMenuKeyboard()).catch(() => {});
      }

      
// Some Android keyboards add invisible variation selectors / extra spaces to emoji labels.
// Match the button by the words, not by the exact emoji string.
const __wdText = String(text || "").replace(/\s+/g, " ").trim();
if (/\bWEEKLY\s*DRAW\b/i.test(__wdText)) {
  const c = ensureWeeklyDrawObject();
  if (!c.enabled) {
    return bot.sendMessage(chatId, "⛔ WEEKLY DRAW is currently not active.", mainMenuKeyboard(chatId)).catch(() => {});
  }

  await maybeAutoEndWeeklyDraw();
  await maybeBroadcastEndSoon3Days(); // will respect opt-in checks internally
  await maybeSendNearQualifyReminder(chatId); // will respect opt-in

  const status = String(c.status || "OFF").toUpperCase();
  const heading = String(c.heading || "WEEKLY DRAW").toUpperCase();
  const countdown = getCampaignCountdown();

  // Build Top 10 qualified participants
  const entries = (c.entries && typeof c.entries === "object") ? c.entries : {};
  const ranked = Object.entries(entries)
    .map(([cid, t]) => ({ cid, tickets: Number(t || 0) }))
    .filter((x) => x.tickets > 0)
    .map((x) => {
      const u = getUser(x.cid);
      const name = safeDisplayName(u, x.cid);
      const q = weeklyDrawQualification(x.cid);
      return { ...x, name, qualified: q.qualified };
    })
    .filter((x) => x.qualified)
    .sort((a, b) => b.tickets - a.tickets)
    .slice(0, 10);

  const listLines = ranked.length
    ? ranked.map((r, i) => `${i + 1}️⃣ ${r.name} — ${r.tickets} ${tr(chatId,"tickets","tiketi")}`).join("\n")
    : tr(chatId, 'No qualified participants yet.', 'Bado hakuna washiriki waliohitimu.');

  // Winners block (ENDED)
  let winnersBlock = "";
  if (status === "ENDED" && Array.isArray(c.winners) && c.winners.length) {
    const lines = c.winners.slice(0, (c.winnersCount || 3)).map((w, i) => {
      const pos = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
      const paid = w.paid ? tr(chatId,"Paid ✅","Imelipwa ✅") : tr(chatId,"Pending ⏳","Inasubiri ⏳");
      return `${pos} ${(w.name || safeDisplayName(getUser(w.chatId), w.chatId) || w.chatId)} — Ksh ${Number(w.prize || 0)} (${paid})`;
    });
    winnersBlock = `\n\n🏁 ${tr(chatId,"Winners (Top 3)","Washindi (Top 3)")}\n${lines.join("\n")}`;
  }

  const optedLine = isWeeklyDrawOptedIn(chatId)
    ? tr(chatId, '✅ You are opted in (you will receive updates).', '✅ Umejiunga (utapokea taarifa).')
    : tr(chatId, 'ℹ️ You are not opted in (no campaign messages). Tap ✅ JOIN to participate.', 'ℹ️ Hujajiunga (hutapokea taarifa za kampeni). Bonyeza ✅ JIUNGE kushiriki.');

  const caption =
    `🎉 ${heading}\n` +
    `Status: ${status}\n` +
    `⏳ Ends in: ${countdown}${winnersBlock}\n\n` +
    `${optedLine}\n\n` +
    `🏆 Top Participants (Top 10)\n${listLines}`;

  const img = String(c.image || "").trim();
  if (img) {
    return bot.sendPhoto(chatId, img, { caption, ...weeklyDrawUserMenuKeyboard(chatId) })
      .catch(() => bot.sendMessage(chatId, caption, weeklyDrawUserMenuKeyboard(chatId)).catch(() => {}));
  }
  return bot.sendMessage(chatId, caption, weeklyDrawUserMenuKeyboard(chatId)).catch(() => {});
}



      // Admin toggles (simple)
      // Admin text commands block removed (handled via inline buttons/callbacks).
      if (typeof isAdmin === "function" && isAdmin(chatId)) {
        // (no-op)
      }
    });

    // ---------- Phone reuse approval bypass for Business (and Admin) ----------
    if (typeof canUsePhone === "function") {
      const __origCanUsePhone = canUsePhone;
      global.canUsePhone = function patchedCanUsePhone(chatId, phone254) {
        if (isLimitBypass(chatId)) return { ok: true };
        return __origCanUsePhone(chatId, phone254);
      };
    }

    // ---------- Referral system (single source of truth) ----------
    // Daily cap: 15 NEW successful referrals/day for NORMAL only.
    db.refDaily = db.refDaily && typeof db.refDaily === "object" ? db.refDaily : {};
    function dayKeySafe() {
      try { return todayKey(); } catch (_) { return new Date().toISOString().slice(0,10); }
    }
    function getDailyNewReferralCount(inviterId) {
      const day = dayKeySafe();
      if (!db.refDaily[day]) db.refDaily[day] = {};
      return Number(db.refDaily[day][String(inviterId)] || 0);
    }
    function incDailyNewReferralCount(inviterId) {
      const day = dayKeySafe();
      if (!db.refDaily[day]) db.refDaily[day] = {};
      const k = String(inviterId);
      db.refDaily[day][k] = Number(db.refDaily[day][k] || 0) + 1;
      try { saveDB(); } catch (_) {}
    }

    function normalReferralRate(amountKsh) {
      const amt = Number(amountKsh || 0);
      if (amt >= 1 && amt <= 50) return 0.015;
      if (amt >= 51) return 0.02;
      return 0;
    }

    function businessRateByCount(count) {
      const c = Number(count || 0);
      if (c >= 250) return 0.045;
      if (c >= 200) return 0.04;
      if (c >= 140) return 0.035;
      if (c >= 100) return 0.03;
      if (c >= 30)  return 0.025;
      return 0.02; // 0–29
    }

    function ensureBusinessRefState(inviterId) {
      const u = getUser(inviterId);
      const subStart = Number(u.subscriptionStart || 0);
      if (!u.businessRefSubStart || Number(u.businessRefSubStart) !== subStart) {
        u.businessRefSubStart = subStart;
        u.businessRefSet = {};
        u.businessRefCount = 0;
        try { saveDB(); } catch (_) {}
      }
      if (!u.businessRefSet || typeof u.businessRefSet !== "object") u.businessRefSet = {};
      if (!u.businessRefCount) u.businessRefCount = 0;
      return u;
    }

    // Override reward handler at the very end to avoid earlier conflicting overrides
    global.maybeRewardInviterOnSuccessPurchase = function patchedMaybeRewardInviterOnSuccessPurchase(buyerChatId, amountKsh, when) {
      try {
        const buyer = getUser(buyerChatId);
        if (!buyer) return;

        const inviterId = buyer.inviterId ? String(buyer.inviterId) : null;
        if (!inviterId || !/^\d+$/.test(inviterId)) return;
        if (String(inviterId) === String(buyerChatId)) return; // no self-referral

        const amt = Number(amountKsh || 0);
        if (!(amt > 0)) return;

        // Normal referral expiry (30 days) — applies to normal-rate earnings
        const inviterSetAt = Number(buyer.inviterSetAt || 0);
        const withinReferralWindow = inviterSetAt ? (Date.now() - inviterSetAt) <= (30 * 24 * 60 * 60 * 1000) : true;

        // Determine if inviter is business eligible for business-tier rates
        const inviterBusinessActive = (typeof isBusinessActive === "function") && isBusinessActive(inviterId);
        const inviterBusinessUnlocked = inviterBusinessActive && isBusinessPerksUnlocked(inviterId);

        let rate = 0;
        let countTowardBusinessTier = false;

        if (inviterBusinessUnlocked && amt >= 20) {
          // Business tier rate
          const iu = ensureBusinessRefState(inviterId);
          rate = businessRateByCount(iu.businessRefCount || 0);
          countTowardBusinessTier = true;
        } else {
          // Normal rate (also used as fallback for business on <20)
          rate = normalReferralRate(amt);
          if (!withinReferralWindow) rate = 0;
        }

        if (!(rate > 0)) return;

        // Daily cap for NORMAL only, only when buyer is a NEW successful referral (first ever purchase)
        const isFirstPurchase = Number(buyer.totalPurchases || 0) === 0;
        if (!inviterBusinessActive && isFirstPurchase) {
          const cur = getDailyNewReferralCount(inviterId);
          if (cur >= 15) {
            return; // silently skip
          }
          incDailyNewReferralCount(inviterId);
        }

        const rewardKsh = amt * rate;
        const rewardPts = kesToPoints(rewardKsh);

        // Credit points
        if (typeof addPoints === "function") addPoints(inviterId, rewardPts);

        // Business tier counting: only if purchase >=20 and within active subscription
        if (countTowardBusinessTier) {
          const iu = ensureBusinessRefState(inviterId);
          const key = String(buyerChatId);
          if (!iu.businessRefSet[key]) {
            iu.businessRefSet[key] = { firstAt: Date.now() };
            iu.businessRefCount = Number(iu.businessRefCount || 0) + 1;
            try { saveDB(); } catch (_) {}
          }
        }

        // Record that this buyer has at least one successful purchase (for "active referrals" logic elsewhere)
        buyer.hasPurchased = true;
        try { saveDB(); } catch (_) {}

        // Notify inviter on EVERY successful purchase
        bot.sendMessage(
          inviterId,
          `🎉 Referral Bonus Earned!\n\n` +
          `Purchase: Ksh ${amt}\n` +
          `Rate: ${(rate * 100).toFixed(2)}%\n` +
          `Reward: Ksh ${rewardKsh.toFixed(2)}`
        ).catch(() => {});

        // Admin log (optional)
        try {
          if (typeof notifyAdmin === "function") {
            if (!isStopReferralNotifs(inviterId)) notifyAdmin(
              `🎯 Referral Reward\n` +
              `Inviter: ${inviterId}\n` +
              `Buyer: ${buyerChatId}\n` +
              `Amount: Ksh ${amt}\n` +
              `Rate: ${(rate*100).toFixed(2)}%\n` +
              `Reward: Ksh ${rewardKsh.toFixed(2)}\n` +
              `Time: ${when || ""}`
            ).catch(() => {});
          }
        } catch (_) {}
      } catch (_) {}
    };

    console.log("✅ PATCH 2026-02-28 applied: referral + business bypass + WEEKLY DRAW visibility");
  } catch (e) {
    console.log("PATCH 2026-02-28 failed:", e?.message || e);
  }
})();


// ===================== REFERRAL COPY LINK HANDLER =====================
bot.on("callback_query", async (q) => {
  try {
    const chatId = q.message?.chat?.id;
    if (!chatId) return;

    if (q.data === "copy_ref_link") {
      const BOT_USERNAME = process.env.BOT_USERNAME || "";
      const referralLink = `https://t.me/${BOT_USERNAME}?start=${chatId}`;

      // Send plain text so user can tap-and-hold to copy easily
      await bot.sendMessage(chatId, `📋 Copy this link:\n\n${referralLink}`);
      await bot.answerCallbackQuery(q.id, { text: "Link sent ✅", show_alert: false });
      return;
    }

    if (q.data === "ref:home") {
      await bot.answerCallbackQuery(q.id).catch(() => {});
      // Delete the referral message to keep chat clean (safe if already gone)
      try { if (q.message?.message_id) await bot.deleteMessage(chatId, q.message.message_id).catch(() => {}); } catch (_) {}
      await sendTracked(chatId, "🏠 Main Menu", { ...mainMenuKeyboard(chatId) });
      return;
    }


    // Let other callback handlers process their own data
  } catch (_) {
    try { await bot.answerCallbackQuery(q.id, { text: "Try again.", show_alert: false }); } catch {}
  }
});


// ===================== ADMIN: DEACTIVATE BUSINESS =====================
async function deactivateBusinessAccount(targetChatId) {
  try {
    const u = getUser(targetChatId);
    u.accountType = "normal";
    u.subscriptionStart = 0;
    u.subscriptionExpiry = 0;    disableBusinessFeatures(u);
    saveDB();

    await bot.sendMessage(
      targetChatId,
      "❌ Your Business account has been deactivated by admin.\n\nIf this was a mistake, contact support.",
      { ...mainMenuKeyboard(targetChatId) }
    ).catch(() => {});

    adminNotify(`❌ Business manually deactivated\nUser: ${targetChatId}`);

    return true;
  } catch (err) {
    console.log("DeactivateBusiness error:", err?.message || err);
    return false;
  }
}





// ===================== BUSINESS SETTINGS MEMORY (SAFE ADDITION) =====================

function backupBusinessSettings(user) {
  if (!user) return;

  user._businessBackup = {
    fastPurchaseEnabled: !!user.fastPurchaseEnabled,
    autoRetryStkEnabled: !!user.autoRetryStkEnabled
  };
}

function restoreBusinessSettings(user) {
  if (!user) return;

  if (user._businessBackup) {
    user.fastPurchaseEnabled = !!user._businessBackup.fastPurchaseEnabled;
    user.autoRetryStkEnabled = !!user._businessBackup.autoRetryStkEnabled;
  }
}

function disableBusinessFeatures(user) {
  if (!user) return;

  backupBusinessSettings(user);

  user.fastPurchaseEnabled = false;
  user.autoRetryStkEnabled = false;
}

function activateBusinessFeatures(user) {
  if (!user) return;
  restoreBusinessSettings(user);
}

// ===============================================================================



// ===================== ADMIN: SHOW TOKEN STATUS =====================
if (typeof bot !== "undefined") {
  bot.onText(/\/showtokenstatus/, async (msg) => {
    const chatId = msg.chat.id;

    if (Number(chatId) !== Number(ADMIN_ID)) {
      return bot.sendMessage(chatId, "❌ Only admin can view token status.");
    }

    try {
      const hasToken = db.botToken && typeof db.botToken === "string" && db.botToken.length > 10;

      if (hasToken) {
        await bot.sendMessage(chatId, "✅ Bot token is SET in database.");
      } else {
        await bot.sendMessage(chatId, "⚠️ Bot token is NOT set.");
      }
    } catch (err) {
      await bot.sendMessage(chatId, "❌ Error checking token status.");
    }
  });
}


// ===== ADDED: PRIVACY / TERMS / LEADERBOARD / HISTORY =====

// Privacy
bot.onText(/📄?\s*Terms of Service/i, async (msg)=>{
  const chatId=msg.chat.id;
  bot.sendMessage(chatId,
`📄 Terms of Service

By using this bot you agree to:

• Not abusing or exploiting the bot
• Not using multiple fake accounts
• Points and rewards may change anytime
• Violating rules may result in account removal

This service is provided "as is".`,
{});
});

// Privacy
bot.onText(/🔒?\s*Privacy/i, async (msg)=>{
  const chatId=msg.chat.id;
  bot.sendMessage(chatId,
`🔒 Privacy Policy

We store only:
• Telegram ID
• Username
• Points
• Bot activity

Your data is never sold or shared with third parties.`,
{});
});

// Leaderboard (Top 30 by points)
bot.onText(/🏆?\s*Leaderboard/i, async (msg)=>{
  const chatId=msg.chat.id;

  try{
    const users=db.users||{};
    const arr=Object.entries(users).map(([cid,u])=>{
      return {id:cid,pts:Number(u.points||0),name:(u.profile?.username?("@"+u.profile.username):(u.profile?.firstName||"User"))};
    });

    arr.sort((a,b)=>b.pts-a.pts);

    const top=arr.slice(0,30);

    let txt="🏆 Top 30 Users (Points)\n\n";
    top.forEach((u,i)=>{
      txt+=`${i+1}. ${u.name} — ${u.pts} pts\n`;
    });

    if(!top.length) txt+="No users yet.";

    bot.sendMessage(chatId,txt);
  }catch(e){
    bot.sendMessage(chatId,"Leaderboard unavailable.");
  }
});

// History (user transactions)
bot.onText(/📜?\s*History/i, async (msg)=>{
  const chatId=msg.chat.id;

  try{
    const u=getUser(chatId);
    const log=(u.txLog||[]).slice(-10).reverse();

    if(!log.length){
      return bot.sendMessage(chatId,"📜 No activity yet.");
    }

    let txt="📜 Your Activity\n\n";

    log.forEach(x=>{
      const time=new Date(x.time||Date.now()).toLocaleString();
      txt+=`${x.pkgLabel||"Activity"} — ${x.amountKsh||0} pts\n${time}\n\n`;
    });

    bot.sendMessage(chatId,txt);

  }catch(e){
    bot.sendMessage(chatId,"History unavailable.");
  }
});



// ===== USER STK RETRY TOGGLE SYSTEM =====

// ensure toggle exists
function ensureRetrySetting(user){
  if(!user) return;
  if(typeof user.stkRetryEnabled !== "boolean"){
    user.stkRetryEnabled=false;
  }
}

// Toggle command
bot.onText(/🔁\s*STK Retry/i, (msg)=>{
  const chatId=msg.chat.id;
  try{
    const u=getUser(chatId);
    ensureRetrySetting(u);
    u.stkRetryEnabled=!u.stkRetryEnabled;
    saveDB();
    bot.sendMessage(chatId,
      u.stkRetryEnabled
        ? "✅ STK retry enabled. You can retry failed payments."
        : "⛔ STK retry disabled.");
  }catch(e){
    bot.sendMessage(chatId,"Retry toggle error.");
  }
});

// Block retry callbacks if disabled
bot.on("callback_query", async (q)=>{
  try{
    const data=(q.data||"").toLowerCase();
    if(data.includes("retry")){
      const chatId=q.message.chat.id;
      const u=getUser(chatId);
      ensureRetrySetting(u);

      if(!u.stkRetryEnabled){
        await bot.answerCallbackQuery(q.id,{
          text:"STK retry disabled. Enable it in Commands & Settings.",
          show_alert:true
        });
        return;
      }
    }
  }catch(e){}
});

// Block retry typed commands if disabled
bot.on("message",(msg)=>{
  try{
    const txt=(msg.text||"").toLowerCase();
    if(txt.includes("retry")){
      const chatId=msg.chat.id;
      const u=getUser(chatId);
      ensureRetrySetting(u);
      if(!u.stkRetryEnabled){
        return;
      }
    }
  }catch(e){}
});



// ===== Business Account inline manage button =====
bot.on("callback_query", async (q) => {
  try {
    const data = String(q.data || "");
    if (data !== "biz:manage") return;

    const chatId = q.message?.chat?.id;
    if (!chatId) return;

    try { await bot.answerCallbackQuery(q.id); } catch (_) {}

    const u = getUser(chatId);

    const header = isBusinessActive(chatId)
      ? "⚙️ *Manage Business Account*\n\nTap your ✅ active plan to deactivate, or choose another plan to subscribe."
      : "✅ *Activate Business Account*\n\nChoose a plan to subscribe:";

    await sendTracked(
      chatId,
      header,
      { parse_mode: "Markdown", ...sellKeyboard(chatId) }
    );
  } catch (_) {}
});

