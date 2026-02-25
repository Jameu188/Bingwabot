'use strict';

module.exports.initPhoneLock = function initPhoneLock(bot, ctx) {
  // This module was extracted from index.js (phone reuse lock + admin approval callbacks)
  if (!ctx.getDB().phoneAccountUsage || typeof ctx.getDB().phoneAccountUsage !== "object") {
  ctx.getDB().phoneAccountUsage = {};
  ctx.saveDB();
}

if (!ctx.getDB().pendingPhoneOverrides || typeof ctx.getDB().pendingPhoneOverrides !== "object") {
  ctx.getDB().pendingPhoneOverrides = {};
  ctx.saveDB();
}

const PHONE_LOCK_WINDOW_MS = 24 * 60 * 60 * 1000;

function canUsePhone(chatId, phone254) {
  const rec = ctx.getDB().phoneAccountUsage[phone254];
  if (!rec) return { ok: true };

  const sameUser = String(rec.chatId) === String(chatId);
  const withinWindow = Date.now() - Number(rec.lastUsed || 0) < PHONE_LOCK_WINDOW_MS;

  if (sameUser) return { ok: true };
  if (!withinWindow) return { ok: true };

  return { ok: false, lockedBy: rec.chatId };
}

function markPhoneUsage(chatId, phone254) {
  ctx.getDB().phoneAccountUsage[phone254] = {
    chatId: String(chatId),
    lastUsed: Date.now()
  };
  ctx.saveDB();
}

// Wrap existing phone usage marking inside successful STK send
const __originalMarkBingwaPurchasedToday = markBingwaPurchasedToday;
markBingwaPurchasedToday = function (phone254) {
  const result = __originalMarkBingwaPurchasedToday(phone254);
  return result;
};

// Hook into STK send process by wrapping payheroStkPush call indirectly via usage mark
const __originalPayheroStkPush = ctx.getPayheroStkPush();
const _wrappedPayheroStkPush = async function (payload) {
  const phone = payload.phone;
  const chatId = payload.externalRef?.split("-").pop();

  const check = canUsePhone(chatId, phone);

  if (!check.ok) {
    const overrideId = `PH-${Date.now()}-${chatId}`;

    ctx.getDB().pendingPhoneOverrides[overrideId] = {
      phone,
      requestingChatId: chatId,
      lockedBy: check.lockedBy,
      status: "pending",
      time: ctx.kenyaDateTime()
    };
    ctx.saveDB();

    await bot.sendMessage(
      ctx.ADMIN_ID,
      `🚩 Phone Reuse Alert

Phone: ${ctx.formatTo07(phone)}
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
  if (!ctx.isAdmin(q.message?.chat?.id)) return;

  if (!data.startsWith("phone_")) return;

  const [action, overrideId] = data.split(":");
  const req = ctx.getDB().pendingPhoneOverrides[overrideId];
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

  ctx.saveDB();

  // remove buttons + delete admin request message
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
  await bot.deleteMessage(q.message.chat.id, q.message.message_id).catch(() => {});
  await bot.answerCallbackQuery(q.id).catch(() => {});
});

console.log("🚩 24hr phone lock system enabled");




// ===============================================================


// Apply wrapper back to main scope
ctx.setPayheroStkPush(_wrappedPayheroStkPush);

};
