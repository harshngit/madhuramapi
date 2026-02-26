const express = require("express");
const router = express.Router();
const { pool } = require("../db");

/**
 * @swagger
 * tags:
 *   name: DeliveryChallan
 *   description: Delivery Challan management
 */

/**
 * @swagger
 * /api/dc:
 *   post:
 *     summary: Create a new Delivery Challan
 *     tags: [DeliveryChallan]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               project_id:
 *                 type: integer
 *               po_id:
 *                 type: integer
 *               po_number:
 *                 type: string
 *               challan_number:
 *                 type: string
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     description:
 *                       type: string
 *                     width:
 *                       type: number
 *                     length:
 *                       type: number
 *                     quantity:
 *                       type: number
 *                     price:
 *                       type: number
 *               challan_date:
 *                 type: string
 *                 format: date
 *               work_order_number:
 *                 type: string
 *               order_date:
 *                 type: string
 *                 format: date
 *     responses:
 *       201:
 *         description: Delivery Challan created successfully
 *       400:
 *         description: Bad request
 *       500:
 *         description: Internal server error
 */
router.post("/", async (req, res) => {
  const {
    project_id,
    po_id,
    po_number,
    challan_number,
    items,
    challan_date,
    work_order_number,
    order_date,
  } = req.body;

  if (!project_id || !challan_number || !Array.isArray(items)) {
    return res.status(400).json({ error: "project_id, challan_number and items are required" });
  }

  try {
    let total_po_items = null;

    if (po_id) {
      const poRes = await pool.query("SELECT jsonb_array_length(items) AS cnt FROM pos WHERE po_id = $1", [po_id]);
      total_po_items = poRes.rows.length ? poRes.rows[0].cnt : null;
    } else if (po_number) {
      // Fallback: find PO by order_no within the same project
      const poRes = await pool.query(
        "SELECT po_id, jsonb_array_length(items) AS cnt FROM pos WHERE order_no = $1 AND project_id = $2 LIMIT 1",
        [po_number, project_id]
      );
      if (poRes.rows.length) {
        total_po_items = poRes.rows[0].cnt;
      }
    }

    const total_challan_items = Array.isArray(items) ? items.length : 0;
    const status = total_po_items !== null && total_po_items === total_challan_items ? "completed" : "incomplete";

    const result = await pool.query(
      `INSERT INTO delivery_challans (
        project_id, po_id, po_number, challan_number, items, challan_date,
        work_order_number, order_date, total_po_items, total_challan_items, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        project_id,
        po_id || null,
        po_number || null,
        challan_number,
        JSON.stringify(items || []),
        challan_date || null,
        work_order_number || null,
        order_date || null,
        total_po_items,
        total_challan_items,
        status,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error creating Delivery Challan:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/dc/project/{projectId}:
 *   get:
 *     summary: Get all Delivery Challans for a specific project
 *     tags: [DeliveryChallan]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Project ID
 *     responses:
 *       200:
 *         description: List of Delivery Challans
 *       500:
 *         description: Internal server error
 */
router.get("/project/:projectId", async (req, res) => {
  const { projectId } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM delivery_challans WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching Delivery Challans:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/dc/po/{poId}:
 *   get:
 *     summary: Get all Delivery Challans for a specific PO
 *     tags: [DeliveryChallan]
 *     parameters:
 *       - in: path
 *         name: poId
 *         required: true
 *         schema:
 *           type: integer
 *         description: PO ID
 *     responses:
 *       200:
 *         description: List of Delivery Challans
 *       500:
 *         description: Internal server error
 */
router.get("/po/:poId", async (req, res) => {
  const { poId } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM delivery_challans WHERE po_id = $1 ORDER BY created_at DESC",
      [poId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching Delivery Challans:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/dc/{id}:
 *   get:
 *     summary: Get a single Delivery Challan by ID
 *     tags: [DeliveryChallan]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Delivery Challan ID
 *     responses:
 *       200:
 *         description: Delivery Challan details
 *       404:
 *         description: Delivery Challan not found
 *       500:
 *         description: Internal server error
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM delivery_challans WHERE dc_id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Delivery Challan not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching Delivery Challan:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/dc/{id}:
 *   put:
 *     summary: Update an existing Delivery Challan
 *     tags: [DeliveryChallan]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Delivery Challan ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               project_id:
 *                 type: integer
 *               po_id:
 *                 type: integer
 *               po_number:
 *                 type: string
 *               challan_number:
 *                 type: string
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *               challan_date:
 *                 type: string
 *                 format: date
 *               work_order_number:
 *                 type: string
 *               order_date:
 *                 type: string
 *                 format: date
 *     responses:
 *       200:
 *         description: Delivery Challan updated successfully
 *       404:
 *         description: Delivery Challan not found
 *       500:
 *         description: Internal server error
 */
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const {
    project_id,
    po_id,
    po_number,
    challan_number,
    items,
    challan_date,
    work_order_number,
    order_date,
  } = req.body;

  try {
    const existingRes = await pool.query("SELECT * FROM delivery_challans WHERE dc_id = $1", [id]);
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: "Delivery Challan not found" });
    }
    const current = existingRes.rows[0];

    const next_po_id = po_id !== undefined ? po_id : current.po_id;
    const next_items = items !== undefined ? items : current.items;

    let total_po_items = current.total_po_items;
    if (next_po_id) {
      const poRes = await pool.query("SELECT jsonb_array_length(items) AS cnt FROM pos WHERE po_id = $1", [next_po_id]);
      total_po_items = poRes.rows.length ? poRes.rows[0].cnt : null;
    }

    const total_challan_items = Array.isArray(next_items)
      ? next_items.length
      : Array.isArray(current.items)
      ? current.items.length
      : 0;

    const status = total_po_items !== null && total_po_items === total_challan_items ? "completed" : "incomplete";

    const result = await pool.query(
      `UPDATE delivery_challans SET
        project_id = COALESCE($1, project_id),
        po_id = COALESCE($2, po_id),
        po_number = COALESCE($3, po_number),
        challan_number = COALESCE($4, challan_number),
        items = COALESCE($5, items),
        challan_date = COALESCE($6, challan_date),
        work_order_number = COALESCE($7, work_order_number),
        order_date = COALESCE($8, order_date),
        total_po_items = $9,
        total_challan_items = $10,
        status = $11,
        updated_at = CURRENT_TIMESTAMP
      WHERE dc_id = $12 RETURNING *`,
      [
        project_id || null,
        po_id || null,
        po_number || null,
        challan_number || null,
        items ? JSON.stringify(items) : null,
        challan_date || null,
        work_order_number || null,
        order_date || null,
        total_po_items,
        total_challan_items,
        status,
        id,
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating Delivery Challan:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/dc/{id}:
 *   delete:
 *     summary: Delete a Delivery Challan
 *     tags: [DeliveryChallan]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Delivery Challan ID
 *     responses:
 *       200:
 *         description: Delivery Challan deleted successfully
 *       404:
 *         description: Delivery Challan not found
 *       500:
 *         description: Internal server error
 */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("DELETE FROM delivery_challans WHERE dc_id = $1 RETURNING *", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Delivery Challan not found" });
    }
    res.json({ message: "Delivery Challan deleted successfully" });
  } catch (error) {
    console.error("Error deleting Delivery Challan:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
