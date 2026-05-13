const express = require("express");
const router = express.Router();
const { pool } = require("../db");

/**
 * @swagger
 * tags:
 *   name: Backpath API
 *   description: Relationship endpoints between PR, PO, DC, and Sample entities
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     BackpathPRResponse:
 *       type: object
 *       properties:
 *         totalCount:
 *           type: integer
 *           description: Total count of connected PO and DC records
 *         pos:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               po_id: { type: integer }
 *               order_no: { type: string }
 *               created_at: { type: string, format: date-time }
 *               status: { type: string }
 *         dcs:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               dc_id: { type: integer }
 *               challan_number: { type: string }
 *               created_at: { type: string, format: date-time }
 *               status: { type: string }
 *     BackpathSampleResponse:
 *       type: object
 *       properties:
 *         totalCount:
 *           type: integer
 *           description: Total count of connected records
 *         prs:
 *           type: array
 *           items: { type: object }
 *         pos:
 *           type: array
 *           items: { type: object }
 *         dcs:
 *           type: array
 *           items: { type: object }
 *     BackpathPOResponse:
 *       type: object
 *       properties:
 *         totalCount:
 *           type: integer
 *           description: Total count of connected DC records
 *         dcs:
 *           type: array
 *           items: { type: object }
 */

/**
 * @swagger
 * /api/backpath/pr/{prId}:
 *   get:
 *     summary: Get all connected PO and DC records for a specific PR ID
 *     tags: [Backpath API]
 *     parameters:
 *       - in: path
 *         name: prId
 *         required: true
 *         schema:
 *           type: integer
 *         description: PR ID
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of items per page
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter by creation date (start)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter by creation date (end)
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by status
 *     responses:
 *       200:
 *         description: Connected PO and DC records
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BackpathPRResponse'
 *             example:
 *               totalCount: 2
 *               pos:
 *                 - po_id: 101
 *                   order_no: "PO-2023-001"
 *                   created_at: "2023-10-01T10:00:00Z"
 *                   status: "created"
 *               dcs:
 *                 - dc_id: 501
 *                   challan_number: "CH-001"
 *                   created_at: "2023-10-05T14:00:00Z"
 *                   status: "completed"
 *       404:
 *         description: PR not found
 *       500:
 *         description: Internal server error
 */
