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
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
// ORIGINAL TOKEN REMOVED FOR SECURITY
// const TELEGRAM_TOKEN = "Hnf2wGQ4aXqqZUX02u_0rLYGronNhwP8Y";
const PAYHERO_USERNAME = process.env.PAYHERO_USERNAME || "";
// const PAYHERO_USERNAME = "UuT8gpaqwB5ttjYC4ivd";
const PAYHERO_PASSWORD = process.env.PAYHERO_PASSWORD || "";
// const PAYHERO_PASSWORD = "FIfH59osWhh2cwwrsWfxtnx8K7SPjhitehpPgAmZ";
// ✅ ADMIN
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);
// const ADMIN_ID = 7859465542;

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
  { key: "FREE_250MB", label: "250MB free", cost: 20 },
  { key: "FREE_20MIN", label: "20mins midnight free", cost: 25 },
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
  if (!db0.phoneCooldown || typeof db0.phoneCooldown !== "object") db0.phoneCooldown = {};
  if (!db0.stats || typeof db0.stats !== "object") db0.stats = { totalPurchases: 0, totalBroadcasts: 0 };
  if (typeof db0.stats.lastLeaderboardWeek !== "string") db0.stats.lastLeaderboardWeek = "";
  if (typeof db0.stats.totalPurchases !== "number") db0.stats.totalPurchases = 0;
  if (typeof db0.stats.totalBroadcasts !== "number") db0.stats.totalBroadcasts = 0;
// analytics (revenue)
if (!db0.analytics || typeof db0.analytics !== "object") db0.analytics = {};
if (!db0.analytics.revenueByDay || typeof db0.analytics.revenueByDay !== "object") db0.analytics.revenueByDay = {};
if (!db0.analytics.revenueByWeek || typeof db0.analytics.revenueByWeek !== "object") db0.analytics.revenueByWeek = {};
if (!db0.analytics.revenueByCategoryDay || typeof db0.analytics.revenueByCategoryDay !== "object") db0.analytics.revenueByCategoryDay = {};
if (!db0.analytics.revenueByPackageDay || typeof db0.analytics.revenueByPackageDay !== "object") db0.analytics.revenueByPackageDay = {};


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
    if (typeof x.lastReferralRewardDay !== "string") x.lastReferralRewardDay = "";
    if (typeof x.points !== "number") x.points = 0;
    if (typeof x.totalSpentKsh !== "number") x.totalSpentKsh = 0;
    if (typeof x.referralSuccessCount !== "number") x.referralSuccessCount = 0;
    if (typeof x.referralCounted !== "boolean") x.referralCounted = false;
    if (typeof x.bonusEligibleCount !== "number") x.bonusEligibleCount = 0;
    if (typeof x.lastNudgeDay !== "string") x.lastNudgeDay = "";

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
      redeemUnlockStart: 0,
      redeemUnlockPurchases: 0,
      redeemedCounts: {},
      inviterId: "",
      lastReferralRewardDay: "",
      points: 0,
      totalSpentKsh: 0,
      referralSuccessCount: 0,
      referralCounted: false,
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

  return `${title}\n` + rows.map((r) => `• ${r.k} — Ksh ${r.revenueKsh} (${r.orders} orders)`).join("\n");
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
  rows.push(["date", "type", "key", "orders", "revenue_ksh"]);

  for (let i = days - 1; i >= 0; i--) {
    const day = kenyaDayKeyOffset(i);

    const tot = db.analytics?.revenueByDay?.[day] || { orders: 0, revenueKsh: 0 };
    rows.push([day, "TOTAL", "ALL", Number(tot.orders || 0), Number(tot.revenueKsh || 0)]);

    const byCat = db.analytics?.revenueByCategoryDay?.[day] || {};
    for (const [cat, v] of Object.entries(byCat)) {
      rows.push([day, "CATEGORY", cat, Number(v.orders || 0), Number(v.revenueKsh || 0)]);
    }

    const byPkg = db.analytics?.revenueByPackageDay?.[day] || {};
    for (const [pkg, v] of Object.entries(byPkg)) {
      rows.push([day, "PACKAGE", pkg, Number(v.orders || 0), Number(v.revenueKsh || 0)]);
    }
  }

  return rows;
}

