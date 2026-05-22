const express = require("express");
const { pool } = require("../db");
const { logActivity } = require("./dashboard");

const router = express.Router();

/**
 * @swagger
 * components:
 *   schemas:
 *     LodhaInvoiceItemInput:
 *       type: object
 *       properties:
 *         sr:                { type: integer }
 *         description:       { type: string }
 *         sac_code:          { type: string }
 *         value_of_supply:   { type: number }
 *         discount:          { type: number }
 *         taxable_value:     { type: number }
 *         cgst_rate:         { type: number }
 *         cgst_amount:       { type: number }
 *         sgst_rate:         { type: number }
 *         sgst_amount:       { type: number }
 *         total:             { type: number }
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
 *         company_name:              { type: string }
 *         company_address:           { type: string }
 *         company_contact_number:    { type: string }
 *         company_email:             { type: string }
 *         company_website:           { type: string }
 *         invoice_title:             { type: string }
 *         invoice_number:            { type: string }
 *         supplier_gstin:            { type: string }
 *         pan_no:                    { type: string }
 *         pf_number:                 { type: string }
 *         esic_number:               { type: string }
 *         ptr_number:                { type: string }
 *         mlwf_number:               { type: string }
 *         reverse_charge:            { type: boolean }
 *         state_name:                { type: string }
 *         state_code:                { type: string }
 *         receiver_name:             { type: string }
 *         receiver_address:          { type: string }
 *         buyer_gstin:               { type: string }
 *         ship_to_name:              { type: string }
 *         ship_to_state:             { type: string }
 *         ship_to_state_code:        { type: string }
 *         ship_to_gstin:             { type: string }
 *         project_id:                { type: integer }
 *         building_name:             { type: string }
 *         ra_number:                 { type: string }
 *         work_description:          { type: string }
 *         work_order_number:         { type: string }
 *         service_date_from:         { type: string, format: date }
 *         service_date_to:           { type: string, format: date }
 *         total_taxable_value:       { type: number }
 *         total_cgst:                { type: number }
 *         total_sgst:                { type: number }
 *         total_invoice_value:       { type: number }
 *         round_off:                 { type: number }
 *         total_invoice_value_words: { type: string }
 *         gst_on_reverse_charge:     { type: number }
 *         terms:                     { type: string }
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
      company_name, company_address, company_contact_number, company_email, company_website,
      invoice_title, invoice_number, supplier_gstin, pan_no, pf_number, esic_number,
      ptr_number, mlwf_number, reverse_charge, state_name, state_code,
      receiver_name, receiver_address, buyer_gstin,
      ship_to_name, ship_to_state, ship_to_state_code, ship_to_gstin,
      project_id, building_name, ra_number, work_description, work_order_number, service_date_from, service_date_to,
      total_taxable_value, total_cgst, total_sgst, total_invoice_value, round_off,
      total_invoice_value_words, gst_on_reverse_charge, terms, authorised_signatory,
      items = [], user_id, user_name
    } = req.body;

    const invResult = await client.query(
      `INSERT INTO lodha_invoices (
        company_name, company_address, company_contact_number, company_email, company_website,
        invoice_title, invoice_number, supplier_gstin, pan_no, pf_number, esic_number,
        ptr_number, mlwf_number, reverse_charge, state_name, state_code,
        receiver_name, receiver_address, buyer_gstin,
        ship_to_name, ship_to_state, ship_to_state_code, ship_to_gstin,
        project_id, building_name, ra_number, work_description, work_order_number, service_date_from, service_date_to,
        total_taxable_value, total_cgst, total_sgst, total_invoice_value, round_off,
        total_invoice_value_words, gst_on_reverse_charge, terms, authorised_signatory
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39)
      RETURNING *`,
      [
        company_name, company_address, company_contact_number, company_email, company_website,
        invoice_title, invoice_number, supplier_gstin, pan_no, pf_number, esic_number,
        ptr_number, mlwf_number, reverse_charge || false, state_name, state_code,
        receiver_name, receiver_address, buyer_gstin,
        ship_to_name, ship_to_state, ship_to_state_code, ship_to_gstin,
        project_id, building_name, ra_number, work_description, work_order_number, service_date_from || null, service_date_to || null,
        total_taxable_value || 0, total_cgst || 0, total_sgst || 0, total_invoice_value || 0, round_off || 0,
        total_invoice_value_words, gst_on_reverse_charge || 0, terms, authorised_signatory
      ]
    );

    const invoiceId = invResult.rows[0].invoice_id;

    if (items.length > 0) {
      const itemSql = `
        INSERT INTO lodha_invoice_items (
          invoice_id, sr, description, sac_code, value_of_supply, discount,
          taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount, total
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `;
      for (const item of items) {
        await client.query(itemSql, [
          invoiceId, item.sr, item.description, item.sac_code,
          item.value_of_supply || 0, item.discount || 0, item.taxable_value || 0,
          item.cgst_rate || 0, item.cgst_amount || 0,
          item.sgst_rate || 0, item.sgst_amount || 0,
          item.total || 0
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
      performed_by_name: user_name || null
    });

    res.status(201).json(invResult.rows[0]);
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
    res.json(result.rows);
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
    res.json(result.rows);
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
    const itemResult = await pool.query("SELECT * FROM lodha_invoice_items WHERE invoice_id = $1 ORDER BY sr", [id]);
    res.json({
      ...invResult.rows[0],
      items: itemResult.rows
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
      company_name, company_address, company_contact_number, company_email, company_website,
      invoice_title, invoice_number, supplier_gstin, pan_no, pf_number, esic_number,
      ptr_number, mlwf_number, reverse_charge, state_name, state_code,
      receiver_name, receiver_address, buyer_gstin,
      ship_to_name, ship_to_state, ship_to_state_code, ship_to_gstin,
      project_id, building_name, ra_number, work_description, work_order_number,
      service_date_from, service_date_to,
      total_taxable_value, total_cgst, total_sgst, total_invoice_value, round_off,
      total_invoice_value_words, gst_on_reverse_charge, terms, authorised_signatory,
      items = [], user_id, user_name
    } = req.body;

    await client.query(
      `UPDATE lodha_invoices SET
        company_name=$1, company_address=$2, company_contact_number=$3, company_email=$4, company_website=$5,
        invoice_title=$6, invoice_number=$7, supplier_gstin=$8, pan_no=$9, pf_number=$10, esic_number=$11,
        ptr_number=$12, mlwf_number=$13, reverse_charge=$14, state_name=$15, state_code=$16,
        receiver_name=$17, receiver_address=$18, buyer_gstin=$19,
        ship_to_name=$20, ship_to_state=$21, ship_to_state_code=$22, ship_to_gstin=$23,
        project_id=$24, building_name=$25, ra_number=$26, work_description=$27, work_order_number=$28,
        service_date_from=$29, service_date_to=$30,
        total_taxable_value=$31, total_cgst=$32, total_sgst=$33, total_invoice_value=$34, round_off=$35,
        total_invoice_value_words=$36, gst_on_reverse_charge=$37, terms=$38, authorised_signatory=$39,
        updated_at=NOW()
      WHERE invoice_id = $40`,
      [
        company_name, company_address, company_contact_number, company_email, company_website,
        invoice_title, invoice_number, supplier_gstin, pan_no, pf_number, esic_number,
        ptr_number, mlwf_number, reverse_charge, state_name, state_code,
        receiver_name, receiver_address, buyer_gstin,
        ship_to_name, ship_to_state, ship_to_state_code, ship_to_gstin,
        project_id, building_name, ra_number, work_description, work_order_number,
        service_date_from || null, service_date_to || null,
        total_taxable_value, total_cgst, total_sgst, total_invoice_value, round_off,
        total_invoice_value_words, gst_on_reverse_charge, terms, authorised_signatory,
        id
      ]
    );

    // Replace items
    await client.query("DELETE FROM lodha_invoice_items WHERE invoice_id = $1", [id]);
    if (items.length > 0) {
      const itemSql = `
        INSERT INTO lodha_invoice_items (
          invoice_id, sr, description, sac_code, value_of_supply, discount,
          taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount, total
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `;
      for (const item of items) {
        await client.query(itemSql, [
          id, item.sr, item.description, item.sac_code,
          item.value_of_supply || 0, item.discount || 0, item.taxable_value || 0,
          item.cgst_rate || 0, item.cgst_amount || 0,
          item.sgst_rate || 0, item.sgst_amount || 0,
          item.total || 0
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
      performed_by_name: user_name || null
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
    
    const check = await pool.query("SELECT invoice_number FROM lodha_invoices WHERE invoice_id = $1", [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    const invNo = check.rows[0].invoice_number;

    await pool.query("DELETE FROM lodha_invoices WHERE invoice_id = $1", [id]);

    logActivity({
      action: "deleted",
      entity_type: "lodha_invoice",
      entity_id: id,
      entity_name: `Invoice #${invNo}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null
    });

    res.json({ message: "Invoice deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
