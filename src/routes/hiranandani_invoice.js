const express = require("express");
const { pool } = require("../db");
const { logActivity, getEntityHistory, attachCreatedUpdatedBy } = require("./dashboard");

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Hiranandani Invoice
 *   description: |
 *     Hiranandani invoice management. Every GET (list/by-id/by-project)
 *     response also includes created_by/created_by_name/updated_by/updated_by_name
 *     — see the CreatedUpdatedBy schema.
 */

function normalizeHiranandaniItem(item = {}) {
  return {
    sn: item.sn ?? item.sNo ?? item.serial_number ?? null,
    description: item.description ?? item.goodsServiceDescription ?? item.goods_or_service_description ?? null,
    sac_code: item.sac_code ?? item.sacCode ?? null,
    value_of_supply: item.value_of_supply ?? item.valueOfSupply ?? 0,
    discount: item.discount ?? 0,
    taxable_value: item.taxable_value ?? item.taxableValue ?? 0,
    cgst_rate: item.cgst_rate ?? (item.cgst ? item.cgst.rate : 0) ?? 0,
    cgst_amount: item.cgst_amount ?? (item.cgst ? item.cgst.amount : 0) ?? 0,
    sgst_rate: item.sgst_rate ?? (item.sgst ? item.sgst.rate : 0) ?? 0,
    sgst_amount: item.sgst_amount ?? (item.sgst ? item.sgst.amount : 0) ?? 0,
    line_total: item.line_total ?? item.total ?? 0,
  };
}

function normalizeHiranandaniInvoicePayload(body = {}) {
  // Support both nested structure (user's new request) and flat structure (previous)
  const inv = body.invoice || body;
  const seller = inv.seller || {};
  const compliance = inv.complianceDetails || {};
  const billTo = inv.billToParty || {};
  const shipTo = inv.shipToPartySite || {};
  const reference = inv.referenceDetails || {};
  const summary = inv.summary || {};

  return {
    project_id: body.project_id ?? inv.project_id ?? null,
    company_name: seller.name ?? inv.company_name ?? null,
    company_address: inv.company_address ?? null,
    company_phone: inv.company_phone ?? inv.company_contact_number ?? null,
    company_email: inv.company_email ?? null,
    company_website: inv.company_website ?? null,
    supplier_gstin: seller.gstin ?? inv.supplier_gstin ?? null,
    pan_number: seller.panNo ?? inv.pan_number ?? inv.pan_no ?? null,
    pf_number: compliance.pfNo ?? inv.pf_number ?? null,
    esic_number: compliance.esicNo ?? inv.esic_number ?? null,
    ptr_number: compliance.ptrNo ?? inv.ptr_number ?? null,
    mlwf_number: compliance.mlwfNo ?? inv.mlwf_number ?? null,
    invoice_number: inv.invoiceNo ?? inv.invoice_number ?? null,
    invoice_date: inv.invoiceDate ?? inv.invoice_date ?? null,
    reverse_charge: inv.reverseCharge ?? inv.reverse_charge ?? null,
    supplier_state_name: inv.state ?? inv.supplier_state_name ?? null,
    supplier_state_code: inv.stateCode ?? inv.supplier_state_code ?? null,
    bill_to_name: billTo.coAccountName ?? inv.bill_to_name ?? inv.bill_to_company_name ?? null,
    bill_to_address: billTo.address ?? inv.bill_to_address ?? null,
    bill_to_gstin: billTo.gstin ?? inv.bill_to_gstin ?? null,
    bill_to_state: billTo.state ?? inv.bill_to_state ?? null,
    bill_to_state_code: billTo.stateCode ?? inv.bill_to_state_code ?? null,
    ship_to_name: shipTo.coAccountName ?? inv.ship_to_name ?? inv.ship_to_company_name ?? null,
    ship_to_address: inv.ship_to_address ?? null,
    ship_to_gstin: shipTo.gstin ?? inv.ship_to_gstin ?? null,
    ship_to_state: shipTo.state ?? inv.ship_to_state ?? null,
    ship_to_state_code: shipTo.stateCode ?? inv.ship_to_state_code ?? null,
    building_name: shipTo.buildingName ?? inv.building_name ?? null,
    ra_number: reference.raNo ?? inv.ra_number ?? inv.reference_ra_number ?? null,
    work_description: reference.workDescription ?? inv.work_description ?? null,
    work_order_number: reference.woNo ?? inv.work_order_number ?? null,
    work_order_date: reference.woDate ?? inv.work_order_date ?? null,
    service_date_from: reference.serviceDateFrom ?? inv.service_date_from ?? null,
    service_date_to: reference.serviceDateTo ?? inv.service_date_to ?? null,
    total_before_tax: summary.totalAmountBeforeTax ?? inv.total_before_tax ?? inv.total_value_before_tax ?? 0,
    total_taxable_value: inv.total_taxable_value ?? 0,
    total_cgst: summary.addCgst ?? inv.total_cgst ?? 0,
    total_sgst: summary.addSgst ?? inv.total_sgst ?? 0,
    round_off: summary.roundOff ?? inv.round_off ?? 0,
    total_amount_after_tax: summary.totalAmountAfterTax ?? inv.total_amount_after_tax ?? 0,
    gst_on_reverse_charge: summary.gstOnReverseCharge ?? inv.gst_on_reverse_charge ?? 0,
    invoice_amount_words: summary.totalInvoiceAmountInWords ?? inv.invoice_amount_words ?? inv.invoice_amount_in_words ?? null,
    bank_details: inv.bankDetails ?? inv.bank_details ?? null,
    terms_and_conditions: inv.terms_and_conditions ?? null,
    authorised_signatory: inv.authorisedSignatory ?? inv.authorised_signatory ?? null,
    user_id: body.user_id ?? inv.user_id ?? null,
    user_name: body.user_name ?? inv.user_name ?? null,
    items: Array.isArray(inv.lineItems) ? inv.lineItems.map(normalizeHiranandaniItem) : (Array.isArray(inv.items) ? inv.items.map(normalizeHiranandaniItem) : []),
  };
}

