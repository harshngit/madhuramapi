const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { pool } = require("../db");

const router = express.Router();

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, "../../uploads/boq");
if (!fs.existsSync(uploadDir)) {
	fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure Multer
const storage = multer.diskStorage({
	destination: function (req, file, cb) {
		cb(null, uploadDir);
	},
	filename: function (req, file, cb) {
		const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
		cb(null, "boq-" + uniqueSuffix + path.extname(file.originalname));
	},
});

const upload = multer({
	storage: storage,
	limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});

/**
 * @swagger
 * components:
 *   schemas:
 *     BOQ:
 *       type: object
 *       properties:
 *         boq_id:
 *           type: integer
 *         category:
 *           type: string
 *         item_code:
 *           type: string
 *         description:
 *           type: string
 *         floor:
 *           type: string
 *         unit:
 *           type: string
 *         quantity:
 *           type: number
 *         rate:
 *           type: number
 *         amount:
 *           type: number
 *         boq_file:
 *           type: string
 *         project_id:
 *           type: integer
 *         created_at:
 *           type: string
 *           format: date-time
 */

/**
 * @swagger
 * /api/boq:
 *   post:
 *     summary: Create a new BOQ item
 *     tags: [BOQ]
 *     consumes:
 *       - multipart/form-data
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               category:
 *                 type: string
 *               item_code:
 *                 type: string
 *               description:
 *                 type: string
 *               floor:
 *                 type: string
 *               unit:
 *                 type: string
 *               quantity:
 *                 type: number
 *               rate:
 *                 type: number
 *               amount:
 *                 type: number
 *               project_id:
 *                 type: integer
 *               boq_file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: BOQ created successfully
 *       500:
 *         description: Server error
 */
router.post("/", upload.single("boq_file"), async (req, res) => {
	try {
		const {
			category,
			item_code,
			description,
			floor,
			unit,
			quantity,
			rate,
			amount,
			project_id,
		} = req.body;

		const boq_file = req.file ? `/uploads/boq/${req.file.filename}` : null;

		const query = `
      INSERT INTO boqs (category, item_code, description, floor, unit, quantity, rate, amount, boq_file, project_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *;
    `;

		const values = [
			category,
			item_code,
			description,
			floor,
			unit,
			quantity,
			rate,
			amount,
			boq_file,
			project_id,
		];

		const result = await pool.query(query, values);
		res.status(201).json(result.rows[0]);
	} catch (error) {
		console.error("Error creating BOQ:", error);
		if (error.code === '23503') {
			return res.status(400).json({ error: "Invalid project_id: Project does not exist" });
		}
		res.status(500).json({ error: "Internal Server Error" });
	}
});

/**
 * @swagger
 * /api/boq:
 *   get:
 *     summary: Get all BOQ items
 *     tags: [BOQ]
 *     responses:
 *       200:
 *         description: List of all BOQs
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/BOQ'
 */
router.get("/", async (req, res) => {
	try {
		const result = await pool.query("SELECT * FROM boqs ORDER BY created_at DESC");
		res.json(result.rows);
	} catch (error) {
		console.error("Error fetching BOQs:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

/**
 * @swagger
 * /api/boq/{id}:
 *   get:
 *     summary: Get a BOQ item by ID
 *     tags: [BOQ]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: BOQ item details
 *       404:
 *         description: BOQ not found
 */
router.get("/:id", async (req, res) => {
	try {
		const { id } = req.params;
		const result = await pool.query("SELECT * FROM boqs WHERE boq_id = $1", [id]);

		if (result.rows.length === 0) {
			return res.status(404).json({ error: "BOQ not found" });
		}

		res.json(result.rows[0]);
	} catch (error) {
		console.error("Error fetching BOQ:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

/**
 * @swagger
 * /api/boq/project/{projectId}:
 *   get:
 *     summary: Get BOQ items by Project ID
 *     tags: [BOQ]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of BOQs for the project
 */
router.get("/project/:projectId", async (req, res) => {
	try {
		const { projectId } = req.params;
		const result = await pool.query("SELECT * FROM boqs WHERE project_id = $1 ORDER BY created_at DESC", [projectId]);
		res.json(result.rows);
	} catch (error) {
		console.error("Error fetching project BOQs:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

/**
 * @swagger
 * /api/boq/{id}:
 *   put:
 *     summary: Update a BOQ item
 *     tags: [BOQ]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               category:
 *                 type: string
 *               item_code:
 *                 type: string
 *               description:
 *                 type: string
 *               floor:
 *                 type: string
 *               unit:
 *                 type: string
 *               quantity:
 *                 type: number
 *               rate:
 *                 type: number
 *               amount:
 *                 type: number
 *               project_id:
 *                 type: integer
 *               boq_file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: BOQ updated successfully
 */
router.put("/:id", upload.single("boq_file"), async (req, res) => {
	try {
		const { id } = req.params;
		const {
			category,
			item_code,
			description,
			floor,
			unit,
			quantity,
			rate,
			amount,
			project_id,
		} = req.body;

		// Build update query dynamically
		let updateFields = [];
		let values = [];
		let counter = 1;

		if (category !== undefined) { updateFields.push(`category = $${counter++}`); values.push(category); }
		if (item_code !== undefined) { updateFields.push(`item_code = $${counter++}`); values.push(item_code); }
		if (description !== undefined) { updateFields.push(`description = $${counter++}`); values.push(description); }
		if (floor !== undefined) { updateFields.push(`floor = $${counter++}`); values.push(floor); }
		if (unit !== undefined) { updateFields.push(`unit = $${counter++}`); values.push(unit); }
		if (quantity !== undefined) { updateFields.push(`quantity = $${counter++}`); values.push(quantity); }
		if (rate !== undefined) { updateFields.push(`rate = $${counter++}`); values.push(rate); }
		if (amount !== undefined) { updateFields.push(`amount = $${counter++}`); values.push(amount); }
		if (project_id !== undefined) { updateFields.push(`project_id = $${counter++}`); values.push(project_id); }

		if (req.file) {
			const boq_file = `/uploads/boq/${req.file.filename}`;
			updateFields.push(`boq_file = $${counter++}`);
			values.push(boq_file);
		}

		if (updateFields.length === 0) {
			return res.status(400).json({ error: "No fields to update" });
		}

		values.push(id);
		const query = `UPDATE boqs SET ${updateFields.join(", ")} WHERE boq_id = $${counter} RETURNING *`;

		const result = await pool.query(query, values);

		if (result.rows.length === 0) {
			return res.status(404).json({ error: "BOQ not found" });
		}

		res.json(result.rows[0]);
	} catch (error) {
		console.error("Error updating BOQ:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

/**
 * @swagger
 * /api/boq/{id}:
 *   delete:
 *     summary: Delete a BOQ item
 *     tags: [BOQ]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: BOQ deleted successfully
 */
router.delete("/:id", async (req, res) => {
	try {
		const { id } = req.params;

		// First get the file path to delete it
		const checkQuery = "SELECT boq_file FROM boqs WHERE boq_id = $1";
		const checkResult = await pool.query(checkQuery, [id]);

		if (checkResult.rows.length === 0) {
			return res.status(404).json({ error: "BOQ not found" });
		}

		const fileUrl = checkResult.rows[0].boq_file;
		if (fileUrl) {
			// Extract filename from URL (assuming /uploads/boq/filename)
			const filename = path.basename(fileUrl);
			const filePath = path.join(uploadDir, filename);
			if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
			}
		}

		const deleteQuery = "DELETE FROM boqs WHERE boq_id = $1 RETURNING *";
		await pool.query(deleteQuery, [id]);

		res.json({ message: "BOQ deleted successfully" });
	} catch (error) {
		console.error("Error deleting BOQ:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

module.exports = router;
