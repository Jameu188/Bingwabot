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
const PAYHERO_CHANNEL_ID_BUSINESS = PAYHERO_CHANNEL_ID_DATA; // Business subscription uses same channel as Bingwa/Data

// ✅ MUST MATCH YOUR LIVE URL
const PAYHERO_CALLBACK_URL = "https://bingwabot-4.onrender.com/payhero/callback";

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
  BUS_1M: { label: "Business 1 Month", price: 105, months: 1 },
  BUS_3M: { label: "Business 3 Months", price: 260, months: 3 },
};


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
        scheduledBroadcasts: [],
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
  if (!db0.referralsByDay || typeof db0.referralsByDay !== "object") db0.referralsByDay = {};
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

  return db0;
}

db = loadDB();


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
  db.campaign.heading = db.campaign.heading || "WEEKLY DRAW";
  db.campaign.status = db.campaign.status || (db.campaign.enabled ? "RUNNING" : "OFF");
  db.campaign.winners = db.campaign.winners || [];
  db.campaign.entries = db.campaign.entries && typeof db.campaign.entries === "object" ? db.campaign.entries : {};
  db.campaign.image = db.campaign.image || ""; // file_id or URL

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
      };

  // Per-campaign tracking maps (successful purchases only)
  db.campaign.spend = db.campaign.spend && typeof db.campaign.spend === "object" ? db.campaign.spend : {};
  db.campaign.withdrawReq = db.campaign.withdrawReq && typeof db.campaign.withdrawReq === "object" ? db.campaign.withdrawReq : {};
  db.campaign.offerCount = db.campaign.offerCount && typeof db.campaign.offerCount === "object" ? db.campaign.offerCount : {};

  return db.campaign;
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
      u.name = displayName(u, chatId);
    }
    try { saveDB(); } catch (_) {}
  }
    function weeklyDrawUserMenuKeyboard(chatId, page = "menu") {
    const opted = isWeeklyDrawOptedIn(chatId);

    const rows = [];

    // Sub-pages use a Back button to return to the campaign menu
    if (page === "more") {
      rows.push([{ text: "⬅️ BACK", callback_data: "wdusr:back" }]);
      // keep opt toggle visible on info pages too
      if (!opted) rows.push([{ text: "✅ JOIN", callback_data: "wdusr:optin" }]);
      else rows.push([{ text: "🚫 LEAVE", callback_data: "wdusr:optout" }]);
      rows.push([{ text: "🏆 PREVIOUS WINNERS", callback_data: "wdusr:prev" }]);
      return { reply_markup: { inline_keyboard: rows } };
    }

    if (page === "prev") {
      rows.push([{ text: "⬅️ BACK", callback_data: "wdusr:back" }]);
      if (!opted) rows.push([{ text: "✅ JOIN", callback_data: "wdusr:optin" }]);
      else rows.push([{ text: "🚫 LEAVE", callback_data: "wdusr:optout" }]);
      rows.push([{ text: "ℹ️ MORE…", callback_data: "wdusr:more" }]);
      return { reply_markup: { inline_keyboard: rows } };
    }

    // Main campaign menu
    if (!opted) rows.push([{ text: "✅ JOIN", callback_data: "wdusr:optin" }]);
    else rows.push([{ text: "🚫 LEAVE", callback_data: "wdusr:optout" }]);

    rows.push(
      [{ text: "ℹ️ MORE…", callback_data: "wdusr:more" }],
      [{ text: "🏆 PREVIOUS WINNERS", callback_data: "wdusr:prev" }]
    );

    return { reply_markup: { inline_keyboard: rows } };
  }



function weeklyDrawQualificationsInfoLines() {
  const c = ensureWeeklyDrawObject();
  const qcfg = (c.qualifications && typeof c.qualifications === "object") ? c.qualifications : {};
  const lines = [];

  const add = (txt) => { if (txt) lines.push("• " + txt); };

  if (qcfg.ageDays?.enabled) add(`Stay at least ${Number(qcfg.ageDays.days || 0)} day(s) in the bot`);
  if (qcfg.purchases?.enabled) add(`${Number(qcfg.purchases.count || 0)}+ successful purchases of ${Number(qcfg.purchases.minAmount || 20)} KSH or more`);
  if (qcfg.activeReferrals?.enabled) add(`${Number(qcfg.activeReferrals.count || 0)} active referrals (referred users with at least 1 successful purchase)`);
  if (qcfg.spend?.enabled) add(`Spend at least ${Number(qcfg.spend.amount || 0)} KSH (successful purchases only)`);
  if (qcfg.withdraw?.enabled) add(`${Number(qcfg.withdraw.count || 0)} withdrawal request(s)`);
  if (qcfg.offer?.enabled) {
    const match = String(qcfg.offer.match || "").trim();
    const need = Number(qcfg.offer.count || 1);
    add(match ? `Buy "${match}" ${need} time(s)` : `Buy the required offer (set by admin)`);
  }

  return lines.length ? lines.join("\n") : "• No qualification rules set (everyone qualifies).";
}

function weeklyDrawPurchasesCountText() {
  const c = ensureWeeklyDrawObject();
  const qcfg = c.qualifications || {};
  if (qcfg?.purchases?.enabled) {
    return `✅ Purchases ≥${Number(qcfg.purchases.minAmount || 20)} KSH count toward qualification.`;
  }
  return `✅ Any successful purchase earns tickets.`;
}
function weeklyDrawMoreText() {
  const c = ensureWeeklyDrawObject();
  const heading = String(c.heading || "WEEKLY DRAW").toUpperCase();
  const p = c.prizes || {};
  const first = Number(p.first || 0);
  const second = Number(p.second || 0);
  const third = Number(p.third || 0);
  const total = first + second + third;
  const prizesTxt = `🥇 1st: ${first} KSH
🥈 2nd: ${second} KSH
🥉 3rd: ${third} KSH
💰 Total: ${total} KSH`;
  const periodTxt = (c.startAt && c.endAt)
    ? `${new Date(c.startAt).toISOString().slice(0,10)} → ${new Date(c.endAt).toISOString().slice(0,10)}`
    : "Not set yet";

  const qualTxt = weeklyDrawQualificationsInfoLines();

  return (
    `🎉 ${heading}

` +
    `What is this?
` +
    `Weekly Draw is a giveaway where you earn tickets from successful purchases. More tickets = higher chance to win.

` +
    `Prizes (current):
${prizesTxt}

` +
    `Period:
${periodTxt}

` +
    `How to participate:
` +
    `1) Tap ✅ JOIN (so you receive ticket updates, reminders & winner announcements)
` +
    `2) Buy offers — every 5 KSH = 1 ticket (Business gets +12% bonus tickets)
` +
    `3) Invite friends using 🔗 My Referral

` +
    `What purchases count?
` +
    `✅ Only successful payments.
` +
    `✅ Purchase must be ≥ 5 KSH to earn tickets.
` +
    `${weeklyDrawPurchasesCountText()}

` +
    `How to qualify (current rules):
${qualTxt}

` +
    `What is an active referral?
` +
    `A person who joined using your referral link and has made at least one successful purchase.

` +
    `Tip:
` +
    `Buy more to earn more tickets and climb the Top Participants list.`
  );
}


