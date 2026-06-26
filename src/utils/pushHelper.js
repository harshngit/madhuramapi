const { pool } = require("../db");
const { sendPushToMultiple } = require("./firebase");

// ─── Notification templates keyed by "action|entity_type" ────────────────────
// Each entry defines: title, body builder, and target (role list OR "performer_target")
const NOTIFICATION_MAP = {
  // ── Attendance (labour → admin) ────────────────────────────────────────────
  "created|attendance": {
    title: "New Check-in",
    body: (p) => `${p.performed_by_name || "A worker"} has checked in`,
    target: ["admin"],
    dataType: "attendance",
  },
  "checked_out|attendance": {
    title: "Check-out",
    body: (p) => `${p.performed_by_name || "A worker"} has checked out`,
    target: ["admin"],
    dataType: "attendance",
  },
  "updated_status|attendance": {
    title: "Attendance Status Updated",
    body: (p) => `Your attendance status has been updated to ${p.meta?.status || "updated"}`,
    target: "performed_target",
    dataType: "attendance",
  },
  "updated|attendance": {
    title: "Attendance Updated",
    body: (p) => `Attendance record for ${p.entity_name || "a worker"} was updated`,
    target: ["admin"],
    dataType: "attendance",
  },
  "deleted|attendance": {
    title: "Attendance Deleted",
    body: (p) => `Attendance record ${p.entity_id || ""} was deleted`,
    target: ["admin"],
    dataType: "attendance",
  },
  "uploaded|attendance_photo": {
    title: "Attendance Photo Uploaded",
    body: (p) => `${p.performed_by_name || "A worker"} uploaded an attendance photo`,
    target: ["admin"],
    dataType: "attendance",
  },

  // ── User block/unblock (admin → target labour) ────────────────────────────
  "blocked_user|user": {
    title: "Account Blocked",
    body: () => "Your account has been blocked. Please contact admin.",
    target: "entity_target",
    dataType: "user",
  },
  "unblocked_user|user": {
    title: "Account Unblocked",
    body: () => "Your account has been unblocked. You can now check in.",
    target: "entity_target",
    dataType: "user",
  },

  // ── Leave ──────────────────────────────────────────────────────────────────
  "leave_applied|leave": {
    title: "New Leave Request",
    body: (p) => `${p.performed_by_name || "A worker"} has applied for leave (${p.meta?.from_date || ""} - ${p.meta?.to_date || ""})`,
    target: ["admin"],
    dataType: "leave",
  },
  "leave_granted_by_admin|leave": {
    title: "Leave Granted",
    body: (p) => `Admin has granted you leave from ${p.meta?.from_date || ""} to ${p.meta?.to_date || ""}`,
    target: "meta_target",
    metaTargetKey: "target_user_id",
    dataType: "leave",
  },
  "leave_approved|leave": {
    title: "Leave Approved",
    body: (p) => `Your leave request has been approved`,
    target: "entity_target",
    dataType: "leave",
  },
  "leave_rejected|leave": {
    title: "Leave Rejected",
    body: (p) => `Your leave request has been rejected`,
    target: "entity_target",
    dataType: "leave",
  },

  // ── PO (→ admin) ──────────────────────────────────────────────────────────
  "created|po": {
    title: "New Purchase Order",
    body: (p) => `PO "${p.entity_name || ""}" created by ${p.performed_by_name || "someone"}`,
    target: ["admin"],
    dataType: "po",
  },
  "updated|po": {
    title: "PO Updated",
    body: (p) => `PO "${p.entity_name || ""}" was updated`,
    target: ["admin"],
    dataType: "po",
  },
  "email_sent|po": {
    title: "PO Email Sent",
    body: (p) => `PO "${p.entity_name || ""}" email sent to vendor`,
    target: ["admin"],
    dataType: "po",
  },
  "deleted|po": {
    title: "PO Deleted",
    body: (p) => `PO "${p.entity_name || ""}" was deleted`,
    target: ["admin"],
    dataType: "po",
  },

  // ── PR (→ admin) ──────────────────────────────────────────────────────────
  "created|pr": {
    title: "New Purchase Request",
    body: (p) => `PR "${p.entity_name || ""}" created by ${p.performed_by_name || "someone"}`,
    target: ["admin"],
    dataType: "pr",
  },
  "updated|pr": {
    title: "PR Updated",
    body: (p) => `PR "${p.entity_name || ""}" was updated`,
    target: ["admin"],
    dataType: "pr",
  },
  "email_sent|pr": {
    title: "PR Email Sent",
    body: (p) => `PR "${p.entity_name || ""}" email sent`,
    target: ["admin"],
    dataType: "pr",
  },
  "deleted|pr": {
    title: "PR Deleted",
    body: (p) => `PR "${p.entity_name || ""}" was deleted`,
    target: ["admin"],
    dataType: "pr",
  },

  // ── Inventory (→ admin) ───────────────────────────────────────────────────
  "created|inventory": {
    title: "Inventory Added",
    body: (p) => `"${p.entity_name || "Item"}" added to inventory`,
    target: ["admin"],
    dataType: "inventory",
  },
  "updated|inventory": {
    title: "Inventory Updated",
    body: (p) => `"${p.entity_name || "Item"}" updated in inventory`,
    target: ["admin"],
    dataType: "inventory",
  },
  "deleted|inventory": {
    title: "Inventory Deleted",
    body: (p) => `"${p.entity_name || "Item"}" removed from inventory`,
    target: ["admin"],
    dataType: "inventory",
  },

  // ── MIR (→ admin) ─────────────────────────────────────────────────────────
  "created|mir": {
    title: "New MIR",
    body: (p) => `MIR "${p.entity_name || ""}" created`,
    target: ["admin"],
    dataType: "mir",
  },
  "updated|mir": {
    title: "MIR Updated",
    body: (p) => `MIR "${p.entity_name || ""}" was updated`,
    target: ["admin"],
    dataType: "mir",
  },
  "deleted|mir": {
    title: "MIR Deleted",
    body: (p) => `MIR "${p.entity_name || ""}" was deleted`,
    target: ["admin"],
    dataType: "mir",
  },
  "email_sent|mir": {
    title: "MIR Email Sent",
    body: (p) => `MIR "${p.entity_name || ""}" email sent`,
    target: ["admin"],
    dataType: "mir",
  },

  // ── ITR (→ admin) ─────────────────────────────────────────────────────────
  "created|itr": {
    title: "New ITR",
    body: (p) => `ITR "${p.entity_name || ""}" created`,
    target: ["admin"],
    dataType: "itr",
  },
  "updated|itr": {
    title: "ITR Updated",
    body: (p) => `ITR "${p.entity_name || ""}" was updated`,
    target: ["admin"],
    dataType: "itr",
  },
  "deleted|itr": {
    title: "ITR Deleted",
    body: (p) => `ITR "${p.entity_name || ""}" was deleted`,
    target: ["admin"],
    dataType: "itr",
  },

  // ── Quotation (→ admin) ───────────────────────────────────────────────────
  "created|quotation": {
    title: "New Quotation",
    body: (p) => `Quotation "${p.entity_name || ""}" created`,
    target: ["admin"],
    dataType: "quotation",
  },
  "updated|quotation": {
    title: "Quotation Updated",
    body: (p) => `Quotation "${p.entity_name || ""}" was updated`,
    target: ["admin"],
    dataType: "quotation",
  },
  "deleted|quotation": {
    title: "Quotation Deleted",
    body: (p) => `Quotation "${p.entity_name || ""}" was deleted`,
    target: ["admin"],
    dataType: "quotation",
  },

  // ── Quotation Field (→ admin) ─────────────────────────────────────────────
  "created|quotation_field": {
    title: "Quotation Field Added",
    body: (p) => `Field "${p.entity_name || ""}" added to quotation`,
    target: ["admin"],
    dataType: "quotation",
  },
  "updated|quotation_field": {
    title: "Quotation Field Updated",
    body: (p) => `Field "${p.entity_name || ""}" updated`,
    target: ["admin"],
    dataType: "quotation",
  },
  "deleted|quotation_field": {
    title: "Quotation Field Deleted",
    body: (p) => `Field "${p.entity_name || ""}" removed`,
    target: ["admin"],
    dataType: "quotation",
  },

  // ── Delivery Challan (→ admin) ────────────────────────────────────────────
  "created|delivery_challan": {
    title: "New Delivery Challan",
    body: (p) => `DC "${p.entity_name || ""}" created`,
    target: ["admin"],
    dataType: "delivery_challan",
  },
  "updated|delivery_challan": {
    title: "DC Updated",
    body: (p) => `DC "${p.entity_name || ""}" was updated`,
    target: ["admin"],
    dataType: "delivery_challan",
  },
  "deleted|delivery_challan": {
    title: "DC Deleted",
    body: (p) => `DC "${p.entity_name || ""}" was deleted`,
    target: ["admin"],
    dataType: "delivery_challan",
  },

  // ── BOQ (→ admin) ─────────────────────────────────────────────────────────
  "created|boq": {
    title: "New BOQ",
    body: (p) => `BOQ "${p.entity_name || ""}" created`,
    target: ["admin"],
    dataType: "boq",
  },
  "updated|boq": {
    title: "BOQ Updated",
    body: (p) => `BOQ "${p.entity_name || ""}" was updated`,
    target: ["admin"],
    dataType: "boq",
  },
  "deleted|boq": {
    title: "BOQ Deleted",
    body: (p) => `BOQ "${p.entity_name || ""}" was deleted`,
    target: ["admin"],
    dataType: "boq",
  },

  // ── Vendor (→ admin) ──────────────────────────────────────────────────────
  "created|vendor": {
    title: "New Vendor",
    body: (p) => `Vendor "${p.entity_name || ""}" added`,
    target: ["admin"],
    dataType: "vendor",
  },
  "updated|vendor": {
    title: "Vendor Updated",
    body: (p) => `Vendor "${p.entity_name || ""}" was updated`,
    target: ["admin"],
    dataType: "vendor",
  },
  "deleted|vendor": {
    title: "Vendor Deleted",
    body: (p) => `Vendor "${p.entity_name || ""}" was deleted`,
    target: ["admin"],
    dataType: "vendor",
  },

  // ── Vendor Price List (→ admin) ───────────────────────────────────────────
  "created|vendor_price_list": {
    title: "Vendor Price List Added",
    body: (p) => `Price list "${p.entity_name || ""}" added`,
    target: ["admin"],
    dataType: "vendor_price_list",
  },
  "updated|vendor_price_list": {
    title: "Vendor Price List Updated",
    body: (p) => `Price list "${p.entity_name || ""}" was updated`,
    target: ["admin"],
    dataType: "vendor_price_list",
  },
  "deleted|vendor_price_list": {
    title: "Vendor Price List Deleted",
    body: (p) => `Price list "${p.entity_name || ""}" was deleted`,
    target: ["admin"],
    dataType: "vendor_price_list",
  },

  // ── Vendor Comparison (→ admin) ───────────────────────────────────────────
  "created|vendor_comparison": {
    title: "Vendor Comparison Created",
    body: (p) => `Comparison "${p.entity_name || ""}" created`,
    target: ["admin"],
    dataType: "vendor_comparison",
  },
  "updated|vendor_comparison": {
    title: "Vendor Comparison Updated",
    body: (p) => `Comparison "${p.entity_name || ""}" was updated`,
    target: ["admin"],
    dataType: "vendor_comparison",
  },
  "deleted|vendor_comparison": {
    title: "Vendor Comparison Deleted",
    body: (p) => `Comparison "${p.entity_name || ""}" was deleted`,
    target: ["admin"],
    dataType: "vendor_comparison",
  },

  // ── Project (→ admin) ─────────────────────────────────────────────────────
  "created|project": {
    title: "New Project",
    body: (p) => `Project "${p.entity_name || ""}" created`,
    target: ["admin"],
    dataType: "project",
  },
  "updated|project": {
    title: "Project Updated",
    body: (p) => `Project "${p.entity_name || ""}" was updated`,
    target: ["admin"],
    dataType: "project",
  },
  "deleted|project": {
    title: "Project Deleted",
    body: (p) => `Project "${p.entity_name || ""}" was deleted`,
    target: ["admin"],
    dataType: "project",
  },

  // ── Sample (→ admin) ──────────────────────────────────────────────────────
  "created|sample": {
    title: "New Sample",
    body: (p) => `Sample "${p.entity_name || ""}" created`,
    target: ["admin"],
    dataType: "sample",
  },
  "updated|sample": {
    title: "Sample Updated",
    body: (p) => `Sample "${p.entity_name || ""}" was updated`,
    target: ["admin"],
    dataType: "sample",
  },
  "deleted|sample": {
    title: "Sample Deleted",
    body: (p) => `Sample "${p.entity_name || ""}" was deleted`,
    target: ["admin"],
    dataType: "sample",
  },

  // ── Inventory Trace (→ admin) ─────────────────────────────────────────────
  "created|inventory_trace": {
    title: "Inventory Trace Added",
    body: (p) => `Trace "${p.entity_name || ""}" created`,
    target: ["admin"],
    dataType: "inventory_trace",
  },
  "updated|inventory_trace": {
    title: "Inventory Trace Updated",
    body: (p) => `Trace "${p.entity_name || ""}" was updated`,
    target: ["admin"],
    dataType: "inventory_trace",
  },
  "deleted|inventory_trace": {
    title: "Inventory Trace Deleted",
    body: (p) => `Trace "${p.entity_name || ""}" was deleted`,
    target: ["admin"],
    dataType: "inventory_trace",
  },

  // ── Invoices (→ admin) ────────────────────────────────────────────────────
  "created|lodha_invoice": {
    title: "New Lodha Invoice",
    body: (p) => `Invoice "${p.entity_name || ""}" created`,
    target: ["admin"],
    dataType: "lodha_invoice",
  },
  "updated|lodha_invoice": {
    title: "Lodha Invoice Updated",
    body: (p) => `Invoice "${p.entity_name || ""}" was updated`,
    target: ["admin"],
    dataType: "lodha_invoice",
  },
  "deleted|lodha_invoice": {
    title: "Lodha Invoice Deleted",
    body: (p) => `Invoice "${p.entity_name || ""}" was deleted`,
    target: ["admin"],
    dataType: "lodha_invoice",
  },
  "created|hiranandani_invoice": {
    title: "New Hiranandani Invoice",
    body: (p) => `Invoice "${p.entity_name || ""}" created`,
    target: ["admin"],
    dataType: "hiranandani_invoice",
  },
  "updated|hiranandani_invoice": {
    title: "Hiranandani Invoice Updated",
    body: (p) => `Invoice "${p.entity_name || ""}" was updated`,
    target: ["admin"],
    dataType: "hiranandani_invoice",
  },
  "deleted|hiranandani_invoice": {
    title: "Hiranandani Invoice Deleted",
    body: (p) => `Invoice "${p.entity_name || ""}" was deleted`,
    target: ["admin"],
    dataType: "hiranandani_invoice",
  },

  // ── Bulk Inventory (→ admin) ──────────────────────────────────────────────
  "created|bulk_inventory": {
    title: "Bulk Inventory Upload",
    body: (p) => `Bulk inventory "${p.entity_name || ""}" uploaded`,
    target: ["admin"],
    dataType: "bulk_inventory",
  },

  // ── Auth ──────────────────────────────────────────────────────────────────
  "created|user": {
    title: "New User Registered",
    body: (p) => `${p.entity_name || "A new user"} has registered`,
    target: ["admin"],
    dataType: "user",
  },
};

