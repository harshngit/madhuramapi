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
 *         billing:
 *           type: boolean
 *         units:
 *           type: string
 *         width:
 *           type: number
 *         height:
 *           type: number
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
 *               units:
 *                 type: string
 *               width:
 *                 type: number
 *               height:
 *                 type: number
 *     responses:
 *       201:
 *         description: Inventory item created successfully
 *       500:
 *         description: Server error
 */
router.post("/", async (req, res) => {
  try {
    const { brand, quantity, name, price, stockin, billing, units, width, height } = req.body;

    const query = `
      INSERT INTO inventories (
        brand, quantity, name, price, stockin, billing, units, width, height
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;

    const values = [brand, quantity, name, price, stockin, billing, units, width, height];

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
      meta: { brand, quantity, price }
    });
  } catch (error) {
    console.error("Error creating inventory item:", error);
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
  } catch (error) {
    console.error("Error fetching inventory item:", error);
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
 *               units:
 *                 type: string
 *               width:
 *                 type: number
 *               height:
 *                 type: number
 *     responses:
 *       200:
 *         description: Inventory item updated successfully
 *       404:
 *         description: Inventory item not found
 */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { brand, quantity, name, price, stockin, billing, units, width, height } = req.body;

    const query = `
      UPDATE inventories SET
        brand = COALESCE($1, brand),
        quantity = COALESCE($2, quantity),
        name = COALESCE($3, name),
        price = COALESCE($4, price),
        stockin = COALESCE($5, stockin),
        billing = COALESCE($6, billing),
        units = COALESCE($7, units),
        width = COALESCE($8, width),
        height = COALESCE($9, height),
        updated_at = CURRENT_TIMESTAMP
      WHERE inventory_id = $10
      RETURNING *;
    `;

    const values = [brand, quantity, name, price, stockin, billing, units, width, height, id];

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
      meta: { updates: req.body }
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
      meta: { stockin_update: stockin }
    });
  } catch (error) {
    console.error("Error updating stockin status:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