function weeklyDrawLastWinnersText() {
    const c = ensureWeeklyDrawObject();
    const last = c.lastEnded || null; // { endedAt, heading, prizes, image, winners }
    if (!last || !Array.isArray(last.winners) || !last.winners.length) return "";
    const date = last.endedAt ? new Date(last.endedAt).toISOString().slice(0,10) : "";
    const head = String(last.heading || "WEEKLY DRAW").toUpperCase();
    const p = last.prizes || {};
    const prizeLine = `🥇 ${Number(p.first||0)} • 🥈 ${Number(p.second||0)} • 🥉 ${Number(p.third||0)} (KSH)`;
    const lines = last.winners.slice(0,3).map((w,i)=>{
      const pos = i===0?"🥇":i===1?"🥈":"🥉";
      return `${pos} ${w.name || w.chatId} — Ksh ${Number(w.prize||0)} (${w.paid ? "Paid ✅" : "Pending ⏳"})`;
    }).join("\n");
    return `

🏁 Previous Winners (${date})
${head}
Prizes: ${prizeLine}
${lines}`;
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
        const name = displayName(u, x.cid);
        const q = weeklyDrawQualification(x.cid);
        return { ...x, name, qualified: q.qualified };
      })
      .filter((x) => x.qualified)
      .sort((a, b) => b.tickets - a.tickets)
      .slice(0, 10);

    const listLines = ranked.length
      ? ranked.map((r, i) => `${i + 1}️⃣ ${r.name} — ${r.tickets} tickets`).join("\n")
      : "No qualified participants yet.";

    let winnersBlock = "";
    if (status === "ENDED" && Array.isArray(c.winners) && c.winners.length) {
      const lines = c.winners.slice(0, 3).map((w, i) => {
        const pos = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
        const paid = w.paid ? "Paid ✅" : "Pending ⏳";
        return `${pos} ${w.name || w.chatId} — Ksh ${Number(w.prize || 0)} (${paid})`;
      });
      winnersBlock = `\n\n🏁 Winners (Top 3)\n${lines.join("\n")}`;
    }

    const optedLine = isWeeklyDrawOptedIn(chatId)
      ? "✅ You are opted in (you will receive updates)."
      : "ℹ️ You are not opted in (no campaign messages). Tap ✅ JOIN to participate.";

    const caption =
      `🎉 ${heading}\n` +
      `Status: ${status}\n` +
      `⏳ Ends in: ${countdown}${winnersBlock}\n\n` +
      `${optedLine}\n\n` +
      `🏆 Top Participants (Top 10)\n${listLines}`;

    return caption;
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
        [{ text: "🏁 End & Announce", callback_data: "wdadm:end" }, { text: "🔄 Restart", callback_data: "wdadm:restart" }],
        [{ text: "💰 Pay Winners", callback_data: "wdadm:pay" }],
        [{ text: "📝 Set Prizes", callback_data: "wdadm:set_prizes" }, { text: "🗓 Set Period", callback_data: "wdadm:set_period" }],
        [{ text: "✅ Qualifications", callback_data: "wdadm:quals" }],
        [{ text: "🖼 Set Image", callback_data: "wdadm:set_image" }],
        [{ text: "📝 Set Heading", callback_data: "wdadm:set_heading" }, { text: "📋 Status", callback_data: "wdadm:status" }],
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
        row("activeReferrals", "Active Referrals"),
        row("spend", "Spend (KSH)"),
        row("withdraw", "Withdraw Requests"),
        row("offer", "Specific Offer"),
        [{ text: "⬅️ Back", callback_data: "wdadm:menu" }],
      ],
    },
  };
}

function qualificationPromptFor(key) {
  if (key === "ageDays") return "🗓 Send required days in bot (e.g., 3)";
  if (key === "purchases") return "🛒 Send: <count> <minAmount>  (example: 5 20)";
  if (key === "activeReferrals") return "👥 Send required active referrals (e.g., 3)";
  if (key === "spend") return "💰 Send required spend in KSH (e.g., 300)";
  if (key === "withdraw") return "💸 Send required withdrawal requests (e.g., 1)";
  if (key === "offer") return "🎯 Send offer match text + optional count.\nExample: 99ksh 1gb | 1\n(Format: <text> | <count>)";
  return "Send value";
}

function setQualificationValue(c, key, inputText) {
  c.qualifications = c.qualifications || {};
  c.qualifications[key] = c.qualifications[key] || { enabled: true };

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
    ? winners.map((w, i) => `${i+1}. ${w.name || w.chatId} — ${w.prize} KSH (${w.paid ? "Paid ✅" : "Pending"})`).join("\n")
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
  const winners = Array.isArray(c.winners) ? c.winners.slice(0, 3) : [];
  const rows = [];
  if (!winners.length) {
    rows.push([{ text: "⬅ Back", callback_data: "wdadm:menu" }]);
    return { reply_markup: { inline_keyboard: rows } };
  }
  for (const w of winners) {
    const label = `${w.paid ? "✅ Paid" : "⏳ Pending"} — ${w.name || w.chatId} (${w.prize}KSH)`;
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
  // Business bonus tickets: +12% while business active
  try {
    if (typeof isBusinessActive === "function" && isBusinessActive(chatId)) {
      t = Math.floor(t * 1.12);
      if (t < baseTickets) t = baseTickets;
    }
  } catch (_) {}
  return t;
}
function addWeeklyDrawTicketsFromPurchase(chatId, amountKsh) {
  const c = ensureWeeklyDrawObject();
  if (!c.enabled || String(c.status || "").toUpperCase() !== "RUNNING") return { earned: 0, total: 0 };

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
    try { if (isWeeklyDrawOptedIn(chatId)) await bot.sendMessage(chatId, messageText, mainMenuKeyboard(chatId)); } catch (_) {}
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
    candidates.push({ chatId, tickets: Number(tickets || 0) });
  }
  candidates.sort((a, b) => (b.tickets - a.tickets));

  const prizes = c.prizes || { first: 250, second: 150, third: 100 };
  const top3 = candidates.slice(0, 3);
  const winners = [];
  if (top3[0]) winners.push({ chatId: top3[0].chatId, tickets: top3[0].tickets, prize: Number(prizes.first || 0), paid: false });
  if (top3[1]) winners.push({ chatId: top3[1].chatId, tickets: top3[1].tickets, prize: Number(prizes.second || 0), paid: false });
  if (top3[2]) winners.push({ chatId: top3[2].chatId, tickets: top3[2].tickets, prize: Number(prizes.third || 0), paid: false });

  // Attach display names (best-effort)
  for (const w of winners) {
    try {
      const u = getUser(w.chatId);
      w.name = displayName(u, w.chatId);
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
      inviterSetAt: 0,
      lastReferralRewardDay: "",
      points: 0,
      totalSpentKsh: 0,
      referralSuccessCount: 0,
      referralCounted: false,
      pendingAction: null,

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
    };
  }
  if (db.users[cid].pendingAction === undefined) db.users[cid].pendingAction = null;
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
    saveDB();
    return false;
  }
  return true;
}

