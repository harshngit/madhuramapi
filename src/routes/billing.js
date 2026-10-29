const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { pool } = require("../db");
const { logActivity, getEntityHistory, attachCreatedUpdatedBy } = require("./dashboard");

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Billing
 *   description: |
 *     RA (running account) bills per project, in the builder's format
 *     (Hiranandani / Lodha / Rustomjee).
 *
 *     A bill stores the whole workbook the app edits (`sheets`, Fortune Sheet
 *     JSON), so every cell edit, added/deleted row or formula is saved by
 *     sending the workbook back with `PUT /api/billing/{id}`. Alongside it the
 *     bill can carry `items` — the quantity billed this RA per BOQ item and
 *     payment stage — from which the server works out each item's previous
 *     (carried-forward) quantity and the bill's previous/cumulative amounts.
 *
 *     Life cycle: draft → submitted → certified → paid. Certified and paid
 *     bills are read-only. Only the latest bill can be deleted, and only while
 *     it is a draft, so earlier bills' carry-forward never breaks.
 *
 *     Every GET (list/by-id) response also includes created_by/created_by_name/
 *     updated_by/updated_by_name — see the CreatedUpdatedBy schema.
 */

const BUILDERS = ["hiranandani", "lodha", "rustomjee"];
const STATUS_FLOW = {
  draft: ["submitted"],
  submitted: ["draft", "certified"],
  certified: ["paid"],
  paid: [],
};
const LOCKED_STATUSES = ["certified", "paid"];
const STATUS_TIMESTAMP = { submitted: "submitted_at", certified: "certified_at", paid: "paid_at" };
const INVOICE_TABLES = { lodha: "lodha_invoices", hiranandani: "hiranandani_invoices" };
const DEFAULT_GST_RATE = 0.18;

