'use strict';

module.exports.initRiskEngine = function initRiskEngine(bot, ctx) {
  // This module was extracted from index.js (advanced risk protection layer)
  // 🚨 ADVANCED RISK PROTECTION LAYER
// - 7 override attempts → 1 day withdrawal cooldown
// - Dynamic risk score per account
// ===============================================================

if (!ctx.getDB().riskProfiles || typeof ctx.getDB().riskProfiles !== "object") {
  ctx.getDB().riskProfiles = {};
}

const WITHDRAW_LOCK_24H_MS = 24 * 60 * 60 * 1000;
const MAX_OVERRIDE_ATTEMPTS = 7;

function getRiskProfile(chatId) {
  ctx.getDB().riskProfiles[chatId] = ctx.getDB().riskProfiles[chatId] || {
    overrideAttempts: 0,
    withdrawalLockUntil: 0,
    riskScore: 0
  };
  return ctx.getDB().riskProfiles[chatId];
}

function increaseRisk(chatId, points) {
  const profile = getRiskProfile(chatId);
  profile.riskScore += Number(points || 0);
  ctx.saveDB();
}

function registerOverrideAttempt(chatId) {
  const profile = getRiskProfile(chatId);
  profile.overrideAttempts += 1;
  increaseRisk(chatId, 5);

  if (profile.overrideAttempts >= MAX_OVERRIDE_ATTEMPTS) {
    profile.withdrawalLockUntil = Date.now() + WITHDRAW_LOCK_24H_MS;
    increaseRisk(chatId, 20);
  }

  ctx.saveDB();
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
  if (!ctx.isAdmin(msg.chat.id)) return;
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
    ctx.saveDB();

    // Notify admin once per escalation
    bot.sendMessage(
      ctx.ADMIN_ID,
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
  if (!ctx.isAdmin(msg.chat.id)) return;

  const text = (msg.text || "").trim();

  // Manual block
  const blockMatch = text.match(/^\/block\s+(\d+)$/i);
  if (blockMatch) {
    const targetId = blockMatch[1];
    const profile = getRiskProfile(targetId);

    profile.withdrawalLockUntil = Date.now() + TEMP_BLOCK_72H_MS;
    ctx.saveDB();

    await bot.sendMessage(msg.chat.id, `⛔ User ${targetId} blocked for 72 hours.`);
    return;
  }

  // Manual unblock
  const unblockMatch = text.match(/^\/unblock\s+(\d+)$/i);
  if (unblockMatch) {
    const targetId = unblockMatch[1];
    const profile = getRiskProfile(targetId);

    profile.withdrawalLockUntil = 0;
    ctx.saveDB();

    await bot.sendMessage(msg.chat.id, `✅ User ${targetId} unblocked.`);
    return;
  }
});

console.log("🚨 Auto risk alert + 72hr block system enabled");




// ===============================================================
// 🧠 ADVANCED RISK DECAY + STK FAILURE RISK + REFERRAL PROTECTION
// ===============================================================

if (!ctx.getDB().phoneReferralLock || typeof ctx.getDB().phoneReferralLock !== "object") {
  ctx.getDB().phoneReferralLock = {};
  ctx.saveDB();
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

  ctx.saveDB();
}

// Hook into successful revenue recording
const __originalRecordRevenueRiskHook = ctx.getRecordSuccessfulRevenue();
const _wrappedRecordSuccessfulRevenue = function(pending) {
  if (pending && pending.chatId) {
    reduceRiskAfterSuccess(pending.chatId);
  }
  __originalRecordRevenueRiskHook(pending);
};


// ---------- 2️⃣ STK FAILURE INCREASES RISK ----------

function increaseRiskOnStkFailure(chatId) {
  const profile = getRiskProfile(chatId);
  profile.riskScore += 4;  // +4 per failed STK
  ctx.saveDB();
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
  const rec = ctx.getDB().phoneReferralLock[phone254];
  if (!rec) return true;

  const sameUser = String(rec.chatId) === String(buyerChatId);
  const within24h = Date.now() - rec.ts < REFERRAL_PHONE_LOCK_MS;

  if (!within24h) return true;
  if (sameUser) return true;

  return false;
}

function markReferralPhone(phone254, buyerChatId) {
  ctx.getDB().phoneReferralLock[phone254] = {
    chatId: String(buyerChatId),
    ts: Date.now()
  };
  ctx.saveDB();
}

// Hook referral reward logic
const __originalReferralReward = maybeRewardInviterOnSuccessPurchase;
maybeRewardInviterOnSuccessPurchase = function(buyerChatId, amountKsh, when) {

  const buyer = ctx.getUser(buyerChatId);
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

if (!ctx.getDB().phoneFirstAccount || typeof ctx.getDB().phoneFirstAccount !== "object") {
  ctx.getDB().phoneFirstAccount = {};
  ctx.saveDB();
}

// When a user saves or uses a phone, register first owner if not already set
function registerFirstAccountForPhone(phone254, chatId) {
  if (!phone254) return;

  if (!ctx.getDB().phoneFirstAccount[phone254]) {
    ctx.getDB().phoneFirstAccount[phone254] = {
      firstChatId: String(chatId),
      ts: Date.now()
    };
    ctx.saveDB();
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

  const buyer = ctx.getUser(buyerChatId);
  const phone = buyer.phone;

  if (!phone) {
    return __originalReferralRewardFirstOnly(buyerChatId, amountKsh, when);
  }

  const firstOwner = ctx.getDB().phoneFirstAccount[phone];

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

if (!ctx.getDB().phoneDailyFirstAccount || typeof ctx.getDB().phoneDailyFirstAccount !== "object") {
  ctx.getDB().phoneDailyFirstAccount = {};
  ctx.saveDB();
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

  ctx.getDB().phoneDailyFirstAccount[phone254] = ctx.getDB().phoneDailyFirstAccount[phone254] || {};

  if (!ctx.getDB().phoneDailyFirstAccount[phone254][dayKey]) {
    ctx.getDB().phoneDailyFirstAccount[phone254][dayKey] = {
      firstChatId: String(chatId),
      ts: Date.now()
    };
    ctx.saveDB();
  }
}

function isDailyFirstAccount(phone254, chatId) {
  const dayKey = getTodayKeySafe();
  const rec = ctx.getDB().phoneDailyFirstAccount?.[phone254]?.[dayKey];
  if (!rec) return true;
  return String(rec.firstChatId) === String(chatId);
}

// Override referral reward logic again (daily based)
const __originalReferralRewardDaily = maybeRewardInviterOnSuccessPurchase;
maybeRewardInviterOnSuccessPurchase = function(buyerChatId, amountKsh, when) {

  const buyer = ctx.getUser(buyerChatId);
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
    if (ctx.getDB().phoneDailyFirstAccount && typeof ctx.getDB().phoneDailyFirstAccount === "object") {
      for (const phone of Object.keys(ctx.getDB().phoneDailyFirstAccount)) {
        const dayEntries = ctx.getDB().phoneDailyFirstAccount[phone];
        if (dayEntries && typeof dayEntries === "object") {
          // Keep only current day entry
          if (dayEntries[currentDay]) {
            ctx.getDB().phoneDailyFirstAccount[phone] = {
              [currentDay]: dayEntries[currentDay]
            };
          } else {
            delete ctx.getDB().phoneDailyFirstAccount[phone];
          }
        }
      }
      ctx.saveDB();
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

  const buyer = ctx.getUser(buyerChatId);
  const phone = buyer.phone;

  if (!phone) {
    return __originalReferralRewardSuccessOnly(buyerChatId, amountKsh, when);
  }

  const dayKey = getCurrentDayKeySafe();

  ctx.getDB().phoneDailyFirstAccount = ctx.getDB().phoneDailyFirstAccount || {};
  ctx.getDB().phoneDailyFirstAccount[phone] = ctx.getDB().phoneDailyFirstAccount[phone] || {};

  const existing = ctx.getDB().phoneDailyFirstAccount[phone][dayKey];

  // If no successful purchase recorded yet today → allow & register
  if (!existing) {
    ctx.getDB().phoneDailyFirstAccount[phone][dayKey] = {
      firstChatId: String(buyerChatId),
      ts: Date.now()
    };
    ctx.saveDB();
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

  const buyer = ctx.getUser(buyerChatId);
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

  ctx.addPoints(inviterId, rewardPoints);

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


// Apply wrapper back to main scope (if present)
if (typeof _wrappedRecordSuccessfulRevenue === 'function') ctx.setRecordSuccessfulRevenue(_wrappedRecordSuccessfulRevenue);

};
