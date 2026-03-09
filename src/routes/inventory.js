const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { logActivity } = require("./dashboard");

/**
 * @swagger
 * components:
 *   schemas:
 *     Inventory:
 *       type: object
 *       properties:
 *         inventory_id:
 *           type: integer
 *         project_id:
 *           type: integer
 *         brand:
 *           type: string
 *         quantity:
 *           type: number
 *         name:
 *           type: string
 *         price:
 *           type: number
 *         stockin:
 *           type: boolean
 *         created_at:
 *           type: string
 *           format: date-time
 */

/**
 * @swagger
 * tags:
 *   name: Inventory
 *   description: Inventory management
 */

/**
 * @swagger
 * /api/inventory:
 *   post:
 *     summary: Create a new inventory item
 *     tags: [Inventory]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               project_id:
 *                 type: integer
 *               brand:
 *                 type: string
 *               quantity:
 *                 type: number
 *               name:
 *                 type: string
 *               price:
 *                 type: number
 *               stockin:
 *                 type: boolean
 *               billing:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Inventory item created successfully
 *       400:
 *         description: Invalid project_id
 *       500:
 *         description: Server error
 */
router.post("/", async (req, res) => {
  try {
    const { project_id, brand, quantity, name, price, stockin, billing } = req.body;

    const query = `
      INSERT INTO inventories (
        project_id,
        brand,
        quantity,
        name,
        price,
        stockin,
        billing
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;

    const values = [project_id, brand, quantity, name, price, stockin, billing];

    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);

    // Log Activity
    logActivity({
      action: "created",
      entity_type: "inventory",
      entity_id: result.rows[0].inventory_id,
      entity_name: result.rows[0].name,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: project_id,
      meta: { brand, quantity, price }
    });
  } catch (error) {
    console.error("Error creating inventory item:", error);
    if (error.code === "23503") {
      return res.status(400).json({ error: "Invalid project_id: Project does not exist" });
    }
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/inventory:
 *   get:
 *     summary: Get all inventory items
 *     tags: [Inventory]
 *     responses:
 *       200:
 *         description: List of all inventory items
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Inventory'
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM inventories ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching inventory items:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/inventory/{id}:
 *   get:
 *     summary: Get an inventory item by ID
 *     tags: [Inventory]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Inventory item details
 *       404:
 *         description: Inventory item not found
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM inventories WHERE inventory_id = $1", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    res.json(result.rows[0]);

    // Log Activity
    logActivity({
      action: "updated",
      entity_type: "inventory",
      entity_id: id,
      entity_name: result.rows[0].name,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: { updates: req.body }
    });
  } catch (error) {
    console.error("Error fetching inventory item:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/inventory/project/{projectId}:
 *   get:
 *     summary: Get inventory items by Project ID
 *     tags: [Inventory]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of inventory items for the project
 */
router.get("/project/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const result = await pool.query(
      "SELECT * FROM inventories WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching project inventory items:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/inventory/{id}:
 *   put:
 *     summary: Update an inventory item
 *     tags: [Inventory]
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
 *               brand:
 *                 type: string
 *               quantity:
 *                 type: number
 *               name:
 *                 type: string
 *               price:
 *                 type: number
 *               stockin:
 *                 type: boolean
 *               billing:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Inventory item updated successfully
 *       404:
 *         description: Inventory item not found
 */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { brand, quantity, name, price, stockin, billing } = req.body;

    const query = `
      UPDATE inventories SET
        brand = COALESCE($1, brand),
        quantity = COALESCE($2, quantity),
        name = COALESCE($3, name),
        price = COALESCE($4, price),
        stockin = COALESCE($5, stockin),
        billing = COALESCE($6, billing),
        updated_at = CURRENT_TIMESTAMP
      WHERE inventory_id = $7
      RETURNING *;
    `;

    const values = [brand, quantity, name, price, stockin, billing, id];

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    res.json(result.rows[0]);

    // Log Activity
    logActivity({
      action: "updated",
      entity_type: "inventory",
      entity_id: id,
      entity_name: result.rows[0].name,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: { stockin_update: stockin }
    });
  } catch (error) {
    console.error("Error updating inventory item:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/inventory/{id}:
 *   delete:
 *     summary: Delete an inventory item
 *     tags: [Inventory]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Inventory item deleted successfully
 *       404:
 *         description: Inventory item not found
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "DELETE FROM inventories WHERE inventory_id = $1 RETURNING *",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    res.json({ message: "Inventory item deleted successfully" });

    // Log Activity
    logActivity({
      action: "deleted",
      entity_type: "inventory",
      entity_id: id,
      entity_name: result.rows[0].name,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: {}
    });
  } catch (error) {
    console.error("Error deleting inventory item:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/inventory/{id}/stockin:
 *   patch:
 *     summary: Update stockin status of an inventory item
 *     tags: [Inventory]
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
 *             required: [stockin]
 *             properties:
 *               stockin:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Stockin status updated successfully
 *       404:
 *         description: Inventory item not found
 */
router.patch("/:id/stockin", async (req, res) => {
  try {
    const { id } = req.params;
    const { stockin } = req.body;

    if (typeof stockin !== 'boolean') {
      return res.status(400).json({ error: "stockin must be a boolean" });
    }

    const result = await pool.query(
      "UPDATE inventories SET stockin = $1, updated_at = CURRENT_TIMESTAMP WHERE inventory_id = $2 RETURNING *",
      [stockin, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    res.json(result.rows[0]);

    // Log Activity
    logActivity({
      action: "updated",
      entity_type: "inventory",
      entity_id: id,
      entity_name: result.rows[0].name,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: result.rows[0].project_id,
      meta: { billing_update: billing }
    });
  } catch (error) {
    console.error("Error updating stockin status:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * @swagger
 * /api/inventory/{id}/billing:
 *   patch:
 *     summary: Update billing status of an inventory item
 *     tags: [Inventory]
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
 *             required: [billing]
 *             properties:
 *               billing:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Billing status updated successfully
 *       404:
 *         description: Inventory item not found
 */
router.patch("/:id/billing", async (req, res) => {
  try {
    const { id } = req.params;
    const { billing } = req.body;

    if (typeof billing !== 'boolean') {
      return res.status(400).json({ error: "billing must be a boolean" });
    }

    const result = await pool.query(
      "UPDATE inventories SET billing = $1, updated_at = CURRENT_TIMESTAMP WHERE inventory_id = $2 RETURNING *",
      [billing, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating billing status:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;

