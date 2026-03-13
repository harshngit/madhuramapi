const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { logActivity } = require("./dashboard");

const uploadDir = path.join(__dirname, "../../uploads/pr");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const signatureUploadDir = path.join(__dirname, "../../uploads/pr_signatu res");
if (!fs.existsSync(signatureUploadDir)) {
  fs.mkdirSync(signatureUploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const signatureStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, signatureUploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage });
const uploadSignature = multer({ storage: signatureStorage });

/**
 * @swagger
 * tags:
 *   name: PR
 *   description: Purchase Requisition management
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     PRItem:
 *       type: object
 *       properties:
 *         pr_item_id:
 *           type: integer
 *         material_description:
 *           type: string
 *         unit:
 *           type: string
 *         req_qty:
 *           type: number
 *         make:
 *           type: string
 *         place_of_utilisation:
 *           type: string
 *     PR:
 *       type: object
 *       properties:
 *         pr_id:
 *           type: integer
 *         project_id:
 *           type: integer
 *         sample_id:
 *           type: integer
 *         project_name:
 *           type: string
 *         workorder_no:
 *           type: string
 *         location:
 *           type: string
 *         mirno:
 *           type: string
 *         urgency:
 *           type: string
 *         date:
 *           type: string
 *           format: date
 *         approved_by:
 *           type: string
 *         pr_file_path:
 *           type: string
 *         signature_file_path:
 *           type: string
 *         created_at:
 *           type: string
 *           format: date-time
 *         updated_at:
 *           type: string
 *           format: date-time
 *         items:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/PRItem'
 */

/**
 * @swagger
 * /api/pr/upload:
 *   post:
 *     summary: Upload PR document
 *     tags: [PR]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: File uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 filePath:
 *                   type: string
 *       400:
 *         description: No file uploaded
 */
router.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const filePath = `/uploads/pr/${req.file.filename}`;
  res.json({ filePath });

  if (req.body.user_id) {
    logActivity({
      action: "uploaded",
      entity_type: "pr_file",
      entity_id: null,
      entity_name: req.file.originalname,
      performed_by: req.body.user_id,
      performed_by_name: req.body.user_name || null,
      meta: { filePath },
    });
  }
});

/**
 * @swagger
 * /api/pr/upload-signature:
 *   post:
 *     summary: Upload authorized signature for PR
 *     tags: [PR]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Signature uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 filePath:
 *                   type: string
 *       400:
 *         description: No file uploaded
 */
router.post("/upload-signature", uploadSignature.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const filePath = `/uploads/pr_signatures/${req.file.filename}`;
  res.json({ filePath });

  if (req.body.user_id) {
    logActivity({
      action: "uploaded",
      entity_type: "pr_signature",
      entity_id: null,
      entity_name: req.file.originalname,
      performed_by: req.body.user_id,
      performed_by_name: req.body.user_name || null,
      meta: { filePath },
    });
  }
});

async function insertItems(client, prId, items) {
  if (!Array.isArray(items) || items.length === 0) return;

  const values = [];
  const placeholders = [];
  let p = 1;

  for (const item of items) {
    values.push(
      prId,
      item.material_description || null,
      item.unit || null,
      item.req_qty ?? item["req.qty"] ?? item.reqQty ?? null,
      item.make || null,
      item.place_of_utilisation || item.place_of_utilization || null
    );
    placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
  }

  await client.query(
    `INSERT INTO purchase_requisition_items
      (pr_id, material_description, unit, req_qty, make, place_of_utilisation)
     VALUES ${placeholders.join(", ")}`,
    values
  );
}

/**
 * @swagger
 * /api/pr:
 *   post:
 *     summary: Create a new PR
 *     tags: [PR]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [project_id, project_name, items]
 *             properties:
 *               project_id:
 *                 type: integer
 *               sample_id:
 *                 type: integer
 *               project_name:
 *                 type: string
 *               workorder_no:
 *                 type: string
 *               location:
 *                 type: string
 *               mirno:
 *                 type: string
 *               urgency:
 *                 type: string
 *               date:
 *                 type: string
 *                 format: date
 *               approved_by:
 *                 type: string
 *               pr_file_path:
 *                 type: string
 *               signature_file_path:
 *                 type: string
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     material_description:
 *                       type: string
 *                     unit:
 *                       type: string
 *                     req_qty:
 *                       type: number
 *                     make:
 *                       type: string
 *                     place_of_utilisation:
 *                       type: string
 *     responses:
 *       201:
 *         description: PR created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PR'
 *       400:
 *         description: Bad request
 *       500:
 *         description: Server error
 */
