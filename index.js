"use strict";

const TelegramBot = require("node-telegram-bot-api");

// Core modules
const PhoneLock = require("./core/phoneLock");
const RiskEngine = require("./core/riskEngine");
const ReferralSystem = require("./core/referralSystem");
const WithdrawalGuard = require("./core/withdrawalGuard");
const DailyReset = require("./core/dailyReset");

const { loadDB, saveDB } = require("./utils/db");

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
  if (!data.users) data.users = {};
  return data;
}

function todayKey() {
  return kenyaDateTime().toISOString().slice(0, 10);
}

function isoWeekKey() {
  return "week";
}

function getAllUserIds() {
  return Object.keys(db.users);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [["Menu"]],
      resize_keyboard: true
    }
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

// ================= CORE CONTEXT =================
const __coreCtx = {
  getDB: () => db,
  setDB: (next) => { db = repairDB(next); },
  saveDB: () => saveDB(db),

  getUser,
  addPoints,
  isAdmin,
  kenyaDateTime,
  formatTo07,
  ADMIN_ID,

  getPayheroStkPush: () => payheroStkPush,
  setPayheroStkPush: (fn) => { payheroStkPush = fn; },

  getRecordSuccessfulRevenue: () => recordSuccessfulRevenue,
  setRecordSuccessfulRevenue: (fn) => { recordSuccessfulRevenue = fn; },

  repairDB,
  todayKey,
  isoWeekKey,
  buildReferralLeaderboardText,
  getAllUserIds,
  sleep,
  mainMenuKeyboard
};

// ================= INIT MODULES =================
PhoneLock.initPhoneLock(bot, __coreCtx);
RiskEngine.initRiskEngine(bot, __coreCtx);
WithdrawalGuard.initWithdrawalGuard(bot, __coreCtx);
DailyReset.initDailyReset(bot, __coreCtx);

// ================= BASIC START =================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "✅ BingwaBot running.", mainMenuKeyboard());
});

console.log("🚀 BingwaBot started successfully");
