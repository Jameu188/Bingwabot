'use strict';

module.exports.applyReferralIfAny = function applyReferralIfAny(ctx, chatId, payload) {
  if (!payload || typeof payload !== "string") return;
  if (!payload.startsWith("ref_")) return;
  const inviter = payload.slice(4).trim();
  if (!/^\d+$/.test(inviter)) return;
  if (String(inviter) === String(chatId)) return;

  const u = ctx.getUser(chatId);
  if (!u.inviterId) {
    u.inviterId = String(inviter);
    ctx.saveDB();
  }
};

// Credits inviter ONLY on successful callback; bonus = 2% of amount paid
module.exports.maybeRewardInviterOnSuccessPurchase = function maybeRewardInviterOnSuccessPurchase(ctx, buyerChatId, amountKsh, when) {
  const buyer = ctx.getUser(buyerChatId);
  const inviterId = buyer.inviterId;
  if (!inviterId) return;

  const amt = Number(amountKsh || 0);
  if (!Number.isFinite(amt) || amt <= 0) return;

  const bonus = amt * 0.02; // keep same percent
  if (!Number.isFinite(bonus) || bonus <= 0) return;

  ctx.addPoints(inviterId, bonus);

  // count unique successful referrals (only first success per referred user)
  if (!buyer.referralCounted) {
    const inv = ctx.getUser(inviterId);
    inv.referralSuccessCount = Number(inv.referralSuccessCount || 0) + 1;
    buyer.referralCounted = true;
    ctx.saveDB();
  }

  // admin logging is handled in index.js if desired; keep this pure
};
