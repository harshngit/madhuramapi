const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");
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

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Upload email attachments for a PR
// POST /api/pr/:id/upload-email-attachment
//
// multipart/form-data — field name: "files" (supports multiple files)
// Returns an array of { filePath, originalName } to pass into send-email
// ─────────────────────────────────────────────────────────────────────────────

const emailAttachmentDir = path.join(__dirname, "../../uploads/pr_email_attachments");
if (!fs.existsSync(emailAttachmentDir)) {
  fs.mkdirSync(emailAttachmentDir, { recursive: true });
}

const emailAttachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, emailAttachmentDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const uploadEmailAttachment = multer({ storage: emailAttachmentStorage });

/**
 * @swagger
 * /api/pr/{id}/upload-email-attachment:
 *   post:
 *     summary: Upload one or more attachments to be sent with the PR email
 *     tags: [PR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: PR ID
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               files:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: One or more files to attach to the email
 *     responses:
 *       200:
 *         description: Files uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 attachments:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       filePath:
 *                         type: string
 *                         example: /uploads/pr_email_attachments/1234567890-file.pdf
 *                       originalName:
 *                         type: string
 *                         example: quotation.pdf
 *       400:
 *         description: No files uploaded
 *       500:
 *         description: Server error
 */
router.post(
  "/:id/upload-email-attachment",
  uploadEmailAttachment.array("files", 10),
  async (req, res) => {
    const { id } = req.params;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded." });
    }

    try {
      // Save each file record to pr_email_attachments table
      const attachments = [];
      for (const file of req.files) {
        const filePath = `/uploads/pr_email_attachments/${file.filename}`;

        await pool.query(
          `INSERT INTO pr_email_attachments
             (pr_id, file_path, original_name, mime_type, size_bytes, uploaded_by_user_id, uploaded_by_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            filePath,
            file.originalname,
            file.mimetype,
            file.size,
            req.body.user_id   || null,
            req.body.user_name || null,
          ]
        );

        attachments.push({ filePath, originalName: file.originalname });
      }

      return res.status(200).json({
        message: `${attachments.length} file(s) uploaded successfully.`,
        attachments,
      });
    } catch (error) {
      console.error("Error saving email attachment record:", error);
      res.status(500).json({ error: error.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Send PR Email
// POST /api/pr/:id/send-email
//
// Request Body (JSON):
// {
//   "to"          : "approver@example.com",       // required
//   "cc"          : ["manager@company.com"],       // optional
//   "message"     : "Please review the PR.",       // optional
//   "attachments" : [                              // optional — from upload-email-attachment
//     {
//       "filePath"     : "/uploads/pr_email_attachments/abc.pdf",
//       "originalName" : "quotation.pdf"
//     }
//   ],
//   "user_id"     : "431534af-f94a-424d-bfad-157db4516ad1",  // optional — UUID string
//   "user_name"   : "Admin"                        // optional — for activity log
// }
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/pr/{id}/send-email:
 *   post:
 *     summary: Send PR details via email with optional attachments
 *     tags: [PR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: PR ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - to
 *             properties:
 *               to:
 *                 type: string
 *                 description: Recipient email address
 *                 example: approver@example.com
 *               cc:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: CC email addresses
 *                 example: ["manager@company.com"]
 *               message:
 *                 type: string
 *                 description: Custom message body (HTML supported)
 *                 example: "Please review the attached Purchase Requisition."
 *               attachments:
 *                 type: array
 *                 description: Files to attach — use filePath values returned by upload-email-attachment
 *                 items:
 *                   type: object
 *                   properties:
 *                     filePath:
 *                       type: string
 *                       example: /uploads/pr_email_attachments/1234567890-file.pdf
 *                     originalName:
 *                       type: string
 *                       example: quotation.pdf
 *               user_id:
 *                 type: string
 *                 description: User UUID
 *               user_name:
 *                 type: string
 *     responses:
 *       200:
 *         description: Email sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 messageId:
 *                   type: string
 *                 to:
 *                   type: string
 *                 cc:
 *                   type: array
 *                   items:
 *                     type: string
 *                 log_saved:
 *                   type: boolean
 *       400:
 *         description: Missing required fields
 *       404:
 *         description: PR not found
 *       500:
 *         description: Internal server error / email send failed
 */
router.post("/:id/send-email", async (req, res) => {
  const { id } = req.params;
  const { to, cc, message, attachments, user_id, user_name } = req.body;

  if (!to) {
    return res.status(400).json({ error: "Recipient email address ('to') is required." });
  }

  try {
    // 1. Fetch PR with items from DB
    const rows = await getPrList("pr.pr_id = $1", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "PR not found" });
    }
    const pr = rows[0];

    // 2. Build Nodemailer transporter
    //    Required .env vars:
    //      SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    // 3. Build HTML email body
    const formatDate = (d) => {
      if (!d) return "-";
      const dt = new Date(d);
      return isNaN(dt) ? d : dt.toLocaleDateString("en-IN");
    };

    let items = pr.items || [];
    if (typeof items === "string") {
      try { items = JSON.parse(items); } catch { items = []; }
    }

    const itemRows = items
      .map(
        (item, index) => `
        <tr>
          <td style="border:1px solid #ddd;padding:6px;text-align:center;">${index + 1}</td>
          <td style="border:1px solid #ddd;padding:6px;">${item.material_description ?? "-"}</td>
          <td style="border:1px solid #ddd;padding:6px;text-align:center;">${item.unit ?? "-"}</td>
          <td style="border:1px solid #ddd;padding:6px;text-align:center;">${item.req_qty ?? "-"}</td>
          <td style="border:1px solid #ddd;padding:6px;">${item.make ?? "-"}</td>
          <td style="border:1px solid #ddd;padding:6px;">${item.place_of_utilisation ?? "-"}</td>
        </tr>`
      )
      .join("");

    const customMessage = message
      ? `<p style="margin:12px 0;color:#333;">${message}</p>`
      : `<p style="margin:12px 0;color:#333;">Please find the attached Purchase Requisition for your review and approval.</p>`;

    const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;color:#222;max-width:700px;margin:auto;padding:20px;">

  <!-- Header -->
  <div style="background:#1a1a2e;padding:20px;border-radius:8px 8px 0 0;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:22px;">MADHURAM ENTERPRISES</h1>
  </div>

  <!-- PR Title Band -->
  <div style="background:#4a90d9;padding:10px;text-align:center;">
    <h2 style="color:#fff;margin:0;font-size:16px;letter-spacing:2px;">PURCHASE REQUISITION</h2>
  </div>

  <!-- PR Details -->
  <div style="background:#f5f7fa;padding:16px;border:1px solid #ddd;">
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td width="50%">
          <p style="margin:4px 0;font-size:13px;"><b>PR ID:</b> ${pr.pr_id}</p>
          <p style="margin:4px 0;font-size:13px;"><b>Project:</b> ${pr.project_name || "-"}</p>
          <p style="margin:4px 0;font-size:13px;"><b>Work Order No:</b> ${pr.workorder_no || "-"}</p>
          <p style="margin:4px 0;font-size:13px;"><b>Location:</b> ${pr.location || "-"}</p>
        </td>
        <td width="50%">
          <p style="margin:4px 0;font-size:13px;"><b>Date:</b> ${formatDate(pr.date)}</p>
          <p style="margin:4px 0;font-size:13px;"><b>MIR No:</b> ${pr.mirno || "-"}</p>
          <p style="margin:4px 0;font-size:13px;"><b>Urgency:</b> ${pr.urgency || "-"}</p>
          <p style="margin:4px 0;font-size:13px;"><b>Approved By:</b> ${pr.approved_by || "-"}</p>
        </td>
      </tr>
    </table>
  </div>

  <!-- Custom message -->
  <div style="padding:12px 16px;">
    ${customMessage}
  </div>

  <!-- Items Table -->
  <div style="padding:0 0 12px;">
    <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="background:#1a1a2e;color:#fff;">
          <th style="border:1px solid #555;padding:8px;text-align:center;">Sr</th>
          <th style="border:1px solid #555;padding:8px;">Material Description</th>
          <th style="border:1px solid #555;padding:8px;text-align:center;">Unit</th>
          <th style="border:1px solid #555;padding:8px;text-align:center;">Req. Qty</th>
          <th style="border:1px solid #555;padding:8px;">Make</th>
          <th style="border:1px solid #555;padding:8px;">Place of Utilisation</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>
  </div>

  <!-- Footer -->
  <div style="background:#1a1a2e;padding:14px;text-align:center;margin-top:20px;border-radius:0 0 8px 8px;">
    <p style="color:#aabbee;margin:0;font-size:11px;">MADHURAM ENTERPRISES — Purchase Requisition</p>
    <p style="color:#7788aa;margin:4px 0 0;font-size:10px;">This is a system-generated email. Please do not reply directly to this email.</p>
  </div>

</body>
</html>`;

    const emailSubject = `Purchase Requisition PR #${pr.pr_id} – ${pr.project_name || "Project"}`;

    // 4. Build attachments list for nodemailer
    //    Priority: user-supplied attachments array → fallback to pr_file_path on the PR record
    const nodemailerAttachments = [];

    if (Array.isArray(attachments) && attachments.length > 0) {
      for (const att of attachments) {
        if (!att.filePath) continue;
        const absolutePath = path.join(__dirname, "../../", att.filePath);
        if (fs.existsSync(absolutePath)) {
          nodemailerAttachments.push({
            filename:    att.originalName || path.basename(att.filePath),
            path:        absolutePath,
          });
        } else {
          console.warn(`Attachment not found on disk, skipping: ${absolutePath}`);
        }
      }
    } else if (pr.pr_file_path) {
      // fallback: attach the PR's own document if no explicit attachments provided
      const absolutePath = path.join(__dirname, "../../", pr.pr_file_path);
      if (fs.existsSync(absolutePath)) {
        nodemailerAttachments.push({
          filename: path.basename(pr.pr_file_path),
          path:     absolutePath,
        });
      }
    }

    // 5. Send email
    const mailOptions = {
      from:        process.env.SMTP_FROM || process.env.SMTP_USER,
      to:          to,
      cc:          cc && cc.length > 0 ? cc.join(",") : undefined,
      subject:     emailSubject,
      html:        htmlBody,
      attachments: nodemailerAttachments,
    };

    let emailStatus     = "sent";
    let emailError      = null;
    let nodemailerMsgId = null;

    try {
      const info = await transporter.sendMail(mailOptions);
      nodemailerMsgId = info.messageId;
    } catch (sendErr) {
      emailStatus = "failed";
      emailError  = sendErr.message;
      console.error("Nodemailer send error:", sendErr);
    }

    // 6. Save email log to DB (always — even on failure)
    const attachmentPaths = nodemailerAttachments.map((a) => path.basename(a.path));
    try {
      await pool.query(
        `INSERT INTO pr_email_logs (
          pr_id, sent_to, cc_addresses, subject, custom_message,
          attachment_names, status, error_message, nodemailer_msg_id,
          sent_by_user_id, sent_by_name
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          to,
          cc && cc.length > 0 ? cc : null,
          emailSubject,
          message || null,
          attachmentPaths.length > 0 ? attachmentPaths : null,
          emailStatus,
          emailError,
          nodemailerMsgId,
          user_id   || null,
          user_name || null,
        ]
      );
    } catch (dbErr) {
      console.error("Warning: could not save email log to DB:", dbErr.message);
    }

    // 7. Activity log
    logActivity({
      action:            emailStatus === "sent" ? "email_sent" : "email_failed",
      entity_type:       "pr",
      entity_id:         id,
      entity_name:       `PR #${pr.pr_id}`,
      performed_by:      user_id   || null,
      performed_by_name: user_name || null,
      meta: { to, cc, nodemailerMsgId, status: emailStatus, attachments: attachmentPaths },
    });

    // 8. Respond
    if (emailStatus === "failed") {
      return res.status(500).json({
        error:   "Email sending failed. Details saved to log.",
        details: emailError,
      });
    }

    return res.status(200).json({
      message:     "Email sent successfully",
      messageId:   nodemailerMsgId,
      to,
      cc:          cc || [],
      attachments: attachmentPaths,
      log_saved:   true,
    });

  } catch (error) {
    console.error("Error in PR send-email route:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Get email logs for a PR
// GET /api/pr/:id/email-logs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/pr/{id}/email-logs:
 *   get:
 *     summary: Get all email send history for a PR (optionally filtered by user)
 *     tags: [PR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: PR ID
 *       - in: query
 *         name: user_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter logs by user ID
 *     responses:
 *       200:
 *         description: List of email logs
 *       500:
 *         description: Internal server error
 */
router.get("/:id/email-logs", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.query;
  try {
    let query = `
      SELECT
        log_id, pr_id, sent_to, cc_addresses, subject,
        custom_message, attachment_names, status, error_message,
        nodemailer_msg_id, sent_by_user_id, sent_by_name, sent_at
      FROM pr_email_logs
      WHERE pr_id = $1
    `;
    const params = [id];

    if (user_id) {
      query += ` AND sent_by_user_id = $2`;
      params.push(user_id);
    }

    query += ` ORDER BY sent_at DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching PR email logs:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;