// ─── Resolve target user IDs from the template config ────────────────────────
async function resolveTargetUserIds(config, params) {
  const { target } = config;

  if (Array.isArray(target)) {
    // target is a list of roles → fetch all users with those roles, excluding the performer
    const result = await pool.query(
      "SELECT user_id FROM auth_users WHERE role = ANY($1)",
      [target]
    );
    return result.rows
      .map((r) => r.user_id)
      .filter((id) => id !== params.performed_by);
  }

  if (target === "entity_target" && params.entity_id) {
    // entity_id IS the target user_id (e.g., block/unblock, leave approve/reject)
    return [params.entity_id].filter((id) => id !== params.performed_by);
  }

  if (target === "meta_target" && config.metaTargetKey && params.meta?.[config.metaTargetKey]) {
    return [params.meta[config.metaTargetKey]].filter((id) => id !== params.performed_by);
  }

  if (target === "performed_target" && params.entity_id) {
    // notification goes to the user whose attendance was updated (look up from attendance table)
    try {
      const result = await pool.query(
        "SELECT user_id FROM attendance WHERE attendance_id = $1",
        [params.entity_id]
      );
      if (result.rows.length > 0) {
        return [result.rows[0].user_id].filter((id) => id !== params.performed_by);
      }
    } catch (_) {}
    return [];
  }

  return [];
}