function activateBusiness(chatId, months) {
  const u = getUser(chatId);
  const now = Date.now();
  const durationMs = Number(months || 0) * 30 * 24 * 60 * 60 * 1000;

  u.accountType = "business";
  u.subscriptionStart = now;
  u.subscriptionExpiry = now + durationMs;
  // Do NOT reset businessIntroShown (announcement should show only once ever)
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

var db = {};

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

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
  };

  if (action === "optin") {
    setWeeklyDrawOptIn(actorId, true);
    await bot.answerCallbackQuery(q.id, { text: "🎉 You joined Weekly Draw! Keep buying to earn more tickets.", show_alert: true }).catch(() => {});
    await refreshMenu();
    return;
  }

  if (action === "optout") {
    setWeeklyDrawOptIn(actorId, false);
    await bot.answerCallbackQuery(q.id, { text: "😔 You left Weekly Draw. You will no longer receive campaign updates.", show_alert: true }).catch(() => {});
    await refreshMenu();
    return;
  }

    if (action === "more") {
    await bot.answerCallbackQuery(q.id, { text: "More…" }).catch(() => {});
    const txt = weeklyDrawMoreText() + weeklyDrawLastWinnersText();
    await editInlineMessage(q, txt, weeklyDrawUserMenuKeyboard(actorId, "more"));
    return;
  }

  if (action === "prev") {
    await bot.answerCallbackQuery(q.id, { text: "Previous winners" }).catch(() => {});
    const txt = weeklyDrawLastWinnersText().trim() || "No previous winners yet.";
    await editInlineMessage(q, txt, weeklyDrawUserMenuKeyboard(actorId, "prev"));
    return;
  }

  
  if (action === "back") {
    await bot.answerCallbackQuery(q.id, { text: "Back" }).catch(() => {});
    const caption = buildWeeklyDrawMainCaption(actorId);
    await editInlineMessage(q, caption, weeklyDrawUserMenuKeyboard(actorId, "menu"));
    return;
  }

if (action === "refresh") {
    await bot.answerCallbackQuery(q.id, { text: "Refreshing…" }).catch(() => {});
    await refreshMenu();
    // Re-render handled elsewhere (user can tap 🎉 WEEKLY DRAW again)
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

  if (action === "set_period") {
    setWeeklyDrawAdminState(chatId, { mode: "set_period", messageId: q.message?.message_id });
    await bot.answerCallbackQuery(q.id, { text: "Send period" }).catch(() => {});
    await editInlineMessage(q, "🗓 Send period as: YYYY-MM-DD YYYY-MM-DD", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "wdadm:menu" }]] } });
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
    await editInlineMessage(q, "💰 Tap a winner to toggle Paid/Pending.", weeklyDrawPayWinnersKeyboard());
    return;
  }

  if (action === "toggle_paid") {
    const target = data.split(":")[2] || "";
    const winners = Array.isArray(c.winners) ? c.winners : [];
    const w = winners.find((x) => String(x.chatId) === String(target));
    if (w) {
      w.paid = !w.paid;
      try { saveDB(); } catch (_) {}
      await bot.answerCallbackQuery(q.id, { text: w.paid ? "Marked Paid" : "Marked Pending" }).catch(() => {});
    } else {
      await bot.answerCallbackQuery(q.id, { text: "Winner not found" }).catch(() => {});
    }
    await editInlineMessage(q, "💰 Tap a winner to toggle Paid/Pending.", weeklyDrawPayWinnersKeyboard());
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
      return sendTracked(chatId, "ℹ️ No previous purchase found yet. Buy any offer first.", { ...mainMenuKeyboard(chatId) });
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
      `🔁 *Buy Last Offer*\n\nCategory: *${mdEscape(lp.category)}*\nOffer: *${mdEscape(pkg.label)}*\nPrice: *Ksh ${mdEscape(String(pkg.price))}*\n\n✅ Tap Proceed to pay or Change Number.`,
      { parse_mode: "Markdown", ...confirmKeyboard(hasSaved) }
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
      { parse_mode: "Markdown", ...confirmKeyboard(hasSaved) }
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
        return sendTracked(chatId, "⚠️ This STK request expired. Please try again from 🛒 Buy Offers.", {
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
        return sendTracked(chatId, "⚠️ This STK request expired. Please try again from 🛒 Buy Offers.", {
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
      return sendTracked(chatId, section("CHOOSE CATEGORY") + "✅ Choose a category:", categoriesKeyboard());
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
    return sendTracked(chatId, section("CHOOSE CATEGORY") + "✅ Choose a category:", categoriesKeyboard());
  }

  if (s.step === "package") {
    if (!s.category) return sendTracked(chatId, section("CHOOSE CATEGORY") + "✅ Choose a category:", categoriesKeyboard());
    return sendTracked(chatId, section(String(s.category || "").toUpperCase()) + `👇 ${s.category} packages:`, packagesKeyboard(s.category));
  }

  if (s.step === "confirm") {
    if (!s.category) return sendTracked(chatId, section("CHOOSE CATEGORY") + "✅ Choose a category:", categoriesKeyboard());
    const pkg = findPackageByLabel(s.category, s.pkgKey);
    if (!pkg) return sendTracked(chatId, section(String(s.category || "").toUpperCase()) + `👇 ${s.category} packages:`, packagesKeyboard(s.category));

    const savedPhone = getUserPhone(chatId);
    const hasSaved = !!savedPhone;
    const msgText =
      `✅ Selected:\n*${pkg.label}*\n\n` +
      (hasSaved ? `📱 Saved number: *${maskPhone(savedPhone)}*\n\n` : `📱 Paste number.\n\n`) +
      `Choose:\n• ✅ Proceed (use saved number)\n• 📞 Change Number`;

    return sendTracked(chatId, msgText, { parse_mode: "Markdown", ...confirmKeyboard(hasSaved) });
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
}

function recordSuccessfulPurchase(chatId, category) {
  const u = getUser(chatId);
  ensureUserStats(u);
  const c = String(category || "");
  u.stats.categoryCounts[c] = Number(u.stats.categoryCounts[c] || 0) + 1;
  u.stats.lastPurchaseAt = Date.now();
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

  { cmd: "🛒 Buy Offers", desc: "Browse all categories & packages" },
  { cmd: "🔎 Search Offers", desc: "Search offers inside bot (if enabled)" },
  { cmd: "🔁 Buy Last Offer", desc: "Repeat your last successful purchase" },
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
  const keyboard = [];

  // WEEKLY DRAW (global visibility)
  if (db.campaign && db.campaign.enabled === true) {
    keyboard.push(["🎉 WEEKLY DRAW"]);
  }

  keyboard.push(["🛒 Buy Offers"]);

  if (chatId) {
    // Quick buttons (hide if no purchase in 2 days)
    const quick = getQuickCategories(chatId);
    for (const q of quick) keyboard.push([q.text]);
  }

  keyboard.push(
    ["💸 Withdraw Points"],
    ["🔗 My Referral", "ℹ️ Help"]
  );

// Admin shortcut
if (chatId && (typeof isAdmin === "function" && isAdmin(chatId))) {
  keyboard.push(["🎛 WEEKLY DRAW ADMIN"]);
}

  return { reply_markup: { keyboard, resize_keyboard: true } };
}

function categoriesKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["📦 Bingwa Deals", "∞ Unlimited Deals"],
        ["✉️ SMS Offers", "📞 Minutes"],
        ["⭐ Bonga Points", "🌀 Flex Deals"],
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


function packagesKeyboard(category) {
  const list = PACKAGES[category] || [];
  const rows = [];
  for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2).map((x) => x.label));
  rows.push([ PREV_BTN]);
  return { reply_markup: { keyboard: rows, resize_keyboard: true, one_time_keyboard: false } };
}

function confirmKeyboard(hasSavedPhone) {
  const rows = [];
  if (hasSavedPhone) rows.push(["✅ Proceed", "📞 Change Number"]);
  rows.push([PREV_BTN]);
  return { reply_markup: { keyboard: rows, resize_keyboard: true, one_time_keyboard: false } };
}

function redeemKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["1️⃣ 20 free SMS (5 pts)"],
        ["2️⃣ 250MB free (20 pts)"],
        ["3️⃣ 20mins midnight free (25 pts)"],
        ["⬅ Back", PREV_BTN],
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
        ["⬅ Back", PREV_BTN],
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


function sellKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["💼 Business 1 Month — Ksh 105"],
        ["💼 Business 3 Months — Ksh 260"],
        ["⬅ Back"],
      ],
      resize_keyboard: true,
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
    u.inviterSetAt = Date.now();
    saveDB();
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

      // ✅ Store per-transaction provider reference for CSV export
      recordSuccessfulTransaction(pending, externalRef, mpesaOut, when);

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
    activateBusiness(chatId, plan.months);
    await maybeShowBusinessIntroOnce(chatId);
  }
}

      deletePendingPayment(externalRef);
    }

    // ✅ Notify user (ONLY ONE MESSAGE on success)
    // Also track purchases and show Reference + Package + Total Purchases
    const user = getUser(chatId);
    const totalPurchases = Number(user.totalPurchases || 0) + 1;
    user.totalPurchases = totalPurchases;
    user.totalSpentKsh = Number(user.totalSpentKsh || 0) + Number(pending?.price || 0);
    saveDB();

    const referenceNumber = externalRef;
    const packageName = pending?.pkgLabel || "Unknown Package";

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

    // ✅ Save last successful purchase for 🔁 Buy Last Offer (data offers only)
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
        saveDB();

        // Update quick stats and clear STK failures
        recordSuccessfulPurchase(chatId, pending.category);
        recordOfferTrend(pending.category, pending.pkgLabel);
        clearStkFailures(chatId, pending.phone254);
      }
    } catch (_) {}
