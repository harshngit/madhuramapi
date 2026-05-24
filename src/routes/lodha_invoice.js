const express = require("express");
const { pool } = require("../db");
const { logActivity } = require("./dashboard");

const router = express.Router();

function normalizeLodhaItem(item = {}) {
  return {
    sn: item.sn ?? item.sr ?? item.serial_number ?? null,
    description: item.description ?? item.goods_or_service_description ?? null,
    sac_code: item.sac_code ?? null,
    value_of_supply: item.value_of_supply ?? 0,
    discount: item.discount ?? 0,
    taxable_value: item.taxable_value ?? 0,
    cgst_rate: item.cgst_rate ?? 0,
    cgst_amount: item.cgst_amount ?? 0,
    sgst_rate: item.sgst_rate ?? 0,
    sgst_amount: item.sgst_amount ?? 0,
    igst_amount: item.igst_amount ?? 0,
    line_total: item.line_total ?? item.total ?? 0,
  };
}

function normalizeLodhaInvoicePayload(body = {}) {
  return {
    company_name: body.company_name ?? null,
    company_address: body.company_address ?? null,
    company_phone: body.company_phone ?? body.company_contact_number ?? null,
    company_email: body.company_email ?? null,
    company_website: body.company_website ?? null,
    supplier_gstin: body.supplier_gstin ?? null,
    invoice_number: body.invoice_number ?? null,
    invoice_date: body.invoice_date ?? null,
    buyer_name: body.buyer_name ?? body.bill_to_name ?? null,
    buyer_address: body.buyer_address ?? body.bill_to_address ?? null,
    buyer_state_name: body.buyer_state_name ?? body.bill_to_state ?? null,
    buyer_state_code: body.buyer_state_code ?? body.bill_to_state_code ?? null,
    buyer_gstin: body.buyer_gstin ?? body.bill_to_gstin ?? null,
    receiver_name: body.receiver_name ?? body.ship_to_name ?? null,
    receiver_address: body.receiver_address ?? body.ship_to_address ?? null,
    place_of_supply: body.place_of_supply ?? null,
    work_order_number: body.work_order_number ?? null,
    plant_name: body.plant_name ?? body.building_name ?? null,
    bill_no: body.bill_no ?? body.ra_number ?? null,
    total_taxable_value: body.total_taxable_value ?? 0,
    total_cgst: body.total_cgst ?? 0,
    total_sgst: body.total_sgst ?? 0,
    total_value: body.total_value ?? body.total_invoice_value ?? 0,
    total_invoice_value: body.total_invoice_value ?? 0,
    total_invoice_value_words: body.total_invoice_value_words ?? null,
    declaration: body.declaration ?? body.terms ?? null,
    electronic_ref_number: body.electronic_ref_number ?? null,
    electronic_ref_date: body.electronic_ref_date ?? null,
    authorised_signatory: body.authorised_signatory ?? null,
    project_id: body.project_id ?? null,
    user_id: body.user_id ?? null,
    user_name: body.user_name ?? null,
    items: Array.isArray(body.items) ? body.items.map(normalizeLodhaItem) : [],
  };
}

