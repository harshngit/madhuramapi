const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Ensure upload directory exists
const uploadDir = path.join(__dirname, "../../uploads/price_lists");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage: storage });

/**
 * @swagger
 * tags:
 *   name: Vendor Price List
 *   description: Manage vendor price lists and history
 */

/**
 * @swagger
 * /api/vendor-price-list/upload:
 *   post:
 *     summary: Upload a price list file
 *     tags: [Vendor Price List]
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
 *                 filename:
 *                   type: string
 *       400:
 *         description: No file uploaded
 */
router.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  // Return just the filename or relative path as requested
  // User asked for "filelink" but in the create API they want "filename".
  // Let's return the relative path that can be stored in DB.
  // Actually, the user said "filename" in the request body for create API.
  // But usually we store the path. Let's return both to be safe.
  
  const filename = req.file.filename;
  const filePath = `/uploads/price_lists/${filename}`;
  
  res.json({ 
    success: true, 
    filename: filename, 
    filePath: filePath 
  });
});

/**
 * @swagger
 * /api/vendor-price-list/vendor/{vendorId}:
 *   get:
 *     summary: Get all price lists for a vendor (history)
 *     tags: [Vendor Price List]
 *     parameters:
 *       - in: path
 *         name: vendorId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of price lists
 *       500:
 *         description: Server error
 */
