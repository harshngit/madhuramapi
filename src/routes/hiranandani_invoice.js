const express = require("express");
const { pool } = require("../db");
const { logActivity } = require("./dashboard");

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// CRUD: CREATE Hiranandani Invoice
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/hiranandani-invoice:
 *   post:
 *     summary: Create a new Hiranandani Invoice with items
 *     tags: [Hiranandani Invoice]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - invoice_number
 *             properties:
 *               company_name:             { type: string }
 *               project_id:               { type: integer }
 *               company_address:          { type: string }
 *               company_contact_number:   { type: string }
 *               company_email:            { type: string }
 *               company_website:          { type: string }
 *               supplier_gstin:           { type: string }
 *               invoice_number:           { type: string }
 *               invoice_date:             { type: string, format: date }
 *               bill_to_company_name:     { type: string }
 *               bill_to_address:          { type: string }
 *               bill_to_gstin:            { type: string }
 *               bill_to_state:            { type: string }
 *               bill_to_state_code:       { type: string }
 *               ship_to_company_name:     { type: string }
 *               ship_to_address:          { type: string }
 *               ship_to_gstin:            { type: string }
 *               ship_to_state:            { type: string }
 *               ship_to_state_code:       { type: string }
 *               building_name:            { type: string }
 *               reference_ra_number:      { type: string }
 *               work_description:         { type: string }
 *               work_order_number:        { type: string }
 *               work_order_date:          { type: string, format: date }
 *               service_date_from:        { type: string, format: date }
 *               service_date_to:          { type: string, format: date }
 *               total_value_before_tax:   { type: number }
 *               total_taxable_value:      { type: number }
 *               total_cgst:               { type: number }
 *               total_sgst:               { type: number }
 *               round_off:                { type: number }
 *               total_amount_after_tax:   { type: number }
 *               gst_on_reverse_charge:    { type: number }
 *               invoice_amount_in_words:  { type: string }
 *               bank_details:             { type: string }
 *               terms_and_conditions:     { type: string }
 *               authorised_signatory:     { type: string }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     serial_number:                 { type: integer }
 *                     goods_or_service_description:  { type: string }
 *                     sac_code:                      { type: string }
 *                     value_of_supply:               { type: number }
 *                     discount:                      { type: number }
 *                     taxable_value:                 { type: number }
 *                     cgst_rate:                     { type: number }
 *                     cgst_amount:                   { type: number }
 *                     sgst_rate:                     { type: number }
 *                     sgst_amount:                   { type: number }
 *                     igst_rate:                     { type: number }
 *                     igst_amount:                   { type: number }
 *                     cess_rate:                     { type: number }
 *                     cess_amount:                   { type: number }
 */
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const {
      company_name, project_id, company_address, company_contact_number, company_email, company_website,
      supplier_gstin, invoice_number, invoice_date, bill_to_company_name, bill_to_address, bill_to_gstin,
      bill_to_state, bill_to_state_code, ship_to_company_name, ship_to_address, ship_to_gstin,
      ship_to_state, ship_to_state_code, building_name, reference_ra_number, work_description,
      work_order_number, work_order_date, service_date_from, service_date_to,
      total_value_before_tax, total_taxable_value, total_cgst, total_sgst, round_off,
      total_amount_after_tax, gst_on_reverse_charge, invoice_amount_in_words,
      bank_details, terms_and_conditions, authorised_signatory,
      items = [], user_id, user_name
    } = req.body;

    const invResult = await client.query(
      `INSERT INTO hiranandani_invoices (
        company_name, project_id, company_address, company_contact_number, company_email, company_website,
        supplier_gstin, invoice_number, invoice_date, bill_to_company_name, bill_to_address, bill_to_gstin,
        bill_to_state, bill_to_state_code, ship_to_company_name, ship_to_address, ship_to_gstin,
        ship_to_state, ship_to_state_code, building_name, reference_ra_number, work_description,
        work_order_number, work_order_date, service_date_from, service_date_to,
        total_value_before_tax, total_taxable_value, total_cgst, total_sgst, round_off,
        total_amount_after_tax, gst_on_reverse_charge, invoice_amount_in_words,
        bank_details, terms_and_conditions, authorised_signatory
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37)
      RETURNING *`,
      [
        company_name, project_id, company_address, company_contact_number, company_email, company_website,
        supplier_gstin, invoice_number, invoice_date || null, bill_to_company_name, bill_to_address, bill_to_gstin,
        bill_to_state, bill_to_state_code, ship_to_company_name, ship_to_address, ship_to_gstin,
        ship_to_state, ship_to_state_code, building_name, reference_ra_number, work_description,
        work_order_number, work_order_date || null, service_date_from || null, service_date_to || null,
        total_value_before_tax || 0, total_taxable_value || 0, total_cgst || 0, total_sgst || 0, round_off || 0,
        total_amount_after_tax || 0, gst_on_reverse_charge || 0, invoice_amount_in_words,
        bank_details, terms_and_conditions, authorised_signatory
      ]
    );

    const invoiceId = invResult.rows[0].invoice_id;

    if (items.length > 0) {
      const itemSql = `
        INSERT INTO hiranandani_invoice_items (
          invoice_id, serial_number, goods_or_service_description, sac_code, value_of_supply, discount,
          taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount, cess_rate, cess_amount
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `;
      for (const item of items) {
        await client.query(itemSql, [
          invoiceId, item.serial_number, item.goods_or_service_description, item.sac_code,
          item.value_of_supply || 0, item.discount || 0, item.taxable_value || 0,
          item.cgst_rate || 0, item.cgst_amount || 0,
          item.sgst_rate || 0, item.sgst_amount || 0,
          item.igst_rate || 0, item.igst_amount || 0,
          item.cess_rate || 0, item.cess_amount || 0
        ]);
      }
    }

    await client.query("COMMIT");

    logActivity({
      action: "created",
      entity_type: "hiranandani_invoice",
      entity_id: invoiceId,
      entity_name: `Invoice #${invoice_number}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      project_id
    });

    res.status(201).json(invResult.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create Hiranandani Invoice error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD: READ All Hiranandani Invoices
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/hiranandani-invoice:
 *   get:
 *     summary: Get all Hiranandani Invoices
 *     tags: [Hiranandani Invoice]
 *     responses:
 *       200:
 *         description: List of invoices
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM hiranandani_invoices ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD: READ Hiranandani Invoices by project_id
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/hiranandani-invoice/project/{projectId}:
 *   get:
 *     summary: Get all Hiranandani Invoices for a specific project
 *     tags: [Hiranandani Invoice]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of invoices for the project
 */
router.get("/project/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const result = await pool.query(
      "SELECT * FROM hiranandani_invoices WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD: READ Single Hiranandani Invoice
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/hiranandani-invoice/{id}:
 *   get:
 *     summary: Get a single Hiranandani Invoice with its items
 *     tags: [Hiranandani Invoice]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Invoice details with items
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const invResult = await pool.query("SELECT * FROM hiranandani_invoices WHERE invoice_id = $1", [id]);
    if (invResult.rows.length === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    const itemResult = await pool.query("SELECT * FROM hiranandani_invoice_items WHERE invoice_id = $1 ORDER BY serial_number", [id]);
    res.json({
      ...invResult.rows[0],
      items: itemResult.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD: UPDATE Hiranandani Invoice
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/hiranandani-invoice/{id}:
 *   put:
 *     summary: Update a Hiranandani Invoice and its items
 *     tags: [Hiranandani Invoice]
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
 */
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const {
      company_name, project_id, company_address, company_contact_number, company_email, company_website,
      supplier_gstin, invoice_number, invoice_date, bill_to_company_name, bill_to_address, bill_to_gstin,
      bill_to_state, bill_to_state_code, ship_to_company_name, ship_to_address, ship_to_gstin,
      ship_to_state, ship_to_state_code, building_name, reference_ra_number, work_description,
      work_order_number, work_order_date, service_date_from, service_date_to,
      total_value_before_tax, total_taxable_value, total_cgst, total_sgst, round_off,
      total_amount_after_tax, gst_on_reverse_charge, invoice_amount_in_words,
      bank_details, terms_and_conditions, authorised_signatory,
      items = [], user_id, user_name
    } = req.body;

    await client.query(
      `UPDATE hiranandani_invoices SET
        company_name=$1, project_id=$2, company_address=$3, company_contact_number=$4, company_email=$5, company_website=$6,
        supplier_gstin=$7, invoice_number=$8, invoice_date=$9, bill_to_company_name=$10, bill_to_address=$11, bill_to_gstin=$12,
        bill_to_state=$13, bill_to_state_code=$14, ship_to_company_name=$15, ship_to_address=$16, ship_to_gstin=$17,
        ship_to_state=$18, ship_to_state_code=$19, building_name=$20, reference_ra_number=$21, work_description=$22,
        work_order_number=$23, work_order_date=$24, service_date_from=$25, service_date_to=$26,
        total_value_before_tax=$27, total_taxable_value=$28, total_cgst=$29, total_sgst=$30, round_off=$31,
        total_amount_after_tax=$32, gst_on_reverse_charge=$33, invoice_amount_in_words=$34,
        bank_details=$35, terms_and_conditions=$36, authorised_signatory=$37,
        updated_at=NOW()
      WHERE invoice_id = $38`,
      [
        company_name, project_id, company_address, company_contact_number, company_email, company_website,
        supplier_gstin, invoice_number, invoice_date || null, bill_to_company_name, bill_to_address, bill_to_gstin,
        bill_to_state, bill_to_state_code, ship_to_company_name, ship_to_address, ship_to_gstin,
        ship_to_state, ship_to_state_code, building_name, reference_ra_number, work_description,
        work_order_number, work_order_date || null, service_date_from || null, service_date_to || null,
        total_value_before_tax, total_taxable_value, total_cgst, total_sgst, round_off,
        total_amount_after_tax, gst_on_reverse_charge, invoice_amount_in_words,
        bank_details, terms_and_conditions, authorised_signatory,
        id
      ]
    );

    // Replace items
    await client.query("DELETE FROM hiranandani_invoice_items WHERE invoice_id = $1", [id]);
    if (items.length > 0) {
      const itemSql = `
        INSERT INTO hiranandani_invoice_items (
          invoice_id, serial_number, goods_or_service_description, sac_code, value_of_supply, discount,
          taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount, cess_rate, cess_amount
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `;
      for (const item of items) {
        await client.query(itemSql, [
          id, item.serial_number, item.goods_or_service_description, item.sac_code,
          item.value_of_supply || 0, item.discount || 0, item.taxable_value || 0,
          item.cgst_rate || 0, item.cgst_amount || 0,
          item.sgst_rate || 0, item.sgst_amount || 0,
          item.igst_rate || 0, item.igst_amount || 0,
          item.cess_rate || 0, item.cess_amount || 0
        ]);
      }
    }

    await client.query("COMMIT");

    logActivity({
      action: "updated",
      entity_type: "hiranandani_invoice",
      entity_id: id,
      entity_name: `Invoice #${invoice_number}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      project_id
    });

    res.json({ message: "Invoice updated successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD: DELETE Hiranandani Invoice
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/hiranandani-invoice/{id}:
 *   delete:
 *     summary: Delete a Hiranandani Invoice
 *     tags: [Hiranandani Invoice]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Deleted successfully
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id, user_name } = req.body;
    
    const check = await pool.query("SELECT invoice_number, project_id FROM hiranandani_invoices WHERE invoice_id = $1", [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    const invNo = check.rows[0].invoice_number;
    const projectId = check.rows[0].project_id;

    await pool.query("DELETE FROM hiranandani_invoices WHERE invoice_id = $1", [id]);

    logActivity({
      action: "deleted",
      entity_type: "hiranandani_invoice",
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