router.get("/pr/:prId", async (req, res) => {
  const { prId } = req.params;
  const { page = 1, limit = 10, startDate, endDate, status } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  try {
    // 1. Check if PR exists
    const prCheck = await pool.query("SELECT pr_id FROM purchase_requisitions WHERE pr_id = $1", [prId]);
    if (prCheck.rows.length === 0) {
      return res.status(404).json({ error: "PR not found" });
    }

    // 2. Fetch connected POs
    let poQuery = "FROM pos WHERE indent_no = $1";
    const poValues = [prId.toString()];
    let p = 2;
    if (startDate) { poQuery += ` AND created_at >= $${p++}`; poValues.push(startDate); }
    if (endDate) { poQuery += ` AND created_at <= $${p++}`; poValues.push(endDate); }
    if (status) { poQuery += ` AND status = $${p++}`; poValues.push(status); }

    const totalPosRes = await pool.query(`SELECT COUNT(*) ${poQuery}`, poValues);
    const totalPos = parseInt(totalPosRes.rows[0].count);

    const pos = await pool.query(
      `SELECT * ${poQuery} ORDER BY created_at DESC LIMIT $${p++} OFFSET $${p++}`,
      [...poValues, Number(limit), offset]
    );

    // 3. Fetch connected DCs (via those POs)
    // We get all PO IDs for this PR to find all related DCs, regardless of PO pagination
    const allPoIdsRes = await pool.query("SELECT po_id FROM pos WHERE indent_no = $1", [prId.toString()]);
    const poIds = allPoIdsRes.rows.map(r => r.po_id);

    let dcs = { rows: [], total: 0 };
    if (poIds.length > 0) {
      let dcQuery = "FROM delivery_challans WHERE po_id = ANY($1)";
      const dcValues = [poIds];
      let dp = 2;
      if (startDate) { dcQuery += ` AND created_at >= $${dp++}`; dcValues.push(startDate); }
      if (endDate) { dcQuery += ` AND created_at <= $${dp++}`; dcValues.push(endDate); }
      if (status) { dcQuery += ` AND status = $${dp++}`; dcValues.push(status); }

      const totalDcsRes = await pool.query(`SELECT COUNT(*) ${dcQuery}`, dcValues);
      dcs.total = parseInt(totalDcsRes.rows[0].count);

      const dcResults = await pool.query(
        `SELECT * ${dcQuery} ORDER BY created_at DESC LIMIT $${dp++} OFFSET $${dp++}`,
        [...dcValues, Number(limit), offset]
      );
      dcs.rows = dcResults.rows;
    }

    res.json({
      totalCount: totalPos + dcs.total,
      pos: pos.rows,
      dcs: dcs.rows
    });
  } catch (error) {
    console.error("Backpath PR error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/backpath/sample/{sampleId}:
 *   get:
 *     summary: Get all associated PR, PO, and DC records for a specific Sample ID
 *     tags: [Backpath API]
 *     parameters:
 *       - in: path
 *         name: sampleId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Sample ID
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of items per page
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter by creation date (start)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter by creation date (end)
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by status
 *     responses:
 *       200:
 *         description: Associated records for the Sample
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BackpathSampleResponse'
 *       404:
 *         description: Sample not found
 *       500:
 *         description: Internal server error
 */
router.get("/sample/:sampleId", async (req, res) => {
  const { sampleId } = req.params;
  const { page = 1, limit = 10, startDate, endDate, status } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  try {
    const sampleCheck = await pool.query("SELECT sample_id FROM samples WHERE sample_id = $1", [sampleId]);
    if (sampleCheck.rows.length === 0) {
      return res.status(404).json({ error: "Sample not found" });
    }

    // 1. Fetch PRs
    let prQuery = "FROM purchase_requisitions WHERE sample_id = $1";
    const prValues = [sampleId];
    let prp = 2;
    if (startDate) { prQuery += ` AND created_at >= $${prp++}`; prValues.push(startDate); }
    if (endDate) { prQuery += ` AND created_at <= $${prp++}`; prValues.push(endDate); }
    // PR table doesn't have status column, so we skip status filter for PRs

    const totalPrsRes = await pool.query(`SELECT COUNT(*) ${prQuery}`, prValues);
    const totalPrs = parseInt(totalPrsRes.rows[0].count);
    const prs = await pool.query(`SELECT * ${prQuery} ORDER BY created_at DESC LIMIT $${prp++} OFFSET $${prp++}`, [...prValues, Number(limit), offset]);

    // 2. Fetch POs
    let poQuery = "FROM pos WHERE sample_id = $1";
    const poValues = [sampleId];
    let pop = 2;
    if (startDate) { poQuery += ` AND created_at >= $${pop++}`; poValues.push(startDate); }
    if (endDate) { poQuery += ` AND created_at <= $${pop++}`; poValues.push(endDate); }
    if (status) { poQuery += ` AND status = $${pop++}`; poValues.push(status); }

    const totalPosRes = await pool.query(`SELECT COUNT(*) ${poQuery}`, poValues);
    const totalPos = parseInt(totalPosRes.rows[0].count);
    const pos = await pool.query(`SELECT * ${poQuery} ORDER BY created_at DESC LIMIT $${pop++} OFFSET $${pop++}`, [...poValues, Number(limit), offset]);

    // 3. Fetch DCs (via those POs)
    const allPoIdsRes = await pool.query("SELECT po_id FROM pos WHERE sample_id = $1", [sampleId]);
    const poIds = allPoIdsRes.rows.map(r => r.po_id);

    let dcs = { rows: [], total: 0 };
    if (poIds.length > 0) {
      let dcQuery = "FROM delivery_challans WHERE po_id = ANY($1)";
      const dcValues = [poIds];
      let dcp = 2;
      if (startDate) { dcQuery += ` AND created_at >= $${dcp++}`; dcValues.push(startDate); }
      if (endDate) { dcQuery += ` AND created_at <= $${dcp++}`; dcValues.push(endDate); }
      if (status) { dcQuery += ` AND status = $${dcp++}`; dcValues.push(status); }

      const totalDcsRes = await pool.query(`SELECT COUNT(*) ${dcQuery}`, dcValues);
      dcs.total = parseInt(totalDcsRes.rows[0].count);
      const dcResults = await pool.query(`SELECT * ${dcQuery} ORDER BY created_at DESC LIMIT $${dcp++} OFFSET $${dcp++}`, [...dcValues, Number(limit), offset]);
      dcs.rows = dcResults.rows;
    }

    res.json({
      totalCount: totalPrs + totalPos + dcs.total,
      prs: prs.rows,
      pos: pos.rows,
      dcs: dcs.rows
    });
  } catch (error) {
    console.error("Backpath Sample error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/backpath/po/{poId}:
 *   get:
 *     summary: Get all connected DC records for a specific PO ID
 *     tags: [Backpath API]
 *     parameters:
 *       - in: path
 *         name: poId
 *         required: true
 *         schema:
 *           type: integer
 *         description: PO ID
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of items per page
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter by creation date (start)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter by creation date (end)
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by status
 *     responses:
 *       200:
 *         description: Connected DC records
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BackpathPOResponse'
 *       404:
 *         description: PO not found
 *       500:
 *         description: Internal server error
 */
router.get("/po/:poId", async (req, res) => {
  const { poId } = req.params;
  const { page = 1, limit = 10, startDate, endDate, status } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  try {
    const poCheck = await pool.query("SELECT po_id FROM pos WHERE po_id = $1", [poId]);
    if (poCheck.rows.length === 0) {
      return res.status(404).json({ error: "PO not found" });
    }

    let dcQuery = "FROM delivery_challans WHERE po_id = $1";
    const dcValues = [poId];
    let dcp = 2;
    if (startDate) { dcQuery += ` AND created_at >= $${dcp++}`; dcValues.push(startDate); }
    if (endDate) { dcQuery += ` AND created_at <= $${dcp++}`; dcValues.push(endDate); }
    if (status) { dcQuery += ` AND status = $${dcp++}`; dcValues.push(status); }

    const totalDcsRes = await pool.query(`SELECT COUNT(*) ${dcQuery}`, dcValues);
    const totalDcs = parseInt(totalDcsRes.rows[0].count);
    const dcs = await pool.query(`SELECT * ${dcQuery} ORDER BY created_at DESC LIMIT $${dcp++} OFFSET $${dcp++}`, [...dcValues, Number(limit), offset]);

    res.json({
      totalCount: totalDcs,
      dcs: dcs.rows
    });
  } catch (error) {
    console.error("Backpath PO error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
