const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { sendPushNotification, sendPushToMultiple } = require("../utils/firebase");
const { logActivity } = require("./dashboard");

/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: Push notifications & device token management (Firebase FCM)
 */

// ─────────────────────────────────────────────────────────────────────────────
// DEVICE TOKENS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/notifications/register-token:
 *   post:
 *     summary: Register or update a device FCM token for a user
 *     tags: [Notifications]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_id, fcm_token, platform]
 *             properties:
 *               user_id:   { type: string, format: uuid }
 *               fcm_token: { type: string }
 *               platform:  { type: string, enum: [web, android, ios] }
 *               device_id: { type: string, description: "Optional unique device identifier" }
 *     responses:
 *       200:
 *         description: Token registered
 *       500:
 *         description: Server error
 */
router.post("/register-token", async (req, res) => {
  const { user_id, fcm_token, platform, device_id } = req.body;
  if (!user_id || !fcm_token || !platform) {
    return res.status(400).json({ error: "user_id, fcm_token, and platform are required" });
  }
  try {
    await pool.query(
      `INSERT INTO device_tokens (user_id, fcm_token, platform, device_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (fcm_token) DO UPDATE SET
         user_id = $1, platform = $3, device_id = $4, is_active = true, updated_at = CURRENT_TIMESTAMP`,
      [user_id, fcm_token, platform, device_id || null]
    );
    res.json({ message: "Token registered successfully" });
  } catch (error) {
    console.error("Register token error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/notifications/remove-token:
 *   post:
 *     summary: Remove a device FCM token (on logout)
 *     tags: [Notifications]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fcm_token]
 *             properties:
 *               fcm_token: { type: string }
 *     responses:
 *       200:
 *         description: Token removed
 */
router.post("/remove-token", async (req, res) => {
  const { fcm_token } = req.body;
  try {
    await pool.query(
      "UPDATE device_tokens SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE fcm_token = $1",
      [fcm_token]
    );
    res.json({ message: "Token removed" });
  } catch (error) {
    console.error("Remove token error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SEND NOTIFICATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/notifications/send:
 *   post:
 *     summary: Send a push notification to a specific user
 *     tags: [Notifications]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_id, title, body]
 *             properties:
 *               user_id:   { type: string, format: uuid }
 *               title:     { type: string }
 *               body:      { type: string }
 *               type:      { type: string, description: "Notification type e.g. attendance, po, pr, leave, inventory, general" }
 *               entity_type: { type: string }
 *               entity_id:   { type: string }
 *               data:        { type: object, description: "Extra data payload for the client" }
 *               sent_by:     { type: string, format: uuid }
 *               sent_by_name: { type: string }
 *     responses:
 *       200:
 *         description: Notification sent
 *       500:
 *         description: Server error
 */
router.post("/send", async (req, res) => {
  const { user_id, title, body, type, entity_type, entity_id, data, sent_by, sent_by_name } = req.body;
  if (!user_id || !title || !body) {
    return res.status(400).json({ error: "user_id, title, and body are required" });
  }
  try {
    const notif = await pool.query(
      `INSERT INTO notifications (user_id, title, body, type, entity_type, entity_id, data, sent_by, sent_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [user_id, title, body, type || "general", entity_type || null, entity_id || null,
       data ? JSON.stringify(data) : null, sent_by || null, sent_by_name || null]
    );

    const tokens = await pool.query(
      "SELECT fcm_token FROM device_tokens WHERE user_id = $1 AND is_active = true",
      [user_id]
    );

    let push_sent = 0;
    if (tokens.rows.length > 0) {
      const fcmTokens = tokens.rows.map(t => t.fcm_token);
      const results = await sendPushToMultiple({
        tokens: fcmTokens,
        title,
        body,
        data: { notification_id: String(notif.rows[0].notification_id), type: type || "general", entity_type: entity_type || "", entity_id: entity_id || "", ...(data || {}) },
      });
      push_sent = results.filter(r => r.success).length;
    }

    res.json({ notification: notif.rows[0], push_sent, total_devices: tokens.rows.length });
  } catch (error) {
    console.error("Send notification error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/notifications/send-bulk:
 *   post:
 *     summary: Send a push notification to multiple users
 *     tags: [Notifications]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_ids, title, body]
 *             properties:
 *               user_ids:  { type: array, items: { type: string, format: uuid } }
 *               title:     { type: string }
 *               body:      { type: string }
 *               type:      { type: string }
 *               entity_type: { type: string }
 *               entity_id:   { type: string }
 *               data:        { type: object }
 *               sent_by:     { type: string, format: uuid }
 *               sent_by_name: { type: string }
 *     responses:
 *       200:
 *         description: Notifications sent
 */
router.post("/send-bulk", async (req, res) => {
  const { user_ids, title, body, type, entity_type, entity_id, data, sent_by, sent_by_name } = req.body;
  if (!user_ids || !Array.isArray(user_ids) || !title || !body) {
    return res.status(400).json({ error: "user_ids (array), title, and body are required" });
  }
  try {
    const notifications = [];
    for (const user_id of user_ids) {
      const notif = await pool.query(
        `INSERT INTO notifications (user_id, title, body, type, entity_type, entity_id, data, sent_by, sent_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [user_id, title, body, type || "general", entity_type || null, entity_id || null,
         data ? JSON.stringify(data) : null, sent_by || null, sent_by_name || null]
      );
      notifications.push(notif.rows[0]);
    }

    const tokens = await pool.query(
      "SELECT fcm_token, user_id FROM device_tokens WHERE user_id = ANY($1) AND is_active = true",
      [user_ids]
    );

    let push_sent = 0;
    if (tokens.rows.length > 0) {
      const fcmTokens = tokens.rows.map(t => t.fcm_token);
      const results = await sendPushToMultiple({
        tokens: fcmTokens,
        title,
        body,
        data: { type: type || "general", entity_type: entity_type || "", entity_id: entity_id || "", ...(data || {}) },
      });
      push_sent = results.filter(r => r.success).length;
    }

    res.json({ notifications_created: notifications.length, push_sent, total_devices: tokens.rows.length });
  } catch (error) {
    console.error("Send bulk notification error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/notifications/send-all:
 *   post:
 *     summary: Send a push notification to all active users
 *     tags: [Notifications]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, body]
 *             properties:
 *               title:     { type: string }
 *               body:      { type: string }
 *               type:      { type: string }
 *               entity_type: { type: string }
 *               entity_id:   { type: string }
 *               data:        { type: object }
 *               sent_by:     { type: string, format: uuid }
 *               sent_by_name: { type: string }
 *     responses:
 *       200:
 *         description: Notifications sent to all users
 */
router.post("/send-all", async (req, res) => {
  const { title, body, type, entity_type, entity_id, data, sent_by, sent_by_name } = req.body;
  if (!title || !body) {
    return res.status(400).json({ error: "title and body are required" });
  }
  try {
    const users = await pool.query("SELECT user_id FROM auth_users WHERE is_active = true");
    const user_ids = users.rows.map(u => u.user_id);

    for (const user_id of user_ids) {
      await pool.query(
        `INSERT INTO notifications (user_id, title, body, type, entity_type, entity_id, data, sent_by, sent_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [user_id, title, body, type || "general", entity_type || null, entity_id || null,
         data ? JSON.stringify(data) : null, sent_by || null, sent_by_name || null]
      );
    }

    const tokens = await pool.query(
      "SELECT fcm_token FROM device_tokens WHERE user_id = ANY($1) AND is_active = true",
      [user_ids]
    );

    let push_sent = 0;
    if (tokens.rows.length > 0) {
      const fcmTokens = tokens.rows.map(t => t.fcm_token);
      const results = await sendPushToMultiple({
        tokens: fcmTokens,
        title,
        body,
        data: { type: type || "general", entity_type: entity_type || "", entity_id: entity_id || "", ...(data || {}) },
      });
      push_sent = results.filter(r => r.success).length;
    }

    res.json({ users_notified: user_ids.length, push_sent, total_devices: tokens.rows.length });
  } catch (error) {
    console.error("Send all notification error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET NOTIFICATIONS (USER)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/notifications/user/{user_id}:
 *   get:
 *     summary: Get all notifications for a user
 *     tags: [Notifications]
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: is_read
 *         schema: { type: boolean }
 *         description: Filter by read status
 *       - in: query
 *         name: type
 *         schema: { type: string }
 *         description: Filter by notification type
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: List of notifications
 */
router.get("/user/:user_id", async (req, res) => {
  const { user_id } = req.params;
  const { is_read, type, limit = 50, offset = 0 } = req.query;
  try {
    let query = "SELECT * FROM notifications WHERE user_id = $1";
    const params = [user_id];
    let p = 2;

    if (is_read !== undefined) {
      query += ` AND is_read = $${p++}`;
      params.push(is_read === "true");
    }
    if (type) {
      query += ` AND type = $${p++}`;
      params.push(type);
    }

    query += ` ORDER BY created_at DESC LIMIT $${p++} OFFSET $${p++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    const countResult = await pool.query(
      "SELECT COUNT(*) FILTER (WHERE is_read = false) AS unread_count FROM notifications WHERE user_id = $1",
      [user_id]
    );

    res.json({
      notifications: result.rows,
      unread_count: parseInt(countResult.rows[0].unread_count),
    });
  } catch (error) {
    console.error("Get notifications error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/notifications/user/{user_id}/unread-count:
 *   get:
 *     summary: Get unread notification count for a user
 *     tags: [Notifications]
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Unread count
 */
router.get("/user/:user_id/unread-count", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false",
      [req.params.user_id]
    );
    res.json({ unread_count: parseInt(result.rows[0].count) });
  } catch (error) {
    console.error("Get unread count error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MARK READ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/notifications/{id}/read:
 *   patch:
 *     summary: Mark a notification as read
 *     tags: [Notifications]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Marked as read
 *       404:
 *         description: Notification not found
 */
router.patch("/:id/read", async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE notifications SET is_read = true, read_at = CURRENT_TIMESTAMP WHERE notification_id = $1 RETURNING *",
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Notification not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Mark read error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/notifications/user/{user_id}/read-all:
 *   patch:
 *     summary: Mark all notifications as read for a user
 *     tags: [Notifications]
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: All marked as read
 */
router.patch("/user/:user_id/read-all", async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE notifications SET is_read = true, read_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND is_read = false RETURNING notification_id",
      [req.params.user_id]
    );
    res.json({ message: "All notifications marked as read", count: result.rowCount });
  } catch (error) {
    console.error("Mark all read error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/notifications/{id}:
 *   delete:
 *     summary: Delete a notification
 *     tags: [Notifications]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Notification deleted
 *       404:
 *         description: Not found
 */
router.delete("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM notifications WHERE notification_id = $1 RETURNING *",
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Notification not found" });
    }
    res.json({ message: "Notification deleted" });
  } catch (error) {
    console.error("Delete notification error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/notifications/user/{user_id}/clear:
 *   delete:
 *     summary: Delete all notifications for a user
 *     tags: [Notifications]
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: All notifications cleared
 */
router.delete("/user/:user_id/clear", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM notifications WHERE user_id = $1 RETURNING notification_id",
      [req.params.user_id]
    );
    res.json({ message: "All notifications cleared", count: result.rowCount });
  } catch (error) {
    console.error("Clear notifications error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
