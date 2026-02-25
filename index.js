"use strict";

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");

// Core modules
const PhoneLock = require("./core/phoneLock");
const RiskEngine = require("./core/riskEngine");
const ReferralSystem = require("./core/referralSystem");
const WithdrawalGuard = require("./core/withdrawalGuard");
const DailyReset = require("./core/dailyReset");

// DB utils
const { loadDB, saveDB: saveDBFile } = require("./utils/db");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN missing in environment (.env).");
}

const ADMIN_ID = process.env.ADMIN_ID || ""; // set in Render env or .env

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ===================== DB =====================
let db = loadDB();
function saveDB() {
  saveDBFile(db);
}

// ===================== Helpers expected by core modules =====================
function isAdmin(chatId) {
  if (!ADMIN_ID) return false;
  return String(chatId) === String(ADMIN_ID);
}

function kenyaDateTime() {
  // Render runs UTC; this gives a GMT+3-like Date object representation
  // (Used mainly for timestamps/keys; keep simple)
  const now = new Date();
  return new Date(now.getTime() + 3 * 60 * 60 * 1000);
}

function formatTo07(phone) {
  if (!phone) return "";
  let p = String(phone).trim();
  p = p.replace(/\s+/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  if (p.startsWith("254")) p = "0" + p.slice(3);
  if (p.startsWith("7")) p = "0" + p;
  return p;
}

function repairDB(d) {
  // Keep minimal—avoid crashes if fields missing
  if (!d || typeof d !== "object") d = {};
  if (!d.users) d.users = {};
  if (!d.phoneAccountUsage) d.phoneAccountUsage = {};
  if (!d.phoneDailyUsage) d.phoneDailyUsage = {};
  return d;
}
db = repairDB(db);

function getUser(chatId) {
  const id = String(chatId);
  if (!db.users[id]) db.users[id] = {};
  return db.users[id];
}

function addPoints(chatId, amount) {
  const u = getUser(chatId);
  const a = Number(amount || 0);
  u.points = Number(u.points || 0) + (Number.isFinite(a) ? a : 0);
  saveDB();
}

// These are referenced by periodic tasks / leaderboards in your extracted modules.
// Keep them safe no-op or simple implementations.
function todayKey() {
  const d = kenyaDateTime();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isoWeekKey(date = kenyaDateTime()) {
  // Simple ISO week key (YYYY-Www)
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function getAllUserIds() {
  return Object.keys(db.users || {});
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [["Menu"]],
      resize_keyboard: true,
    },
  };
}

function buildReferralLeaderboardText() {
  // Optional: implement later. Keep safe.
  return "Referral leaderboard is not configured yet.";
}

// ===================== Functions that core modules may wrap =====================
// Keep these as real functions so wrappers can reassign them safely.

async function payheroStkPush(payload) {
  // Your existing STK push logic should be here.
  // Keep placeholder so app doesn't crash.
  return { ok: false, message: "STK push not implemented in this index.js yet." };
}

function recordSuccessfulRevenue(chatId, amountKsh, when = kenyaDateTime()) {
  // Used by withdrawal min-spend tracking. Keep basic.
  const u = getUser(chatId);
  u.totalSpentKsh = Number(u.totalSpentKsh || 0) + Number(amountKsh || 0);
  u.lastSpendAt = String(when);
  saveDB();
}

// ===================== Referral hook wrappers =====================
function applyReferralIfAny(chatId, payload) {
  return ReferralSystem.applyReferralIfAny(__coreCtx, chatId, payload);
}

function maybeRewardInviterOnSuccessPurchase(buyerChatId, amountKsh, when) {
  return ReferralSystem.maybeRewardInviterOnSuccessPurchase(__coreCtx, buyerChatId, amountKsh, when);
}

// ===================== Basic bot start (you can keep your old handlers below) =====================
bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const payload = match && match[1] ? match[1] : "";
  applyReferralIfAny(chatId, payload);

  bot.sendMessage(chatId, "✅ Bot is running.", mainMenuKeyboard());
});

// ===================== Initialize modular core systems =====================
let __coreCtx = null;

function __initCoreModules() {
  __coreCtx = {
    // DB
    getDB: () => db,
    setDB: (next) => {
      db = repairDB(next);
    },
    saveDB,

    // required funcs
    getUser,
    addPoints,
    isAdmin,
    kenyaDateTime,
    formatTo07,

    // IDs
    ADMIN_ID,

    // Wrappable funcs
    getPayheroStkPush: () => payheroStkPush,
    setPayheroStkPush: (fn) => {
      payheroStkPush = fn;
    },

    getRecordSuccessfulRevenue: () => recordSuccessfulRevenue,
    setRecordSuccessfulRevenue: (fn) => {
      recordSuccessfulRevenue = fn;
    },

    // periodic deps
    repairDB,
    todayKey,
    isoWeekKey,
    buildReferralLeaderboardText,
    getAllUserIds,
    sleep,
    mainMenuKeyboard,
  };

  PhoneLock.initPhoneLock(bot, __coreCtx);
  RiskEngine.initRiskEngine(bot, __coreCtx);
  WithdrawalGuard.initWithdrawalGuard(bot, __coreCtx);
  DailyReset.initDailyReset(bot, __coreCtx);
}

__initCoreModules();

console.log("🚀 BingwaBot started successfully");