function formatLodhaInvoiceRow(row) {
  if (!row) return row;

  return {
    invoice_id: row.invoice_id,
    project_id: row.project_id,
    company_name: row.company_name,
    company_address: row.company_address,
    company_phone: row.company_phone,
    company_email: row.company_email,
    company_website: row.company_website,
    supplier_gstin: row.supplier_gstin,
    invoice_number: row.invoice_number,
    invoice_date: row.invoice_date,
    buyer_name: row.buyer_name,
    buyer_address: row.buyer_address,
    buyer_state_name: row.buyer_state_name,
    buyer_state_code: row.buyer_state_code,
    buyer_gstin: row.buyer_gstin,
    receiver_name: row.receiver_name,
    receiver_address: row.receiver_address,
    place_of_supply: row.place_of_supply,
    work_order_number: row.work_order_number,
    plant_name: row.plant_name,
    bill_no: row.bill_no,
    total_taxable_value: row.total_taxable_value,
    total_cgst: row.total_cgst,
    total_sgst: row.total_sgst,
    total_value: row.total_value,
    total_invoice_value: row.total_invoice_value,
    total_invoice_value_words: row.total_invoice_value_words,
    declaration: row.declaration,
    electronic_ref_number: row.electronic_ref_number,
    electronic_ref_date: row.electronic_ref_date,
    authorised_signatory: row.authorised_signatory,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function formatLodhaInvoiceItemRow(row) {
  return {
    item_id: row.item_id,
    invoice_id: row.invoice_id,
    sn: row.sn,
    description: row.description,
    sac_code: row.sac_code,
    value_of_supply: row.value_of_supply,
    discount: row.discount,
    taxable_value: row.taxable_value,
    cgst_rate: row.cgst_rate,
    cgst_amount: row.cgst_amount,
    sgst_rate: row.sgst_rate,
    sgst_amount: row.sgst_amount,
    igst_amount: row.igst_amount,
    line_total: row.line_total,
  };
}

/**
 * @swagger
 * components:
 *   schemas:
 *     LodhaInvoiceItemInput:
 *       type: object
 *       properties:
 *         sn:                { type: integer }
 *         description:       { type: string }
 *         sac_code:          { type: string }
 *         value_of_supply:   { type: number }
 *         discount:          { type: number }
 *         taxable_value:     { type: number }
 *         cgst_rate:         { type: number }
 *         cgst_amount:       { type: number }
 *         sgst_rate:         { type: number }
 *         sgst_amount:       { type: number }
 *         igst_amount:       { type: number }
 *         line_total:        { type: number }
 *     LodhaInvoiceItem:
 *       allOf:
 *         - $ref: '#/components/schemas/LodhaInvoiceItemInput'
 *         - type: object
 *           properties:
 *             item_id: { type: integer }
 *             invoice_id: { type: integer }
 *     LodhaInvoiceInput:
 *       type: object
 *       required:
 *         - invoice_number
 *       properties:
 *         project_id:                { type: integer }
 *         company_name:              { type: string }
 *         company_address:           { type: string }
 *         company_phone:             { type: string }
 *         company_email:             { type: string }
 *         company_website:           { type: string }
 *         supplier_gstin:            { type: string }
 *         invoice_number:            { type: string }
 *         invoice_date:              { type: string, format: date }
 *         buyer_name:                { type: string }
 *         buyer_address:             { type: string }
 *         buyer_state_name:          { type: string }
 *         buyer_state_code:          { type: string }
 *         buyer_gstin:               { type: string }
 *         receiver_name:             { type: string }
 *         receiver_address:          { type: string }
 *         place_of_supply:           { type: string }
 *         work_order_number:         { type: string }
 *         plant_name:                { type: string }
 *         bill_no:                   { type: string }
 *         total_taxable_value:       { type: number }
 *         total_cgst:                { type: number }
 *         total_sgst:                { type: number }
 *         total_value:               { type: number }
 *         total_invoice_value:       { type: number }
 *         total_invoice_value_words: { type: string }
 *         declaration:               { type: string }
 *         electronic_ref_number:     { type: string }
 *         electronic_ref_date:       { type: string, format: date }
 *         authorised_signatory:      { type: string }
 *         user_id:                   { type: string }
 *         user_name:                 { type: string }
 *         items:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/LodhaInvoiceItemInput'
 *     LodhaInvoice:
 *       allOf:
 *         - $ref: '#/components/schemas/LodhaInvoiceInput'
 *         - type: object
 *           properties:
 *             invoice_id: { type: integer }
 *             created_at: { type: string, format: date-time }
 *             updated_at: { type: string, format: date-time }
 *             items:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/LodhaInvoiceItem'
 */

// ─────────────────────────────────────────────────────────────────────────────
// CRUD: CREATE Lodha Invoice
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/lodha-invoice:
 *   post:
 *     summary: Create a new Lodha Invoice with items
 *     tags: [Lodha Invoice]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LodhaInvoiceInput'
 *     responses:
 *       201:
 *         description: Invoice created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LodhaInvoice'
 *       500:
 *         description: Server error
 */
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const {
      company_name, company_address, company_phone, company_email, company_website,
      supplier_gstin, invoice_number, invoice_date,
      buyer_name, buyer_address, buyer_state_name, buyer_state_code, buyer_gstin,
      receiver_name, receiver_address, place_of_supply,
      project_id, work_order_number, plant_name, bill_no,
      total_taxable_value, total_cgst, total_sgst, total_value, total_invoice_value,
      total_invoice_value_words, declaration, electronic_ref_number, electronic_ref_date,
      authorised_signatory, items = [], user_id, user_name
    } = normalizeLodhaInvoicePayload(req.body);

    const invResult = await client.query(
      `INSERT INTO lodha_invoices (
        project_id, company_name, company_address, company_phone, company_email, company_website,
        supplier_gstin, invoice_number, invoice_date,
        buyer_name, buyer_address, buyer_state_name, buyer_state_code, buyer_gstin,
        receiver_name, receiver_address, place_of_supply,
        work_order_number, plant_name, bill_no,
        total_taxable_value, total_cgst, total_sgst, total_value, total_invoice_value,
        total_invoice_value_words, declaration, electronic_ref_number, electronic_ref_date, authorised_signatory
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
      RETURNING *`,
      [
        project_id, company_name, company_address, company_phone, company_email, company_website,
        supplier_gstin, invoice_number, invoice_date || null,
        buyer_name, buyer_address, buyer_state_name, buyer_state_code, buyer_gstin,
        receiver_name, receiver_address, place_of_supply,
        work_order_number, plant_name, bill_no,
        total_taxable_value || 0, total_cgst || 0, total_sgst || 0, total_value || 0, total_invoice_value || 0,
        total_invoice_value_words, declaration, electronic_ref_number, electronic_ref_date || null, authorised_signatory
      ]
    );

    const invoiceId = invResult.rows[0].invoice_id;

    if (items.length > 0) {
      const itemSql = `
        INSERT INTO lodha_invoice_items (
          invoice_id, sn, description, sac_code, value_of_supply, discount,
          taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_amount, line_total
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `;
      for (const item of items) {
        await client.query(itemSql, [
          invoiceId, item.sn, item.description, item.sac_code,
          item.value_of_supply || 0, item.discount || 0, item.taxable_value || 0,
          item.cgst_rate || 0, item.cgst_amount || 0,
          item.sgst_rate || 0, item.sgst_amount || 0, item.igst_amount || 0,
          item.line_total || 0
        ]);
      }
    }

    await client.query("COMMIT");

    logActivity({
      action: "created",
      entity_type: "lodha_invoice",
      entity_id: invoiceId,
      entity_name: `Invoice #${invoice_number}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      project_id
    });

    res.status(201).json(formatLodhaInvoiceRow(invResult.rows[0]));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create Lodha Invoice error:", err);
    if (err.code === "23505") {
      return res.status(409).json({ error: `Invoice number '${req.body.invoice_number}' already exists.` });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD: READ All Lodha Invoices
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/lodha-invoice:
 *   get:
 *     summary: Get all Lodha Invoices
 *     tags: [Lodha Invoice]
 *     responses:
 *       200:
 *         description: List of invoices
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/LodhaInvoice'
 *       500:
 *         description: Server error
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM lodha_invoices ORDER BY created_at DESC");
    res.json(result.rows.map(formatLodhaInvoiceRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD: READ Lodha Invoices by project_id
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/lodha-invoice/project/{projectId}:
 *   get:
 *     summary: Get all Lodha Invoices for a specific project
 *     tags: [Lodha Invoice]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: integer }
 *         description: The project ID
 *     responses:
 *       200:
 *         description: List of invoices for the project
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/LodhaInvoice'
 *       500:
 *         description: Server error
 */
router.get("/project/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const result = await pool.query(
      "SELECT * FROM lodha_invoices WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId]
    );
    res.json(result.rows.map(formatLodhaInvoiceRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD: READ Single Lodha Invoice
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/lodha-invoice/{id}:
 *   get:
 *     summary: Get a single Lodha Invoice with its items
 *     tags: [Lodha Invoice]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: The invoice ID
 *     responses:
 *       200:
 *         description: Invoice details with items
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LodhaInvoice'
 *       404:
 *         description: Invoice not found
 *       500:
 *         description: Server error
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const invResult = await pool.query("SELECT * FROM lodha_invoices WHERE invoice_id = $1", [id]);
    if (invResult.rows.length === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    const itemResult = await pool.query(
      "SELECT * FROM lodha_invoice_items WHERE invoice_id = $1 ORDER BY sn NULLS LAST, item_id",
      [id]
    );
    res.json({
      ...formatLodhaInvoiceRow(invResult.rows[0]),
      items: itemResult.rows.map(formatLodhaInvoiceItemRow)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD: UPDATE Lodha Invoice
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/lodha-invoice/{id}:
 *   put:
 *     summary: Update a Lodha Invoice and its items
 *     tags: [Lodha Invoice]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: The invoice ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LodhaInvoiceInput'
 *     responses:
 *       200:
 *         description: Invoice updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *       404:
 *         description: Invoice not found
 *       500:
 *         description: Server error
 */
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const {
      company_name, company_address, company_phone, company_email, company_website,
      supplier_gstin, invoice_number, invoice_date,
      buyer_name, buyer_address, buyer_state_name, buyer_state_code, buyer_gstin,
      receiver_name, receiver_address, place_of_supply,
      project_id, work_order_number, plant_name, bill_no,
      total_taxable_value, total_cgst, total_sgst, total_value, total_invoice_value,
      total_invoice_value_words, declaration, electronic_ref_number, electronic_ref_date,
      authorised_signatory, items = [], user_id, user_name
    } = normalizeLodhaInvoicePayload(req.body);

    const updateResult = await client.query(
      `UPDATE lodha_invoices SET
        project_id=$1, company_name=$2, company_address=$3, company_phone=$4, company_email=$5, company_website=$6,
        supplier_gstin=$7, invoice_number=$8, invoice_date=$9,
        buyer_name=$10, buyer_address=$11, buyer_state_name=$12, buyer_state_code=$13, buyer_gstin=$14,
        receiver_name=$15, receiver_address=$16, place_of_supply=$17,
        work_order_number=$18, plant_name=$19, bill_no=$20,
        total_taxable_value=$21, total_cgst=$22, total_sgst=$23, total_value=$24, total_invoice_value=$25,
        total_invoice_value_words=$26, declaration=$27, electronic_ref_number=$28, electronic_ref_date=$29,
        authorised_signatory=$30,
        updated_at=NOW()
      WHERE invoice_id = $31
      RETURNING *`,
      [
        project_id, company_name, company_address, company_phone, company_email, company_website,
        supplier_gstin, invoice_number, invoice_date || null,
        buyer_name, buyer_address, buyer_state_name, buyer_state_code, buyer_gstin,
        receiver_name, receiver_address, place_of_supply,
        work_order_number, plant_name, bill_no,
        total_taxable_value, total_cgst, total_sgst, total_value, total_invoice_value,
        total_invoice_value_words, declaration, electronic_ref_number, electronic_ref_date || null, authorised_signatory,
        id
      ]
    );

    if (updateResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Invoice not found" });
    }

    // Replace items
    await client.query("DELETE FROM lodha_invoice_items WHERE invoice_id = $1", [id]);
    if (items.length > 0) {
      const itemSql = `
        INSERT INTO lodha_invoice_items (
          invoice_id, sn, description, sac_code, value_of_supply, discount,
          taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_amount, line_total
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `;
      for (const item of items) {
        await client.query(itemSql, [
          id, item.sn, item.description, item.sac_code,
          item.value_of_supply || 0, item.discount || 0, item.taxable_value || 0,
          item.cgst_rate || 0, item.cgst_amount || 0,
          item.sgst_rate || 0, item.sgst_amount || 0, item.igst_amount || 0,
          item.line_total || 0
        ]);
      }
    }

    await client.query("COMMIT");

    logActivity({
      action: "updated",
      entity_type: "lodha_invoice",
      entity_id: id,
      entity_name: `Invoice #${invoice_number}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      project_id
    });

    res.json({ message: "Invoice updated successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Update Lodha Invoice error:", err);
    if (err.code === "23505") {
      return res.status(409).json({ error: `Invoice number '${req.body.invoice_number}' already exists.` });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD: DELETE Lodha Invoice
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/lodha-invoice/{id}:
 *   delete:
 *     summary: Delete a Lodha Invoice
 *     tags: [Lodha Invoice]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: The invoice ID
 *     responses:
 *       200:
 *         description: Deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *       404:
 *         description: Invoice not found
 *       500:
 *         description: Server error
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id, user_name } = req.body;
    
    const check = await pool.query("SELECT invoice_number, project_id FROM lodha_invoices WHERE invoice_id = $1", [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    const invNo = check.rows[0].invoice_number;
    const projectId = check.rows[0].project_id;

    await pool.query("DELETE FROM lodha_invoices WHERE invoice_id = $1", [id]);

    logActivity({
      action: "deleted",
      entity_type: "lodha_invoice",
      entity_id: id,
      entity_name: `Invoice #${invNo}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      project_id: projectId
    });

    res.json({ message: "Invoice deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
