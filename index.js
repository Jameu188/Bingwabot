// Telegram + PayHero STK Payment (with payment confirmation via callback)
// IMPORTANT: Put secrets in Render ENV vars, NOT in code.

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

// Prevent crashes
process.on("unhandledRejection", (err) => console.log("unhandledRejection:", err?.message || err));
process.on("uncaughtException", (err) => console.log("uncaughtException:", err?.message || err));

// ===================== CONFIG (USE ENV VARS) =====================
const TELEGRAM_TOKEN = "8179985214:AAGUCtLsLuMD90hKMNbWs6N70unEWbyAEbc";

const PAYHERO_USERNAME = "UuT8gpaqwB5ttjYC4ivd";

const PAYHERO_PASSWORD = "FIfH59osWhh2cwwrsWfxtnx8K7SPjhitehpPgAmZ";
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);

const PAYHERO_CHANNEL_ID_DATA = Number(process.env.PAYHERO_CHANNEL_ID_DATA || 0);
const PAYHERO_CHANNEL_ID_SMS = Number(process.env.PAYHERO_CHANNEL_ID_SMS || 0);
const PAYHERO_CHANNEL_ID_MINUTES = Number(process.env.PAYHERO_CHANNEL_ID_MINUTES || 0);

const PAYHERO_CALLBACK_URL =
  process.env.PAYHERO_CALLBACK_URL || "https://bingwabot-4.onrender.com/payhero/callback";

const HELP_PHONE = process.env.HELP_PHONE || "0707071631";

const BANNER_URL = process.env.BANNER_URL || "";
const BANNER_LOCAL_PATH = path.join(__dirname, "banner.jpg");

const ANTI_SPAM = {
  DUPLICATE_WINDOW_MS: 60 * 1000,
  COOLDOWN_MS: 15 * 1000,
};

const REFERRAL = {
  POINTS_PER_DAY_FIRST_STK: 0.2,
};

const REDEEM_ITEMS = [
  { key: "FREE_SMS_20", label: "20 free SMS", cost: 3 },
  { key: "FREE_250MB", label: "250MB free", cost: 7 },
];

// ===================== DB (persistent) =====================
const DB_FILE = path.join(__dirname, "db.json");

