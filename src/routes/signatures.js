const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Ensure upload directory exists
const uploadDir = path.join(__dirname, "../../uploads/signatures");
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
    cb(null, "sig-" + uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB limit for signature images
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|webp/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Only images (jpeg, jpg, png, webp) are allowed"));
  },
});

/**
 * @swagger
 * tags:
 *   name: Signatures
 *   description: Signature upload management
 */

/**
 * @swagger
 * /api/signatures/upload:
 *   post:
 *     summary: Upload a signature image
 *     tags: [Signatures]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               signature:
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
 *                 message: { type: string }
 *                 signatureUrl: { type: string }
 *       400:
 *         description: Bad request
 *       500:
 *         description: Server error
 */
router.post("/upload", upload.single("signature"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No signature file uploaded." });
    }

    // Construct the URL to access the file
    // Assuming the server serves static files from the 'uploads' directory
    const signatureUrl = `/uploads/signatures/${req.file.filename}`;

    res.status(200).json({
      message: "Signature uploaded successfully",
      signatureUrl: signatureUrl,
    });
  } catch (error) {
    console.error("Signature upload error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
