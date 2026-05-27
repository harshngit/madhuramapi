const express = require("express");
const { pool } = require("../db");
const { logActivity } = require("./dashboard");

const router = express.Router();

function normalizeLodhaItem(item = {}) {
  return {
    sn: item.sn ?? item.sr ?? item.serial_number ?? null,
    description: item.description ?? item.descriptionOfServiceGoods ?? item.goods_or_service_description ?? null,
    sac_code: item.sac_code ?? item.sacHsnCode ?? null,
    uom: item.uom ?? null,
    quantity: item.quantity ?? item.qty ?? null,
    rate: item.rate ?? null,
    value_of_supply: item.value_of_supply ?? item.totalValueOfGoods ?? 0,
    discount: item.discount ?? item.discountIf ?? 0,
    taxable_value: item.taxable_value ?? 0,
    cgst_rate: item.cgst_rate ?? (item.cgst ? item.cgst.rate : 0) ?? 0,
    cgst_amount: item.cgst_amount ?? (item.cgst ? item.cgst.amount : 0) ?? 0,
    sgst_rate: item.sgst_rate ?? (item.sgst ? item.sgst.rate : 0) ?? 0,
    sgst_amount: item.sgst_amount ?? (item.sgst ? item.sgst.amount : 0) ?? 0,
    igst_rate: item.igst_rate ?? (item.igst ? item.igst.rate : 0) ?? 0,
    igst_amount: item.igst_amount ?? (item.igst ? item.igst.amount : 0) ?? 0,
    cess_rate: item.cess_rate ?? (item.cess ? item.cess.rate : 0) ?? 0,
    cess_amount: item.cess_amount ?? (item.cess ? item.cess.amount : 0) ?? 0,
    line_total: item.line_total ?? item.total ?? 0,
  };
}

