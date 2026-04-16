"use strict";

/**
 * Simple Telegram bot with Daraja STK Push
 *
 * Features:
 * - /start welcome flow
 * - Reply-keyboard main menu
 * - Buy Data / Buy SMS / Buy Minutes sample menus
 * - Saved phone number management
 * - Daraja OAuth token caching
 * - Daraja STK push initiation
 * - Daraja callback endpoint
 * - In-memory pending payments (swap to DB in production)
 *
 * Deploy:
 * 1) npm i node-telegram-bot-api express
 * 2) Set env vars shown in REQUIRED ENV below
 * 3) node daraja_telegram_bot.js
 */

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const fetchFn = global.fetch;
if (!fetchFn) {
  throw new Error("Node 18+ is required because global fetch is not available.");
}
const fetch = (...args) => fetchFn(...args);

// ===================== REQUIRED ENV =====================
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const BASE_URL = String(process.env.BASE_URL || "").trim();
const PORT = Number(process.env.PORT || 3000);

const DARAJA_CONSUMER_KEY = String(process.env.DARAJA_CONSUMER_KEY || "").trim();
const DARAJA_CONSUMER_SECRET = String(process.env.DARAJA_CONSUMER_SECRET || "").trim();
const DARAJA_SHORTCODE = String(process.env.DARAJA_SHORTCODE || "174379").trim();
const DARAJA_PASSKEY = String(process.env.DARAJA_PASSKEY || "").trim();
const DARAJA_CALLBACK_URL = String(
  process.env.DARAJA_CALLBACK_URL || (BASE_URL ? `${BASE_URL.replace(/\/+$/, "")}/daraja/callback` : "")
).trim();
const DARAJA_ENV = String(process.env.DARAJA_ENV || "sandbox").trim().toLowerCase();

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN env var.");
if (!DARAJA_CONSUMER_KEY) throw new Error("Missing DARAJA_CONSUMER_KEY env var.");
if (!DARAJA_CONSUMER_SECRET) throw new Error("Missing DARAJA_CONSUMER_SECRET env var.");
if (!DARAJA_PASSKEY) throw new Error("Missing DARAJA_PASSKEY env var.");
if (!DARAJA_CALLBACK_URL) throw new Error("Missing DARAJA_CALLBACK_URL or BASE_URL env var.");

const DARAJA = {
  oauthUrl:
    DARAJA_ENV === "production"
      ? "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials"
      : "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
  stkUrl:
    DARAJA_ENV === "production"
      ? "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest"
      : "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
};

const app = express();
app.use(express.json({ limit: "2mb" }));

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// ===================== SIMPLE IN-MEMORY STORE =====================
// Replace this with Postgres / Redis / file DB in production.
const users = new Map();
const pendingPayments = new Map();
const processedCheckoutIds = new Set();

function getUser(chatId) {
  const key = String(chatId);
  if (!users.has(key)) {
    users.set(key, {
      chatId: Number(chatId),
      phone: "",
      state: null,
      pendingPackage: null,
    });
  }
  return users.get(key);
}

function normalizePhone(input) {
  const raw = String(input || "").replace(/\s+/g, "").replace(/^\+/, "");
  if (/^0[17]\d{8}$/.test(raw)) return `254${raw.slice(1)}`;
  if (/^254[17]\d{8}$/.test(raw)) return raw;
  return null;
}

function maskPhone(phone254) {
  const phone = String(phone254 || "");
  if (!/^254\d{9}$/.test(phone)) return "Not set";
  return `${phone.slice(0, 6)}***${phone.slice(-3)}`;
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      resize_keyboard: true,
      keyboard: [
        [{ text: "🛒 Buy Data" }, { text: "✉️ Buy SMS" }],
        [{ text: "📞 Buy Minutes" }, { text: "📱 My Number" }],
        [{ text: "ℹ️ Help" }, { text: "🏠 Main Menu" }],
      ],
    },
  };
}

function backKeyboard() {
  return {
    reply_markup: {
      resize_keyboard: true,
      keyboard: [[{ text: "⬅️ Back" }, { text: "🏠 Main Menu" }]],
    },
  };
}

const PACKAGES = {
  data: [
    { key: "data_1", label: "1GB - Ksh 99", amount: 99 },
    { key: "data_2", label: "2GB - Ksh 199", amount: 199 },
    { key: "data_3", label: "5GB - Ksh 499", amount: 499 },
  ],
  sms: [
    { key: "sms_1", label: "200 SMS - Ksh 20", amount: 20 },
    { key: "sms_2", label: "1000 SMS - Ksh 50", amount: 50 },
  ],
  minutes: [
    { key: "min_1", label: "20 Minutes - Ksh 20", amount: 20 },
    { key: "min_2", label: "60 Minutes - Ksh 50", amount: 50 },
  ],
};

