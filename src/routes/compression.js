const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const zlib = require('zlib');
const { compressPdf } = require('../utils/pdfCompressor');

const router = express.Router();

// Ensure uploads/compressed directory exists
const uploadDir = path.join(__dirname, '../../uploads');
const compressedDir = path.join(uploadDir, 'compressed');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
if (!fs.existsSync(compressedDir)) {
    fs.mkdirSync(compressedDir, { recursive: true });
}

// Configure Multer storage (temporary storage)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'temp-' + uniqueSuffix + path.extname(file.originalname));
    }
});

// Set limit to 50MB to allow larger files to be uploaded for compression
const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }
});

/**
 * @swagger
 * tags:
 *   name: Compression
 *   description: File compression API
 */

/**
 * @swagger
 * /api/compress:
 *   post:
 *     summary: Upload and compress a file
 *     description: Uploads a file and compresses it. For images, it iteratively reduces quality and resolution to ensure the output is under 10MB. For other files, it applies Gzip compression (best effort).
 *     tags: [Compression]
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: File compressed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 original_size:
 *                   type: string
 *                 compressed_size:
 *                   type: string
 *                 url:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Bad request
 *       500:
 *         description: Server error
 */
router.post('/', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const inputPath = req.file.path;
    const originalName = req.file.originalname;
    const originalSize = req.file.size;
    const mimeType = req.file.mimetype;

    // Generate output filename
    const timestamp = Date.now();
    const cleanName = path.parse(originalName).name.replace(/[^a-z0-9]/gi, '_').toLowerCase();

    let outputFilename;
    let outputPath;
    let compressionType = 'none';

    try {
        if (mimeType.startsWith('image/')) {
            // Handle Image Compression using Sharp
            outputFilename = `${cleanName}-${timestamp}.jpg`; // Convert to JPEG for consistency/compression
            outputPath = path.join(compressedDir, outputFilename);

            const TARGET_SIZE = 10 * 1024 * 1024; // 10MB

            // Step 1: Very High Quality (Try to keep original resolution if possible, or 4K)
            // If original is huge, downscale to 4K first
            await sharp(inputPath)
                .resize({ width: 5840, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 90, mozjpeg: true })
                .toFile(outputPath);

            let stats = fs.statSync(outputPath);

            // Step 2: High Quality (FHD) if > 10MB
            if (stats.size > TARGET_SIZE) {
                await sharp(inputPath)
                    .resize({ width: 1920, fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 85, mozjpeg: true })
                    .toFile(outputPath);

                stats = fs.statSync(outputPath);
            }

            // Step 3: Medium Quality if still > 10MB
            if (stats.size > TARGET_SIZE) {
                await sharp(inputPath)
                    .resize({ width: 1280, fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 70, mozjpeg: true })
                    .toFile(outputPath);

                stats = fs.statSync(outputPath);
            }

            // Step 4: Aggressive compression if still > 10MB (Last Resort)
            if (stats.size > TARGET_SIZE) {
                await sharp(inputPath)
                    .resize({ width: 800, fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 50, mozjpeg: true })
                    .toFile(outputPath);
            }

            compressionType = 'image-optimization';
        } else if (mimeType === 'application/pdf') {
            // Handle PDF Compression using Rasterization (re-render pages as images)
            // This is effective for scanned PDFs or high-res generated PDFs to reduce size < 10MB
            outputFilename = `${cleanName}-${timestamp}.pdf`;
            outputPath = path.join(compressedDir, outputFilename);

            await compressPdf(inputPath, outputPath);

            compressionType = 'pdf-rasterization';
        } else {
            // Handle other files using Gzip (Best compression)
            outputFilename = `${cleanName}-${timestamp}${path.extname(originalName)}.gz`;
            outputPath = path.join(compressedDir, outputFilename);

            // Use level 9 for maximum compression
            const gzip = zlib.createGzip({ level: 9 });
            const source = fs.createReadStream(inputPath);
            const destination = fs.createWriteStream(outputPath);

            await new Promise((resolve, reject) => {
                source.pipe(gzip).pipe(destination);
                destination.on('finish', resolve);
                destination.on('error', reject);
            });

            compressionType = mimeType === 'application/pdf' ? 'gzip (PDF)' : 'gzip';
        }

        // Get compressed size
        const compressedStats = fs.statSync(outputPath);
        const compressedSize = compressedStats.size;

        // Construct URL
        const protocol = req.protocol;
        const host = req.get('host');
        const url = `${protocol}://${host}/uploads/compressed/${outputFilename}`;

        // Cleanup original temp file
        fs.unlinkSync(inputPath);

        res.json({
            original_size: formatBytes(originalSize),
            compressed_size: formatBytes(compressedSize),
            url: url,
            message: `File compressed using ${compressionType}`
        });

    } catch (error) {
        console.error('Compression error:', error);
        // Try to cleanup temp file
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        res.status(500).json({ error: 'Failed to compress file' });
    }
});

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

module.exports = router;
