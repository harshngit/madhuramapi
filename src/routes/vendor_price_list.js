const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { logActivity, getEntityHistory, attachCreatedUpdatedBy } = require("./dashboard");
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

  // Log Activity for upload (optional, but good for tracking)
  // Since this is just upload, we might not have user info unless passed in query or form fields (multer handles form fields but only if text fields come before file)
  // Let's assume user_id might be in req.body if sent.
  if (req.body.user_id) {
    logActivity({
      action: "uploaded",
      entity_type: "price_list_file",
      entity_id: null,
      entity_name: filename,
      performed_by: req.body.user_id,
      performed_by_name: req.body.user_name || null,
      meta: { filePath }
    });
  }
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
    res.json(await attachCreatedUpdatedBy(result.rows, "price_list", (r) => r.price_list_id));
  } catch (error) {
    console.error("Error fetching vendor price lists:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/vendor-price-list/compare:
 *   get:
 *     summary: Search items across vendors (latest active price list per vendor by default) and return grouped data for comparison
 *     tags: [Vendor Price List]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Free text search (matches item_name, product_name, category, item_code, hsn_code)
 *       - in: query
 *         name: item_name
 *         schema:
 *           type: string
 *         description: Search by item name (matches items_name)
 *       - in: query
 *         name: product_name
 *         schema:
 *           type: string
 *         description: Search by product name
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Search by category
 *       - in: query
 *         name: vendor_id
 *         schema:
 *           type: integer
 *         description: Filter by a single vendor_id
 *       - in: query
 *         name: vendor_ids
 *         schema:
 *           type: string
 *         description: Filter by multiple vendor_ids (comma-separated), e.g. "1,2,3"
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: integer
 *         description: Filter vendors by project_id
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, inactive, archived, all]
 *           default: active
 *         description: Price list status filter. Default is active (recommended).
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 500
 *         description: Max rows to scan before grouping (max 2000).
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Grouped comparison results with full vendor + price list data (active lists by default)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count:
 *                   type: integer
 *                 groups_count:
 *                   type: integer
 *                 groups:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       compare_key:
 *                         type: string
 *                       items_name:
 *                         type: string
 *                       product_name:
 *                         type: string
 *                       category:
 *                         type: string
 *                       item_code:
 *                         type: string
 *                       hsn_code:
 *                         type: string
 *                       size_inch:
 *                         type: string
 *                       size_mm:
 *                         type: string
 *                       offers:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             vendor_id:
 *                               type: integer
 *                             vendor_name:
 *                               type: string
 *                             vendor_company_name:
 *                               type: string
 *                             project_id:
 *                               type: integer
 *                             price_list_id:
 *                               type: integer
 *                             version_name:
 *                               type: string
 *                             price_list_status:
 *                               type: string
 *                               enum: [active, inactive, archived]
 *                             file_path:
 *                               type: string
 *                             price_list_created_at:
 *                               type: string
 *                               format: date-time
 *                             item_id:
 *                               type: integer
 *                             price_per_pic:
 *                               type: number
 *                             discount_price:
 *                               type: number
 *                             net_price:
 *                               type: number
 *       500:
 *         description: Server error
 */
router.get("/compare", async (req, res) => {
  const {
    q,
    item_name,
    product_name,
    category,
    vendor_id,
    vendor_ids,
    project_id,
    status,
    limit,
    offset,
  } = req.query;

  const statusFilter = status && typeof status === "string" ? status : "active";

  const parsedLimit = Math.min(
    Math.max(parseInt(limit, 10) || 500, 1),
    2000
  );
  const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const vendorIdList = [];
  if (vendor_id !== undefined && vendor_id !== null && vendor_id !== "") {
    const n = Number(vendor_id);
    if (!Number.isNaN(n)) vendorIdList.push(n);
  }
  if (typeof vendor_ids === "string" && vendor_ids.trim()) {
    for (const part of vendor_ids.split(",")) {
      const n = Number(part.trim());
      if (!Number.isNaN(n)) vendorIdList.push(n);
    }
  }

  const params = [];
  const vplWhere = [];

  if (statusFilter !== "all") {
    params.push(statusFilter);
    vplWhere.push(`vpl.status = $${params.length}`);
  }

  if (vendorIdList.length > 0) {
    params.push(vendorIdList);
    vplWhere.push(`vpl.vendor_id = ANY($${params.length}::int[])`);
  }

  const chosenPriceListsCte = `
    chosen_price_lists AS (
      SELECT DISTINCT ON (vpl.vendor_id) vpl.*
      FROM vendor_price_lists vpl
      ${vplWhere.length ? `WHERE ${vplWhere.join(" AND ")}` : ""}
      ORDER BY vpl.vendor_id, vpl.created_at DESC, vpl.price_list_id DESC
    )
  `;

  const outerWhere = [];

  if (project_id !== undefined && project_id !== null && project_id !== "") {
    const n = Number(project_id);
    if (!Number.isNaN(n)) {
      params.push(n);
      outerWhere.push(`v.project_id = $${params.length}`);
    }
  }

  if (typeof item_name === "string" && item_name.trim()) {
    params.push(`%${item_name.trim()}%`);
    outerWhere.push(`vpli.items_name ILIKE $${params.length}`);
  }

  if (typeof product_name === "string" && product_name.trim()) {
    params.push(`%${product_name.trim()}%`);
    outerWhere.push(`vpli.product_name ILIKE $${params.length}`);
  }

  if (typeof category === "string" && category.trim()) {
    params.push(`%${category.trim()}%`);
    outerWhere.push(`vpli.category ILIKE $${params.length}`);
  }

  if (typeof q === "string" && q.trim()) {
    params.push(`%${q.trim()}%`);
    const p = `$${params.length}`;
    outerWhere.push(
      `(vpli.items_name ILIKE ${p} OR vpli.product_name ILIKE ${p} OR vpli.category ILIKE ${p} OR vpli.item_code ILIKE ${p} OR vpli.hsn_code ILIKE ${p})`
    );
  }

  params.push(parsedLimit);
  const limitParam = `$${params.length}`;
  params.push(parsedOffset);
  const offsetParam = `$${params.length}`;

  const sql = `
    WITH
    ${chosenPriceListsCte}
    SELECT
      v.vendor_id,
      v.vendor_name,
      v.vendor_company_name,
      v.project_id,
      vpl.price_list_id,
      vpl.version_name,
      vpl.status AS price_list_status,
      vpl.file_path,
      vpl.created_at AS price_list_created_at,
      vpli.item_id,
      vpli.items_name,
      vpli.hsn_code,
      vpli.item_code,
      vpli.category,
      vpli.product_name,
      vpli.size_inch,
      vpli.size_mm,
      vpli.price_per_pic,
      vpli.discount_price,
      vpli.net_price
    FROM chosen_price_lists vpl
    JOIN vendors v ON v.vendor_id = vpl.vendor_id
    JOIN vendor_price_list_items vpli ON vpli.price_list_id = vpl.price_list_id
    ${outerWhere.length ? `WHERE ${outerWhere.join(" AND ")}` : ""}
    ORDER BY
      LOWER(COALESCE(vpli.items_name, vpli.product_name, '')) ASC,
      LOWER(COALESCE(v.vendor_name, '')) ASC,
      vpl.created_at DESC,
      vpli.item_id ASC
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  const normalize = (val) =>
    String(val ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

  try {
    const result = await pool.query(sql, params);

    const groupsMap = new Map();
    for (const row of result.rows) {
      const code = normalize(row.item_code);
      const key = code
        ? `code:${code}|hsn:${normalize(row.hsn_code)}|inch:${normalize(
            row.size_inch
          )}|mm:${normalize(row.size_mm)}`
        : `name:${normalize(row.items_name)}|product:${normalize(
            row.product_name
          )}|category:${normalize(row.category)}|hsn:${normalize(
            row.hsn_code
          )}|inch:${normalize(row.size_inch)}|mm:${normalize(row.size_mm)}`;

      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          compare_key: key,
          items_name: row.items_name,
          product_name: row.product_name,
          category: row.category,
          item_code: row.item_code,
          hsn_code: row.hsn_code,
          size_inch: row.size_inch,
          size_mm: row.size_mm,
          offers: [],
        });
      }

      groupsMap.get(key).offers.push({
        vendor_id: row.vendor_id,
        vendor_name: row.vendor_name,
        vendor_company_name: row.vendor_company_name,
        project_id: row.project_id,
        price_list_id: row.price_list_id,
        version_name: row.version_name,
        price_list_status: row.price_list_status,
        file_path: row.file_path,
        price_list_created_at: row.price_list_created_at,
        item_id: row.item_id,
        price_per_pic: row.price_per_pic,
        discount_price: row.discount_price,
        net_price: row.net_price,
      });
    }

    res.json({
      count: result.rows.length,
      groups_count: groupsMap.size,
      groups: Array.from(groupsMap.values()),
    });
  } catch (error) {
    console.error("Error comparing vendor price list items:", error);
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

    res.json(await attachCreatedUpdatedBy(priceList, "price_list", (r) => r.price_list_id));
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
        item.net_price || null,
        item.quantity || 0
      );

      const rowPlaceholders = [];
      for (let j = 0; j < 12; j++) {
        rowPlaceholders.push(`$${paramIndex++}`);
      }
      placeholders.push(`(${rowPlaceholders.join(', ')})`);
    }

    const insertQuery = `
      INSERT INTO vendor_price_list_items (
        price_list_id, items_name, hsn_code, item_code, category, product_name,
        size_inch, size_mm, price_per_pic, discount_price, net_price, quantity
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
 *                     quantity:
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

    // Log Activity
    logActivity({
      action: "created",
      entity_type: "price_list",
      entity_id: priceListRes.rows[0].price_list_id,
      entity_name: version_name || `Price List #${priceListRes.rows[0].price_list_id}`,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      project_id: null, // vendor price list is not directly linked to project, but vendor might be.
      meta: { vendor_id, items_count: items ? items.length : 0 }
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

    // Log Activity
    logActivity({
      action: "updated",
      entity_type: "price_list",
      entity_id: id,
      entity_name: updateRes.rows[0].version_name,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      meta: { status, version_name }
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

    // Log Activity
    logActivity({
      action: "deleted",
      entity_type: "price_list",
      entity_id: id,
      entity_name: fileRes.rows[0]?.version_name || "Price List", // Need to fetch name if possible, but fileRes only selects file_path
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      meta: {}
    });
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

    // Log Activity
    logActivity({
      action: "updated",
      entity_type: "price_list",
      entity_id: id,
      entity_name: result.rows[0].version_name,
      performed_by: req.body.user_id || null,
      performed_by_name: req.body.user_name || null,
      meta: { status_change: status }
    });
  } catch (error) {
    console.error("Error updating price list status:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vendor-price-list/:id/history — who created/updated/deleted this price list, and when
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/vendor-price-list/{id}/history:
 *   get:
 *     summary: Get the create/update/delete history for a vendor price list (who did what, and when)
 *     tags: [Vendor Price List]
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
 *         description: Activity history for this price list
 */
router.get("/:id/history", async (req, res) => {
  try {
    const data = await getEntityHistory("price_list", req.params.id, {
      limit: req.query.limit, offset: req.query.offset,
    });
    res.json(data);
  } catch (error) {
    console.error("Error fetching price list history:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