// Inline action buttons (Upgrade + Buy Last Offer + Buy Offers)
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
      inline_keyboard.push([{ text: "🔁 Buy Last Offer", callback_data: "ui:buy_last" }]);
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



// 🎉 WEEKLY DRAW: after every successful purchase (when campaign ON), show tickets + qualification status
try {
  const c = ensureWeeklyDrawObject();
  if (c.enabled === true && String(c.status || "").toUpperCase() === "RUNNING") {
    // Count qualification purchases (>=20 KSH)
    try {
      const uqd = getUser(chatId);
      uqd.qPurch20Count = Number(uqd.qPurch20Count || 0) + ((Number(pending?.price||0) >= 20) ? 1 : 0);
      if (uqd.createdAt === undefined || !uqd.createdAt) uqd.createdAt = uqd.createdAt || Date.now();
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
    try { saveDB(); } catch (_) {}
  }
} catch (_) {}

    await maybeAutoEndWeeklyDraw();
    await maybeBroadcastEndSoon3Days();

    const t = addWeeklyDrawTicketsFromPurchase(chatId, Number(pending?.price || 0));
    const qualTxt = weeklyDrawQualificationText(chatId);


    // Show earned tickets, totals, rank gap, and remaining requirements
    const rankLine = weeklyDrawRankGapText(chatId);
    const msg =
      `🎟 WEEKLY DRAW UPDATE

` +
      `Tickets earned: ${t.earned}
` +
      `Total tickets: ${t.total}
` +
      (rankLine ? (rankLine + `
`) : ``) +
      `⏳ Ends in: ${getCampaignCountdown()}

` +
      qualTxt;

    if (isWeeklyDrawOptedIn(chatId)) {
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

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();


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
        { parse_mode: "Markdown", ...confirmKeyboard(hasSaved) }
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
  const isStartCmd = /^\/start/i.test(text);

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
      `✅ You are on *Business Account*.\n\nExpiry: \`${mdEscape(exp)}\``,
      { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
    );
    return;
  }

  await sendTracked(
    chatId,
    `💼 *Business Account Subscription*\n\n` +
      `Choose a plan:\n` +
      `• Ksh 105 — 1 Month\n` +
      `• Ksh 260 — 3 Months\n\n` +
      `✅ Bingwa daily rule remains.\n` +
      `❌ Self-referral not allowed.`,
    { parse_mode: "Markdown", ...sellKeyboard() }
  );
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

// Plan selection buttons for /sell
if (text === "💼 Business 1 Month — Ksh 105" || text === "💼 Business 3 Months — Ksh 260") {
  const planKey = text.includes("1 Month") ? "BUS_1M" : "BUS_3M";
  const plan = BUSINESS_PLANS[planKey];

  if (!plan) {
    await sendTracked(chatId, "❌ Invalid plan. Type /sell again.", { ...mainMenuKeyboard(chatId) });
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
      channelId: PAYHERO_CHANNEL_ID_BUSINESS, // same as PAYHERO_CHANNEL_ID_DATA
    });
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

      
      // 🔎 Inline search button (opens inline mode in current chat)
      try {
        await bot.sendMessage(chatId, "🔎 Search offers inline:", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔎 Search Offers", switch_inline_query_current_chat: "" }]
            ]
          }
        });
      } catch (_) {}
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
      return sendTracked(chatId, section("CHOOSE CATEGORY") + "✅ Choose a category:", categoriesKeyboard());
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