function packageKeyboard(group) {
  const items = PACKAGES[group] || [];
  return {
    reply_markup: {
      resize_keyboard: true,
      keyboard: [
        ...items.map((item) => [{ text: item.label }]),
        [{ text: "⬅️ Back" }, { text: "🏠 Main Menu" }],
      ],
    },
  };
}

function findPackageByLabel(label) {
  for (const [group, items] of Object.entries(PACKAGES)) {
    const found = items.find((item) => item.label === label);
    if (found) return { group, ...found };
  }
  return null;
}

function confirmKeyboard(user) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: `✅ Proceed (${maskPhone(user.phone)})`, callback_data: "pay:proceed" }],
        [{ text: "📱 Change Number", callback_data: "pay:change_number" }],
        [{ text: "❌ Cancel", callback_data: "pay:cancel" }],
      ],
    },
  };
}

async function sendMenu(chatId) {
  return bot.sendMessage(
    chatId,
    "Welcome. Choose an option from the menu below.",
    mainMenuKeyboard()
  );
}

// ===================== DARAJA =====================
const darajaTokenCache = {
  token: "",
  expiresAt: 0,
};

function darajaTimestamp() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}${hh}${mi}${ss}`;
}

async function getDarajaAccessToken() {
  const now = Date.now();
  if (darajaTokenCache.token && darajaTokenCache.expiresAt > now + 60_000) {
    return darajaTokenCache.token;
  }

  const auth = Buffer.from(`${DARAJA_CONSUMER_KEY}:${DARAJA_CONSUMER_SECRET}`).toString("base64");

  const res = await fetch(DARAJA.oauthUrl, {
    method: "GET",
    headers: {
      Authorization: `Basic ${auth}`,
    },
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Daraja token error: ${JSON.stringify(data)}`);
  }

  darajaTokenCache.token = String(data.access_token);
  darajaTokenCache.expiresAt = now + (Math.max(60, Number(data.expires_in || 3599) - 60) * 1000);
  return darajaTokenCache.token;
}

function makeExternalRef(chatId, pkg) {
  const safeKey = String(pkg?.key || "pkg");
  return `TG${chatId}_${safeKey}_${Date.now()}`;
}