// ─── Export file uploads ─────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, "../../uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const EXPORT_EXTENSIONS = [".xlsx", ".xls", ".csv", ".pdf"];
const exportUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, `ra-bill-${req.params.id}-${uniqueSuffix}${path.extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (EXPORT_EXTENSIONS.includes(path.extname(file.originalname).toLowerCase())) return cb(null, true);
    cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "file"));
  },
}).single("file");

// ─── Helpers ─────────────────────────────────────────────────────────────────
class BillingError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function num(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

const round = (value, places) => Number(Number(value).toFixed(places));
const nullableText = (value) => (value === undefined || value === null || String(value).trim() === "" ? null : String(value).trim());

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new BillingError(400, `${name} must be a positive integer`);
  return n;
}

function optionalDate(value, name) {
  const text = nullableText(value);
  if (text === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new BillingError(400, `${name} must be a date in YYYY-MM-DD format`);
  }
  return text;
}

function sendError(res, err, label) {
  if (err instanceof BillingError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err && err.code === "23505") return res.status(409).json({ error: "An RA bill with this number already exists for the project" });
  console.error(`${label} error:`, err);
  res.status(500).json({ error: err.message });
}

function normalizeItems(items) {
  if (!Array.isArray(items)) throw new BillingError(400, "items must be an array");
  return items.map((item, index) => {
    const boqId = item.boq_id === undefined || item.boq_id === null || item.boq_id === "" ? null : Number(item.boq_id);
    if (boqId !== null && !Number.isInteger(boqId)) throw new BillingError(400, `items[${index}].boq_id must be an integer`);
    const sharePct = num(item.share_pct, 100);
    if (sharePct < 0 || sharePct > 100) throw new BillingError(400, `items[${index}].share_pct must be between 0 and 100`);
    return {
      boq_id: boqId,
      item_no: nullableText(item.item_no),
      description: nullableText(item.description),
      unit: nullableText(item.unit),
      stage: nullableText(item.stage)?.toLowerCase() || "full",
      share_pct: sharePct,
      rate: num(item.rate),
      wo_qty: item.wo_qty === undefined || item.wo_qty === null || item.wo_qty === "" ? null : num(item.wo_qty),
      previous_qty: num(item.previous_qty),
      current_qty: num(item.current_qty),
      sort_order: Number.isInteger(item.sort_order) ? item.sort_order : index,
    };
  });
}

const itemAmount = (item, qtyKey) => (num(item[qtyKey]) * num(item.share_pct, 100) / 100) * num(item.rate);

// The same BOQ item + stage across bills; items not linked to a BOQ row match on item no / description.
function chainKey(item) {
  const id = item.boq_id !== null && item.boq_id !== undefined
    ? `boq:${item.boq_id}`
    : item.item_no ? `no:${String(item.item_no).trim().toLowerCase()}` : `desc:${String(item.description || "").trim().toLowerCase()}`;
  return `${id}|${item.stage || "full"}`;
}

// Walks a project's bills in RA order and works out, for every bill, each
// item's previous quantity and the bill's previous/cumulative amount. The first
// bill keeps the previous quantities/amount it was given (the opening balance
// when a project starts billing in the app part-way, e.g. from RA 14).
function walkChain(bills, itemsByBill) {
  const running = new Map();
  let runningAmount = 0;
  const result = [];
  bills.forEach((bill, index) => {
    const items = itemsByBill.get(bill.bill_id) || [];
    const previousByKey = new Map();
    for (const item of items) {
      const key = chainKey(item);
      if (!previousByKey.has(key)) previousByKey.set(key, index === 0 ? num(item.previous_qty) : running.get(key)?.qty ?? 0);
    }
    const itemPrevious = items.map((item) => ({ item, previous_qty: previousByKey.get(chainKey(item)) }));
    const currentByKey = new Map();
    for (const item of items) {
      const key = chainKey(item);
      currentByKey.set(key, (currentByKey.get(key) || 0) + num(item.current_qty));
      running.set(key, {
        boq_id: item.boq_id,
        item_no: item.item_no,
        description: item.description,
        unit: item.unit,
        stage: item.stage,
        share_pct: num(item.share_pct, 100),
        rate: num(item.rate),
        qty: 0,
      });
    }
    for (const [key, current] of currentByKey) running.get(key).qty = previousByKey.get(key) + current;

    const previousAmount = index === 0 ? num(bill.previous_amount) : runningAmount;
    const cumulativeAmount = previousAmount + num(bill.this_bill_amount);
    runningAmount = cumulativeAmount;
    result.push({ bill, itemPrevious, previous_amount: previousAmount, cumulative_amount: cumulativeAmount });
  });
  return { steps: result, running, runningAmount };
}

async function loadChain(db, projectId, beforeRaNo = null) {
  const bills = (
    await db.query(
      `SELECT bill_id, ra_no, status, this_bill_amount, previous_amount, cumulative_amount
         FROM ra_bills
        WHERE project_id = $1 AND ($2::int IS NULL OR ra_no < $2)
        ORDER BY ra_no`,
      [projectId, beforeRaNo]
    )
  ).rows;
  const items = (
    await db.query(
      `SELECT i.* FROM ra_bill_items i
         JOIN ra_bills b ON b.bill_id = i.bill_id
        WHERE b.project_id = $1 AND ($2::int IS NULL OR b.ra_no < $2)
        ORDER BY i.bill_id, i.sort_order, i.bill_item_id`,
      [projectId, beforeRaNo]
    )
  ).rows;
  const itemsByBill = new Map();
  for (const item of items) {
    if (!itemsByBill.has(item.bill_id)) itemsByBill.set(item.bill_id, []);
    itemsByBill.get(item.bill_id).push(item);
  }
  return { bills, itemsByBill };
}

// Re-applies the carry-forward to every bill of the project after a write.
async function recomputeChain(client, projectId) {
  const { bills, itemsByBill } = await loadChain(client, projectId);
  const { steps } = walkChain(bills, itemsByBill);
  const itemIds = [];
  const itemPrevious = [];
  for (const step of steps) {
    for (const { item, previous_qty } of step.itemPrevious) {
      if (Math.abs(num(item.previous_qty) - previous_qty) > 1e-9) {
        itemIds.push(item.bill_item_id);
        itemPrevious.push(round(previous_qty, 3));
      }
    }
    if (
      Math.abs(num(step.bill.previous_amount) - step.previous_amount) > 0.001 ||
      Math.abs(num(step.bill.cumulative_amount) - step.cumulative_amount) > 0.001
    ) {
      await client.query(
        "UPDATE ra_bills SET previous_amount = $1, cumulative_amount = $2 WHERE bill_id = $3",
        [round(step.previous_amount, 2), round(step.cumulative_amount, 2), step.bill.bill_id]
      );
    }
  }
  if (itemIds.length) {
    await client.query(
      `UPDATE ra_bill_items AS i SET previous_qty = v.previous_qty
         FROM (SELECT unnest($1::int[]) AS bill_item_id, unnest($2::numeric[]) AS previous_qty) AS v
        WHERE i.bill_item_id = v.bill_item_id`,
      [itemIds, itemPrevious]
    );
  }
}

async function insertItems(client, billId, items) {
  if (!items.length) return;
  const columns = ["bill_id", "boq_id", "item_no", "description", "unit", "stage", "share_pct", "rate", "wo_qty", "previous_qty", "current_qty", "sort_order"];
  // Batches keep each statement well under Postgres' 65535 parameter limit.
  for (let start = 0; start < items.length; start += 500) {
    const batch = items.slice(start, start + 500);
    const values = [];
    const rows = batch.map((item, index) => {
      values.push(billId, item.boq_id, item.item_no, item.description, item.unit, item.stage, item.share_pct, item.rate, item.wo_qty, item.previous_qty, item.current_qty, item.sort_order);
      const base = index * columns.length;
      return `(${columns.map((_, c) => `$${base + c + 1}`).join(",")})`;
    });
    await client.query(`INSERT INTO ra_bill_items (${columns.join(",")}) VALUES ${rows.join(",")}`, values);
  }
}

async function checkInvoice(db, builder, invoiceId, projectId) {
  const table = INVOICE_TABLES[builder];
  if (!table) throw new BillingError(400, `There is no invoice API for ${builder} bills yet`);
  const found = await db.query(`SELECT project_id FROM ${table} WHERE invoice_id = $1`, [invoiceId]);
  if (!found.rows.length) throw new BillingError(400, `invoice_id ${invoiceId} was not found in ${table}`);
  const invoiceProject = found.rows[0].project_id;
  if (invoiceProject !== null && Number(invoiceProject) !== Number(projectId)) {
    throw new BillingError(400, `invoice_id ${invoiceId} belongs to another project`);
  }
}

const AMOUNT_COLUMNS = ["this_bill_amount", "previous_amount", "cumulative_amount", "gst_amount", "total_with_gst", "certified_amount"];
const DATE_COLUMNS = ["bill_date", "service_from", "service_to"];

// pg turns a DATE into a JS Date at local midnight, which serialises as the
// previous day in UTC on an IST server; send the calendar date as written.
function dateOnly(value) {
  if (!(value instanceof Date)) return value ?? null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function formatBill(row, { withSheets = true } = {}) {
  if (!row) return row;
  const bill = { ...row };
  for (const key of AMOUNT_COLUMNS) bill[key] = row[key] === null || row[key] === undefined ? null : Number(row[key]);
  for (const key of DATE_COLUMNS) if (key in row) bill[key] = dateOnly(row[key]);
  bill.invoice_type = INVOICE_TABLES[row.builder] ? row.builder : null;
  bill.export_file_url = row.export_file ? `/uploads/${row.export_file}` : null;
  if (!withSheets) delete bill.sheets;
  return bill;
}

function formatItem(row) {
  return {
    bill_item_id: row.bill_item_id,
    bill_id: row.bill_id,
    boq_id: row.boq_id,
    item_no: row.item_no,
    description: row.description,
    unit: row.unit,
    stage: row.stage,
    share_pct: num(row.share_pct, 100),
    rate: num(row.rate),
    wo_qty: row.wo_qty === null ? null : num(row.wo_qty),
    previous_qty: num(row.previous_qty),
    current_qty: num(row.current_qty),
    cumulative_qty: round(num(row.previous_qty) + num(row.current_qty), 3),
    this_bill_amount: round(itemAmount(row, "current_qty"), 2),
    sort_order: row.sort_order,
  };
}

const LIST_COLUMNS = `bill_id, project_id, builder, ra_no, bill_date, service_from, service_to, status, is_final,
  file_name, this_bill_amount, previous_amount, cumulative_amount, gst_amount, total_with_gst, certified_amount,
  invoice_id, export_file, remarks, version, submitted_at, certified_at, paid_at, created_at, updated_at`;

async function fetchBill(db, id) {
  const bill = await db.query("SELECT * FROM ra_bills WHERE bill_id = $1", [id]);
  if (!bill.rows.length) return null;
  const items = await db.query("SELECT * FROM ra_bill_items WHERE bill_id = $1 ORDER BY sort_order, bill_item_id", [id]);
  return { ...formatBill(bill.rows[0]), items: items.rows.map(formatItem) };
}

function cumulativeItems(running) {
  return [...running.values()].map((entry) => ({
    boq_id: entry.boq_id,
    item_no: entry.item_no,
    description: entry.description,
    unit: entry.unit,
    stage: entry.stage,
    share_pct: entry.share_pct,
    rate: entry.rate,
    cumulative_qty: round(entry.qty, 3),
    cumulative_amount: round((entry.qty * entry.share_pct) / 100 * entry.rate, 2),
  }));
}

// Amount fields a save may send. this_bill_amount falls back to the items' total,
// and GST to 18% of the bill, when not sent.
function readAmounts(body, items) {
  const amounts = {};
  if (body.this_bill_amount !== undefined) amounts.this_bill_amount = round(num(body.this_bill_amount), 2);
  else if (items) amounts.this_bill_amount = round(items.reduce((total, item) => total + itemAmount(item, "current_qty"), 0), 2);
  if (body.gst_amount !== undefined) amounts.gst_amount = round(num(body.gst_amount), 2);
  else if (amounts.this_bill_amount !== undefined) amounts.gst_amount = round(amounts.this_bill_amount * DEFAULT_GST_RATE, 2);
  if (body.total_with_gst !== undefined) amounts.total_with_gst = round(num(body.total_with_gst), 2);
  if (body.previous_amount !== undefined) amounts.previous_amount = round(num(body.previous_amount), 2);
  return amounts;
}

/**
 * @swagger
 * components:
 *   schemas:
 *     RaBillItemInput:
 *       type: object
 *       description: |
 *         Quantity billed this RA for one BOQ item in one payment stage.
 *         `previous_qty` is only used for the project's first bill in the app
 *         (opening balance); for later bills the server carries it forward.
 *       properties:
 *         boq_id:       { type: integer, nullable: true }
 *         item_no:      { type: string, example: "1.01.1" }
 *         description:  { type: string, example: "Soil pipe 110mm dia" }
 *         unit:         { type: string, example: "RMT" }
 *         stage:        { type: string, example: "supply", description: "supply / installation / testing / handover, or full (default)" }
 *         share_pct:    { type: number, example: 60, description: "Share of the rate paid at this stage (default 100)" }
 *         rate:         { type: number, example: 696 }
 *         wo_qty:       { type: number, example: 1111.85 }
 *         previous_qty: { type: number, example: 990 }
 *         current_qty:  { type: number, example: 121.85 }
 *         sort_order:   { type: integer }
 *     RaBillItem:
 *       allOf:
 *         - $ref: '#/components/schemas/RaBillItemInput'
 *         - type: object
 *           properties:
 *             bill_item_id:     { type: integer }
 *             bill_id:          { type: integer }
 *             cumulative_qty:   { type: number }
 *             this_bill_amount: { type: number, description: "current_qty × share_pct% × rate" }
 *     RaBillSaveInput:
 *       type: object
 *       description: Every field is optional; only the fields sent are changed.
 *       properties:
 *         version:          { type: integer, description: "The version you loaded. If the bill was saved since, the save is rejected with 409." }
 *         bill_date:        { type: string, format: date }
 *         service_from:     { type: string, format: date }
 *         service_to:       { type: string, format: date }
 *         is_final:         { type: boolean }
 *         file_name:        { type: string }
 *         sheets:           { type: array, items: { type: object }, description: "The whole workbook (Fortune Sheet sheets)" }
 *         items:            { type: array, items: { $ref: '#/components/schemas/RaBillItemInput' }, description: "Replaces all items of the bill" }
 *         this_bill_amount: { type: number, description: "Defaults to the items' total when items are sent" }
 *         gst_amount:       { type: number, description: "Defaults to 18% of this_bill_amount" }
 *         total_with_gst:   { type: number, description: "Defaults to this_bill_amount + gst_amount" }
 *         previous_amount:  { type: number, description: "Only used for the project's first bill (opening balance)" }
 *         invoice_id:       { type: integer, nullable: true, description: "Lodha / Hiranandani invoice raised for this bill" }
 *         remarks:          { type: string }
 *         user_id:          { type: string }
 *         user_name:        { type: string }
 *     RaBillCreateInput:
 *       allOf:
 *         - $ref: '#/components/schemas/RaBillSaveInput'
 *         - type: object
 *           required: [project_id]
 *           properties:
 *             project_id:         { type: integer }
 *             builder:            { type: string, enum: [hiranandani, lodha, rustomjee], description: "Defaults to the project's builder" }
 *             ra_no:              { type: integer, description: "Defaults to the next number; must be higher than every existing RA of the project" }
 *             copy_from_previous: { type: boolean, default: true, description: "Start from the previous bill's workbook when sheets are not sent" }
 *     RaBillSummary:
 *       type: object
 *       properties:
 *         bill_id:           { type: integer }
 *         project_id:        { type: integer }
 *         builder:           { type: string, enum: [hiranandani, lodha, rustomjee] }
 *         ra_no:             { type: integer }
 *         bill_date:         { type: string, format: date }
 *         service_from:      { type: string, format: date }
 *         service_to:        { type: string, format: date }
 *         status:            { type: string, enum: [draft, submitted, certified, paid] }
 *         is_final:          { type: boolean }
 *         file_name:         { type: string }
 *         this_bill_amount:  { type: number }
 *         previous_amount:   { type: number }
 *         cumulative_amount: { type: number }
 *         gst_amount:        { type: number }
 *         total_with_gst:    { type: number }
 *         certified_amount:  { type: number, nullable: true }
 *         invoice_id:        { type: integer, nullable: true }
 *         invoice_type:      { type: string, nullable: true, description: "lodha / hiranandani — which invoice API invoice_id belongs to" }
 *         export_file:       { type: string, nullable: true }
 *         export_file_url:   { type: string, nullable: true }
 *         remarks:           { type: string }
 *         version:           { type: integer }
 *         submitted_at:      { type: string, format: date-time }
 *         certified_at:      { type: string, format: date-time }
 *         paid_at:           { type: string, format: date-time }
 *         created_at:        { type: string, format: date-time }
 *         updated_at:        { type: string, format: date-time }
 *     RaBill:
 *       allOf:
 *         - $ref: '#/components/schemas/RaBillSummary'
 *         - type: object
 *           properties:
 *             sheets: { type: array, items: { type: object } }
 *             items:  { type: array, items: { $ref: '#/components/schemas/RaBillItem' } }
 *     RaBillCumulative:
 *       type: object
 *       properties:
 *         project_id:        { type: integer }
 *         before_ra:         { type: integer, nullable: true }
 *         ra_nos:            { type: array, items: { type: integer }, description: "Bills counted" }
 *         cumulative_amount: { type: number }
 *         items:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               boq_id:            { type: integer, nullable: true }
 *               item_no:           { type: string }
 *               description:       { type: string }
 *               unit:              { type: string }
 *               stage:             { type: string }
 *               share_pct:         { type: number }
 *               rate:              { type: number }
 *               cumulative_qty:    { type: number }
 *               cumulative_amount: { type: number }
 */

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/billing/project/:projectId — the project's RA bills (without workbooks)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/billing/project/{projectId}:
 *   get:
 *     summary: List a project's RA bills (newest first, without the workbook)
 *     tags: [Billing]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [draft, submitted, certified, paid] }
 *     responses:
 *       200:
 *         description: RA bills of the project
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/RaBillSummary'
 *       500:
 *         description: Server error
 */
router.get("/project/:projectId", async (req, res) => {
  try {
    const projectId = positiveInt(req.params.projectId, "projectId");
    const status = nullableText(req.query.status);
    const result = await pool.query(
      `SELECT ${LIST_COLUMNS} FROM ra_bills
        WHERE project_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY ra_no DESC`,
      [projectId, status]
    );
    res.json(await attachCreatedUpdatedBy(result.rows.map((row) => formatBill(row, { withSheets: false })), "ra_bill", (r) => r.bill_id));
  } catch (err) {
    sendError(res, err, "List RA bills");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/billing/project/:projectId/cumulative — carried-forward quantities
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/billing/project/{projectId}/cumulative:
 *   get:
 *     summary: Cumulative billed quantity per BOQ item and stage (the "previous" figures for the next RA)
 *     tags: [Billing]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: before_ra
 *         schema: { type: integer }
 *         description: Count only bills with a lower RA number (the previous figures for that RA). Omit to count every bill.
 *     responses:
 *       200:
 *         description: Cumulative quantities and amount
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RaBillCumulative'
 *       500:
 *         description: Server error
 */
router.get("/project/:projectId/cumulative", async (req, res) => {
  try {
    const projectId = positiveInt(req.params.projectId, "projectId");
    const beforeRa = req.query.before_ra === undefined || req.query.before_ra === "" ? null : positiveInt(req.query.before_ra, "before_ra");
    const { bills, itemsByBill } = await loadChain(pool, projectId, beforeRa);
    const { running, runningAmount } = walkChain(bills, itemsByBill);
    res.json({
      project_id: projectId,
      before_ra: beforeRa,
      ra_nos: bills.map((bill) => bill.ra_no),
      cumulative_amount: round(runningAmount, 2),
      items: cumulativeItems(running),
    });
  } catch (err) {
    sendError(res, err, "RA bill cumulative");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/billing — start a new RA bill
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/billing:
 *   post:
 *     summary: Start a new RA bill for a project
 *     description: |
 *       Takes the next RA number unless `ra_no` is sent. Unless `sheets` are
 *       sent, the workbook starts as a copy of the previous bill's. The response
 *       also carries `previous_items` — the cumulative quantities before this
 *       RA — so the app can fill the "previous" columns.
 *     tags: [Billing]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RaBillCreateInput'
 *     responses:
 *       201:
 *         description: RA bill created
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/RaBill'
 *                 - type: object
 *                   properties:
 *                     previous_items:
 *                       $ref: '#/components/schemas/RaBillCumulative/properties/items'
 *       400:
 *         description: Invalid input (unknown project/builder, RA number not after the latest, ...)
 *       409:
 *         description: RA number already used for the project
 *       500:
 *         description: Server error
 */
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const projectId = positiveInt(body.project_id, "project_id");
    const items = body.items === undefined ? null : normalizeItems(body.items);
    if (body.sheets !== undefined && !Array.isArray(body.sheets)) throw new BillingError(400, "sheets must be an array");

    await client.query("BEGIN");
    const project = await client.query("SELECT project_id, project_name, builder FROM projects WHERE project_id = $1 FOR UPDATE", [projectId]);
    if (!project.rows.length) throw new BillingError(400, `Project ${projectId} not found`);

    const builder = (nullableText(body.builder) || project.rows[0].builder || "").toLowerCase();
    if (!BUILDERS.includes(builder)) {
      throw new BillingError(400, `builder is required (one of: ${BUILDERS.join(", ")}) — send it, or set it on the project`);
    }

    const latest = await client.query("SELECT bill_id, ra_no, sheets FROM ra_bills WHERE project_id = $1 ORDER BY ra_no DESC LIMIT 1", [projectId]);
    const latestRa = latest.rows[0]?.ra_no || 0;
    const raNo = body.ra_no === undefined || body.ra_no === null || body.ra_no === "" ? latestRa + 1 : positiveInt(body.ra_no, "ra_no");
    if (raNo <= latestRa) throw new BillingError(400, `ra_no must be after the latest RA bill (RA ${latestRa})`);

    const copyFromPrevious = body.copy_from_previous !== false;
    const sheets = Array.isArray(body.sheets) ? body.sheets : copyFromPrevious && latest.rows[0] ? latest.rows[0].sheets : [];
    const amounts = readAmounts(body, items);
    if (amounts.previous_amount === undefined && items && !latestRa) {
      amounts.previous_amount = round(items.reduce((total, item) => total + itemAmount(item, "previous_qty"), 0), 2);
    }
    const thisBill = amounts.this_bill_amount ?? 0;
    const gst = amounts.gst_amount ?? round(thisBill * DEFAULT_GST_RATE, 2);
    const invoiceId = body.invoice_id === undefined || body.invoice_id === null || body.invoice_id === "" ? null : positiveInt(body.invoice_id, "invoice_id");
    if (invoiceId !== null) await checkInvoice(client, builder, invoiceId, projectId);

    const created = await client.query(
      `INSERT INTO ra_bills (
         project_id, builder, ra_no, bill_date, service_from, service_to, is_final, file_name, sheets,
         this_bill_amount, previous_amount, gst_amount, total_with_gst, invoice_id, remarks
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING bill_id`,
      [
        projectId, builder, raNo,
        optionalDate(body.bill_date, "bill_date"), optionalDate(body.service_from, "service_from"), optionalDate(body.service_to, "service_to"),
        Boolean(body.is_final), nullableText(body.file_name), JSON.stringify(sheets),
        thisBill, amounts.previous_amount ?? 0, gst, amounts.total_with_gst ?? round(thisBill + gst, 2),
        invoiceId, nullableText(body.remarks),
      ]
    );
    const billId = created.rows[0].bill_id;
    if (items) await insertItems(client, billId, items);
    await recomputeChain(client, projectId);

    const chain = await loadChain(client, projectId, raNo);
    const previousItems = cumulativeItems(walkChain(chain.bills, chain.itemsByBill).running);
    const bill = await fetchBill(client, billId);
    await client.query("COMMIT");

    logActivity({
      action: "created",
      entity_type: "ra_bill",
      entity_id: billId,
      entity_name: `RA ${raNo} — ${project.rows[0].project_name}`,
      performed_by: body.user_id || null,
      performed_by_name: body.user_name || null,
      project_id: projectId,
      meta: { builder, ra_no: raNo },
    });

    res.status(201).json({ ...bill, previous_items: previousItems });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    sendError(res, err, "Create RA bill");
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/billing/:id — one RA bill with its workbook and items
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/billing/{id}:
 *   get:
 *     summary: Get one RA bill with its workbook and items
 *     tags: [Billing]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: The RA bill
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RaBill'
 *       404:
 *         description: RA bill not found
 *       500:
 *         description: Server error
 */
router.get("/:id", async (req, res) => {
  try {
    const bill = await fetchBill(pool, positiveInt(req.params.id, "id"));
    if (!bill) return res.status(404).json({ error: "RA bill not found" });
    res.json(await attachCreatedUpdatedBy(bill, "ra_bill", (r) => r.bill_id));
  } catch (err) {
    sendError(res, err, "Get RA bill");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/billing/:id — save / edit the bill (workbook, items, details)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/billing/{id}:
 *   put:
 *     summary: Save an RA bill — the workbook, items and bill details
 *     description: |
 *       Send only what changed (e.g. just `sheets` + `version` on autosave).
 *       Sending `items` replaces all items of the bill; the server then works
 *       out previous quantities and previous/cumulative amounts for this and
 *       every later bill. Certified/paid bills, and bills followed by a
 *       certified/paid bill, cannot be edited.
 *     tags: [Billing]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RaBillSaveInput'
 *     responses:
 *       200:
 *         description: The saved RA bill
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RaBill'
 *       400:
 *         description: Invalid input
 *       404:
 *         description: RA bill not found
 *       409:
 *         description: Saved by someone else since `version` (response has current_version), or the bill is locked
 *       500:
 *         description: Server error
 */
router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = positiveInt(req.params.id, "id");
    const body = req.body || {};
    const items = body.items === undefined ? null : normalizeItems(body.items);
    if (body.sheets !== undefined && !Array.isArray(body.sheets)) throw new BillingError(400, "sheets must be an array");

    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM ra_bills WHERE bill_id = $1 FOR UPDATE", [id]);
    if (!found.rows.length) throw new BillingError(404, "RA bill not found");
    const current = found.rows[0];

    if (body.version !== undefined && Number(body.version) !== current.version) {
      throw new BillingError(409, "This bill was saved by someone else since you opened it. Reload it to get the latest version.", { current_version: current.version });
    }
    if (LOCKED_STATUSES.includes(current.status)) {
      throw new BillingError(409, `RA ${current.ra_no} is ${current.status} and can no longer be edited`);
    }
    const lockedLater = await client.query(
      "SELECT ra_no, status FROM ra_bills WHERE project_id = $1 AND ra_no > $2 AND status = ANY($3) ORDER BY ra_no LIMIT 1",
      [current.project_id, current.ra_no, LOCKED_STATUSES]
    );
    if (lockedLater.rows.length) {
      const later = lockedLater.rows[0];
      throw new BillingError(409, `RA ${current.ra_no} cannot be edited because RA ${later.ra_no} after it is already ${later.status}`);
    }

    const updates = {};
    if (body.bill_date !== undefined) updates.bill_date = optionalDate(body.bill_date, "bill_date");
    if (body.service_from !== undefined) updates.service_from = optionalDate(body.service_from, "service_from");
    if (body.service_to !== undefined) updates.service_to = optionalDate(body.service_to, "service_to");
    if (body.is_final !== undefined) updates.is_final = Boolean(body.is_final);
    if (body.file_name !== undefined) updates.file_name = nullableText(body.file_name);
    if (body.remarks !== undefined) updates.remarks = nullableText(body.remarks);
    if (body.sheets !== undefined) updates.sheets = JSON.stringify(body.sheets);
    if (body.invoice_id !== undefined) {
      updates.invoice_id = body.invoice_id === null || body.invoice_id === "" ? null : positiveInt(body.invoice_id, "invoice_id");
      if (updates.invoice_id !== null) await checkInvoice(client, current.builder, updates.invoice_id, current.project_id);
    }
    const amounts = readAmounts(body, items);
    // The project's first bill takes its opening previous amount from the items, as on create.
    if (amounts.previous_amount === undefined && items) {
      const earlier = await client.query("SELECT 1 FROM ra_bills WHERE project_id = $1 AND ra_no < $2 LIMIT 1", [current.project_id, current.ra_no]);
      if (!earlier.rows.length) {
        amounts.previous_amount = round(items.reduce((total, item) => total + itemAmount(item, "previous_qty"), 0), 2);
      }
    }
    Object.assign(updates, amounts);
    if (amounts.this_bill_amount !== undefined || amounts.gst_amount !== undefined) {
      if (amounts.total_with_gst === undefined) {
        updates.total_with_gst = round((amounts.this_bill_amount ?? num(current.this_bill_amount)) + (amounts.gst_amount ?? num(current.gst_amount)), 2);
      }
    }

    const keys = Object.keys(updates);
    const sets = keys.map((key, index) => `${key} = $${index + 1}`);
    await client.query(
      `UPDATE ra_bills SET ${[...sets, "version = version + 1", "updated_at = CURRENT_TIMESTAMP"].join(", ")}
        WHERE bill_id = $${keys.length + 1}`,
      [...keys.map((key) => updates[key]), id]
    );
    if (items) {
      await client.query("DELETE FROM ra_bill_items WHERE bill_id = $1", [id]);
      await insertItems(client, id, items);
    }
    await recomputeChain(client, current.project_id);
    const bill = await fetchBill(client, id);
    await client.query("COMMIT");

    logActivity({
      action: "updated",
      entity_type: "ra_bill",
      entity_id: id,
      entity_name: `RA ${current.ra_no}`,
      performed_by: body.user_id || null,
      performed_by_name: body.user_name || null,
      project_id: current.project_id,
      meta: { fields: [...keys, ...(items ? ["items"] : [])] },
    });

    res.json(await attachCreatedUpdatedBy(bill, "ra_bill", (r) => r.bill_id));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    sendError(res, err, "Update RA bill");
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/billing/:id/status — move the bill through its life cycle
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/billing/{id}/status:
 *   patch:
 *     summary: Change an RA bill's status (draft → submitted → certified → paid; submitted → draft to reopen)
 *     tags: [Billing]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:           { type: string, enum: [draft, submitted, certified, paid] }
 *               certified_amount: { type: number, description: "Amount the client certified (when certifying)" }
 *               user_id:          { type: string }
 *               user_name:        { type: string }
 *     responses:
 *       200:
 *         description: The RA bill with its new status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RaBillSummary'
 *       400:
 *         description: Status change not allowed from the current status
 *       404:
 *         description: RA bill not found
 *       500:
 *         description: Server error
 */
router.patch("/:id/status", async (req, res) => {
  try {
    const id = positiveInt(req.params.id, "id");
    const body = req.body || {};
    const status = nullableText(body.status)?.toLowerCase();
    if (!STATUS_FLOW[status]) throw new BillingError(400, `status must be one of: ${Object.keys(STATUS_FLOW).join(", ")}`);

    const found = await pool.query("SELECT bill_id, project_id, ra_no, status FROM ra_bills WHERE bill_id = $1", [id]);
    if (!found.rows.length) throw new BillingError(404, "RA bill not found");
    const current = found.rows[0];
    if (!STATUS_FLOW[current.status].includes(status)) {
      const allowed = STATUS_FLOW[current.status];
      throw new BillingError(400, `RA ${current.ra_no} is ${current.status}; it can only move to ${allowed.length ? allowed.join(" or ") : "nothing (final)"}`);
    }

    const values = [status, id];
    const sets = ["status = $1", "version = version + 1", "updated_at = CURRENT_TIMESTAMP"];
    if (STATUS_TIMESTAMP[status]) sets.push(`${STATUS_TIMESTAMP[status]} = CURRENT_TIMESTAMP`);
    if (status === "draft") sets.push("submitted_at = NULL");
    if (body.certified_amount !== undefined) {
      values.push(body.certified_amount === null || body.certified_amount === "" ? null : round(num(body.certified_amount), 2));
      sets.push(`certified_amount = $${values.length}`);
    }
    const updated = await pool.query(`UPDATE ra_bills SET ${sets.join(", ")} WHERE bill_id = $2 RETURNING ${LIST_COLUMNS}`, values);

    logActivity({
      action: "updated",
      entity_type: "ra_bill",
      entity_id: id,
      entity_name: `RA ${current.ra_no}`,
      performed_by: body.user_id || null,
      performed_by_name: body.user_name || null,
      project_id: current.project_id,
      meta: { status_from: current.status, status_to: status },
    });

    res.json(formatBill(updated.rows[0], { withSheets: false }));
  } catch (err) {
    sendError(res, err, "Update RA bill status");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/billing/:id/file — attach the exported .xlsx / .pdf
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/billing/{id}/file:
 *   post:
 *     summary: Upload the exported bill file (.xlsx, .xls, .csv or .pdf, max 50 MB) to an RA bill
 *     tags: [Billing]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:      { type: string, format: binary }
 *               user_id:   { type: string }
 *               user_name: { type: string }
 *     responses:
 *       200:
 *         description: File stored; returns export_file and export_file_url
 *       400:
 *         description: Missing or unsupported file
 *       404:
 *         description: RA bill not found
 *       500:
 *         description: Server error
 */
router.post("/:id/file", (req, res) => {
  exportUpload(req, res, async (uploadErr) => {
    if (uploadErr) {
      const message = uploadErr.code === "LIMIT_FILE_SIZE" ? "File too large. Max limit is 50MB." : `Only ${EXPORT_EXTENSIONS.join(", ")} files are accepted`;
      return res.status(400).json({ error: message });
    }
    try {
      const id = positiveInt(req.params.id, "id");
      if (!req.file) throw new BillingError(400, "Attach the file in the 'file' field");
      const updated = await pool.query(
        "UPDATE ra_bills SET export_file = $1, updated_at = CURRENT_TIMESTAMP WHERE bill_id = $2 RETURNING bill_id, project_id, ra_no, export_file",
        [req.file.filename, id]
      );
      if (!updated.rows.length) {
        fs.unlink(req.file.path, () => {});
        throw new BillingError(404, "RA bill not found");
      }
      const bill = updated.rows[0];
      logActivity({
        action: "uploaded",
        entity_type: "ra_bill",
        entity_id: id,
        entity_name: `RA ${bill.ra_no}`,
        performed_by: req.body.user_id || null,
        performed_by_name: req.body.user_name || null,
        project_id: bill.project_id,
        meta: { export_file: bill.export_file },
      });
      res.json({ bill_id: id, export_file: bill.export_file, export_file_url: `/uploads/${bill.export_file}` });
    } catch (err) {
      sendError(res, err, "Upload RA bill file");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/billing/:id — delete the latest draft bill
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/billing/{id}:
 *   delete:
 *     summary: Delete an RA bill — only the project's latest bill, and only while it is a draft
 *     tags: [Billing]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               user_id:   { type: string }
 *               user_name: { type: string }
 *     responses:
 *       200:
 *         description: Deleted successfully
 *       404:
 *         description: RA bill not found
 *       409:
 *         description: Not a draft, or a later RA bill exists
 *       500:
 *         description: Server error
 */
router.delete("/:id", async (req, res) => {
  try {
    const id = positiveInt(req.params.id, "id");
    const body = req.body || {};
    const found = await pool.query("SELECT bill_id, project_id, ra_no, status FROM ra_bills WHERE bill_id = $1", [id]);
    if (!found.rows.length) throw new BillingError(404, "RA bill not found");
    const bill = found.rows[0];
    if (bill.status !== "draft") {
      throw new BillingError(409, `RA ${bill.ra_no} is ${bill.status}; only draft bills can be deleted (move it back to draft first if it was only submitted)`);
    }
    const later = await pool.query("SELECT ra_no FROM ra_bills WHERE project_id = $1 AND ra_no > $2 ORDER BY ra_no LIMIT 1", [bill.project_id, bill.ra_no]);
    if (later.rows.length) {
      throw new BillingError(409, `RA ${bill.ra_no} cannot be deleted because RA ${later.rows[0].ra_no} comes after it`);
    }

    await pool.query("DELETE FROM ra_bills WHERE bill_id = $1", [id]);

    logActivity({
      action: "deleted",
      entity_type: "ra_bill",
      entity_id: id,
      entity_name: `RA ${bill.ra_no}`,
      performed_by: body.user_id || req.query.user_id || null,
      performed_by_name: body.user_name || req.query.user_name || null,
      project_id: bill.project_id,
    });

    res.json({ message: "RA bill deleted successfully" });
  } catch (err) {
    sendError(res, err, "Delete RA bill");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/billing/:id/history — who created/updated/deleted this bill, and when
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/billing/{id}/history:
 *   get:
 *     summary: Get the create/update/delete history for an RA bill (who did what, and when)
 *     tags: [Billing]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Activity history for this RA bill
 */
router.get("/:id/history", async (req, res) => {
  try {
    const data = await getEntityHistory("ra_bill", req.params.id, {
      limit: req.query.limit, offset: req.query.offset,
    });
    res.json(data);
  } catch (err) {
    console.error("Error fetching RA bill history:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