function formatHiranandaniInvoiceRow(row) {
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
    pan_number: row.pan_number,
    pf_number: row.pf_number,
    esic_number: row.esic_number,
    ptr_number: row.ptr_number,
    mlwf_number: row.mlwf_number,
    invoice_number: row.invoice_number,
    invoice_date: row.invoice_date,
    reverse_charge: row.reverse_charge,
    supplier_state_name: row.supplier_state_name,
    supplier_state_code: row.supplier_state_code,
    bill_to_name: row.bill_to_name,
    bill_to_address: row.bill_to_address,
    bill_to_gstin: row.bill_to_gstin,
    bill_to_state: row.bill_to_state,
    bill_to_state_code: row.bill_to_state_code,
    ship_to_name: row.ship_to_name,
    ship_to_address: row.ship_to_address,
    ship_to_gstin: row.ship_to_gstin,
    ship_to_state: row.ship_to_state,
    ship_to_state_code: row.ship_to_state_code,
    building_name: row.building_name,
    ra_number: row.ra_number,
    work_description: row.work_description,
    work_order_number: row.work_order_number,
    work_order_date: row.work_order_date,
    service_date_from: row.service_date_from,
    service_date_to: row.service_date_to,
    total_before_tax: row.total_before_tax,
    total_taxable_value: row.total_taxable_value,
    total_cgst: row.total_cgst,
    total_sgst: row.total_sgst,
    round_off: row.round_off,
    total_amount_after_tax: row.total_amount_after_tax,
    gst_on_reverse_charge: row.gst_on_reverse_charge,
    invoice_amount_words: row.invoice_amount_words,
    bank_details: row.bank_details,
    terms_and_conditions: row.terms_and_conditions,
    authorised_signatory: row.authorised_signatory,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function formatHiranandaniInvoiceItemRow(row) {
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
    line_total: row.line_total,
  };
}

