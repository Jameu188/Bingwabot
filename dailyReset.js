'use strict';

module.exports.initDailyReset = function initDailyReset(bot, ctx) {
  // This module was extracted from index.js (periodic tasks: leaderboard + inactivity nudges, etc.)
  // ===================== PERIODIC TASKS =====================
// ✅ Weekly Leaderboard (every Monday) + Inactivity Nudge (3+ days)
setInterval(async () => {
  try {
    ctx.setDB(ctx.repairDB(ctx.getDB()));
    const db = ctx.getDB();
    const now = new Date();
    const dayKey = ctx.todayKey();
    const weekKey = ctx.isoWeekKey(now);

    // Weekly leaderboard broadcast on Monday (Kenya time). Send once per week.
    // Monday = 1 (in Kenya, using local Date is fine because server should run in UTC but dayKey uses Kenya timezone)
    const isMonday = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Nairobi", weekday: "short" }).format(now).toLowerCase().startsWith("mon");
    if (isMonday && db.stats.lastLeaderboardWeek !== weekKey) {
      const text = ctx.buildReferralLeaderboardText(5);
      const userIds = ctx.getAllUserIds();
      for (const uid of userIds) {
        // eslint-disable-next-line no-await-in-loop
        await bot.sendMessage(uid, text, { parse_mode: "Markdown", ...ctx.mainMenuKeyboard(uid) }).catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        await ctx.sleep(35);
      }
      db.stats.lastLeaderboardWeek = weekKey;
      ctx.saveDB();
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
      ctx.saveDB();

      // eslint-disable-next-line no-await-in-loop
      await bot.sendMessage(
        Number(cid),
        `👋 We miss you!\n\nCome back today and grab your best offer.\n\n🎁 Tip: Share your referral link to earn points on every successful purchase!`,
        { ...ctx.mainMenuKeyboard(Number(cid)) }
      ).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await ctx.sleep(35);
    }
  } catch (e) {
    // silent
  }
}, 60 * 60 * 1000); // hourly

};