router.get("/vendor/:vendorId", async (req, res) => {
  const { vendorId } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM vendor_price_lists 
       WHERE vendor_id = $1 
       ORDER BY created_at DESC`,
      [vendorId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching vendor price lists:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/vendor-price-list/{id}:
 *   get:
 *     summary: Get a specific price list with items
 *     tags: [Vendor Price List]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Price list details with items
 *       404:
 *         description: Price list not found
 *       500:
 *         description: Server error
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const priceListResult = await pool.query(
      `SELECT * FROM vendor_price_lists WHERE price_list_id = $1`,
      [id]
    );

    if (priceListResult.rows.length === 0) {
      return res.status(404).json({ error: "Price list not found" });
    }

    const itemsResult = await pool.query(
      `SELECT * FROM vendor_price_list_items WHERE price_list_id = $1 ORDER BY item_id ASC`,
      [id]
    );

    const priceList = priceListResult.rows[0];
    priceList.items = itemsResult.rows;

    res.json(priceList);
  } catch (error) {
    console.error("Error fetching price list details:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Helper function for bulk insert
 */
async function bulkInsertItems(client, priceListId, items) {
  if (!items || items.length === 0) return;

  const batchSize = 1000;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (const item of batch) {
      values.push(
        priceListId,
        item.items_name || null,
        item.hsn_code || null,
        item.item_code || null,
        item.category || null,
        item.product_name || null,
        item.SIZE_INCH || item.size_inch || null,
        item.SIZE_MM || item.size_mm || null,
        item['price_per-pic'] || item.price_per_pic || null,
        item.discountprice || item.discount_price || null,
        item.net_price || null
      );

      const rowPlaceholders = [];
      for (let j = 0; j < 11; j++) {
        rowPlaceholders.push(`$${paramIndex++}`);
      }
      placeholders.push(`(${rowPlaceholders.join(', ')})`);
    }

    const insertQuery = `
      INSERT INTO vendor_price_list_items (
        price_list_id, items_name, hsn_code, item_code, category, product_name,
        size_inch, size_mm, price_per_pic, discount_price, net_price
      ) VALUES ${placeholders.join(', ')}
    `;

    await client.query(insertQuery, values);
  }
}

/**
 * @swagger
 * /api/vendor-price-list:
 *   post:
 *     summary: Create a new price list for a vendor
 *     tags: [Vendor Price List]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [vendor_id, items]
 *             properties:
 *               filename:
 *                 type: string
 *                 description: Filename returned from upload API (or full path)
 *               vendor_id:
 *                 type: integer
 *               version_name:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [active, inactive, archived]
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     items_name:
 *                       type: string
 *                     hsn_code:
 *                       type: string
 *                     item_code:
 *                       type: string
 *                     category:
 *                       type: string
 *                     product_name:
 *                       type: string
 *                     SIZE_INCH:
 *                       type: string
 *                     SIZE_MM:
 *                       type: string
 *                     price_per-pic:
 *                       type: number
 *                     discountprice:
 *                       type: number
 *                     net_price:
 *                       type: number
 *     responses:
 *       201:
 *         description: Price list created successfully
 *       500:
 *         description: Server error
 */
router.post("/", async (req, res) => {
  const { vendor_id, version_name, status, filename, items } = req.body;
  
  if (!vendor_id) {
    return res.status(400).json({ error: "vendor_id is required" });
  }

  // If filename is provided, construct the path. 
  // If it already looks like a path, keep it. 
  // Assuming the upload API returns just the filename, we prepend /uploads/price_lists/
  let filePath = null;
  if (filename) {
    if (filename.startsWith("/uploads") || filename.startsWith("\\uploads")) {
      filePath = filename;
    } else {
      filePath = `/uploads/price_lists/${filename}`;
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Create the price list entry
    const priceListRes = await client.query(
      `INSERT INTO vendor_price_lists (vendor_id, version_name, status, file_path)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [vendor_id, version_name || `Version ${new Date().toISOString()}`, status || 'active', filePath]
    );
    const priceListId = priceListRes.rows[0].price_list_id;

    // Bulk insert items
    if (items && Array.isArray(items) && items.length > 0) {
      await bulkInsertItems(client, priceListId, items);
    }

    // Update vendor's price_list_ids array
    await client.query(
      `UPDATE vendors 
       SET price_list_ids = array_append(COALESCE(price_list_ids, '{}'), $1),
           updated_at = CURRENT_TIMESTAMP
       WHERE vendor_id = $2`,
      [priceListId, vendor_id]
    );

    await client.query("COMMIT");
    res.status(201).json({ 
      message: "Price list created successfully", 
      price_list: priceListRes.rows[0],
      items_count: items ? items.length : 0 
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating price list:", error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

/**
 * @swagger
 * /api/vendor-price-list/{id}:
 *   put:
 *     summary: Update an existing price list
 *     tags: [Vendor Price List]
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
 *               version_name:
 *                 type: string
 *               status:
 *                 type: string
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *     responses:
 *       200:
 *         description: Price list updated successfully
 *       500:
 *         description: Server error
 */
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { version_name, status, items } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Update header
    const updateRes = await client.query(
      `UPDATE vendor_price_lists 
       SET version_name = COALESCE($1, version_name),
           status = COALESCE($2, status),
           updated_at = CURRENT_TIMESTAMP
       WHERE price_list_id = $3
       RETURNING *`,
      [version_name, status, id]
    );

    if (updateRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Price list not found" });
    }

    // If items are provided, replace them
    if (items && Array.isArray(items)) {
      // Delete existing items
      await client.query(`DELETE FROM vendor_price_list_items WHERE price_list_id = $1`, [id]);

      // Bulk insert new items
      await bulkInsertItems(client, id, items);
    }

    await client.query("COMMIT");
    res.json({ 
      message: "Price list updated successfully", 
      price_list: updateRes.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating price list:", error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

/**
 * @swagger
 * /api/vendor-price-list/{id}:
 *   delete:
 *     summary: Delete a price list
 *     tags: [Vendor Price List]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Price list deleted successfully
 *       404:
 *         description: Price list not found
 *       500:
 *         description: Server error
 */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    // Get file path before deleting
    const fileRes = await pool.query("SELECT file_path FROM vendor_price_lists WHERE price_list_id = $1", [id]);
    
    const result = await pool.query(
      "DELETE FROM vendor_price_lists WHERE price_list_id = $1 RETURNING *",
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Price list not found" });
    }

    // Delete associated file if exists
    if (fileRes.rows.length > 0 && fileRes.rows[0].file_path) {
      const fullPath = path.join(__dirname, "../../", fileRes.rows[0].file_path);
      if (fs.existsSync(fullPath)) {
        fs.unlink(fullPath, (err) => {
          if (err) console.error("Error deleting file:", err);
        });
      }
    }

    res.json({ message: "Price list deleted successfully" });
  } catch (error) {
    console.error("Error deleting price list:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/vendor-price-list/{id}/status:
 *   patch:
 *     summary: Update status of a price list
 *     tags: [Vendor Price List]
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
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [active, inactive, archived]
 *     responses:
 *       200:
 *         description: Status updated successfully
 *       400:
 *         description: Invalid status value
 *       404:
 *         description: Price list not found
 *       500:
 *         description: Server error
 */
router.patch("/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  // Validate status against the allowed values in DB constraint
  const validStatuses = ['active', 'inactive', 'archived'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ 
      error: `Invalid status. Allowed values are: ${validStatuses.join(', ')}` 
    });
  }

  try {
    const result = await pool.query(
      `UPDATE vendor_price_lists 
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE price_list_id = $2
       RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Price list not found" });
    }

    res.json({ 
      message: "Status updated successfully", 
      price_list: result.rows[0] 
    });
  } catch (error) {
    console.error("Error updating price list status:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