/**
 * @swagger
 * components:
 *   schemas:
 *     HiranandaniInvoiceItemInput:
 *       type: object
 *       properties:
 *         sNo:                           { type: integer }
 *         goodsServiceDescription:       { type: string }
 *         sacCode:                       { type: string }
 *         valueOfSupply:                 { type: number }
 *         discount:                      { type: number }
 *         taxableValue:                  { type: number }
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
 *         total:                         { type: number }
 *     HiranandaniInvoiceItem:
 *       allOf:
 *         - $ref: '#/components/schemas/HiranandaniInvoiceItemInput'
 *         - type: object
 *           properties:
 *             item_id: { type: integer }
 *             invoice_id: { type: integer }
 *     HiranandaniInvoiceInput:
 *       type: object
 *       properties:
 *         invoice:
 *           type: object
 *           required:
 *             - invoiceNo
 *           properties:
 *             invoiceNo:      { type: string }
 *             invoiceDate:    { type: string, format: date }
 *             reverseCharge:  { type: string }
 *             state:          { type: string }
 *             stateCode:      { type: string }
 *             seller:
 *               type: object
 *               properties:
 *                 name:   { type: string }
 *                 gstin:  { type: string }
 *                 panNo:  { type: string }
 *             complianceDetails:
 *               type: object
 *               properties:
 *                 pfNo:   { type: string }
 *                 esicNo: { type: string }
 *                 ptrNo:  { type: string }
 *                 mlwfNo: { type: string }
 *             billToParty:
 *               type: object
 *               properties:
 *                 coAccountName: { type: string }
 *                 address:       { type: string }
 *                 gstin:         { type: string }
 *                 state:         { type: string }
 *                 stateCode:     { type: string }
 *             shipToPartySite:
 *               type: object
 *               properties:
 *                 coAccountName: { type: string }
 *                 gstin:         { type: string }
 *                 state:         { type: string }
 *                 stateCode:     { type: string }
 *                 buildingName:  { type: string }
 *             referenceDetails:
 *               type: object
 *               properties:
 *                 raNo:            { type: string }
 *                 workDescription: { type: string }
 *                 woNo:            { type: string }
 *                 woDate:          { type: string, format: date }
 *                 serviceDateFrom: { type: string, format: date }
 *                 serviceDateTo:   { type: string, format: date }
 *             lineItems:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/HiranandaniInvoiceItemInput'
 *             totals:
 *               type: object
 *               properties:
 *                 totalValueOfSupply: { type: number }
 *                 totalDiscount:      { type: number }
 *                 totalTaxableValue:  { type: number }
 *                 totalCgstAmount:    { type: number }
 *                 totalSgstAmount:    { type: number }
 *                 totalAmount:        { type: number }
 *             summary:
 *               type: object
 *               properties:
 *                 totalInvoiceAmountInWords: { type: string }
 *                 totalAmountBeforeTax:      { type: number }
 *                 addCgst:                   { type: number }
 *                 addSgst:                   { type: number }
 *                 roundOff:                  { type: number }
 *                 totalAmountAfterTax:       { type: number }
 *                 gstOnReverseCharge:        { type: number }
 *                 eAndOE:                    { type: boolean }
 *             bankDetails:             { type: string }
 *             authorisedSignatory:     { type: string }
 *         project_id: { type: integer }
 *         user_id:    { type: string }
 *         user_name:  { type: string }
 *     HiranandaniInvoice:
 *       allOf:
 *         - $ref: '#/components/schemas/HiranandaniInvoiceInput'
 *         - type: object
 *           properties:
 *             invoice_id: { type: integer }
 *             created_at: { type: string, format: date-time }
 *             updated_at: { type: string, format: date-time }
 *             items:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/HiranandaniInvoiceItem'
 */

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
 *             $ref: '#/components/schemas/HiranandaniInvoiceInput'
 *     responses:
 *       201:
 *         description: Invoice created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HiranandaniInvoice'
 *       500:
 *         description: Server error
 */
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const {
      company_name, project_id, company_address, company_phone, company_email, company_website,
      supplier_gstin, pan_number, pf_number, esic_number, ptr_number, mlwf_number,
      invoice_number, invoice_date, reverse_charge, supplier_state_name, supplier_state_code,
      bill_to_name, bill_to_address, bill_to_gstin, bill_to_state, bill_to_state_code,
      ship_to_name, ship_to_address, ship_to_gstin, ship_to_state, ship_to_state_code,
      building_name, ra_number, work_description,
      work_order_number, work_order_date, service_date_from, service_date_to,
      total_before_tax, total_taxable_value, total_cgst, total_sgst, round_off,
      total_amount_after_tax, gst_on_reverse_charge, invoice_amount_words,
      bank_details, terms_and_conditions, authorised_signatory,
      items = [], user_id, user_name
    } = normalizeHiranandaniInvoicePayload(req.body);

    const invResult = await client.query(
      `INSERT INTO hiranandani_invoices (
        project_id, company_name, company_address, company_phone, company_email, company_website,
        supplier_gstin, pan_number, pf_number, esic_number, ptr_number, mlwf_number,
        invoice_number, invoice_date, reverse_charge, supplier_state_name, supplier_state_code,
        bill_to_name, bill_to_address, bill_to_gstin, bill_to_state, bill_to_state_code,
        ship_to_name, ship_to_address, ship_to_gstin, ship_to_state, ship_to_state_code,
        building_name, ra_number, work_description, work_order_number, work_order_date, service_date_from, service_date_to,
        total_before_tax, total_taxable_value, total_cgst, total_sgst, round_off,
        total_amount_after_tax, gst_on_reverse_charge, invoice_amount_words,
        bank_details, terms_and_conditions, authorised_signatory
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45)
      RETURNING *`,
      [
        project_id, company_name, company_address, company_phone, company_email, company_website,
        supplier_gstin, pan_number, pf_number, esic_number, ptr_number, mlwf_number,
        invoice_number, invoice_date || null, reverse_charge, supplier_state_name, supplier_state_code,
        bill_to_name, bill_to_address, bill_to_gstin, bill_to_state, bill_to_state_code,
        ship_to_name, ship_to_address, ship_to_gstin, ship_to_state, ship_to_state_code,
        building_name, ra_number, work_description, work_order_number, work_order_date || null, service_date_from || null, service_date_to || null,
        total_before_tax || 0, total_taxable_value || 0, total_cgst || 0, total_sgst || 0, round_off || 0,
        total_amount_after_tax || 0, gst_on_reverse_charge || 0, invoice_amount_words,
        bank_details, terms_and_conditions, authorised_signatory
      ]
    );

    const invoiceId = invResult.rows[0].invoice_id;

    if (items.length > 0) {
      const itemSql = `
        INSERT INTO hiranandani_invoice_items (
          invoice_id, sn, description, sac_code, value_of_supply, discount,
          taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount, line_total
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `;
      for (const item of items) {
        await client.query(itemSql, [
          invoiceId, item.sn, item.description, item.sac_code,
          item.value_of_supply || 0, item.discount || 0, item.taxable_value || 0,
          item.cgst_rate || 0, item.cgst_amount || 0,
          item.sgst_rate || 0, item.sgst_amount || 0, item.line_total || 0
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

    res.status(201).json(formatHiranandaniInvoiceRow(invResult.rows[0]));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create Hiranandani Invoice error:", err);
    if (err.code === "23505") {
      return res.status(409).json({ error: `Invoice number '${req.body.invoice_number}' already exists.` });
    }
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
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/HiranandaniInvoice'
 *       500:
 *         description: Server error
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM hiranandani_invoices ORDER BY created_at DESC");
    res.json(await attachCreatedUpdatedBy(result.rows.map(formatHiranandaniInvoiceRow), "hiranandani_invoice", (r) => r.invoice_id));
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
 *         description: The project ID
 *     responses:
 *       200:
 *         description: List of invoices for the project
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/HiranandaniInvoice'
 *       500:
 *         description: Server error
 */
router.get("/project/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const result = await pool.query(
      "SELECT * FROM hiranandani_invoices WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId]
    );
    res.json(await attachCreatedUpdatedBy(result.rows.map(formatHiranandaniInvoiceRow), "hiranandani_invoice", (r) => r.invoice_id));
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
 *         description: The invoice ID
 *     responses:
 *       200:
 *         description: Invoice details with items
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HiranandaniInvoice'
 *       404:
 *         description: Invoice not found
 *       500:
 *         description: Server error
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const invResult = await pool.query("SELECT * FROM hiranandani_invoices WHERE invoice_id = $1", [id]);
    if (invResult.rows.length === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    const itemResult = await pool.query(
      "SELECT * FROM hiranandani_invoice_items WHERE invoice_id = $1 ORDER BY sn NULLS LAST, item_id",
      [id]
    );
    const invoice = await attachCreatedUpdatedBy({
      ...formatHiranandaniInvoiceRow(invResult.rows[0]),
      items: itemResult.rows.map(formatHiranandaniInvoiceItemRow)
    }, "hiranandani_invoice", (r) => r.invoice_id);
    res.json(invoice);
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
 *         description: The invoice ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/HiranandaniInvoiceInput'
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
      company_name, project_id, company_address, company_phone, company_email, company_website,
      supplier_gstin, pan_number, pf_number, esic_number, ptr_number, mlwf_number,
      invoice_number, invoice_date, reverse_charge, supplier_state_name, supplier_state_code,
      bill_to_name, bill_to_address, bill_to_gstin, bill_to_state, bill_to_state_code,
      ship_to_name, ship_to_address, ship_to_gstin, ship_to_state, ship_to_state_code,
      building_name, ra_number, work_description,
      work_order_number, work_order_date, service_date_from, service_date_to,
      total_before_tax, total_taxable_value, total_cgst, total_sgst, round_off,
      total_amount_after_tax, gst_on_reverse_charge, invoice_amount_words,
      bank_details, terms_and_conditions, authorised_signatory,
      items = [], user_id, user_name
    } = normalizeHiranandaniInvoicePayload(req.body);

    const updateResult = await client.query(
      `UPDATE hiranandani_invoices SET
        project_id=$1, company_name=$2, company_address=$3, company_phone=$4, company_email=$5, company_website=$6,
        supplier_gstin=$7, pan_number=$8, pf_number=$9, esic_number=$10, ptr_number=$11, mlwf_number=$12,
        invoice_number=$13, invoice_date=$14, reverse_charge=$15, supplier_state_name=$16, supplier_state_code=$17,
        bill_to_name=$18, bill_to_address=$19, bill_to_gstin=$20, bill_to_state=$21, bill_to_state_code=$22,
        ship_to_name=$23, ship_to_address=$24, ship_to_gstin=$25, ship_to_state=$26, ship_to_state_code=$27,
        building_name=$28, ra_number=$29, work_description=$30, work_order_number=$31, work_order_date=$32, service_date_from=$33, service_date_to=$34,
        total_before_tax=$35, total_taxable_value=$36, total_cgst=$37, total_sgst=$38, round_off=$39,
        total_amount_after_tax=$40, gst_on_reverse_charge=$41, invoice_amount_words=$42,
        bank_details=$43, terms_and_conditions=$44, authorised_signatory=$45,
        updated_at=NOW()
      WHERE invoice_id = $46
      RETURNING *`,
      [
        project_id, company_name, company_address, company_phone, company_email, company_website,
        supplier_gstin, pan_number, pf_number, esic_number, ptr_number, mlwf_number,
        invoice_number, invoice_date || null, reverse_charge, supplier_state_name, supplier_state_code,
        bill_to_name, bill_to_address, bill_to_gstin, bill_to_state, bill_to_state_code,
        ship_to_name, ship_to_address, ship_to_gstin, ship_to_state, ship_to_state_code,
        building_name, ra_number, work_description, work_order_number, work_order_date || null, service_date_from || null, service_date_to || null,
        total_before_tax, total_taxable_value, total_cgst, total_sgst, round_off,
        total_amount_after_tax, gst_on_reverse_charge, invoice_amount_words,
        bank_details, terms_and_conditions, authorised_signatory,
        id
      ]
    );

    if (updateResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Invoice not found" });
    }

    // Replace items
    await client.query("DELETE FROM hiranandani_invoice_items WHERE invoice_id = $1", [id]);
    if (items.length > 0) {
      const itemSql = `
        INSERT INTO hiranandani_invoice_items (
          invoice_id, sn, description, sac_code, value_of_supply, discount,
          taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount, line_total
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `;
      for (const item of items) {
        await client.query(itemSql, [
          id, item.sn, item.description, item.sac_code,
          item.value_of_supply || 0, item.discount || 0, item.taxable_value || 0,
          item.cgst_rate || 0, item.cgst_amount || 0,
          item.sgst_rate || 0, item.sgst_amount || 0, item.line_total || 0
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
    console.error("Update Hiranandani Invoice error:", err);
    if (err.code === "23505") {
      return res.status(409).json({ error: `Invoice number '${req.body.invoice_number}' already exists.` });
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/hiranandani-invoice/:id/history — who created/updated/deleted this invoice, and when
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/hiranandani-invoice/{id}/history:
 *   get:
 *     summary: Get the create/update/delete history for a Hiranandani invoice (who did what, and when)
 *     tags: [Hiranandani Invoice]
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
 *         description: Activity history for this invoice
 */
router.get("/:id/history", async (req, res) => {
  try {
    const data = await getEntityHistory("hiranandani_invoice", req.params.id, {
      limit: req.query.limit, offset: req.query.offset,
    });
    res.json(data);
  } catch (err) {
    console.error("Error fetching Hiranandani invoice history:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