function writeRevenueCsvFile(days) {
  const safeDays = Math.max(1, Math.min(365, Number(days || 30)));
  const rows = buildRevenueExportRows(safeDays);
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n") + "\n";

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

  let percent = 0;

  if (amount >= 1 && amount <= 10) {
    percent = 0.012; // 1.2%
  } else if (amount >= 11 && amount <= 150) {
    percent = 0.0145; // 1.45%
  } else if (amount >= 151 && amount <= 500) {
    percent = 0.017; // 1.7%
  } else if (amount >= 501 && amount <= 1000) {
    percent = 0.019; // 1.9%
  } else if (amount >= 1001 && amount <= 10000) {
    percent = 0.02; // 2%
  } else {
    // out of configured range -> no cashback
    return;
  }

  const cashbackPts = amount * percent;
  if (!Number.isFinite(cashbackPts) || cashbackPts <= 0) return;

  // addPoints() is centi-points safe later in the file
  addPoints(chatId, cashbackPts);

  // Notify user (non-blocking)
  try {
    bot.sendMessage(
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

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ===================== AUTO DELETE SYSTEM =====================
const lastBotMessage = new Map();
// ✅ Auto STK reminder timers (in-memory)
const stkReminderTimers = new Map();

async function deleteMessageSafe(chatId, messageId) {
  try {
    if (messageId) {
      await bot.deleteMessage(chatId, messageId);
    }
  } catch (e) {}
}


// ===================== ADMIN INLINE ACTIONS =====================
bot.on("callback_query", async (q) => {
  try {
    const data = String(q.data || "");

    // Ignore unrelated callbacks so other handlers don't throw
    if (!data.startsWith("redeem_") && 
        !data.startsWith("phone_") && 
        !data.startsWith("withdraw_")) {
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

    if (!data.startsWith("redeem_")) return;

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
      await bot.sendMessage(q.message?.chat?.id, "✅ Withdrawal approved.").catch(() => {});
      console.error("Callback error:", _);
      await bot.answerCallbackQuery(q.id).catch(() => {});
    } catch (_) {}
  }
});




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

function maskPhone(phone254) {
  const full = formatTo07(phone254);
  if (!full || full.length < 10) return full;
  return full.slice(0,4) + "xxx" + full.slice(-3);
}


// Anti-spam signature
function makeSig({ category, pkgLabel, phone254 }) {
  return `${category}||${pkgLabel}||${phone254}`;
}

function checkAndMarkSpam(chatId, sig, phone254) {
  // ✅ Admin bypasses all STK limits
  if (isAdmin(chatId)) return { ok: true };
  db = repairDB(db);
  const now = Date.now();
  const phoneKey = String(phone254 || "");

  const lastAt = Number(db.phoneCooldown[phoneKey] || 0);

  // ✅ 1 STK per minute per PHONE NUMBER
  if (lastAt && now - lastAt < 60 * 1000) {
    const wait = Math.ceil((60 * 1000 - (now - lastAt)) / 1000);
    return { ok: false, reason: `⏳ This number must wait ${wait}s before another STK.` };
  }

  db.phoneCooldown[phoneKey] = now;
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
function mainMenuKeyboard(chatId = null) {
  const keyboard = [
    ["🛒 Buy Offers"],
    ["💸 Withdraw Points"],
    ["🔗 My Referral", "ℹ️ Help"]
  ];

  // Show Resend STK only if user has pending payment
  if (chatId) {
    const hasPending = Object.values(db.pendingPayments || {}).some(
      p => Number(p.chatId) === Number(chatId)
    );
    if (hasPending) {
      keyboard.splice(1, 0, ["🔄 Resend STK"]);
    }
  }

  return {
    reply_markup: {
      keyboard,
      resize_keyboard: true
    }
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
      keyboard: [
        ["1️⃣ 20 free SMS (5 pts)"],
        ["2️⃣ 250MB free (20 pts)"],
        ["3️⃣ 20mins midnight free (25 pts)"],
        ["⬅ Back", "❌ Cancel"],
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
        ["⬅ Withdraw Menu"],
        ["⬅ Back", "❌ Cancel"],
      ],
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

    `📦 *Packages Overview*\n\n` +

    `📦 *Bingwa Deals*\n` +
    `• Ksh 20 • 250MB 24HRS\n` +
    `• Ksh 21 • 1GB 1HR\n` +
    `• Ksh 47 • 350MB 7 DAYS\n` +
    `• Ksh 49 • 1.5GB 3HRS\n` +
    `• Ksh 55 • 1.25GB MIDNIGHT\n` +
    `• Ksh 99 • 1GB 24HRS\n` +
    `• Ksh 299 • 2.5GB 7 DAYS\n` +
    `• Ksh 700 • 6GB 7 DAYS\n\n` +

    `∞ *Unlimited Deals*\n` +
    `• Ksh 23 • 1GB 1HR\n` +
    `• Ksh 52 • 1.5GB 3HRS\n` +
    `• Ksh 110 • 2GB 24HRS\n` +
    `• Ksh 251 • 5GB 3 DAYS\n\n` +

    `✉️ *SMS Offers*\n` +
    `• Ksh 5 • 20 SMS 24HRS\n` +
    `• Ksh 10 • 200 SMS 24HRS\n` +
    `• Ksh 30 • 1000 SMS 7 DAYS\n` +
    `• Ksh 26 • Unlimited SMS DAILY\n` +
    `• Ksh 49 • Unlimited Weekly SMS\n` +
    `• Ksh 101 • 1500 SMS MONTHLY\n` +
    `• Ksh 201 • 3500 SMS MONTHLY\n\n` +

    `📞 *Minutes*\n` +
    `• Ksh 25 • 20 MIN MIDNIGHT\n` +
    `• Ksh 21 • 43 MIN 3HRS\n` +
    `• Ksh 51 • 50 MIN MIDNIGHT\n` +
    `• Ksh 250 • 200 MIN 7 DAYS\n` +
    `• Ksh 510 • 500 MIN 7 DAYS\n\n` +

    `⭐ *Bonga Points*\n` +
    `• Ksh 22 • 60 Bonga Points\n\n` +

    `🌀 *Flex Deals*\n` +
    `• Ksh 20 • Flex 350 (2HRS)\n` +
    `• Ksh 35 • Flex 500 (3HRS)\n` +
    `• Ksh 100 • Flex 1000 (MIDNIGHT)\n` +
    `• Ksh 255 • Flex 1500 (7 DAYS)\n` +
    `• Ksh 1000 • Flex 9000 (30 DAYS)\n\n` +

    `🎁 Earn points via referrals and redeem.\n\n` +
    `⚠️ *Bingwa Deals rule:* *Once per day per phone number* (ONLY after success).\n\n` +
    `✅ Tap 🛒 *Buy Offers* to purchase.\n\n` +

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
// ✅ Count unique successful referrals for redeem eligibility (only first success per referred user)
if (!buyer.referralCounted) {
  const inv = getUser(inviterId);
  inv.referralSuccessCount = Number(inv.referralSuccessCount || 0) + 1;
  buyer.referralCounted = true;
  saveDB();
}

const cleanBonus = parseFloat(bonus.toFixed(2));

notifyAdmin(
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
  const details =
    pending && pending.pkgLabel
      ? `Offer: ${pending.pkgLabel}\nFrom: ${maskPhone(pending.phone254)}\nAmount: Ksh ${pending.price}`
      : "";

  if (pending) deletePendingPayment(externalRef);

  const out =
    `❌ Payment failed at ${when}.\n` +
    (details ? `${details}\n` : "") +
    `Your package could not be processed. Please try again or contact customer support.\n\nHelp: ${HELP_PHONE}`;

  await sendTracked(chatId, out, { ...mainMenuKeyboard(chatId) });
  return;
}

    // Prevent double-processing if PayHero retries (SUCCESS)
    if (alreadyProcessed(externalRef)) return;

    // mark processed FIRST (idempotent)
    markProcessed(externalRef);

    // If we have pending payment, apply rules + stats
    const pending = getPendingPayment(externalRef);

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
      // ✅ Revenue analytics (SUCCESS only)
      recordSuccessfulRevenue(pending);

      // ✅ Bingwa locks only after SUCCESS
      if (pending.category === "Bingwa Deals" && pending.phone254) {
        markBingwaPurchasedToday(pending.phone254);
      }
      if (pending.pkgLabel) incPurchaseStats(chatId, pending.pkgLabel);
      // track lifetime spend
      try {
        const uu = getUser(chatId);
        uu.totalSpentKsh = Number(uu.totalSpentKsh || 0) + Number(pending.price || 0);
        saveDB();
      } catch (_) {}

      // ✅ Bonus: After every 5 successful purchases above Ksh 20 -> +5 pts
      if (pending.price > 20) {
        const u = getUser(chatId);
        u.bonusEligibleCount = Number(u.bonusEligibleCount || 0) + 1;
        if (u.bonusEligibleCount % 5 === 0) {
          addPoints(chatId, 5);
        }
        saveDB();
      }


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
        `✅ Payment Confirmed\n\nYour payment of *Ksh ${pending.price}* has been received and your request is being processed.`,
        { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
      );
    } else {
      await sendTracked(
        chatId,
        `✅ Payment Confirmed\n\nYour payment has been received and your request is being processed.`,
        { ...mainMenuKeyboard(chatId) }
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

      if (item.key === "FREE_250MB" && redeemPhoneAlreadyUsedToday(phone254)) {
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

      await sendTracked(chatId, packagesOverviewText(), { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) });

      const pts = getPoints(chatId);
      return sendTracked(chatId, `⭐ Your points: *${pts.toFixed(2)}*\n\nUse "🎁 Redeem Points" to redeem.`, {
        parse_mode: "Markdown",
        ...mainMenuKeyboard(chatId),
      });
    }

    // /help
    if (/^\/help$/i.test(text)) {
      return sendTracked(chatId, helpText(), { ...mainMenuKeyboard(chatId) });
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
      
      
// ===================== WITHDRAW QUICK COMMANDS =====================
// Usage:
//   /ac <chatId>  -> approve latest pending withdraw for that user
//   /dc <chatId>  -> decline latest pending withdraw for that user (refund points)
const acMatch = text.match(/^\/ac\s+(\d+)$/i);
if (acMatch) {
  const targetId = acMatch[1];
  db = repairDB(db);

  const req = db.pendingRedeems?.[String(targetId)];
  if (!req || req.status !== "pending" || req.type !== "withdraw") {
    return sendTracked(chatId, "❌ No pending withdraw for that user.");
  }

  req.status = "approved";
  db.pendingRedeems[String(targetId)] = req;
  saveDB();

  clearPendingRedeem(targetId);
  setRedeemCooldown(targetId, 5 * 60 * 1000);

  

const sent = await bot.sendMessage(
  Number(targetId),
  `✅ Withdrawal Approved

Amount: ${Number(req.amount || 0)} pts
KES Sent: ${pointsToKes(req.amount)}
MPESA: ${mask07(req.phone)}

Your withdrawal is being processed.`,
  { ...mainMenuKeyboard(chatId) }
).catch(() => {});

  
  // ✅ Auto-delete the admin withdraw request message
  if (req.adminMsgId) {
    await bot.deleteMessage(ADMIN_ID, req.adminMsgId).catch(() => {});
  }

return sendTracked(chatId, `✅ Withdraw approved for ${targetId}`);
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

  const lines = rows.map((r, i) => `${i + 1}. ${r.k} — *Ksh ${r.revenueKsh}* (${r.orders})`).join("\n");
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

  // User can cancel a pending redeem request any time via ❌ Cancel
  if (!isAdmin(chatId) && (text === "❌ Cancel" || text === "/cancel") && hasPendingRedeem(chatId)) {
    const req = getPendingRedeem(chatId);
    const cost = Number(req?.cost || 0);

    // mark cancelled + refund
    if (req) {
      req.status = "cancelled_by_user";
      db.pendingRedeems[String(chatId)] = req;
      saveDB();
    }

    if (Number.isFinite(cost) && cost > 0) addPoints(chatId, cost);
    clearPendingRedeem(chatId);
    clearPendingAction(chatId);
    setRedeemCooldown(chatId, 5 * 60 * 1000);

    return sendTracked(
      chatId,
      `❌ Redeem cancelled.\n\nReserved points refunded: ${cost} pts\nCurrent balance: ${getPoints(chatId).toFixed(2)} pts`,
      { ...mainMenuKeyboard(chatId) }
    );
  }

  // Handle redeem multi-step input
  if (act && !isAdmin(chatId) && act.kind === "redeem") {
    const item = act?.data?.item;

    if (text === "⬅ Back") {
      clearPendingAction(chatId);
      return sendTracked(chatId, "⬅ Back to menu.", { ...mainMenuKeyboard(chatId) });
    }

    if (text === "❌ Cancel" || text === "/cancel") {
      clearPendingAction(chatId);
      return sendTracked(chatId, "❌ Cancelled.", { ...mainMenuKeyboard(chatId) });
    }

    if (!item) {
      clearPendingAction(chatId);
      return sendTracked(chatId, "❌ Redeem error. Try again.", { ...mainMenuKeyboard(chatId) });
    }

    // Re-check eligibility every step
    const st = canRedeemNow(chatId);
    if (!st.ok) {
      clearPendingAction(chatId);
      return sendTracked(
        chatId,
        `🔒 Redeem locked\n\nRequirements:\n• Total purchases: ${st.totalPurchases}/${REDEEM_MIN_TOTAL_PURCHASES}\n• Purchases in current cycle: ${st.unlockPurchases}/${REDEEM_UNLOCK_PURCHASES_REQUIRED}\n• Cycle resets in: ${st.daysLeft} day(s)`,
        { ...mainMenuKeyboard(chatId) }
      );
    }

    // Cooldown (after admin decision)
    const rem = redeemCooldownRemainingMs(chatId);
    if (rem > 0) {
      const mins = Math.ceil(rem / 60000);
      clearPendingAction(chatId);
      return sendTracked(chatId, `⏳ Please wait ${mins} minute(s) before sending another redeem request.`, { ...mainMenuKeyboard(chatId) });
    }

    if (act.step === "confirm") {
      if (text === "✅ Confirm") {
        const savedPhone = getUserPhone(chatId);
        if (savedPhone) {
          // ✅ FIX: Auto-use saved phone instead of waiting for user to type again
          act.step = "number";
          setPendingAction(chatId, act);
          const phone254 = savedPhone;

          // One-per-day lock ONLY for 250MB item
          if (item.key === "FREE_250MB" && redeemPhoneAlreadyUsedToday(phone254)) {
            clearPendingAction(chatId);
            return sendTracked(
              chatId,
              `🚫 This phone number already redeemed 250MB today.\n\nUse a different number or try again tomorrow.`,
              { ...mainMenuKeyboard(chatId) }
            );
          }

          // Block multiple pending redeems
          if (hasPendingRedeem(chatId)) {
            clearPendingAction(chatId);
            return sendTracked(chatId, "⏳ You already have a pending redeem request. Please wait for admin approval.", { ...mainMenuKeyboard(chatId) });
          }

          const cost = Number(item.cost || 0);
          const bal = getPoints(chatId);
          if (bal < cost) {
            clearPendingAction(chatId);
            return sendTracked(chatId, `❌ Not enough points.\nYou have: ${bal.toFixed(2)} pts\nNeed: ${cost} pts`, { ...mainMenuKeyboard(chatId) });
          }

          // Reserve points
          deductPoints(chatId, cost);

          // Create request
          const reqId = `RDM-${Date.now()}-${chatId}`;
          const u = getUser(chatId);
          const totalPurchases = getTotalPurchases(u);

          const req = {
            reqId,
            chatId,
            name: `${msg.from?.first_name || ""} ${msg.from?.last_name || ""}`.trim(),
            itemKey: item.key,
            itemLabel: item.label,
            cost,
            loadTo: formatTo07(phone254),
            totalReferrals: Number(u.referralSuccessCount || 0),
            totalSpent: Number(u.totalSpentKsh || 0),
            time: kenyaDateTime(),
            status: "pending",
          };

          setPendingRedeem(chatId, req);

          // Mark daily lock when request is submitted (only for 250MB)
          if (item.key === "FREE_250MB") markRedeemPhoneUsedToday(phone254);

          clearPendingAction(chatId);

          // Notify admin with inline buttons
          const adminText =
            `🎁 *Redeem Request*\n` +
            `ChatID: \`${mdEscape(chatId)}\`\n` +
            `User: *${mdEscape(req.name || "User")}*\n` +
            `Item: *${mdEscape(req.itemLabel)}*\n` +
            `Cost: *${mdEscape(cost)} pts*\n` +
            `Load To: *${mdEscape(req.loadTo)}*\n` +
            `Total purchases: *${mdEscape(totalPurchases)}*\n` +
            `Time: \`${mdEscape(req.time)}\`\n\n` +
            `Approve or cancel:`;

          try {
            

  const sent = await bot.sendMessage(ADMIN_ID, adminText, {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "✅ Accept", callback_data: `redeem_accept:${reqId}` }],
                  [{ text: "❌ Cancel", callback_data: `redeem_decline:${reqId}` }],
                ],
              },
            });
          } catch (e) {
            // Refund if admin notification fails
            addPoints(chatId, cost);
            clearPendingRedeem(chatId);
            return sendTracked(chatId, `⚠️ Failed to submit redeem request. Points refunded: ${cost} pts`, { ...mainMenuKeyboard(chatId) });
          }

          return sendTracked(
            chatId,
            `✅ Redemption request submitted!\n\nItem: ${item.label}\nLoad to: ${maskPhone(phone254)}\nPoints reserved: ${cost}\nRemaining: ${getPoints(chatId).toFixed(2)} pts\n\nWaiting for admin approval…`,
            { ...mainMenuKeyboard(chatId) }
          );
        }

        // If no saved phone → ask user to enter phone (original behavior)
        act.step = "number";
        setPendingAction(chatId, act);
        return sendTracked(chatId, "📱 Enter the phone number to load (07/01/254...).", { ...mainMenuKeyboard(chatId) });
      }
      return sendTracked(chatId, "Tap ✅ Confirm or ❌ Cancel.", yesNoKeyboard());

    }

    if (act.step === "number") {
      const phone254 = normalizePhone(text);
      if (!phone254) return sendTracked(chatId, "❌ Invalid phone. Use 07/01/2547/2541 format.", { ...mainMenuKeyboard(chatId) });

      // One-per-day lock ONLY for 250MB item
      if (item.key === "FREE_250MB" && redeemPhoneAlreadyUsedToday(phone254)) {
        clearPendingAction(chatId);
        return sendTracked(
          chatId,
          `🚫 This phone number already redeemed 250MB today.\n\nUse a different number or try again tomorrow.`,
          { ...mainMenuKeyboard(chatId) }
        );
      }

      // Block multiple pending redeems
      if (hasPendingRedeem(chatId)) {
        clearPendingAction(chatId);
        return sendTracked(chatId, "⏳ You already have a pending redeem request. Please wait for admin approval.", { ...mainMenuKeyboard(chatId) });
      }

      const cost = Number(item.cost || 0);
      const bal = getPoints(chatId);
      if (bal < cost) {
        clearPendingAction(chatId);
        return sendTracked(chatId, `❌ Not enough points.\nYou have: ${bal.toFixed(2)} pts\nNeed: ${cost} pts`, { ...mainMenuKeyboard(chatId) });
      }

      // Reserve points
      deductPoints(chatId, cost);

      // Create request
      const reqId = `RDM-${Date.now()}-${chatId}`;
      const u = getUser(chatId);
      const totalPurchases = getTotalPurchases(u);

      const req = {
        reqId,
        chatId,
        name: `${msg.from?.first_name || ""} ${msg.from?.last_name || ""}`.trim(),
        itemKey: item.key,
        itemLabel: item.label,
        cost,
        loadTo: formatTo07(phone254),
        totalReferrals: Number(u.referralSuccessCount || 0),
        totalSpent: Number(u.totalSpentKsh || 0),
        time: kenyaDateTime(),
        status: "pending",
      };

      setPendingRedeem(chatId, req);

      // Mark daily lock when request is submitted (only for 250MB)
      if (item.key === "FREE_250MB") markRedeemPhoneUsedToday(phone254);

      clearPendingAction(chatId);

      // Notify admin with inline buttons
      const adminText =
        `🎁 *Redeem Request*\n` +
        `ChatID: \`${mdEscape(chatId)}\`\n` +
        `User: *${mdEscape(req.name || "User")}*\n` +
        `Item: *${mdEscape(req.itemLabel)}*\n` +
        `Cost: *${mdEscape(cost)} pts*\n` +
        `Load To: *${mdEscape(req.loadTo)}*\n` +
        `Total purchases: *${mdEscape(totalPurchases)}*\n` +
        `Time: \`${mdEscape(req.time)}\`\n\n` +
        `Approve or cancel:`;

      try {
        

  const sent = await bot.sendMessage(ADMIN_ID, adminText, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Accept", callback_data: `redeem_accept:${reqId}` }],
              [{ text: "❌ Cancel", callback_data: `redeem_decline:${reqId}` }],
            ],
          },
        });
      } catch (e) {
        // Refund if admin notification fails
        addPoints(chatId, cost);
        clearPendingRedeem(chatId);
        return sendTracked(chatId, `⚠️ Failed to submit redeem request. Points refunded: ${cost} pts`, { ...mainMenuKeyboard(chatId) });
      }

      return sendTracked(
        chatId,
        `✅ Redemption request submitted!\n\nItem: ${item.label}\nLoad to: ${maskPhone(phone254)}\nPoints reserved: ${cost}\nRemaining: ${getPoints(chatId).toFixed(2)} pts\n\nWaiting for admin approval…`,
        { ...mainMenuKeyboard(chatId) }
      );
    }
  }


// Withdraw Back Button
if (text === "⬅ Withdraw Menu") {
  return sendTracked(
    chatId,
    `💸 Withdraw Points

Your balance: ${getPoints(chatId).toFixed(2)} pts

Choose amount to withdraw:`,
    withdrawKeyboard()
  );
}

// ===================== GLOBAL BUTTONS =====================

  if (text === "⬅ Back") {
    sessions.delete(chatId);
    supportState.delete(String(chatId));
    clearPendingAction(chatId);
    return sendTracked(chatId, "⬅ Back to main menu.", { ...mainMenuKeyboard(chatId) });
  }

  if (text === "❌ Cancel") {
    sessions.delete(chatId);
    supportState.delete(String(chatId));
    clearPendingAction(chatId);
    adminState.delete(String(chatId));
    adminReplyState.delete(String(chatId));
    return sendTracked(chatId, "❌ Cancelled.", { reply_markup: { remove_keyboard: true } });
  }

  if (text === "ℹ️ Help") return sendTracked(chatId, helpText(), { ...mainMenuKeyboard(chatId) });

  
  if (text === "🔗 My Referral") {
    const BOT_USERNAME = "bingwa1_bot";
    const referralCommand = `/start ref_${chatId}`;
    const referralLink = `https://t.me/${BOT_USERNAME}?start=ref_${chatId}-telegram`;

    const u = getUser(chatId);
    const totalReferrals = Number(u.referralSuccessCount || 0);

    // Calculate total earned from all referred users (2% of their total spent)
    let totalEarned = 0;
    for (const [cid, user] of Object.entries(db.users || {})) {
      if (user.inviterId === String(chatId)) {
        totalEarned += Number(user.totalSpentKsh || 0) * 0.02;
      }
    }

    return sendTracked(
      chatId,
      `🔗 *Your Referral:*

` +
      `Use: \`${referralCommand}\` (share this code)

` +
      `Or
${referralLink}

` +
      `⭐ Your points: *${u.points.toFixed(2)} pts*
` +
      `👤 Total referrals: *${totalReferrals}*
` +
      `🤑 Total earned: *${totalEarned.toFixed(0)} KSH*

` +
      `📌 Rule: You earn when your referred user completes a successful purchase.`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
    );
  }


  // ===================== REDEEM DISABLED =====================
  if (text === "🎁 Redeem Points") {
    return sendTracked(chatId, "🚫 Redeem is disabled.", { ...mainMenuKeyboard(chatId) });
  }
  if (text === "1️⃣ 20 free SMS (5 pts)" || text === "2️⃣ 250MB free (20 pts)" || text === "3️⃣ 20mins midnight free (25 pts)") {
    return sendTracked(chatId, "🚫 Redeem is disabled.", { ...mainMenuKeyboard(chatId) });
  }






  if (text === "🛒 Buy Offers") {
    sessions.set(chatId, { step: "category", category: null, pkgKey: null, createdAt: Date.now() });
    await sendBannerIfAvailable(chatId);
    await sendTracked(chatId, packagesOverviewText(), { parse_mode: "Markdown" });
    return sendTracked(chatId, "✅ Choose a category:", categoriesKeyboard());
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




// ===================== WITHDRAW RATE =====================
// 100 pts = 70 KES  →  1 pt = 0.7 KES
// ✅ Withdraw unlock rule: user must spend at least 250 KSH before making a withdrawal request (admin bypass)
const MIN_WITHDRAW_SPEND = 300;
function pointsToKes(pts) {
  return Number(pts || 0) * 0.7;
}

// ===================== WITHDRAW FLOW =====================

if (text === "💸 Withdraw Points") {
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
      `🚫 Withdrawal Locked

You must spend at least *Ksh ${MIN_WITHDRAW_SPEND}* before making a withdrawal request.

💰 Total spent: Ksh ${spent}
🟡 Remaining to unlock: Ksh ${remaining}

Keep buying to unlock withdrawals.`,
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
    return sendTracked(chatId, `🚫 Withdrawal Locked. Spend at least Ksh ${MIN_WITHDRAW_SPEND} first.

Total spent: Ksh ${spent}
Remaining: Ksh ${remaining}`, { ...mainMenuKeyboard(chatId) });
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
          { text: "✅ Approve", callback_data: `withdraw_accept:${reqId}` },
          { text: "❌ Decline", callback_data: `withdraw_decline:${reqId}` },
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

  const msgText =
    `✅ Selected:\n*${pkg.label}*\n\n` +
    (hasSaved 
      ? `📱 Saved number: *${maskPhone(savedPhone)}*\n\n` 
      : `📱 No saved phone yet.\n\n`) +
    `Choose:\n• ✅ Proceed (use saved number)\n• 📞 Change Number`;

  return sendTracked(chatId, msgText, { 
    parse_mode: "Markdown", 
    ...confirmKeyboard(hasSaved) 
  });
}  // ✅ THIS WAS MISSING
    // STEP 3: CONFIRM
    if (s.step === "confirm") {
      const pkg = findPackageByLabel(s.category, s.pkgKey);
      if (!pkg) {
        sessions.delete(chatId);
        return sendTracked(chatId, "❌ Package missing. Tap 🛒 Buy Offers again.", { ...mainMenuKeyboard(chatId) });
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
        if (!isAdmin(chatId) && s.category === "Bingwa Deals" && bingwaAlreadyPurchasedToday(savedPhone)) {
          sessions.delete(chatId);
          return sendTracked(
            chatId,
            `🚫 *Bingwa Deals limit reached*\nNumber: *${maskPhone(savedPhone)}*\nThis number already bought Bingwa today.\n\nUse a different number or try again tomorrow.`,
            { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
          );
        }

        const sig = makeSig({ category: s.category, pkgLabel: pkg.label, phone254: savedPhone });
        const spam = checkAndMarkSpam(chatId, sig, savedPhone);
        if (!spam.ok) return sendTracked(chatId, spam.reason, { ...mainMenuKeyboard(chatId) });

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
                // If already marked processed success/fail, do nothing
                if (alreadyProcessed(ref) || alreadyProcessed(`FAIL-${ref}`)) return;
                await sendTracked(
                  chatId,
                  `⏳ Reminder: You haven\'t completed the payment yet.\n\nTap 🔄 Resend STK if you didn\'t receive the prompt.\n\nHelp: ${HELP_PHONE}`,
                  { ...mainMenuKeyboard(chatId) }
                );
              } catch (_) {}
            }, 2 * 60 * 1000);
            stkReminderTimers.set(ref, t);
          } catch (_) {}

          sessions.delete(chatId);

          // ✅ REMOVED permanently: "✅ STK Sent OK ..." admin message

          return sendTracked(
            chatId,
            `✅ STK sent!\n\nOffer: ${pkg.label}\nPay: Ksh ${pkg.price}\nFrom: ${maskPhone(savedPhone)}\nChannel: ${channelId}\nRef: ${ref}\nTime: ${nowISO()}\n\nWhen payment is successful you will receive a confirmation message here.\n\nIf delay: ${HELP_PHONE}`,
            { ...mainMenuKeyboard(chatId) }
          );
        } catch (err) {
          sessions.delete(chatId);
          deletePendingPayment(ref);

          await notifyAdmin(
            `❌ *STK Failed*\nChatID: \`${mdEscape(chatId)}\`\nRef: \`${mdEscape(ref)}\`\nError: \`${mdEscape(
              String(err.message || err)
            )}\``
          );
          return sendTracked(chatId, `⚠️ Error: ${err.message}`, { ...mainMenuKeyboard(chatId) });
        }
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
        `👋 We miss you!\n\nCome back today and grab your best offer.\n\n🎁 Tip: Share your referral link to earn points on every successful purchase!`,
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
// 🚩 24HR SINGLE ACCOUNT PER PHONE ENFORCEMENT
// ===============================================================