// ✅ If user is changing number via /changenumber
if (act && act.type === "change_number") {
  const phone254 = normalizePhone(text);
  if (!phone254) {
    await sendTracked(chatId, "❌ Invalid phone. Use 07/01/2547/2541 format.", { ...mainMenuKeyboard(chatId) });
    return;
  }
  setUserPhone(chatId, phone254);
  clearPendingAction(chatId);

  await sendTracked(
    chatId,
    `✅ Number saved successfully.\n\n📞 New number: *${mdEscape(phone254)}*`,
    { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
  );
  return;
}

// ✅ If user is in /sell flow and needs to provide phone number
if (act && act.type === "sell_business" && act.planKey) {
  const phone254 = normalizePhone(text);
  if (!phone254) {
    await sendTracked(chatId, "❌ Invalid phone. Use 07/01/2547/2541 format.", { ...mainMenuKeyboard(chatId) });
    return;
  }

  setUserPhone(chatId, phone254);

  const plan = BUSINESS_PLANS[act.planKey];
  if (!plan) {
    clearPendingAction(chatId);
    await sendTracked(chatId, "❌ Invalid plan. Type /sell again.", { ...mainMenuKeyboard(chatId) });
    return;
  }

  clearPendingAction(chatId);

  const externalRef = makeExternalRef(chatId, "Business_Account", plan.price);

  addPendingPayment(externalRef, {
    chatId,
    category: "Business Account",
    pkgLabel: `${plan.label} (Ksh ${plan.price})`,
    phone254,
    price: plan.price,
    planKey: act.planKey,
  });

  await sendTracked(
    chatId,
    `📲 Sending STK for *${mdEscape(plan.label)}* (Ksh ${plan.price})…`,
    { parse_mode: "Markdown", ...mainMenuKeyboard(chatId) }
  );

  try {
    await payheroStkPush({
      amount: plan.price,
      phone: phone254,
      externalRef,
      channelId: PAYHERO_CHANNEL_ID_BUSINESS, // same as PAYHERO_CHANNEL_ID_DATA
    });
  } catch (e) {
    deletePendingPayment(externalRef);
    await sendTracked(chatId, `❌ STK failed: ${mdEscape(e?.message || e)}\nHelp: ${HELP_PHONE}`, {
      parse_mode: "Markdown",
      ...mainMenuKeyboard(chatId),
    });
  }
  return;
}

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
          if (item.key === "FREE_250MB" && !isBusinessActive(chatId) && redeemPhoneAlreadyUsedToday(phone254)) {
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
      if (item.key === "FREE_250MB" && !isBusinessActive(chatId) && redeemPhoneAlreadyUsedToday(phone254)) {
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
  const referralCode = `ref_${chatId}`;
  const referralCommand = `/start ${referralCode}`;
  const referralLink = `https://t.me/${BOT_USERNAME}?start=${referralCode}-telegram`;

  const u = getUser(chatId);
  const totalReferrals = Number(u.referralSuccessCount || 0);

  // Calculate total earned from all referred users (2% of their total spent)
  let totalEarned = 0;
  for (const [, user] of Object.entries(db.users || {})) {
    if (user && user.inviterId === String(chatId)) {
      totalEarned += Number(user.totalSpentKsh || 0) * 0.02;
    }
  }

  const shareText =
    `Join Bingwa Mtaani using my referral and earn rewards after your first successful purchase:
${referralLink}`;
  const shareUrl =
    `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(shareText)}`;

  const leaderboardText = formatTodayLeaderboard(10);

  return sendTracked(
      chatId,
      `🔗 *Your Referral:*

Use: \`${referralCommand}\` (share this code)

Or
${referralLink}

⭐ Your points: *${u.points.toFixed(2)} pts*
👤 Total referrals: *${totalReferrals}*
🤑 Total earned: *${totalEarned.toFixed(0)} KSH*

💸 Use "💸 Withdraw Points" to withdraw.

📌 Rule: You earn when your referred user completes a successful purchase.`,
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






  if (text === "🛒 Buy Offers") {
    pushPrev(chatId, sessions.get(chatId) || { step: null });
    sessions.set(chatId, { step: "category", category: null, pkgKey: null, createdAt: Date.now() });
    await sendBannerIfAvailable(chatId);
    await sendTracked(chatId, packagesOverviewText(), { parse_mode: "Markdown" });
    return sendTracked(chatId, section("CHOOSE CATEGORY") + "✅ Choose a category:", categoriesKeyboard());
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

  if (text === "🔁 Buy Last Offer") {
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
      `🔁 *Buy Last Offer*

Category: *${mdEscape(s2.category)}*
Offer: *${mdEscape(pkg.label)}*
Price: *Ksh ${mdEscape(String(pkg.price))}*

✅ Tap Proceed to pay or Change Number.`,
      { parse_mode: "Markdown", ...confirmKeyboard(hasSaved) }
    );
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
      return sendTracked(chatId, section("CHOOSE CATEGORY") + "✅ Choose a category:", categoriesKeyboard());
    }

    // STEP 1: CATEGORY
    if (s.step === "category") {
      const category = categoryNameFromButton(text);
      if (!category) return sendTracked(chatId, "Tap a category button:", categoriesKeyboard());
      if (!PACKAGES[category]) return sendTracked(chatId, "Tap a category button:", categoriesKeyboard());

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
  s.step = "confirm";
  sessions.set(chatId, s);

  const savedPhone = getUserPhone(chatId);
  const hasSaved = !!savedPhone;

  const msgText =
    `✅ Selected:\n*${pkg.label}*\n\n` +
    (hasSaved 
      ? `📱 Saved number: *${maskPhone(savedPhone)}*\n\n` 
      : `📱 Paste new number.\n\n`) +
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
        pushPrev(chatId, s);
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
          pushPrev(chatId, s);
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
        // ✅ Prevent duplicate STK prompts (same offer/phone) within 2 minutes
        const recent = findRecentPendingForSameRequest({
          chatId,
          phone254: savedPhone,
          category: s.category,
          pkgLabel: pkg.label,
          withinMs: 2 * 60 * 1000,
        });
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

        const spam = checkAndMarkSpam(chatId, sig, savedPhone);
if (!spam.ok && spam.reason === "phone_needs_approval") {
  return sendTracked(chatId,
    `🛂 This phone number is already linked to 4 accounts.\n\n✅ An approval request has been sent to admin.\nPlease wait for approval, then try again.\n\n☎️ Help: ${HELP_PHONE}`,
    { ...mainMenuKeyboard(chatId) }
  );
}
if (!spam.ok && spam.reason === "phone_account_limit") {
  return sendTracked(chatId,
    `⚠️ This phone number is already linked to 4 accounts.\n\nUse a different number or contact support.\n\n☎️ Help: ${HELP_PHONE}`,
    { ...mainMenuKeyboard(chatId) }
  );
}
        if (!spam.ok) return sendTracked(chatId, spam.reason, { ...mainMenuKeyboard(chatId) });

        const blockedUntil = isStkBlocked(chatId, savedPhone);
        if (blockedUntil) {
          const secs = Math.ceil((blockedUntil - Date.now()) / 1000);
          return sendTracked(chatId, `⛔ STK temporarily blocked due to repeated failures.\nTry again in ${secs}s.`, { ...mainMenuKeyboard(chatId) });
        }

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
          // If PayHero gateway is slow (HTTP 504/timeout), keep the pending payment and allow safe retry.
          if (isStkDelayedError(err)) {
            await notifyAdmin(
              `⚠️ *STK Delayed*
ChatID: \`${mdEscape(chatId)}\`
Ref: \`${mdEscape(ref)}\`
Error: \`${mdEscape(
                String(err.message || err)
              )}\``
            );

            return sendTracked(
              chatId,
              `⚠️ *STK Request Delayed*

` +
                `If you receive the M-PESA prompt, complete it.

` +
                `If no prompt appears within 1 minute:
`,
              {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "🔁 Retry STK", callback_data: `ui:stk_retry_prompt:${ref}` }],
                    [{ text: "❌ Cancel Pending", callback_data: `ui:stk_cancel:${ref}` }],
                    [{ text: "🛒 Buy Offers", callback_data: "ui:buy_offers" }],
                  ],
                },
              }
            );
          }

          // Hard failure: clear session + pending
          sessions.delete(chatId);
          deletePendingPayment(ref);

          await notifyAdmin(
            `❌ *STK Failed*
ChatID: \`${mdEscape(chatId)}\`
Ref: \`${mdEscape(ref)}\`
Error: \`${mdEscape(
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

    throw new Error("This phone number is currently at the 4-account limit. An approval request has been sent to admin.");
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



// ============================================================================
// ✅ PATCH: Referral + Business Limits + WEEKLY DRAW button visibility (2026-02-28)
// - Normal referral: 1–50 Ksh => 1.5%, 51+ => 2%
// - Business referral: if (active subscription + 3+ purchases) AND amount>=20 => tiered rate by successful refs during subscription
//   tiers: 0–29 2%, 30+ 2.5%, 100+ 3%, 140+ 3.5%, 200+ 4%, 250+ 4.5%
//   amount < 20 => normal rate (and does NOT count toward business tier counter)
// - Normal daily referral limit: 15 NEW successful referrals/day (business unlimited)
// - Business bypasses phone reuse/approval limits (but NOT admin commands)
// - Home menu: "🎉 WEEKLY DRAW" (ALL CAPS) shows ABOVE other buttons only when admin enables it
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
      // Build base keyboard similar to existing
      const keyboard = [];

      // ✅ WEEKLY DRAW first (only when enabled globally)
      if (db.campaign && db.campaign.enabled === true) {
        keyboard.push(["🎉 WEEKLY DRAW"]);
      }

      // Keep original structure if available; otherwise default minimal
      if (chatId && typeof getQuickCategories === "function") {
        keyboard.push(["🛒 Buy Offers"]);
        const quick = getQuickCategories(chatId);
        for (const q of (quick || [])) keyboard.push([q.text]);
        keyboard.push(["💸 Withdraw Points"]);
        keyboard.push(["🔗 My Referral", "ℹ️ Help"]);
      } else if (__origMainMenuKeyboard) {
        // Use original and just ensure WEEKLY DRAW is on top
        const base = __origMainMenuKeyboard(chatId);
        const baseKb = base?.reply_markup?.keyboard;
        if (Array.isArray(baseKb)) {
          // remove any duplicate WEEKLY DRAW rows if present
          const cleaned = baseKb.filter(row => !(Array.isArray(row) && row.length === 1 && row[0] === "🎉 WEEKLY DRAW"));
          keyboard.push(...cleaned);
        } else {
          keyboard.push(["🛒 Buy Offers"], ["💸 Withdraw Points"], ["🔗 My Referral", "ℹ️ Help"]);
        }
      } else {
        keyboard.push(["🛒 Buy Offers"], ["💸 Withdraw Points"], ["🔗 My Referral", "ℹ️ Help"]);
      }

      return { reply_markup: { keyboard, resize_keyboard: true } };
    };

    // Basic WEEKLY DRAW screen (visible only when enabled). Full campaign logic can be added later safely.
    bot.on("message", async (msg) => {
      const chatId = msg.chat.id;
      const text = (msg.text || "").trim();

      // Admin-only Weekly Draw control panel (hidden for non-admins)
      if (text === "🎛 WEEKLY DRAW ADMIN" || /^\/weeklydraw_admin$/i.test(text)) {
        if (!(typeof isAdmin === "function" && isAdmin(chatId))) {
          return bot.sendMessage(chatId, "⛔ Admin only.", mainMenuKeyboard(chatId)).catch(() => {});
        }
        const statusText = formatWeeklyDrawAdminStatus();
        return bot.sendMessage(chatId, statusText, weeklyDrawAdminMenuKeyboard()).catch(() => {});
      }

      
if (text === "🎉 WEEKLY DRAW") {
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
      const name = displayName(u, x.cid);
      const q = weeklyDrawQualification(x.cid);
      return { ...x, name, qualified: q.qualified };
    })
    .filter((x) => x.qualified)
    .sort((a, b) => b.tickets - a.tickets)
    .slice(0, 10);

  const listLines = ranked.length
    ? ranked.map((r, i) => `${i + 1}️⃣ ${r.name} — ${r.tickets} tickets`).join("\n")
    : "No qualified participants yet.";

  // Winners block (ENDED)
  let winnersBlock = "";
  if (status === "ENDED" && Array.isArray(c.winners) && c.winners.length) {
    const lines = c.winners.slice(0, 3).map((w, i) => {
      const pos = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
      const paid = w.paid ? "Paid ✅" : "Pending ⏳";
      return `${pos} ${w.name || w.chatId} — Ksh ${Number(w.prize || 0)} (${paid})`;
    });
    winnersBlock = `\n\n🏁 Winners (Top 3)\n${lines.join("\n")}`;
  }

  const optedLine = isWeeklyDrawOptedIn(chatId)
    ? "✅ You are opted in (you will receive updates)."
    : "ℹ️ You are not opted in (no campaign messages). Tap ✅ JOIN to participate.";

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
      if (typeof isAdmin === "function" && isAdmin(chatId)) {

// Admin UI menu (buttons)
if (/^\/weeklydraw_admin$/i.test(text) || text === "🎛 WEEKLY DRAW ADMIN") {
  const statusText = formatWeeklyDrawAdminStatus();
  return bot.sendMessage(chatId, statusText, weeklyDrawAdminMenuKeyboard()).catch(() => {});
}

// If admin is currently entering campaign config, intercept their next message
const _wdState = getWeeklyDrawAdminState(chatId);
if (_wdState && _wdState.mode) {
  const c = ensureWeeklyDrawObject();

// === Weekly Draw: Set Image (admin) ===
if (_wdState.mode === "set_image") {
  // Accept photo (preferred) OR URL text
  let img = "";
  if (msg.photo && Array.isArray(msg.photo) && msg.photo.length) {
    img = msg.photo[msg.photo.length - 1].file_id;
  } else if (msg.document && msg.document.mime_type && String(msg.document.mime_type).startsWith("image/")) {
    img = msg.document.file_id;
  } else {
    const t = String(text || "").trim();
    if (/^https?:\/\/\S+$/i.test(t)) img = t;
  }

  if (!img) {
    await editAdminStateMessage(chatId, _wdState, "❌ Please send a PHOTO or a direct image URL (https://...).", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "wdadm:menu" }]] } });
    return;
  }

  c.image = img;
  try { saveDB(); } catch (_) {}
  await editAdminStateMessage(chatId, _wdState, "✅ WEEKLY DRAW image updated.", weeklyDrawAdminMenuKeyboard());
  setWeeklyDrawAdminState(chatId, null);
  return;
}

  if (_wdState.mode === "set_prizes") {
    // Expect: "250 150 100"
    const parts = String(text || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 3) {
      const first = Number(parts[0]), second = Number(parts[1]), third = Number(parts[2]);
      const total = first + second + third;
      if (Number.isFinite(first) && Number.isFinite(second) && Number.isFinite(third) && first >= 0 && second >= 0 && third >= 0 && total <= 500) {
        c.prizes = { first, second, third };
        try { saveDB(); } catch (_) {}
        

setWeeklyDrawAdminState(chatId, null);
        const statusText = formatWeeklyDrawAdminStatus();
        await editAdminStateMessage(chatId, _wdState, `✅ Prizes updated.\n\n${statusText}`, weeklyDrawAdminMenuKeyboard());
        return;
      }
    }
    await editAdminStateMessage(chatId, _wdState, "❌ Invalid prizes. Send: 250 150 100 (total must be ≤ 500).", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "wdadm:menu" }]] } });
    return;
  }

  if (_wdState.mode === "set_period") {
    // Expect: "YYYY-MM-DD YYYY-MM-DD"
    const parts = String(text || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const s = Date.parse(parts[0] + "T00:00:00Z");
      const e = Date.parse(parts[1] + "T23:59:59Z");
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
        c.startAt = s;
        c.endAt = e;
        c.status = c.status === "OFF" ? "RUNNING" : c.status;
        try { saveDB(); } catch (_) {}
        setWeeklyDrawAdminState(chatId, null);
        const statusText = formatWeeklyDrawAdminStatus();
        await editAdminStateMessage(chatId, _wdState, `✅ Period updated.\n\n${statusText}`, weeklyDrawAdminMenuKeyboard());
        return;
      }
    }
    await editAdminStateMessage(chatId, _wdState, "❌ Invalid period. Send: 2026-03-01 2026-03-08", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "wdadm:menu" }]] } });
    return;
  }

  if (_wdState.mode === "set_heading") {
    const heading = String(text || "").trim();
    if (heading.length >= 3) {
      c.heading = heading;
      try { saveDB(); } catch (_) {}
      setWeeklyDrawAdminState(chatId, null);
      const statusText = formatWeeklyDrawAdminStatus();
      await editAdminStateMessage(chatId, _wdState, `✅ Heading updated.\n\n${statusText}`, weeklyDrawAdminMenuKeyboard());
       return;
    }
    await editAdminStateMessage(chatId, _wdState, "❌ Heading too short. Send a valid heading text.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "wdadm:menu" }]] } });
     return;
  }

if (_wdState.mode === "set_qual") {
  const key = String(_wdState.key || "").trim();
  const res = setQualificationValue(c, key, text);
  if (!res.ok) {
    await editAdminStateMessage(chatId, _wdState, `❌ ${res.err || "Invalid value."}\n\n${qualificationPromptFor(key)}`, weeklyDrawQualificationsKeyboard());
    return;
  }
  try { saveDB(); } catch (_) {}
  setWeeklyDrawAdminState(chatId, null);
  await editAdminStateMessage(chatId, _wdState, "✅ Qualification updated.", weeklyDrawQualificationsKeyboard());
   return;
}
}
        if (/^\/weeklydraw_on$/i.test(text)) {
          db.campaign = db.campaign || {};
          db.campaign.enabled = true;
          if (!db.campaign.status || db.campaign.status === "OFF") db.campaign.status = "RUNNING";
          try { saveDB(); } catch (_) {}
          return bot.sendMessage(chatId, "✅ WEEKLY DRAW is now visible to all users.", mainMenuKeyboard(chatId)).catch(() => {});
        }
        if (/^\/weeklydraw_off$/i.test(text)) {
          db.campaign = db.campaign || {};
          db.campaign.enabled = false;
          try { saveDB(); } catch (_) {}
          return bot.sendMessage(chatId, "🚫 WEEKLY DRAW is now hidden from all users.", mainMenuKeyboard(chatId)).catch(() => {});
        }

        // --- Weekly Draw management commands ---
        // Usage:
        // /weeklydraw_start 7                         -> starts a 7-day draw (default 7 if omitted)
        // /weeklydraw_period 2026-03-01 2026-03-08    -> set explicit period (start/end, inclusive start, end at 23:59:59)
        // /weeklydraw_heading Your heading text       -> set heading
        // /weeklydraw_prizes 250 150 100              -> set prizes (must be <= 500 total)
        // /weeklydraw_end                             -> end draw, freeze winners (top3)
        // /weeklydraw_restart                         -> reset everything and start fresh (keeps heading/prizes unless changed)
        // /weeklydraw_pay 1   OR /weeklydraw_pay <chatId>      -> mark winner paid
        // /weeklydraw_unpay 1 OR /weeklydraw_unpay <chatId>    -> mark winner pending
        // /weeklydraw_remove <chatId>                 -> remove a user from entries and winners
        // /weeklydraw_status                          -> show current config

        const ensureCampaign = () => {
          db.campaign = db.campaign || {};
          if (typeof db.campaign.enabled !== "boolean") db.campaign.enabled = false;
          if (!db.campaign.status) db.campaign.status = "OFF";
          if (!db.campaign.heading) db.campaign.heading = "WEEKLY DRAW";
          if (!db.campaign.prizes) db.campaign.prizes = { first: 250, second: 150, third: 100 };
          if (!db.campaign.entries) db.campaign.entries = {}; // chatId -> { tickets, updatedAt, name }
          if (!db.campaign.winners) db.campaign.winners = []; // [{chatId,name,tickets,prize,paid}]
          if (!db.campaign.campaignId) db.campaign.campaignId = String(Date.now());
        };

        const parseYMD = (s) => {
          const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
          if (!m) return null;
          const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
          const dt = new Date(Date.UTC(y, mo, d, 0, 0, 0, 0));
          if (isNaN(dt.getTime())) return null;
          // validate components
          if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return null;
          return dt;
        };

        const endOfDayUtcMs = (dt) => {
          const e = new Date(dt.getTime());
          e.setUTCHours(23, 59, 59, 999);
          return e.getTime();
        };

        const startOfDayUtcMs = (dt) => {
          const s = new Date(dt.getTime());
          s.setUTCHours(0, 0, 0, 0);
          return s.getTime();
        };

        const computeTop3Winners = () => {
          ensureCampaign();
          const entries = db.campaign.entries || {};
          const rows = Object.keys(entries).map((id) => {
            const e = entries[id] || {};
            return {
              chatId: String(id),
              name: e.name || String(id),
              tickets: Number(e.tickets || 0),
              updatedAt: Number(e.updatedAt || 0),
            };
          }).filter((r) => r.tickets > 0);

          rows.sort((a, b) => (b.tickets - a.tickets) || (b.updatedAt - a.updatedAt));
          const top = rows.slice(0, 3);

          const p = db.campaign.prizes || { first: 250, second: 150, third: 100 };
          const prizeArr = [Number(p.first || 0), Number(p.second || 0), Number(p.third || 0)];

          db.campaign.winners = top.map((w, i) => ({
            chatId: w.chatId,
            name: w.name,
            tickets: w.tickets,
            prize: prizeArr[i] || 0,
            paid: false,
          }));
        };

        const showCampaignStatus = () => {
          ensureCampaign();
          const c = db.campaign;
          const p = c.prizes || {};
          const st = String(c.status || "OFF").toUpperCase();
          const enabled = c.enabled === true ? "YES" : "NO";
          const heading = String(c.heading || "WEEKLY DRAW");
          const startAt = c.startAt ? new Date(Number(c.startAt)).toISOString().slice(0, 10) : "N/A";
          const endAt = c.endAt ? new Date(Number(c.endAt)).toISOString().slice(0, 10) : "N/A";
          const entryCount = c.entries ? Object.keys(c.entries).length : 0;
          const winners = (c.winners || []).map((w, i) => {
            const pos = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
            const paid = w.paid ? "Paid ✅" : "Pending ⏳";
            return `${pos} ${w.name || w.chatId} — Ksh ${Number(w.prize || 0)} (${paid})`;
          }).join("\n") || "None";
          const msgText =
            `🎉 ${heading.toUpperCase()}\n` +
            `Enabled: ${enabled}\n` +
            `Status: ${st}\n` +
            `Period: ${startAt} → ${endAt}\n` +
            `Prizes: 1st ${Number(p.first || 0)} / 2nd ${Number(p.second || 0)} / 3rd ${Number(p.third || 0)} (max 500)\n` +
            `Entries: ${entryCount}\n\n` +
            `Winners:\n${winners}\n\n` +
            `Commands:\n` +
            `/weeklydraw_on | /weeklydraw_off\n` +
            `/weeklydraw_start [days]\n` +
            `/weeklydraw_period YYYY-MM-DD YYYY-MM-DD\n` +
            `/weeklydraw_heading <text>\n` +
            `/weeklydraw_prizes <first> <second> <third>\n` +
            `/weeklydraw_end | /weeklydraw_restart\n` +
            `/weeklydraw_pay <1|2|3|chatId> | /weeklydraw_unpay <1|2|3|chatId>\n` +
            `/weeklydraw_remove <chatId>\n`;
          return bot.sendMessage(chatId, msgText, mainMenuKeyboard(chatId)).catch(() => {});
        };

        if (/^\/weeklydraw_status$/i.test(text)) {
          return showCampaignStatus();
        }

        // Start weekly draw for N days (default 7)
        const mStart = /^\/weeklydraw_start(?:\s+(\d+))?$/i.exec(text);
        if (mStart) {
          ensureCampaign();
          const days = Math.max(1, Math.min(60, Number(mStart[1] || 7)));
          const now = Date.now();
          db.campaign.enabled = true;
          db.campaign.status = "RUNNING";
          db.campaign.campaignId = String(now);
          db.campaign.startAt = now;
          db.campaign.endAt = now + days * 24 * 60 * 60 * 1000;
          db.campaign.entries = {};
          db.campaign.winners = [];
          try { saveDB(); } catch (_) {}
          return bot.sendMessage(chatId, `✅ WEEKLY DRAW started for ${days} day(s).`, mainMenuKeyboard(chatId)).catch(() => {});
        }

        // Set explicit period (UTC dates)
        const mPeriod = /^\/weeklydraw_period\s+(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})$/i.exec(text);
        if (mPeriod) {
          ensureCampaign();
          const s = parseYMD(mPeriod[1]);
          const e = parseYMD(mPeriod[2]);
          if (!s || !e) return bot.sendMessage(chatId, "❌ Invalid date format. Use YYYY-MM-DD YYYY-MM-DD", mainMenuKeyboard(chatId)).catch(() => {});
          const startMs = startOfDayUtcMs(s);
          const endMs = endOfDayUtcMs(e);
          if (endMs <= startMs) return bot.sendMessage(chatId, "❌ End date must be after start date.", mainMenuKeyboard(chatId)).catch(() => {});
          db.campaign.enabled = true;
          db.campaign.status = "RUNNING";
          db.campaign.campaignId = String(Date.now());
          db.campaign.startAt = startMs;
          db.campaign.endAt = endMs;
          db.campaign.entries = {};
          db.campaign.winners = [];
          try { saveDB(); } catch (_) {}
          return bot.sendMessage(chatId, `✅ WEEKLY DRAW period set: ${mPeriod[1]} → ${mPeriod[2]}`, mainMenuKeyboard(chatId)).catch(() => {});
        }

        // Set heading
        const mHeading = /^\/weeklydraw_heading\s+([\s\S]{1,120})$/i.exec(text);
        if (mHeading) {
          ensureCampaign();
          db.campaign.heading = String(mHeading[1]).trim();
          try { saveDB(); } catch (_) {}
          return bot.sendMessage(chatId, "✅ Weekly Draw heading updated.", mainMenuKeyboard(chatId)).catch(() => {});
        }

        // Set prizes (max total 500)
        const mPr = /^\/weeklydraw_prizes\s+(\d+)\s+(\d+)\s+(\d+)$/i.exec(text);
        if (mPr) {
          ensureCampaign();
          const first = Number(mPr[1]), second = Number(mPr[2]), third = Number(mPr[3]);
          const total = first + second + third;
          if (total > 500) {
            return bot.sendMessage(chatId, `❌ Total prizes cannot exceed 500 KSH. You set ${total}.`, mainMenuKeyboard(chatId)).catch(() => {});
          }
          db.campaign.prizes = { first, second, third };
          try { saveDB(); } catch (_) {}
          return bot.sendMessage(chatId, `✅ Weekly Draw prizes set: ${first}/${second}/${third} (Total ${total}).`, mainMenuKeyboard(chatId)).catch(() => {});
        }

        // End draw & freeze winners
        if (/^\/weeklydraw_end$/i.test(text)) {
          ensureCampaign();
          db.campaign.status = "ENDED";
          computeTop3Winners();
          try { saveDB(); } catch (_) {}
          // Announce to admin chat only (safe). You can broadcast later if you have broadcast logic.
          const winners = (db.campaign.winners || []).map((w, i) => {
            const pos = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
            return `${pos} ${w.name || w.chatId} — Ksh ${Number(w.prize || 0)} (Pending ⏳)`;
          }).join("\n") || "No eligible entries.";
          return bot.sendMessage(chatId, `🏁 WEEKLY DRAW ended.\n\n🏆 Winners:\n${winners}`, mainMenuKeyboard(chatId)).catch(() => {});
        }

        // Restart draw: full reset + RUNNING (keeps heading/prizes)
        if (/^\/weeklydraw_restart$/i.test(text)) {
          ensureCampaign();
          const now = Date.now();
          const durationMs = (Number(db.campaign.endAt || 0) > Number(db.campaign.startAt || 0))
            ? (Number(db.campaign.endAt) - Number(db.campaign.startAt))
            : (7 * 24 * 60 * 60 * 1000);
          db.campaign.enabled = true;
          db.campaign.status = "RUNNING";
          db.campaign.campaignId = String(now);
          db.campaign.startAt = now;
          db.campaign.endAt = now + durationMs;
          db.campaign.entries = {};
          db.campaign.winners = [];
          try { saveDB(); } catch (_) {}
          return bot.sendMessage(chatId, "🔄 WEEKLY DRAW restarted. Entries cleared.", mainMenuKeyboard(chatId)).catch(() => {});
        }

        const resolveWinnerTarget = (arg) => {
          ensureCampaign();
          const a = String(arg || "").trim();
          if (!a) return null;
          const w = db.campaign.winners || [];
          if (["1","2","3"].includes(a)) return w[Number(a) - 1] ? String(w[Number(a) - 1].chatId) : null;
          return a; // assume chatId
        };

        // Mark paid/unpaid
        const mPay = /^\/weeklydraw_pay\s+(\S+)$/i.exec(text);
        if (mPay) {
          ensureCampaign();
          const targetId = resolveWinnerTarget(mPay[1]);
          if (!targetId) return bot.sendMessage(chatId, "❌ Winner not found. Use 1/2/3 or chatId.", mainMenuKeyboard(chatId)).catch(() => {});
          let updated = false;
          for (const w of (db.campaign.winners || [])) {
            if (String(w.chatId) === String(targetId)) { w.paid = true; updated = true; }
          }
          try { saveDB(); } catch (_) {}
          return bot.sendMessage(chatId, updated ? "✅ Marked as Paid." : "❌ Winner not found.", mainMenuKeyboard(chatId)).catch(() => {});
        }

        const mUnpay = /^\/weeklydraw_unpay\s+(\S+)$/i.exec(text);
        if (mUnpay) {
          ensureCampaign();
          const targetId = resolveWinnerTarget(mUnpay[1]);
          if (!targetId) return bot.sendMessage(chatId, "❌ Winner not found. Use 1/2/3 or chatId.", mainMenuKeyboard(chatId)).catch(() => {});
          let updated = false;
          for (const w of (db.campaign.winners || [])) {
            if (String(w.chatId) === String(targetId)) { w.paid = false; updated = true; }
          }
          try { saveDB(); } catch (_) {}
          return bot.sendMessage(chatId, updated ? "✅ Marked as Pending." : "❌ Winner not found.", mainMenuKeyboard(chatId)).catch(() => {});
        }

        // Remove user from entries and winners
        const mRm = /^\/weeklydraw_remove\s+(\S+)$/i.exec(text);
        if (mRm) {
          ensureCampaign();
          const id = String(mRm[1]).trim();
          if (db.campaign.entries && db.campaign.entries[id]) delete db.campaign.entries[id];
          db.campaign.winners = (db.campaign.winners || []).filter((w) => String(w.chatId) !== id);
          try { saveDB(); } catch (_) {}
          return bot.sendMessage(chatId, `✅ Removed ${id} from Weekly Draw.`, mainMenuKeyboard(chatId)).catch(() => {});
        }
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
            notifyAdmin(
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