router.post("/", async (req, res) => {
  const {
    project_id,
    sample_id,
    project_name,
    workorder_no,
    location,
    mirno,
    urgency,
    date,
    items,
    approved_by,
    pr_file_path,
    signature_file_path,
  } = req.body;

  if (!project_id || !project_name) {
    return res.status(400).json({ error: "project_id and project_name are required" });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items is required and must be a non-empty array" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const headerRes = await client.query(
      `INSERT INTO purchase_requisitions
        (project_id, sample_id, project_name, workorder_no, location, mirno, urgency, date, approved_by, pr_file_path, signature_file_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        project_id,
        sample_id || null,
        project_name,
        workorder_no || null,
        location || null,
        mirno || null,
        urgency || null,
        date || null,
        approved_by || null,
        pr_file_path || null,
        signature_file_path || null,
      ]
    );

    const pr = headerRes.rows[0];
    await insertItems(client, pr.pr_id, items);

    const prWithItemsRes = await client.query(
      `SELECT
        pr.*,
        COALESCE(
          json_agg(
            json_build_object(
              'pr_item_id', pri.pr_item_id,
              'material_description', pri.material_description,
              'unit', pri.unit,
              'req_qty', pri.req_qty,
              'make', pri.make,
              'place_of_utilisation', pri.place_of_utilisation
            )
          ) FILTER (WHERE pri.pr_item_id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM purchase_requisitions pr
      LEFT JOIN purchase_requisition_items pri ON pri.pr_id = pr.pr_id
      WHERE pr.pr_id = $1
      GROUP BY pr.pr_id`,
      [pr.pr_id]
    );

    await client.query("COMMIT");
    res.status(201).json(prWithItemsRes.rows[0]);

    logActivity({
      action: "created",
      entity_type: "pr",
      entity_id: pr.pr_id,
      entity_name: `PR #${pr.pr_id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id,
      meta: { sample_id: sample_id || null },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating PR:", error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

async function getPrList(whereSql, params) {
  const sql = `
    SELECT
      pr.*,
      COALESCE(
        json_agg(
          json_build_object(
            'pr_item_id', pri.pr_item_id,
            'material_description', pri.material_description,
            'unit', pri.unit,
            'req_qty', pri.req_qty,
            'make', pri.make,
            'place_of_utilisation', pri.place_of_utilisation
          )
          ORDER BY pri.pr_item_id ASC
        ) FILTER (WHERE pri.pr_item_id IS NOT NULL),
        '[]'::json
      ) AS items
    FROM purchase_requisitions pr
    LEFT JOIN purchase_requisition_items pri ON pri.pr_id = pr.pr_id
    ${whereSql ? `WHERE ${whereSql}` : ""}
    GROUP BY pr.pr_id
    ORDER BY pr.created_at DESC, pr.pr_id DESC
  `;
  const result = await pool.query(sql, params);
  return result.rows;
}

/**
 * @swagger
 * /api/pr:
 *   get:
 *     summary: List all PR
 *     tags: [PR]
 *     responses:
 *       200:
 *         description: List of PR
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/PR'
 *       500:
 *         description: Server error
 */
router.get("/", async (req, res) => {
  try {
    const rows = await getPrList("", []);
    res.json(rows);
  } catch (error) {
    console.error("Error listing PR:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/pr/project/{projectId}:
 *   get:
 *     summary: List PR by project_id
 *     tags: [PR]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of PR
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/PR'
 *       500:
 *         description: Server error
 */
router.get("/project/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const rows = await getPrList("pr.project_id = $1", [projectId]);
    res.json(rows);
  } catch (error) {
    console.error("Error listing PR by project:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/pr/sample/{sampleId}:
 *   get:
 *     summary: List PR by sample_id
 *     tags: [PR]
 *     parameters:
 *       - in: path
 *         name: sampleId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of PR
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/PR'
 *       500:
 *         description: Server error
 */
router.get("/sample/:sampleId", async (req, res) => {
  try {
    const { sampleId } = req.params;
    const rows = await getPrList("pr.sample_id = $1", [sampleId]);
    res.json(rows);
  } catch (error) {
    console.error("Error listing PR by sample:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/pr/{id}:
 *   get:
 *     summary: Get PR by id
 *     tags: [PR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: PR details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PR'
 *       404:
 *         description: PR not found
 *       500:
 *         description: Server error
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await getPrList("pr.pr_id = $1", [id]);
    if (rows.length === 0) return res.status(404).json({ error: "PR not found" });
    res.json(rows[0]);
  } catch (error) {
    console.error("Error fetching PR:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/pr/{id}:
 *   put:
 *     summary: Update PR
 *     tags: [PR]
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
 *             properties:
 *               project_name:
 *                 type: string
 *               workorder_no:
 *                 type: string
 *               location:
 *                 type: string
 *               mirno:
 *                 type: string
 *               urgency:
 *                 type: string
 *               date:
 *                 type: string
 *                 format: date
 *               approved_by:
 *                 type: string
 *               pr_file_path:
 *                 type: string
 *               signature_file_path:
 *                 type: string
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *     responses:
 *       200:
 *         description: PR updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PR'
 *       404:
 *         description: PR not found
 *       500:
 *         description: Server error
 */
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const {
    project_name,
    workorder_no,
    location,
    mirno,
    urgency,
    date,
    items,
    approved_by,
    pr_file_path,
    signature_file_path,
    sample_id,
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const fields = [];
    const values = [];
    let c = 1;

    if (project_name !== undefined) {
      fields.push(`project_name = $${c++}`);
      values.push(project_name);
    }
    if (workorder_no !== undefined) {
      fields.push(`workorder_no = $${c++}`);
      values.push(workorder_no);
    }
    if (location !== undefined) {
      fields.push(`location = $${c++}`);
      values.push(location);
    }
    if (mirno !== undefined) {
      fields.push(`mirno = $${c++}`);
      values.push(mirno);
    }
    if (urgency !== undefined) {
      fields.push(`urgency = $${c++}`);
      values.push(urgency);
    }
    if (date !== undefined) {
      fields.push(`date = $${c++}`);
      values.push(date);
    }
    if (approved_by !== undefined) {
      fields.push(`approved_by = $${c++}`);
      values.push(approved_by);
    }
    if (pr_file_path !== undefined) {
      fields.push(`pr_file_path = $${c++}`);
      values.push(pr_file_path);
    }
    if (signature_file_path !== undefined) {
      fields.push(`signature_file_path = $${c++}`);
      values.push(signature_file_path);
    }
    if (sample_id !== undefined) {
      fields.push(`sample_id = $${c++}`);
      values.push(sample_id || null);
    }

    fields.push("updated_at = CURRENT_TIMESTAMP");

    values.push(id);
    const updateSql = `UPDATE purchase_requisitions SET ${fields.join(
      ", "
    )} WHERE pr_id = $${c} RETURNING *`;

    const headerRes = await client.query(updateSql, values);
    if (headerRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "PR not found" });
    }

    if (items !== undefined) {
      await client.query("DELETE FROM purchase_requisition_items WHERE pr_id = $1", [
        id,
      ]);
      await insertItems(client, id, items);
    }

    const prWithItemsRes = await client.query(
      `SELECT
        pr.*,
        COALESCE(
          json_agg(
            json_build_object(
              'pr_item_id', pri.pr_item_id,
              'material_description', pri.material_description,
              'unit', pri.unit,
              'req_qty', pri.req_qty,
              'make', pri.make,
              'place_of_utilisation', pri.place_of_utilisation
            )
          ) FILTER (WHERE pri.pr_item_id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM purchase_requisitions pr
      LEFT JOIN purchase_requisition_items pri ON pri.pr_id = pr.pr_id
      WHERE pr.pr_id = $1
      GROUP BY pr.pr_id`,
      [id]
    );

    await client.query("COMMIT");
    res.json(prWithItemsRes.rows[0]);

    logActivity({
      action: "updated",
      entity_type: "pr",
      entity_id: Number(id),
      entity_name: `PR #${id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: headerRes.rows[0].project_id,
      meta: { updates: req.body },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating PR:", error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

/**
 * @swagger
 * /api/pr/{id}:
 *   delete:
 *     summary: Delete PR
 *     tags: [PR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: PR deleted successfully
 *       404:
 *         description: PR not found
 *       500:
 *         description: Server error
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "DELETE FROM purchase_requisitions WHERE pr_id = $1 RETURNING pr_id",
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "PR not found" });
    res.json({ message: "PR deleted successfully" });

    logActivity({
      action: "deleted",
      entity_type: "pr",
      entity_id: Number(id),
      entity_name: `PR #${id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      meta: {},
    });
  } catch (error) {
    console.error("Error deleting PR:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

