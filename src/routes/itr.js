const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { logActivity } = require("./dashboard");

// ─── Upload Directory Setup ───────────────────────────────────────────────────
const uploadDir = path.join(__dirname, "../../uploads/itr");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// ─── Helpers ──────────────────────────────────────────────────────────────────
const toJson = (val, fallback = {}) =>
  JSON.stringify(val !== undefined && val !== null ? val : fallback);

const getItrRefNo = (itr_header) =>
  itr_header && typeof itr_header === "object" ? itr_header.itr_ref_no || null : null;

// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * tags:
 *   name: ITR
 *   description: Inspection Test Request management
 */

// =============================================================================
// STAFF ROUTES
// =============================================================================

/**
 * @swagger
 * /api/itr/staff:
 *   get:
 *     summary: Get all staff members
 *     tags: [ITR]
 *     responses:
 *       200:
 *         description: List of all staff
 *       500:
 *         description: Internal server error
 */
router.get("/staff", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM staff ORDER BY staff_name ASC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching staff:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/itr/staff:
 *   post:
 *     summary: Create a new staff member
 *     tags: [ITR]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - staff_name
 *               - staff_number
 *             properties:
 *               staff_name:
 *                 type: string
 *                 example: "Ravi Kumar"
 *               staff_number:
 *                 type: string
 *                 example: "STF-001"
 *     responses:
 *       201:
 *         description: Staff created successfully
 *       400:
 *         description: staff_name and staff_number are required
 *       500:
 *         description: Internal server error
 */
router.post("/staff", async (req, res) => {
  const { staff_name, staff_number } = req.body;

  if (!staff_name || !staff_number) {
    return res.status(400).json({ error: "staff_name and staff_number are required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO staff (staff_name, staff_number)
       VALUES ($1, $2) RETURNING *`,
      [staff_name, staff_number]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error creating staff:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/itr/staff/{id}:
 *   put:
 *     summary: Update a staff member
 *     tags: [ITR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               staff_name:   { type: string, example: "Ravi Kumar" }
 *               staff_number: { type: string, example: "STF-001" }
 *     responses:
 *       200:
 *         description: Staff updated successfully
 *       400:
 *         description: No fields to update
 *       404:
 *         description: Staff not found
 *       500:
 *         description: Internal server error
 */
router.put("/staff/:id", async (req, res) => {
  const { id } = req.params;
  const { staff_name, staff_number } = req.body;

  try {
    const fields = [];
    const values = [];
    let c = 1;

    if (staff_name   !== undefined) { fields.push(`staff_name = $${c++}`);   values.push(staff_name); }
    if (staff_number !== undefined) { fields.push(`staff_number = $${c++}`); values.push(staff_number); }

    if (fields.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    fields.push("updated_at = CURRENT_TIMESTAMP");
    values.push(id);

    const result = await pool.query(
      `UPDATE staff SET ${fields.join(", ")} WHERE staff_id = $${c} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Staff not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating staff:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/itr/staff/{id}:
 *   delete:
 *     summary: Delete a staff member
 *     tags: [ITR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Staff deleted successfully
 *       404:
 *         description: Staff not found
 *       500:
 *         description: Internal server error
 */
router.delete("/staff/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "DELETE FROM staff WHERE staff_id = $1 RETURNING *",
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Staff not found" });
    }
    res.json({ message: "Staff deleted successfully" });
  } catch (error) {
    console.error("Error deleting staff:", error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// FILE UPLOAD
// =============================================================================

/**
 * @swagger
 * /api/itr/upload:
 *   post:
 *     summary: Upload a file for ITR
 *     tags: [ITR]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:      { type: string, format: binary }
 *               user_id:   { type: integer }
 *               user_name: { type: string }
 *     responses:
 *       200:
 *         description: File uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 filePath: { type: string }
 *       400:
 *         description: No file uploaded
 */
router.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const filePath = `/uploads/itr/${req.file.filename}`;
  res.json({ filePath });

  if (req.body.user_id) {
    logActivity({
      action: "uploaded",
      entity_type: "itr_file",
      entity_id: null,
      entity_name: req.file.originalname,
      performed_by: req.body.user_id,
      performed_by_name: req.body.user_name || null,
      meta: { filePath },
    });
  }
});

// =============================================================================
// CREATE ITR  —  POST /api/itr
// =============================================================================

/**
 * @swagger
 * /api/itr:
 *   post:
 *     summary: Create a new ITR
 *     tags: [ITR]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - project_id
 *             properties:
 *               project_id:
 *                 type: integer
 *                 example: 5
 *
 *               project_info:
 *                 type: object
 *                 properties:
 *                   project_name:    { type: string, example: "ANJUR CASA MAGNOLIA C PLUMBING" }
 *                   project_code:    { type: string, example: "MAG-C-PL" }
 *                   client_employer: { type: string, example: "COWTOWN INFOTECH SERVICES PRIVATE LIMITED" }
 *                   pmc_engineer:    { type: string, example: "John Engineer" }
 *                   contractor:      { type: string, example: "MADHURAM ENTERPRISES" }
 *                   vendor_code:     { type: string, example: "30010937" }
 *                   material_code:   { type: string, example: "995462" }
 *                   work_order_no:   { type: string, example: "6100019853" }
 *
 *               itr_header:
 *                 type: object
 *                 properties:
 *                   itr_ref_no:          { type: string, example: "UT-WIR-EWS-MAG C-MADH-PL-32" }
 *                   rev_no:              { type: string, example: "00" }
 *                   submission_datetime: { type: string, example: "2024-06-15T10:30:00+05:30" }
 *                   inspection_datetime: { type: string, example: "2024-06-16T09:00:00+05:30" }
 *                   submitted_to:        { type: string, example: "LODHA PMC" }
 *                   submitted_by:        { type: string, example: "MADHURAM ENTERPRISES" }
 *
 *               location:
 *                 type: object
 *                 properties:
 *                   tower_block_ref: { type: string, example: "MAGNOLIA C" }
 *                   floor_level:     { type: string, example: "ALL FLR" }
 *                   room_area_ref:   { type: string, example: "" }
 *                   grid_reference:  { type: string, example: "" }
 *
 *               discipline:
 *                 type: string
 *                 enum: [SURVEYING, STRUCTURAL_CIVIL, MECHANICAL, ARCH_FINISHING, ELECTRICAL, LANDSCAPE, PLUMBING, FACADE, OTHERS, ID]
 *                 example: "PLUMBING"
 *
 *               quantity:
 *                 type: object
 *                 properties:
 *                   previous_qty: { type: number, example: 0 }
 *                   current_qty:  { type: number, example: 153 }
 *                   unit:         { type: string, example: "NOS" }
 *
 *               description_of_work:
 *                 type: string
 *                 example: "CP INSTALLATION DONE"
 *
 *               work_items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     item_description: { type: string, example: "UPVC BALL VALVE" }
 *                     size:             { type: string, example: "20MM" }
 *                     quantity:         { type: number, example: 11 }
 *                     unit:             { type: string, example: "NOS" }
 *
 *               shaft_details:
 *                 type: array
 *                 description: Each shaft entry includes assigned staff + valve quantities
 *                 items:
 *                   type: object
 *                   properties:
 *                     shaft_no:
 *                       type: integer
 *                       example: 1
 *                     staff_id:     { type: integer, example: 1 }
 *                     staff_name:   { type: string,  example: "Ravi Kumar" }
 *                     staff_number: { type: string,  example: "STF-001" }
 *
 *               attachments:
 *                 type: object
 *                 properties:
 *                   drawing_attached:           { type: string, enum: [YES, NO, NA], example: "NO" }
 *                   drawing_ref_no:             { type: string, example: "" }
 *                   method_statement_attached:  { type: string, enum: [YES, NO, NA], example: "YES" }
 *                   test_certificates_attached: { type: string, enum: [YES, NO, NA], example: "NO" }
 *                   checklist_attached:         { type: string, enum: [YES, NO, NA], example: "YES" }
 *                   joint_measurement_attached: { type: string, enum: [YES, NO, NA], example: "NA" }
 *
 *               part_a_contractor:
 *                 type: object
 *                 properties:
 *                   comments:                  { type: string, example: "Work completed as per drawing." }
 *                   ready_for_inspection_date: { type: string, example: "2024-06-15" }
 *                   ready_for_inspection_time: { type: string, example: "10:30" }
 *                   signed_by:                 { type: string, example: "MADHURAM ENTERPRISES" }
 *                   other_section_signoffs:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         section:       { type: string, example: "MEP Clearance" }
 *                         name:          { type: string, example: "" }
 *                         designation:   { type: string, example: "" }
 *                         signed_date:   { type: string, example: "" }
 *                         signature_url: { type: string, example: "" }
 *                         comments:      { type: string, example: "" }
 *
 *               part_b_lodha_pmc:
 *                 type: object
 *                 properties:
 *                   comments:        { type: string, example: "" }
 *                   inspection_code: { type: string, enum: [CODE_1, CODE_2, CODE_3, CODE_4], example: "" }
 *                   signoffs:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         role:          { type: string, example: "Engineer/Manager-CIVIL" }
 *                         name:          { type: string, example: "" }
 *                         signature_url: { type: string, example: "" }
 *                         signed_date:   { type: string, example: "" }
 *
 *               status:
 *                 type: string
 *                 enum: [DRAFT, SUBMITTED, UNDER_INSPECTION, APPROVED, REJECTED, RESUBMITTED, CLOSED]
 *                 example: "SUBMITTED"
 *
 *               allowed_values:
 *                 type: object
 *                 properties:
 *                   discipline:
 *                     type: array
 *                     example: [SURVEYING, STRUCTURAL_CIVIL, MECHANICAL, ARCH_FINISHING, ELECTRICAL, LANDSCAPE, PLUMBING, FACADE, OTHERS, ID]
 *                   status:
 *                     type: array
 *                     example: [DRAFT, SUBMITTED, UNDER_INSPECTION, APPROVED, REJECTED, RESUBMITTED, CLOSED]
 *                   attachments:
 *                     type: array
 *                     example: [YES, NO, NA]
 *                   inspection_code:
 *                     type: object
 *                     properties:
 *                       CODE_1: { type: string, example: "Work may proceed" }
 *                       CODE_2: { type: string, example: "Conditionally approved. Work may proceed and resubmit incorporating comments" }
 *                       CODE_3: { type: string, example: "Revise and Resubmit. Work may NOT proceed" }
 *                       CODE_4: { type: string, example: "For information and records only. Work may proceed" }
 *
 *               user_id:   { type: integer, example: 1 }
 *               user_name: { type: string,  example: "Admin User" }
 *
 *     responses:
 *       201:
 *         description: ITR created successfully
 *       400:
 *         description: project_id is required
 *       500:
 *         description: Internal server error
 */
router.post("/", async (req, res) => {
  const {
    project_id,
    project_info,
    itr_header,
    location,
    discipline,
    quantity,
    description_of_work,
    work_items,
    shaft_details,
    attachments,
    part_a_contractor,
    part_b_lodha_pmc,
    status,
    allowed_values,
    user_id,
    user_name,
  } = req.body;

  try {
    if (!project_id) {
      return res.status(400).json({ error: "project_id is required" });
    }

    const itrRefNo = getItrRefNo(itr_header);

    const result = await pool.query(
      `INSERT INTO itrs (
        project_id, project_info, itr_header, location, discipline,
        quantity, description_of_work, work_items, shaft_details,
        attachments, part_a_contractor, part_b_lodha_pmc,
        status, allowed_values, itr_ref_no
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *`,
      [
        project_id,
        toJson(project_info),
        toJson(itr_header),
        toJson(location),
        discipline || null,
        toJson(quantity),
        description_of_work || null,
        toJson(work_items, []),
        toJson(shaft_details, []),
        toJson(attachments),
        toJson(part_a_contractor),
        toJson(part_b_lodha_pmc),
        status || "DRAFT",
        toJson(allowed_values),
        itrRefNo,
      ]
    );

    res.status(201).json(result.rows[0]);

    logActivity({
      action: "created",
      entity_type: "itr",
      entity_id: result.rows[0].itr_id,
      entity_name: itrRefNo || `ITR #${result.rows[0].itr_id}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      project_id,
      meta: { itr_ref_no: itrRefNo, status },
    });
  } catch (error) {
    console.error("Error creating ITR:", error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// GET ALL ITRs BY PROJECT  —  GET /api/itr/project/:projectId
// =============================================================================

/**
 * @swagger
 * /api/itr/project/{projectId}:
 *   get:
 *     summary: Get all ITRs for a specific project
 *     tags: [ITR]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of ITRs
 *       500:
 *         description: Internal server error
 */
router.get("/project/:projectId", async (req, res) => {
  const { projectId } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM itrs WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching ITRs:", error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// GET SINGLE ITR  —  GET /api/itr/:id
// =============================================================================

/**
 * @swagger
 * /api/itr/{id}:
 *   get:
 *     summary: Get a single ITR by ID
 *     tags: [ITR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: ITR details
 *       404:
 *         description: ITR not found
 *       500:
 *         description: Internal server error
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM itrs WHERE itr_id = $1",
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "ITR not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching ITR:", error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// UPDATE ITR  —  PUT /api/itr/:id
// =============================================================================

/**
 * @swagger
 * /api/itr/{id}:
 *   put:
 *     summary: Update an existing ITR (send only the fields you want to change)
 *     tags: [ITR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               project_info:        { type: object }
 *               itr_header:          { type: object }
 *               location:            { type: object }
 *               discipline:          { type: string }
 *               quantity:            { type: object }
 *               description_of_work: { type: string }
 *               work_items:          { type: array, items: { type: object } }
 *               shaft_details:       { type: array, items: { type: object } }
 *               attachments:         { type: object }
 *               part_a_contractor:   { type: object }
 *               part_b_lodha_pmc:    { type: object }
 *               status:              { type: string }
 *               allowed_values:      { type: object }
 *               user_id:             { type: integer }
 *               user_name:           { type: string }
 *     responses:
 *       200:
 *         description: ITR updated successfully
 *       400:
 *         description: No fields to update
 *       404:
 *         description: ITR not found
 *       500:
 *         description: Internal server error
 */
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const {
    project_info,
    itr_header,
    location,
    discipline,
    quantity,
    description_of_work,
    work_items,
    shaft_details,
    attachments,
    part_a_contractor,
    part_b_lodha_pmc,
    status,
    allowed_values,
    user_id,
    user_name,
  } = req.body;

  try {
    const fields = [];
    const values = [];
    let c = 1;

    const push = (col, val) => { fields.push(`${col} = $${c++}`); values.push(val); };

    if (project_info        !== undefined) push("project_info",        toJson(project_info));
    if (itr_header          !== undefined) {
      push("itr_header",  toJson(itr_header));
      push("itr_ref_no",  getItrRefNo(itr_header));
    }
    if (location            !== undefined) push("location",            toJson(location));
    if (discipline          !== undefined) push("discipline",          discipline || null);
    if (quantity            !== undefined) push("quantity",            toJson(quantity));
    if (description_of_work !== undefined) push("description_of_work", description_of_work || null);
    if (work_items          !== undefined) push("work_items",          toJson(work_items, []));
    if (shaft_details       !== undefined) push("shaft_details",       toJson(shaft_details, []));
    if (attachments         !== undefined) push("attachments",         toJson(attachments));
    if (part_a_contractor   !== undefined) push("part_a_contractor",   toJson(part_a_contractor));
    if (part_b_lodha_pmc    !== undefined) push("part_b_lodha_pmc",    toJson(part_b_lodha_pmc));
    if (status              !== undefined) push("status",              status || null);
    if (allowed_values      !== undefined) push("allowed_values",      toJson(allowed_values));

    if (fields.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    fields.push("updated_at = CURRENT_TIMESTAMP");
    values.push(id);

    const result = await pool.query(
      `UPDATE itrs SET ${fields.join(", ")} WHERE itr_id = $${c} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "ITR not found" });
    }

    res.json(result.rows[0]);

    logActivity({
      action: "updated",
      entity_type: "itr",
      entity_id: id,
      entity_name: `ITR #${id}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      project_id: result.rows[0].project_id,
      meta: { updates: req.body },
    });
  } catch (error) {
    console.error("Error updating ITR:", error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// PATCH STATUS  —  PATCH /api/itr/:id/status
// =============================================================================

/**
 * @swagger
 * /api/itr/{id}/status:
 *   patch:
 *     summary: Update only the status and inspection code of an ITR
 *     tags: [ITR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [DRAFT, SUBMITTED, UNDER_INSPECTION, APPROVED, REJECTED, RESUBMITTED, CLOSED]
 *                 example: "APPROVED"
 *               inspection_code:
 *                 type: string
 *                 enum: [CODE_1, CODE_2, CODE_3, CODE_4]
 *                 example: "CODE_1"
 *               lodha_pmc_comments:
 *                 type: string
 *                 example: "Inspection passed. Work may proceed."
 *               user_id:   { type: integer }
 *               user_name: { type: string }
 *     responses:
 *       200:
 *         description: Status updated
 *       400:
 *         description: status is required
 *       404:
 *         description: ITR not found
 *       500:
 *         description: Internal server error
 */
router.patch("/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status, inspection_code, lodha_pmc_comments, user_id, user_name } = req.body;

  if (!status) {
    return res.status(400).json({ error: "status is required" });
  }

  try {
    const existing = await pool.query(
      "SELECT part_b_lodha_pmc FROM itrs WHERE itr_id = $1",
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "ITR not found" });
    }

    const partB = existing.rows[0].part_b_lodha_pmc || {};
    if (inspection_code)    partB.inspection_code = inspection_code;
    if (lodha_pmc_comments) partB.comments        = lodha_pmc_comments;

    const result = await pool.query(
      `UPDATE itrs
       SET status = $1, part_b_lodha_pmc = $2, updated_at = CURRENT_TIMESTAMP
       WHERE itr_id = $3 RETURNING *`,
      [status, JSON.stringify(partB), id]
    );

    res.json(result.rows[0]);

    logActivity({
      action: "status_updated",
      entity_type: "itr",
      entity_id: id,
      entity_name: `ITR #${id}`,
      performed_by: user_id || null,
      performed_by_name: user_name || null,
      project_id: result.rows[0].project_id,
      meta: { status, inspection_code },
    });
  } catch (error) {
    console.error("Error updating ITR status:", error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// DELETE ITR  —  DELETE /api/itr/:id
// =============================================================================

/**
 * @swagger
 * /api/itr/{id}:
 *   delete:
 *     summary: Delete an ITR
 *     tags: [ITR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: ITR deleted successfully
 *       404:
 *         description: ITR not found
 *       500:
 *         description: Internal server error
 */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "DELETE FROM itrs WHERE itr_id = $1 RETURNING *",
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "ITR not found" });
    }
    res.json({ message: "ITR deleted successfully" });

    logActivity({
      action: "deleted",
      entity_type: "itr",
      entity_id: id,
      entity_name: `ITR #${id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: {},
    });
  } catch (error) {
    console.error("Error deleting ITR:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;