// Each phone number can only be used by ONE Telegram account within 24 hours.
// If another account attempts to use it, admin approval is required.

if (!db.phoneAccountUsage || typeof db.phoneAccountUsage !== "object") {
  db.phoneAccountUsage = {};
  saveDB();
}

if (!db.pendingPhoneOverrides || typeof db.pendingPhoneOverrides !== "object") {
  db.pendingPhoneOverrides = {};
  saveDB();
}

const PHONE_LOCK_WINDOW_MS = 24 * 60 * 60 * 1000;

function canUsePhone(chatId, phone254) {
  const rec = db.phoneAccountUsage[phone254];
  if (!rec) return { ok: true };

  const sameUser = String(rec.chatId) === String(chatId);
  const withinWindow = Date.now() - Number(rec.lastUsed || 0) < PHONE_LOCK_WINDOW_MS;

  if (sameUser) return { ok: true };
  if (!withinWindow) return { ok: true };

  return { ok: false, lockedBy: rec.chatId };
}

function markPhoneUsage(chatId, phone254) {
  db.phoneAccountUsage[phone254] = {
    chatId: String(chatId),
    lastUsed: Date.now()
  };
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

    throw new Error("Phone locked. Awaiting admin approval.");
  }

  markPhoneUsage(chatId, phone);
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
    markPhoneUsage(req.requestingChatId, req.phone);

    await bot.sendMessage(
      Number(req.requestingChatId),
      `✅ Admin approved phone usage override. You may proceed.`,
      { reply_markup: { remove_keyboard: true } }
    ).catch(() => {});

    await bot.sendMessage(q.message.chat.id, "✅ Phone override approved.").catch(() => {});
  }

  if (action === "phone_decline") {
    req.status = "declined";

    await bot.sendMessage(
      Number(req.requestingChatId),
      `❌ Phone usage denied. This number was used by another account in last 24 hours.`
    ).catch(() => {});

    await bot.sendMessage(q.message.chat.id, "❌ Phone override declined.").catch(() => {});
  }

  saveDB();

  // remove buttons + delete admin request message
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
  await bot.deleteMessage(q.message.chat.id, q.message.message_id).catch(() => {});
  await bot.answerCallbackQuery(q.id).catch(() => {});
});

console.log("🚩 24hr phone lock system enabled");




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

  bot.sendMessage(
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

// Ensure totalSpentKsh updates on successful purchase
const __originalRecordRevenueMinSpend = recordSuccessfulRevenue;
recordSuccessfulRevenue = function(pending) {
  if (pending && pending.chatId && pending.price) {
    const user = getUser(pending.chatId);
    user.totalSpentKsh = Number(user.totalSpentKsh || 0) + Number(pending.price || 0);
    saveDB();
  }
  __originalRecordRevenueMinSpend(pending);
};

console.log("💳 Minimum 300 KSH withdrawal requirement enforced.");