async function darajaStkPush({ amount, phone, accountReference, transactionDesc }) {
  const accessToken = await getDarajaAccessToken();
  const timestamp = darajaTimestamp();
  const password = Buffer.from(`${DARAJA_SHORTCODE}${DARAJA_PASSKEY}${timestamp}`).toString("base64");

  const payload = {
    BusinessShortCode: DARAJA_SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.round(Number(amount || 0)),
    PartyA: phone,
    PartyB: DARAJA_SHORTCODE,
    PhoneNumber: phone,
    CallBackURL: DARAJA_CALLBACK_URL,
    AccountReference: accountReference,
    TransactionDesc: transactionDesc || "Telegram payment",
  };

  const res = await fetch(DARAJA.stkUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Daraja STK HTTP error: ${JSON.stringify(data)}`);
  }
  if (String(data.ResponseCode) !== "0") {
    throw new Error(data.ResponseDescription || "STK request failed");
  }

  return data;
}

// ===================== TELEGRAM FLOW =====================
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  const user = getUser(chatId);
  user.state = null;
  user.pendingPackage = null;

  await bot.sendMessage(
    chatId,
    [
      "👋 Welcome to your Daraja Telegram Bot.",
      "",
      "This bot can:",
      "• start STK Push payments",
      "• save your phone number",
      "• show simple buy menus",
      "",
      `Saved number: ${maskPhone(user.phone)}`,
    ].join("\n"),
    mainMenuKeyboard()
  );
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = String(msg.text || "").trim();
  if (!text || text.startsWith("/start")) return;

  const user = getUser(chatId);

  if (user.state === "await_phone_save") {
    const phone = normalizePhone(text);
    if (!phone) {
      await bot.sendMessage(chatId, "Invalid phone number. Send it as 07xxxxxxxx, 01xxxxxxxx, 2547xxxxxxxx, or 2541xxxxxxxx.", backKeyboard());
      return;
    }
    user.phone = phone;
    user.state = null;
    await bot.sendMessage(chatId, `✅ Number saved: ${maskPhone(phone)}`, mainMenuKeyboard());
    return;
  }

  if (user.state === "await_phone_for_payment") {
    const phone = normalizePhone(text);
    if (!phone) {
      await bot.sendMessage(chatId, "Invalid phone number. Send a valid Safaricom number.", backKeyboard());
      return;
    }
    user.phone = phone;
    user.state = null;

    if (!user.pendingPackage) {
      await bot.sendMessage(chatId, "No pending package found. Start again from the menu.", mainMenuKeyboard());
      return;
    }

    await bot.sendMessage(
      chatId,
      [
        `Package: ${user.pendingPackage.label}`,
        `Amount: Ksh ${user.pendingPackage.amount}`,
        `Phone: ${maskPhone(user.phone)}`,
        "",
        "Tap proceed to send STK push.",
      ].join("\n"),
      confirmKeyboard(user)
    );
    return;
  }

  if (text === "🏠 Main Menu") {
    user.state = null;
    user.pendingPackage = null;
    await sendMenu(chatId);
    return;
  }

  if (text === "⬅️ Back") {
    user.state = null;
    user.pendingPackage = null;
    await sendMenu(chatId);
    return;
  }

  if (text === "🛒 Buy Data") {
    await bot.sendMessage(chatId, "Choose a data package:", packageKeyboard("data"));
    return;
  }

  if (text === "✉️ Buy SMS") {
    await bot.sendMessage(chatId, "Choose an SMS package:", packageKeyboard("sms"));
    return;
  }

  if (text === "📞 Buy Minutes") {
    await bot.sendMessage(chatId, "Choose a minutes package:", packageKeyboard("minutes"));
    return;
  }

  if (text === "📱 My Number") {
    user.state = "await_phone_save";
    await bot.sendMessage(
      chatId,
      `Current number: ${maskPhone(user.phone)}\n\nSend your Safaricom number now.`,
      backKeyboard()
    );
    return;
  }

  if (text === "ℹ️ Help") {
    await bot.sendMessage(
      chatId,
      [
        "Help:",
        "• Use My Number to save the number that receives STK push.",
        "• Choose a package from the menu.",
        "• Confirm to send STK.",
        "• Callback URL must be reachable publicly.",
      ].join("\n"),
      mainMenuKeyboard()
    );
    return;
  }

  const pkg = findPackageByLabel(text);
  if (pkg) {
    user.pendingPackage = pkg;
    if (!user.phone) {
      user.state = "await_phone_for_payment";
      await bot.sendMessage(
        chatId,
        [
          `Package: ${pkg.label}`,
          `Amount: Ksh ${pkg.amount}`,
          "",
          "Send the Safaricom number to receive STK push.",
        ].join("\n"),
        backKeyboard()
      );
      return;
    }

    await bot.sendMessage(
      chatId,
      [
        `Package: ${pkg.label}`,
        `Amount: Ksh ${pkg.amount}`,
        `Phone: ${maskPhone(user.phone)}`,
        "",
        "Tap proceed to send STK push.",
      ].join("\n"),
      confirmKeyboard(user)
    );
    return;
  }
});

bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat?.id || query.from.id;
  const data = String(query.data || "");
  const user = getUser(chatId);

  try {
    if (data === "pay:change_number") {
      user.state = "await_phone_for_payment";
      await bot.answerCallbackQuery(query.id, { text: "Send a new phone number." });
      await bot.sendMessage(chatId, "Send the new Safaricom number for this payment.", backKeyboard());
      return;
    }

    if (data === "pay:cancel") {
      user.state = null;
      user.pendingPackage = null;
      await bot.answerCallbackQuery(query.id, { text: "Payment cancelled." });
      await sendMenu(chatId);
      return;
    }

    if (data === "pay:proceed") {
      if (!user.pendingPackage) {
        await bot.answerCallbackQuery(query.id, { text: "No package selected." });
        await sendMenu(chatId);
        return;
      }
      if (!user.phone) {
        user.state = "await_phone_for_payment";
        await bot.answerCallbackQuery(query.id, { text: "Set phone number first." });
        await bot.sendMessage(chatId, "Send the Safaricom number to receive STK push.", backKeyboard());
        return;
      }

      const externalRef = makeExternalRef(chatId, user.pendingPackage);
      pendingPayments.set(externalRef, {
        chatId,
        phone: user.phone,
        packageKey: user.pendingPackage.key,
        packageLabel: user.pendingPackage.label,
        amount: user.pendingPackage.amount,
        createdAt: Date.now(),
        status: "pending",
      });

      await bot.answerCallbackQuery(query.id, { text: "Sending STK push..." });

      const stk = await darajaStkPush({
        amount: user.pendingPackage.amount,
        phone: user.phone,
        accountReference: externalRef,
        transactionDesc: user.pendingPackage.label,
      });

      pendingPayments.set(externalRef, {
        ...pendingPayments.get(externalRef),
        merchantRequestId: String(stk.MerchantRequestID || ""),
        checkoutRequestId: String(stk.CheckoutRequestID || ""),
      });

      await bot.sendMessage(
        chatId,
        [
          "✅ STK push sent.",
          `Package: ${user.pendingPackage.label}`,
          `Amount: Ksh ${user.pendingPackage.amount}`,
          `Phone: ${maskPhone(user.phone)}`,
          "",
          "Complete the payment on your phone.",
        ].join("\n"),
        mainMenuKeyboard()
      );

      user.pendingPackage = null;
      user.state = null;
      return;
    }
  } catch (error) {
    console.error("Callback query error:", error);
    await bot.answerCallbackQuery(query.id, { text: "Failed. Check logs." }).catch(() => {});
    await bot.sendMessage(chatId, `❌ ${error.message}`, mainMenuKeyboard()).catch(() => {});
  }
});

// ===================== CALLBACK =====================
app.get("/", (_req, res) => {
  res.status(200).send("Bot is running.");
});

app.post("/daraja/callback", async (req, res) => {
  try {
    const cb = req.body?.Body?.stkCallback || {};
    const resultCode = Number(cb.ResultCode);
    const resultDesc = String(cb.ResultDesc || "");
    const merchantRequestId = String(cb.MerchantRequestID || "");
    const checkoutRequestId = String(cb.CheckoutRequestID || "");

    if (checkoutRequestId && processedCheckoutIds.has(checkoutRequestId)) {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    const items = Array.isArray(cb.CallbackMetadata?.Item) ? cb.CallbackMetadata.Item : [];
    const meta = {};
    for (const item of items) {
      if (item && item.Name) meta[item.Name] = item.Value;
    }

    const amount = Number(meta.Amount || 0);
    const mpesaReceiptNumber = String(meta.MpesaReceiptNumber || "");
    const phoneNumber = String(meta.PhoneNumber || "");
    const accountReference = String(meta.AccountReference || "");

    let foundKey = "";
    let pending = null;

    for (const [key, value] of pendingPayments.entries()) {
      if (
        key === accountReference ||
        String(value.checkoutRequestId || "") === checkoutRequestId ||
        String(value.merchantRequestId || "") === merchantRequestId
      ) {
        foundKey = key;
        pending = value;
        break;
      }
    }

    if (!pending && accountReference && pendingPayments.has(accountReference)) {
      foundKey = accountReference;
      pending = pendingPayments.get(accountReference);
    }

    if (!pending) {
      console.warn("No pending payment matched callback:", {
        merchantRequestId,
        checkoutRequestId,
        accountReference,
      });
      if (checkoutRequestId) processedCheckoutIds.add(checkoutRequestId);
      return res.status(200).json({ ok: true, unmatched: true });
    }

    if (checkoutRequestId) processedCheckoutIds.add(checkoutRequestId);

    if (resultCode === 0 && mpesaReceiptNumber) {
      pendingPayments.set(foundKey, {
        ...pending,
        status: "success",
        resultDesc,
        receipt: mpesaReceiptNumber,
        amountPaid: amount,
        callbackPhone: phoneNumber,
        paidAt: Date.now(),
      });

      await bot.sendMessage(
        pending.chatId,
        [
          "✅ Payment confirmed.",
          `Package: ${pending.packageLabel}`,
          `Amount: Ksh ${amount || pending.amount}`,
          `Receipt: ${mpesaReceiptNumber}`,
          "",
          "Your request has been received successfully.",
        ].join("\n"),
        mainMenuKeyboard()
      ).catch(() => {});
    } else {
      pendingPayments.set(foundKey, {
        ...pending,
        status: "failed",
        resultDesc,
        failedAt: Date.now(),
      });

      await bot.sendMessage(
        pending.chatId,
        [
          "❌ Payment failed or was cancelled.",
          `Package: ${pending.packageLabel}`,
          `Amount: Ksh ${pending.amount}`,
          `Reason: ${resultDesc || "Unknown"}`,
        ].join("\n"),
        mainMenuKeyboard()
      ).catch(() => {});
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Daraja callback error:", error);
    return res.status(200).json({ ok: false });
  }
});

app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
  console.log(`Daraja env: ${DARAJA_ENV}`);
  console.log(`Callback URL: ${DARAJA_CALLBACK_URL}`);
});