// ─── Main: send role-based push notification ─────────────────────────────────
async function sendRolePush(params) {
  const key = `${params.action}|${params.entity_type}`;
  const config = NOTIFICATION_MAP[key];
  if (!config) return;

  try {
    const userIds = await resolveTargetUserIds(config, params);
    if (userIds.length === 0) return;

    const tokenResult = await pool.query(
      "SELECT fcm_token FROM device_tokens WHERE user_id = ANY($1) AND is_active = true",
      [userIds]
    );
    if (tokenResult.rows.length === 0) return;

    const tokens = tokenResult.rows.map((r) => r.fcm_token);
    const title = config.title;
    const body = config.body(params);

    await sendPushToMultiple({
      tokens,
      title,
      body,
      data: {
        type: config.dataType || params.entity_type,
        entity_type: params.entity_type || "",
        entity_id: String(params.entity_id || ""),
      },
    });
  } catch (err) {
    console.error("sendRolePush error:", err.message);
  }
}

// ─── Send push to specific user IDs (used by cron jobs & leave status) ──────
async function sendPushToUsers({ userIds, title, body, data = {} }) {
  if (!userIds || userIds.length === 0) return;
  try {
    const tokenResult = await pool.query(
      "SELECT fcm_token FROM device_tokens WHERE user_id = ANY($1) AND is_active = true",
      [userIds]
    );
    if (tokenResult.rows.length === 0) return;

    const tokens = tokenResult.rows.map((r) => r.fcm_token);
    await sendPushToMultiple({ tokens, title, body, data });
  } catch (err) {
    console.error("sendPushToUsers error:", err.message);
  }
}

module.exports = { sendRolePush, sendPushToUsers };