function normalizeLodhaInvoicePayload(body = {}) {
  // Support both nested structure (user's new request) and flat structure (previous)
  const inv = body.invoice || body;
  const buyer = inv.buyer || {};
  const receiver = inv.receiverDetails || {};
  const workOrder = inv.workOrderDetails || {};
  const totals = inv.totals || {};

  return {
    company_name: inv.company_name ?? null,
    company_address: inv.company_address ?? null,
    company_phone: inv.company_phone ?? inv.company_contact_number ?? null,
    company_email: inv.company_email ?? null,
    company_website: inv.company_website ?? inv.website ?? null,
    supplier_gstin: inv.supplier_gstin ?? inv.gstin ?? null,
    invoice_number: inv.invoice_number ?? inv.invoiceNo ?? null,
    invoice_date: inv.invoice_date ?? inv.invoiceDate ?? null,
    buyer_name: buyer.name ?? inv.buyer_name ?? inv.bill_to_name ?? null,
    buyer_address: buyer.address ?? inv.buyer_address ?? inv.bill_to_address ?? null,
    buyer_state_name: buyer.stateName ?? inv.buyer_state_name ?? inv.bill_to_state ?? null,
    buyer_state_code: buyer.stateCode ?? inv.buyer_state_code ?? inv.bill_to_state_code ?? null,
    buyer_gstin: buyer.gstin ?? inv.buyer_gstin ?? inv.bill_to_gstin ?? null,
    receiver_name: receiver.name ?? inv.receiver_name ?? inv.ship_to_name ?? null,
    receiver_address: receiver.address ?? inv.receiver_address ?? inv.ship_to_address ?? null,
    place_of_supply: receiver.placeOfSupply ?? inv.place_of_supply ?? null,
    work_order_number: workOrder.woNo ?? inv.work_order_number ?? null,
    work_order_date: workOrder.woDate ?? inv.work_order_date ?? null,
    plant_name: workOrder.plantName ?? inv.plant_name ?? inv.building_name ?? null,
    bill_no: workOrder.billNo ?? inv.bill_no ?? inv.ra_number ?? null,
    total_taxable_value: totals.totalTaxableValue ?? inv.total_taxable_value ?? 0,
    total_cgst: totals.totalCgstAmount ?? inv.total_cgst ?? 0,
    total_sgst: totals.totalSgstAmount ?? inv.total_sgst ?? 0,
    total_igst: totals.totalIgstAmount ?? inv.total_igst ?? 0,
    total_cess: totals.totalCessAmount ?? inv.total_cess ?? 0,
    total_value: inv.total_value ?? inv.total_invoice_value ?? 0,
    total_invoice_value: totals.totalInvoiceValueFigure ?? inv.total_invoice_value ?? 0,
    total_invoice_value_words: totals.totalInvoiceValueWords ?? inv.total_invoice_value_words ?? null,
    declaration: inv.declaration ?? inv.terms ?? null,
    electronic_ref_number: inv.electronic_ref_number ?? inv.electronicReferenceNumber ?? null,
    electronic_ref_date: inv.electronic_ref_date ?? null,
    authorised_signatory: inv.authorised_signatory ?? inv.authorisedSignatory ?? null,
    project_id: body.project_id ?? inv.project_id ?? null,
    user_id: body.user_id ?? inv.user_id ?? null,
    user_name: body.user_name ?? inv.user_name ?? null,
    items: Array.isArray(inv.lineItems) ? inv.lineItems.map(normalizeLodhaItem) : (Array.isArray(inv.items) ? inv.items.map(normalizeLodhaItem) : []),
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
    work_order_date: row.work_order_date,
    plant_name: row.plant_name,
    bill_no: row.bill_no,
    total_taxable_value: row.total_taxable_value,
    total_cgst: row.total_cgst,
    total_sgst: row.total_sgst,
    total_igst: row.total_igst,
    total_cess: row.total_cess,
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
    uom: row.uom,
    quantity: row.quantity,
    rate: row.rate,
    value_of_supply: row.value_of_supply,
    discount: row.discount,
    taxable_value: row.taxable_value,
    cgst_rate: row.cgst_rate,
    cgst_amount: row.cgst_amount,
    sgst_rate: row.sgst_rate,
    sgst_amount: row.sgst_amount,
    igst_rate: row.igst_rate,
    igst_amount: row.igst_amount,
    cess_rate: row.cess_rate,
    cess_amount: row.cess_amount,
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
 *         sn:                        { type: integer }
 *         descriptionOfServiceGoods: { type: string }
 *         sacHsnCode:                { type: string }
 *         uom:                       { type: string }
 *         qty:                       { type: number }
 *         rate:                      { type: number }
 *         totalValueOfGoods:         { type: number }
 *         discountIf:                { type: number }
 *         taxableValue:              { type: number }
 *         cgst:
 *           type: object
 *           properties:
 *             rate:   { type: number }
 *             amount: { type: number }
 *         sgst:
 *           type: object
 *           properties:
 *             rate:   { type: number }
 *             amount: { type: number }
 *         igst:
 *           type: object
 *           properties:
 *             rate:   { type: number }
 *             amount: { type: number }
 *         cess:
 *           type: object
 *           properties:
 *             rate:   { type: number }
 *             amount: { type: number }
 *         line_total:                { type: number }
 *     LodhaInvoiceItem:
 *       allOf:
 *         - $ref: '#/components/schemas/LodhaInvoiceItemInput'
 *         - type: object
 *           properties:
 *             item_id: { type: integer }
 *             invoice_id: { type: integer }
 *     LodhaInvoiceInput:
 *       type: object
 *       properties:
 *         invoice:
 *           type: object
 *           required:
 *             - invoiceNo
 *           properties:
 *             invoiceNo:      { type: string }
 *             invoiceDate:    { type: string, format: date }
 *             gstin:          { type: string }
 *             website:        { type: string }
 *             buyer:
 *               type: object
 *               properties:
 *                 name:      { type: string }
 *                 address:   { type: string }
 *                 stateName: { type: string }
 *                 stateCode: { type: string }
 *                 gstin:     { type: string }
 *             receiverDetails:
 *               type: object
 *               properties:
 *                 name:          { type: string }
 *                 address:       { type: string }
 *                 placeOfSupply: { type: string }
 *             workOrderDetails:
 *               type: object
 *               properties:
 *                 woNo:      { type: string }
 *                 woDate:    { type: string, format: date }
 *                 plantName: { type: string }
 *                 billNo:    { type: string }
 *             lineItems:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/LodhaInvoiceItemInput'
 *             totals:
 *               type: object
 *               properties:
 *                 totalTaxableValue:       { type: number }
 *                 totalCgstAmount:         { type: number }
 *                 totalSgstAmount:         { type: number }
 *                 totalIgstAmount:         { type: number }
 *                 totalCessAmount:         { type: number }
 *                 totalInvoiceValueFigure: { type: number }
 *                 totalInvoiceValueWords:  { type: string }
 *             declaration:               { type: string }
 *             electronicReferenceNumber: { type: string }
 *             authorisedSignatory:       { type: string }
 *         project_id: { type: integer }
 *         user_id:    { type: string }
 *         user_name:  { type: string }
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
      project_id, work_order_number, work_order_date, plant_name, bill_no,
      total_taxable_value, total_cgst, total_sgst, total_igst, total_cess,
      total_value, total_invoice_value,
      total_invoice_value_words, declaration, electronic_ref_number, electronic_ref_date,
      authorised_signatory, items = [], user_id, user_name
    } = normalizeLodhaInvoicePayload(req.body);

    const invResult = await client.query(
      `INSERT INTO lodha_invoices (
        project_id, company_name, company_address, company_phone, company_email, company_website,
        supplier_gstin, invoice_number, invoice_date,
        buyer_name, buyer_address, buyer_state_name, buyer_state_code, buyer_gstin,
        receiver_name, receiver_address, place_of_supply,
        work_order_number, work_order_date, plant_name, bill_no,
        total_taxable_value, total_cgst, total_sgst, total_igst, total_cess,
        total_value, total_invoice_value,
        total_invoice_value_words, declaration, electronic_ref_number, electronic_ref_date, authorised_signatory
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
      RETURNING *`,
      [
        project_id, company_name, company_address, company_phone, company_email, company_website,
        supplier_gstin, invoice_number, invoice_date || null,
        buyer_name, buyer_address, buyer_state_name, buyer_state_code, buyer_gstin,
        receiver_name, receiver_address, place_of_supply,
        work_order_number, work_order_date || null, plant_name, bill_no,
        total_taxable_value || 0, total_cgst || 0, total_sgst || 0, total_igst || 0, total_cess || 0,
        total_value || 0, total_invoice_value || 0,
        total_invoice_value_words, declaration, electronic_ref_number, electronic_ref_date || null, authorised_signatory
      ]
    );

    const invoiceId = invResult.rows[0].invoice_id;

    if (items.length > 0) {
      const itemSql = `
        INSERT INTO lodha_invoice_items (
          invoice_id, sn, description, sac_code, uom, quantity, rate,
          value_of_supply, discount, taxable_value, 
          cgst_rate, cgst_amount, sgst_rate, sgst_amount, 
          igst_rate, igst_amount, cess_rate, cess_amount, line_total
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      `;
      for (const item of items) {
        await client.query(itemSql, [
          invoiceId, item.sn, item.description, item.sac_code, item.uom, item.quantity, item.rate,
          item.value_of_supply || 0, item.discount || 0, item.taxable_value || 0,
          item.cgst_rate || 0, item.cgst_amount || 0,
          item.sgst_rate || 0, item.sgst_amount || 0,
          item.igst_rate || 0, item.igst_amount || 0,
          item.cess_rate || 0, item.cess_amount || 0,
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
      project_id, work_order_number, work_order_date, plant_name, bill_no,
      total_taxable_value, total_cgst, total_sgst, total_igst, total_cess,
      total_value, total_invoice_value,
      total_invoice_value_words, declaration, electronic_ref_number, electronic_ref_date,
      authorised_signatory, items = [], user_id, user_name
    } = normalizeLodhaInvoicePayload(req.body);

    const updateResult = await client.query(
      `UPDATE lodha_invoices SET
        project_id=$1, company_name=$2, company_address=$3, company_phone=$4, company_email=$5, company_website=$6,
        supplier_gstin=$7, invoice_number=$8, invoice_date=$9,
        buyer_name=$10, buyer_address=$11, buyer_state_name=$12, buyer_state_code=$13, buyer_gstin=$14,
        receiver_name=$15, receiver_address=$16, place_of_supply=$17,
        work_order_number=$18, work_order_date=$19, plant_name=$20, bill_no=$21,
        total_taxable_value=$22, total_cgst=$23, total_sgst=$24, total_igst=$25, total_cess=$26,
        total_value=$27, total_invoice_value=$28,
        total_invoice_value_words=$29, declaration=$30, electronic_ref_number=$31, electronic_ref_date=$32,
        authorised_signatory=$33,
        updated_at=NOW()
      WHERE invoice_id = $34
      RETURNING *`,
      [
        project_id, company_name, company_address, company_phone, company_email, company_website,
        supplier_gstin, invoice_number, invoice_date || null,
        buyer_name, buyer_address, buyer_state_name, buyer_state_code, buyer_gstin,
        receiver_name, receiver_address, place_of_supply,
        work_order_number, work_order_date || null, plant_name, bill_no,
        total_taxable_value, total_cgst, total_sgst, total_igst, total_cess,
        total_value, total_invoice_value,
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
          invoice_id, sn, description, sac_code, uom, quantity, rate,
          value_of_supply, discount, taxable_value, 
          cgst_rate, cgst_amount, sgst_rate, sgst_amount, 
          igst_rate, igst_amount, cess_rate, cess_amount, line_total
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      `;
      for (const item of items) {
        await client.query(itemSql, [
          id, item.sn, item.description, item.sac_code, item.uom, item.quantity, item.rate,
          item.value_of_supply || 0, item.discount || 0, item.taxable_value || 0,
          item.cgst_rate || 0, item.cgst_amount || 0,
          item.sgst_rate || 0, item.sgst_amount || 0,
          item.igst_rate || 0, item.igst_amount || 0,
          item.cess_rate || 0, item.cess_amount || 0,
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