// schema add-ons:
// pendingPayments: { "<externalRef>": { chatId, phone254, category, pkgLabel, amount, createdAt } }
// processedRefs: { "<externalRef>": { status, processedAt } }
function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const init = {
        users: {},
        bingwaByPhone: {},
        stats: { totalPurchases: 0, totalBroadcasts: 0 },
        pendingPayments: {},
        processedRefs: {},
      };
      fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const obj = raw ? JSON.parse(raw) : {};
    return repairDB(obj);
  } catch (_) {
    const init = {
      users: {},
      bingwaByPhone: {},
      stats: { totalPurchases: 0, totalBroadcasts: 0 },
      pendingPayments: {},
      processedRefs: {},
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
  if (!db.stats || typeof db.stats !== "object") db.stats = { totalPurchases: 0, totalBroadcasts: 0 };
  if (!db.pendingPayments || typeof db.pendingPayments !== "object") db.pendingPayments = {};
  if (!db.processedRefs || typeof db.processedRefs !== "object") db.processedRefs = {};
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

  // prune processedRefs old (keep last 1000)
  const refs = Object.entries(db.processedRefs || {}).sort((a, b) => (a[1]?.processedAt || 0) - (b[1]?.processedAt || 0));
  while (refs.length > 1000) {
    const oldest = refs.shift();
    delete db.processedRefs[oldest[0]];
  }

  // prune pendingPayments old (older than 2 days)
  const now = Date.now();
  for (const [ref, p] of Object.entries(db.pendingPayments || {})) {
    const createdAt = Number(p?.createdAt || 0);
    if (createdAt && now - createdAt > 2 * 24 * 60 * 60 * 1000) delete db.pendingPayments[ref];
  }

  return db;
}

let db = loadDB();
function saveDB() {
  db = repairDB(db);
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
function nowISO() {
  return new Date().toISOString();
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

  const weeks = Object.keys(u.weeklyPurchases).sort();
  if (weeks.length > 10) {
    for (let i = 0; i < weeks.length - 10; i++) delete u.weeklyPurchases[weeks[i]];
  }

  db.stats.totalPurchases = Number(db.stats.totalPurchases || 0) + 1;
  saveDB();
}

function addPoints(chatId, pts) {
  const u = getUser(chatId);
  u.points = Number(u.points || 0) + Number(pts || 0);
  saveDB();
}
function getPoints(chatId) {
  const u = getUser(chatId);
  return Number(u.points || 0);
}

function requiredConfigOk() {
  if (!TELEGRAM_TOKEN) return false;
  if (!PAYHERO_USERNAME) return false;
  if (!PAYHERO_PASSWORD) return false;
  if (!Number.isFinite(ADMIN_ID) || ADMIN_ID <= 0) return false;

  const ids = [PAYHERO_CHANNEL_ID_DATA, PAYHERO_CHANNEL_ID_SMS, PAYHERO_CHANNEL_ID_MINUTES];
  if (ids.some((x) => !Number.isInteger(x) || x <= 0)) return false;

  return true;
}

// ===================== BOT =====================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

function isAdmin(chatId) {
  return Number(chatId) === Number(ADMIN_ID);
}
function authHeader() {
  return "Basic " + Buffer.from(`${PAYHERO_USERNAME}:${PAYHERO_PASSWORD}`).toString("base64");
}

async function notifyAdmin(text) {
  try {
    await bot.sendMessage(ADMIN_ID, text, { parse_mode: "Markdown" });
  } catch (e) {
    console.log("notifyAdmin failed:", e?.message || e);
  }
}

// Cleanup tracking (unchanged)
const cleanup = new Map();
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

function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [["🛒 Buy Offers", "🎁 Redeem Points"], ["🔗 My Referral"], ["ℹ️ Help", "❌ Cancel"]],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

function makeExternalRef(chatId, category, price) {
  return `BINGWA-${Date.now()}-${category.replace(/\s+/g, "_")}-${price}-${chatId}`;
}
function channelIdForCategory(category) {
  if (category === "SMS Offers") return PAYHERO_CHANNEL_ID_SMS;
  if (category === "Bonga Points") return PAYHERO_CHANNEL_ID_SMS;
  if (category === "Flex Deals") return PAYHERO_CHANNEL_ID_SMS;
  if (category === "Minutes") return PAYHERO_CHANNEL_ID_MINUTES;
  return PAYHERO_CHANNEL_ID_DATA;
}
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

// ===================== PACKAGES (same as yours) =====================
const PACKAGES = {
  "Bingwa Deals": [
    { label: "Ksh 20 • 250MB 24HRS", price: 20 },
    { label: "Ksh 21 • 1GB 1HR", price: 21 },
    { label: "Ksh 47 • 350MB 7 DAYS", price: 47 },
    { label: "Ksh 49 • 1.5GB 3HRS", price: 49 },
    { label: "Ksh 55 • 1.25GB MIDNIGHT", price: 55 },
    { label: "Ksh 99 • 1GB 24HRS", price: 99 },
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
    { label: "Ksh 26 • Unlimited SMS DAILY", price: 26 },
    { label: "Ksh 49 • Unlimited Weekly SMS", price: 49 },
    { label: "Ksh 101 • 1500 SMS MONTHLY", price: 101 },
    { label: "Ksh 201 • 3500 SMS MONTHLY", price: 201 },
  ],
  Minutes: [
    { label: "Ksh 25 • 20 MIN MIDNIGHT", price: 25 },
    { label: "Ksh 21 • 43 MIN 3HRS", price: 21 },
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

// ===================== REFERRAL =====================
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

// ===================== WEB SERVER + CALLBACK =====================
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => res.status(200).send("OK"));

// Robust extractor for PayHero callback
function extractExternalRef(body) {
  return (
    body?.external_reference ||
    body?.ExternalReference ||
    body?.reference ||
    body?.Reference ||
    body?.data?.external_reference ||
    body?.data?.ExternalReference ||
    body?.data?.reference ||
    body?.data?.Reference ||
    ""
  );
}

function extractStatusRaw(body) {
  return (
    body?.payment_status ||
    body?.status ||
    body?.Status ||
    body?.data?.status ||
    body?.data?.Status ||
    body?.data?.payment_status ||
    body?.ResultDesc ||
    body?.resultDesc ||
    ""
  );
}

function isSuccessCallback(body) {
  const statusRaw = extractStatusRaw(body);
  const status = String(statusRaw || "").toLowerCase();

  const resultCode = body?.ResultCode ?? body?.resultCode ?? body?.data?.ResultCode ?? body?.data?.resultCode ?? null;

  // PayHero often uses Status: "Success"
  if (status.includes("success") || status.includes("paid") || status.includes("complete")) return true;

  // Some MPESA callbacks use ResultCode 0 for success
  if (String(resultCode) === "0") return true;

  // Sometimes boolean flags exist
  if (body?.success === true || body?.data?.success === true) return true;

  return false;
}

app.post("/payhero/callback", async (req, res) => {
  const body = req.body || {};
  console.log("PAYHERO CALLBACK:", JSON.stringify(body));

  // Always ACK fast to stop retries
  res.status(200).json({ ok: true });

  try {
    const externalRef = extractExternalRef(body);
    if (!externalRef) return;

    // prevent double-processing
    db = repairDB(db);
    if (db.processedRefs[externalRef]) {
      console.log("Callback ignored (already processed):", externalRef);
      return;
    }

    const success = isSuccessCallback(body);
    const statusRaw = extractStatusRaw(body);

    // get pending payment info (saved when STK was created)
    const pending = db.pendingPayments[externalRef];
    let chatId = null;

    // fallback: parse chatId from the ref format "....-<chatId>"
    if (pending?.chatId) {
      chatId = Number(pending.chatId);
    } else {
      const parts = String(externalRef).split("-");
      const maybe = Number(parts[parts.length - 1]);
      if (Number.isFinite(maybe)) chatId = maybe;
    }
    if (!Number.isFinite(chatId)) return;

    // mark as processed (idempotent)
    db.processedRefs[externalRef] = { status: success ? "success" : "failed", processedAt: Date.now() };
    saveDB();

    if (!success) {
      await sendTracked(
        chatId,
        `⚠️ Payment not completed.\nRef: ${externalRef}\nStatus: ${statusRaw || "Unknown"}\n\nIf you were charged, contact support: ${HELP_PHONE}`,
        { ...mainMenuKeyboard() }
      );
      await notifyAdmin(
        `⚠️ *Payment Failed/Cancelled*\nChatID: \`${chatId}\`\nRef: \`${externalRef}\`\nStatus: \`${statusRaw || "Unknown"}\``
      );
      // keep pending for a while (for troubleshooting)
      return;
    }

    // SUCCESS: update business rules only NOW
    const category = pending?.category || "";
    const pkgLabel = pending?.pkgLabel || "";
    const phone254 = pending?.phone254 || "";
    const amount = pending?.amount || "";

    if (category === "Bingwa Deals" && phone254) {
      markBingwaPurchasedToday(phone254);
    }
    if (pkgLabel) incPurchaseStats(chatId, pkgLabel);
    if (category) maybeRewardInviterOnSuccessPurchase(chatId, category);

    // remove pending
    db = repairDB(db);
    delete db.pendingPayments[externalRef];
    saveDB();

    await sendTracked(
      chatId,
      `✅ Payment received successfully!\n\nRef: ${externalRef}\nStatus: ${statusRaw || "Success"}\n\nOffer: ${pkgLabel || "-"}\nNumber: ${phone254 ? formatTo07(phone254) : "-"}\nAmount: ${amount || "-"}\n\nYour package will be processed now.`,
      { ...mainMenuKeyboard() }
    );

    await notifyAdmin(
      `✅ *Payment Confirmed*\nChatID: \`${chatId}\`\nRef: \`${externalRef}\`\nStatus: \`${statusRaw || "Success"}\`\nOffer: *${pkgLabel || "-"}*`
    );
  } catch (e) {
    console.log("callback error:", e?.message || e);
  }
});

// ===================== BOT FLOW (your logic, minimal edits) =====================
function welcomeText(name) {
  return (
    `👋 Hello ${name || "there"}, welcome to *Bingwa Mtaani Data Services*.\n\n` +
    `⚡ This bot helps you buy *Data bundles*, *Unlimited offers*, *SMS packages*, *Minutes*, *Bonga Points* and *Flex deals* easily via STK — even if you have Okoa Jahazi debt.\n\n` +
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
    `4) Tap ✅ Proceed (or 📞 Change Number)\n` +
    `5) STK prompt comes to your phone\n\n` +
    `Help: ${HELP_PHONE}`
  );
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

// Purchase flow sessions
const sessions = new Map();

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  getUser(chatId);
  touchLastSeen(chatId);

  const isStartCmd = /^\/start\b/i.test(text);
  if (!isStartCmd && msg.message_id) await cleanupBeforeReply(chatId, msg.message_id);

  if (text.startsWith("/")) {
    const m = text.match(/^\/start(?:\s+(.+))?$/i);
    if (m) {
      const payload = (m[1] || "").trim();
      if (payload) applyReferralIfAny(chatId, payload);

      if (!requiredConfigOk()) {
        return sendTracked(
          chatId,
          "❌ Config not set in ENV.\nSet TELEGRAM_TOKEN, PAYHERO_USERNAME, PAYHERO_PASSWORD, ADMIN_ID, channel IDs.\nThen redeploy."
        );
      }

      await sendBannerIfAvailable(chatId);
      await sendTracked(chatId, welcomeText(msg.from?.first_name), { parse_mode: "Markdown", ...mainMenuKeyboard() });

      const pts = getPoints(chatId);
      return sendTracked(chatId, `⭐ Your points: *${pts.toFixed(1)}*`, { parse_mode: "Markdown", ...mainMenuKeyboard() });
    }

    if (/^\/help$/i.test(text)) return sendTracked(chatId, helpText(), { ...mainMenuKeyboard() });
    if (/^\/cancel$/i.test(text)) {
      sessions.delete(chatId);
      return sendTracked(chatId, "❌ Cancelled.", { reply_markup: { remove_keyboard: true } });
    }
    return;
  }

  if (text === "🛒 Buy Offers") {
    sessions.set(chatId, { step: "category", category: null, pkgKey: null, createdAt: Date.now() });
    return sendTracked(chatId, "✅ Choose a category:", categoriesKeyboard());
  }

  let s = sessions.get(chatId);
  if (!s) {
    const maybeCategory = categoryNameFromButton(text);
    if (maybeCategory && PACKAGES[maybeCategory]) {
      s = { step: "category", category: null, pkgKey: null, createdAt: Date.now() };
      sessions.set(chatId, s);
    } else return;
  }

  if (Date.now() - (s.createdAt || Date.now()) > 15 * 60 * 1000) {
    sessions.delete(chatId);
    return sendTracked(chatId, "⏱️ Session expired. Tap 🛒 Buy Offers again.", { ...mainMenuKeyboard() });
  }

  if (text === "⬅ Back") {
    if (s.step === "confirm" || s.step === "phone") {
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

  if (s.step === "category") {
    const category = categoryNameFromButton(text);
    if (!category || !PACKAGES[category]) return sendTracked(chatId, "Tap a category button:", categoriesKeyboard());

    s.category = category;
    s.step = "package";
    sessions.set(chatId, s);

    return sendTracked(chatId, `👇 ${category} packages:`, packagesKeyboard(category));
  }

  if (s.step === "package") {
    const pkg = findPackageByLabel(s.category, text);
    if (!pkg) return sendTracked(chatId, "Tap a package button from the list:", packagesKeyboard(s.category));

    s.pkgKey = pkg.label;
    s.step = "confirm";
    sessions.set(chatId, s);

    const savedPhone = getUserPhone(chatId);
    const hasSaved = !!savedPhone;

    if (s.category === "Bingwa Deals" && hasSaved && bingwaAlreadyPurchasedToday(savedPhone)) {
      sessions.delete(chatId);
      return sendTracked(
        chatId,
        `🚫 *Bingwa Deals limit reached*\nNumber: *${formatTo07(savedPhone)}*\nYou can buy Bingwa Deals again after *midnight*.`,
        { parse_mode: "Markdown", ...mainMenuKeyboard() }
      );
    }

    return sendTracked(
      chatId,
      `✅ Selected:\n*${pkg.label}*\n\n${hasSaved ? `📱 Saved number: *${formatTo07(savedPhone)}*` : `📱 No saved phone yet.`}\n\nChoose:`,
      { parse_mode: "Markdown", ...confirmKeyboard(hasSaved) }
    );
  }

  if (s.step === "confirm") {
    const pkg = findPackageByLabel(s.category, s.pkgKey);
    if (!pkg) {
      sessions.delete(chatId);
      return sendTracked(chatId, "❌ Package missing. Tap 🛒 Buy Offers again.", { ...mainMenuKeyboard() });
    }

    if (text === "📞 Change Number") {
      s.step = "phone";
      sessions.set(chatId, s);
      return sendTracked(chatId, "📱 Send your phone number (07/01/2547/2541):", confirmKeyboard(false));
    }

    if (text === "✅ Proceed") {
      const savedPhone = getUserPhone(chatId);
      if (!savedPhone) {
        s.step = "phone";
        sessions.set(chatId, s);
        return sendTracked(chatId, "📱 No saved number. Send phone (07/01/2547/2541):", confirmKeyboard(false));
      }

      if (s.category === "Bingwa Deals" && bingwaAlreadyPurchasedToday(savedPhone)) {
        sessions.delete(chatId);
        return sendTracked(
          chatId,
          `🚫 *Bingwa Deals limit reached*\nNumber: *${formatTo07(savedPhone)}*\nTry again after *midnight*.`,
          { parse_mode: "Markdown", ...mainMenuKeyboard() }
        );
      }

      const sig = makeSig({ category: s.category, pkgLabel: pkg.label, phone254: savedPhone });
      const spam = checkAndMarkSpam(chatId, sig);
      if (!spam.ok) return sendTracked(chatId, spam.reason, { ...mainMenuKeyboard() });

      await sendTracked(chatId, "🔔 Sending STK push… Check your phone.");

      const ref = makeExternalRef(chatId, s.category, pkg.price);
      const channelId = channelIdForCategory(s.category);

      // ✅ Save pending payment so callback can confirm + update correctly
      db = repairDB(db);
      db.pendingPayments[ref] = {
        chatId,
        phone254: savedPhone,
        category: s.category,
        pkgLabel: pkg.label,
        amount: pkg.price,
        createdAt: Date.now(),
      };
      saveDB();

      try {
        await payheroStkPush({ amount: pkg.price, phone: savedPhone, externalRef: ref, channelId });
        sessions.delete(chatId);

        await notifyAdmin(
          `✅ *STK Sent OK*\nChatID: \`${chatId}\`\nRef: \`${ref}\`\nOffer: *${pkg.label}*\nPhone: *${formatTo07(savedPhone)}*`
        );

        return sendTracked(
          chatId,
          `✅ STK sent!\n\nOffer: ${pkg.label}\nPay: Ksh ${pkg.price}\nFrom: ${formatTo07(savedPhone)}\nRef: ${ref}\n\n⏳ After you pay, you will receive an automatic confirmation message here.`,
          { ...mainMenuKeyboard() }
        );
      } catch (err) {
        // Remove pending on STK creation failure
        db = repairDB(db);
        delete db.pendingPayments[ref];
        saveDB();

        sessions.delete(chatId);
        await notifyAdmin(`❌ *STK Failed*\nChatID: \`${chatId}\`\nRef: \`${ref}\`\nError: \`${String(err.message || err)}\``);
        return sendTracked(chatId, `⚠️ Error: ${err.message}`, { ...mainMenuKeyboard() });
      }
    }

    // accept phone typed here
    const phoneMaybe = normalizePhone(text);
    if (phoneMaybe) {
      setUserPhone(chatId, phoneMaybe);
      return sendTracked(chatId, `✅ Saved number: ${formatTo07(phoneMaybe)}\nNow tap ✅ Proceed.`, { ...confirmKeyboard(true) });
    }

    return sendTracked(chatId, "Choose ✅ Proceed or 📞 Change Number.", confirmKeyboard(!!getUserPhone(chatId)));
  }

  if (s.step === "phone") {
    const phone = normalizePhone(text);
    if (!phone) return sendTracked(chatId, "❌ Invalid phone. Use 07/01/2547/2541.", confirmKeyboard(false));

    setUserPhone(chatId, phone);

    s.step = "confirm";
    sessions.set(chatId, s);

    const pkg = findPackageByLabel(s.category, s.pkgKey);
    if (!pkg) {
      sessions.delete(chatId);
      return sendTracked(chatId, "❌ Package missing. Tap 🛒 Buy Offers again.", { ...mainMenuKeyboard() });
    }

    return sendTracked(chatId, `✅ Number saved: *${formatTo07(phone)}*\n\nSelected: *${pkg.label}*\n\nTap ✅ Proceed to send STK.`, {
      parse_mode: "Markdown",
      ...confirmKeyboard(true),
    });
  }
});

// ===================== START SERVER AFTER BOT READY =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🌐 Webhook server listening on", PORT));
console.log("✅ Bingwa Mtaani PayHero STK bot running");
