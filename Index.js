"use strict";

const TelegramBot = require("node-telegram-bot-api");

// ✅ Core modules are in ROOT (not /core)
const PhoneLock = require("./phoneLock");
const RiskEngine = require("./riskEngine");
const ReferralSystem = require("./referralSystem");
const WithdrawalGuard = require("./withdrawalGuard");
const DailyReset = require("./dailyReset");

// ✅ DB utils are in ROOT (not /utils)
const { loadDB, saveDB } = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN missing in Render environment variables.");
}

const ADMIN_ID = process.env.ADMIN_ID || "";

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ================= DB =================
let db = loadDB() || {};
if (!db.users) db.users = {};

function getUser(chatId) {
  const id = String(chatId);
  if (!db.users[id]) db.users[id] = {};
  return db.users[id];
}

function addPoints(chatId, amount) {
  const user = getUser(chatId);
  user.points = Number(user.points || 0) + Number(amount || 0);
  saveDB(db);
}

function isAdmin(chatId) {
  return String(chatId) === String(ADMIN_ID);
}

function kenyaDateTime() {
  const now = new Date();
  return new Date(now.getTime() + 3 * 60 * 60 * 1000);
}

function formatTo07(phone) {
  if (!phone) return "";
  let p = String(phone).replace(/\s+/g, "");
  if (p.startsWith("+254")) p = "0" + p.slice(4);
  if (p.startsWith("254")) p = "0" + p.slice(3);
  if (p.startsWith("7")) p = "0" + p;
  return p;
}

function repairDB(data) {
  if (!data || typeof data !== "object") data = {};
  if (!data.users) data.users = {};
  if (!data.phoneAccountUsage) data.phoneAccountUsage = {};
  if (!data.phoneDailyUsage) data.phoneDailyUsage = {};
  return data;
}
db = repairDB(db);

function todayKey() {
  return kenyaDateTime().toISOString().slice(0, 10);
}

function isoWeekKey() {
  return "week";
}

function getAllUserIds() {
  return Object.keys(db.users || {});
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return "Leaderboard not ready.";
}

// ================= Wrappable functions =================
async function payheroStkPush(payload) {
  return { ok: false };
}

function recordSuccessfulRevenue(chatId, amount) {
  const user = getUser(chatId);
  user.totalSpent = Number(user.totalSpent || 0) + Number(amount || 0);
  saveDB(db);
}

// ================= Referral wrappers (optional usage) =================
function applyReferralIfAny(chatId, payload) {
  if (!ReferralSystem || !ReferralSystem.applyReferralIfAny) return;
  return ReferralSystem.applyReferralIfAny(__coreCtx, chatId, payload);
}

function maybeRewardInviterOnSuccessPurchase(buyerChatId, amountKsh, when) {
  if (!ReferralSystem || !ReferralSystem.maybeRewardInviterOnSuccessPurchase) return;
  return ReferralSystem.maybeRewardInviterOnSuccessPurchase(__coreCtx, buyerChatId, amountKsh, when);
}

// ================= CORE CONTEXT =================
const __coreCtx = {
  getDB: () => db,
  setDB: (next) => {
    db = repairDB(next);
  },
  saveDB: () => saveDB(db),

  getUser,
  addPoints,
  isAdmin,
  kenyaDateTime,
  formatTo07,
  ADMIN_ID,

  getPayheroStkPush: () => payheroStkPush,
  setPayheroStkPush: (fn) => {
    payheroStkPush = fn;
  },

  getRecordSuccessfulRevenue: () => recordSuccessfulRevenue,
  setRecordSuccessfulRevenue: (fn) => {
    recordSuccessfulRevenue = fn;
  },

  repairDB,
  todayKey,
  isoWeekKey,
  buildReferralLeaderboardText,
  getAllUserIds,
  sleep,
  mainMenuKeyboard,
};

// ================= INIT MODULES =================
if (PhoneLock?.initPhoneLock) PhoneLock.initPhoneLock(bot, __coreCtx);
if (RiskEngine?.initRiskEngine) RiskEngine.initRiskEngine(bot, __coreCtx);
if (WithdrawalGuard?.initWithdrawalGuard) WithdrawalGuard.initWithdrawalGuard(bot, __coreCtx);
if (DailyReset?.initDailyReset) DailyReset.initDailyReset(bot, __coreCtx);

// ================= BASIC START =================
bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const payload = match && match[1] ? match[1] : "";
  applyReferralIfAny(chatId, payload);

  bot.sendMessage(chatId, "✅ BingwaBot running.", mainMenuKeyboard());
});

console.log("🚀 BingwaBot started successfully");
