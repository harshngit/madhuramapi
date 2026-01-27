const moduleAlias = require('module-alias');
const path = require('path');

// Explicitly alias 'canvas' to the installed '@napi-rs/canvas' package
// We use path.resolve to ensure we get the correct absolute path to the module
moduleAlias.addAlias('canvas', path.join(__dirname, '../../node_modules/@napi-rs/canvas'));

const { createCanvas, Path2D, DOMMatrix } = require('@napi-rs/canvas');

// Polyfill globals for pdfjs-dist
global.Path2D = Path2D;
global.DOMMatrix = DOMMatrix;

const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const fs = require('fs');

// Custom Canvas Factory to use @napi-rs/canvas instead of 'canvas'
const canvasFactory = {
    create: function (width, height) {
        if (width <= 0 || height <= 0) {
            throw new Error("Invalid canvas size");
        }
        const canvas = createCanvas(width, height);
        return {
            canvas: canvas,
            context: canvas.getContext("2d"),
        };
    },
    reset: function (canvasAndContext, width, height) {
        if (!canvasAndContext.canvas) {
            throw new Error("Canvas is not specified");
        }
        if (width <= 0 || height <= 0) {
            throw new Error("Invalid canvas size");
        }
        canvasAndContext.canvas.width = width;
        canvasAndContext.canvas.height = height;
    },
    destroy: function (canvasAndContext) {
        if (!canvasAndContext.canvas) {
            throw new Error("Canvas is not specified");
        }
        canvasAndContext.canvas.width = 0;
        canvasAndContext.canvas.height = 0;
        canvasAndContext.canvas = null;
        canvasAndContext.context = null;
    },
};

/**
 * Compresses a PDF by converting pages to images, resizing/compressing them, and rebuilding the PDF.
 * @param {string} inputPath - Path to the input PDF.
 * @param {string} outputPath - Path to save the compressed PDF.
 * @param {number} targetSize - Target size in bytes (e.g., 10 * 1024 * 1024).
 * @returns {Promise<void>}
 */
async function compressPdf(inputPath, outputPath, targetSize = 10 * 1024 * 1024) {
    const inputBuffer = fs.readFileSync(inputPath);

    // Load the PDF
    const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(inputBuffer),
        standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/'
    });
    const pdfDocument = await loadingTask.promise;

    const newPdfDoc = await PDFDocument.create();

    // Determine compression settings based on page count to estimate target per page
    // This is a heuristic. 
    // If we have 20 pages and want 10MB, that's 0.5MB per page.
    // If we have 100 pages, 0.1MB per page.
    const sizePerPage = targetSize / pdfDocument.numPages;

    // Settings logic:
    // If sizePerPage is small (< 100KB), we need aggressive downsampling.
    // If sizePerPage is large (> 500KB), we can be generous.

    let scale = 1.5; // Default ~100-150 DPI
    let quality = 70;
    let resizeWidth = 1200;

    if (sizePerPage < 100 * 1024) { // < 100KB
        scale = 1.0;
        quality = 40;
        resizeWidth = 800;
    } else if (sizePerPage < 300 * 1024) { // < 300KB
        scale = 1.2;
        quality = 60;
        resizeWidth = 1000;
    }

    // console.log(`Compression Strategy: Pages=${pdfDocument.numPages}, Target=${targetSize}, PerPage=${sizePerPage}, Scale=${scale}, Q=${quality}, W=${resizeWidth}`);

    for (let i = 1; i <= pdfDocument.numPages; i++) {
        const page = await pdfDocument.getPage(i);
        const viewport = page.getViewport({ scale: scale });

        // Render to canvas
        const canvas = createCanvas(viewport.width, viewport.height);
        const context = canvas.getContext('2d');

        await page.render({
            canvasContext: context,
            viewport: viewport,
            canvasFactory: canvasFactory
        }).promise;

        // Convert to JPEG buffer
        const imageBuffer = canvas.toBuffer('image/jpeg', 80); // Initial high quality capture

        // Compress with Sharp
        const compressedImageBuffer = await sharp(imageBuffer)
            .resize({ width: resizeWidth, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: quality, mozjpeg: true })
            .toBuffer();

        // Embed in new PDF
        const embeddedImage = await newPdfDoc.embedJpg(compressedImageBuffer);
        const newPage = newPdfDoc.addPage([embeddedImage.width, embeddedImage.height]);
        newPage.drawImage(embeddedImage, {
            x: 0,
            y: 0,
            width: embeddedImage.width,
            height: embeddedImage.height,
        });

        // Release page resources
        page.cleanup();
    }

    const pdfBytes = await newPdfDoc.save();
    fs.writeFileSync(outputPath, pdfBytes);
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

module.exports = { compressPdf };
