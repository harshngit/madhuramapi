const cron = require("node-cron");
const { pool } = require("../db");
const { sendPushToUsers } = require("../utils/pushHelper");

function startAttendanceCrons() {
  // ── 1. Morning check-in reminder — every day at 8:00 AM ───────────────────
  cron.schedule("0 8 * * *", async () => {
    console.log("[CRON] Sending morning check-in reminder...");
    try {
      const users = await pool.query(
        "SELECT user_id FROM auth_users WHERE is_blocked = false"
      );
      const userIds = users.rows.map((u) => u.user_id);
      if (userIds.length === 0) return;

      await sendPushToUsers({
        userIds,
        title: "Check-in Reminder",
        body: "Good morning! Please check in for today's attendance.",
        data: { type: "attendance_reminder", action: "check_in_reminder" },
      });
      console.log(`[CRON] Check-in reminder sent to ${userIds.length} users`);
    } catch (err) {
      console.error("[CRON] Check-in reminder error:", err.message);
    }
  }, { timezone: "Asia/Kolkata" });

  // ── 2. Evening check-out reminder — every day at 6:00 PM ──────────────────
  cron.schedule("0 18 * * *", async () => {
    console.log("[CRON] Sending evening check-out reminder...");
    try {
      const today = new Date().toISOString().split("T")[0];
      const result = await pool.query(
        `SELECT DISTINCT a.user_id FROM attendance a
         JOIN auth_users u ON u.user_id = a.user_id
         WHERE a.date = $1 AND a.check_out_time IS NULL AND u.is_blocked = false`,
        [today]
      );
      const userIds = result.rows.map((r) => r.user_id);
      if (userIds.length === 0) return;

      await sendPushToUsers({
        userIds,
        title: "Check-out Reminder",
        body: "Please complete your check-out for today.",
        data: { type: "attendance_reminder", action: "check_out_reminder" },
      });
      console.log(`[CRON] Check-out reminder sent to ${userIds.length} users`);
    } catch (err) {
      console.error("[CRON] Check-out reminder error:", err.message);
    }
  }, { timezone: "Asia/Kolkata" });

  // ── 3. Daily attendance summary for admin — every day at 9:00 PM ──────────
  cron.schedule("0 21 * * *", async () => {
    console.log("[CRON] Sending daily attendance summary to admin...");
    try {
      const today = new Date().toISOString().split("T")[0];

      const totalUsers = await pool.query(
        "SELECT COUNT(*) AS count FROM auth_users WHERE is_blocked = false"
      );
      const total = parseInt(totalUsers.rows[0].count);

      const presentResult = await pool.query(
        "SELECT COUNT(DISTINCT user_id) AS count FROM attendance WHERE date = $1",
        [today]
      );
      const present = parseInt(presentResult.rows[0].count);

      const lateResult = await pool.query(
        "SELECT COUNT(DISTINCT user_id) AS count FROM attendance WHERE date = $1 AND remark LIKE 'User is late%'",
        [today]
      );
      const late = parseInt(lateResult.rows[0].count);

      const absent = total - present;

      const admins = await pool.query(
        "SELECT user_id FROM auth_users WHERE role = 'admin'"
      );
      const adminIds = admins.rows.map((a) => a.user_id);
      if (adminIds.length === 0) return;

      await sendPushToUsers({
        userIds: adminIds,
        title: "Daily Attendance Report",
        body: `Today: ${present} present, ${absent} absent, ${late} late (out of ${total} workers)`,
        data: { type: "attendance_summary", action: "daily_summary", present: String(present), absent: String(absent), late: String(late), total: String(total) },
      });
      console.log("[CRON] Daily summary sent to admin");
    } catch (err) {
      console.error("[CRON] Daily summary error:", err.message);
    }
  }, { timezone: "Asia/Kolkata" });

  // ── 4. Absent workers report for admin — next day at 9:00 AM ──────────────
  cron.schedule("0 9 * * *", async () => {
    console.log("[CRON] Sending absent workers report to admin...");
    try {
      const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

      const absentResult = await pool.query(
        `SELECT u.user_id, u.name FROM auth_users u
         WHERE u.is_blocked = false
           AND u.user_id NOT IN (
             SELECT DISTINCT user_id FROM attendance WHERE date = $1
           )`,
        [yesterday]
      );

      if (absentResult.rows.length === 0) return;

      const names = absentResult.rows.map((r) => r.name).slice(0, 10).join(", ");
      const extra = absentResult.rows.length > 10 ? ` and ${absentResult.rows.length - 10} more` : "";

      const admins = await pool.query(
        "SELECT user_id FROM auth_users WHERE role = 'admin'"
      );
      const adminIds = admins.rows.map((a) => a.user_id);
      if (adminIds.length === 0) return;

      await sendPushToUsers({
        userIds: adminIds,
        title: "Absent Workers Report",
        body: `${absentResult.rows.length} workers were absent yesterday: ${names}${extra}`,
        data: { type: "attendance_summary", action: "absent_report", date: yesterday, absent_count: String(absentResult.rows.length) },
      });
      console.log("[CRON] Absent report sent to admin");
    } catch (err) {
      console.error("[CRON] Absent report error:", err.message);
    }
  }, { timezone: "Asia/Kolkata" });

  console.log("Attendance cron jobs scheduled (timezone: Asia/Kolkata)");
}

module.exports = { startAttendanceCrons };
