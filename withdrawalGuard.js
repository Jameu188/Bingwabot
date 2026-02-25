'use strict';

module.exports.initWithdrawalGuard = function initWithdrawalGuard(bot, ctx) {
  // This module was extracted from index.js (min spend rule + spend tracking wrapper)
  
const MIN_WITHDRAW_SPEND_KSH = 300;

// Helper to calculate total lifetime spend
function getTotalUserSpend(chatId) {
  const user = ctx.getUser(chatId);
  return Number(user.totalSpentKsh || 0);
}

// Hook withdrawal amount selection
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  const withdrawOptions = ["25 pts","50 pts","100 pts","250 pts","500 pts","1000 pts","2000 pts"];
  if (!withdrawOptions.includes(text)) return;

  const totalSpent = getTotalUserSpend(chatId);

  if (totalSpent < MIN_WITHDRAW_SPEND_KSH && !ctx.isAdmin(chatId)) {
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
const __originalRecordRevenueMinSpend = ctx.getRecordSuccessfulRevenue();
const _wrappedRecordSuccessfulRevenueMinSpend = function(pending) {
  if (pending && pending.chatId && pending.price) {
    const user = ctx.getUser(pending.chatId);
    user.totalSpentKsh = Number(user.totalSpentKsh || 0) + Number(pending.price || 0);
    ctx.saveDB();
  }
  __originalRecordRevenueMinSpend(pending);
};

console.log("💳 Minimum 300 KSH withdrawal requirement enforced.");



// Apply wrapper back to main scope
ctx.setRecordSuccessfulRevenue(_wrappedRecordSuccessfulRevenueMinSpend);

};
