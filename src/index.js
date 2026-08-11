const express = require("express");
require("dotenv").config();
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");

const swaggerUi   = require("swagger-ui-express");
const swaggerSpec = require("./swagger");

// ─── Middleware ───────────────────────────────────────────────────────────────
const { apiLogger } = require("./middleware/apiLogger"); // ← NEW: live API logger

// ─── Routes ──────────────────────────────────────────────────────────────────
const authRoutes             = require("./routes/auth");
const projectRoutes          = require("./routes/projects");
const compressionRoutes      = require("./routes/compression");
const boqRoutes              = require("./routes/boq");
const mirRoutes              = require("./routes/mir");
const mirParserRoutes        = require("./routes/mir_parser");
const itrRoutes              = require("./routes/itr");
const poParserRoutes         = require("./routes/po_parser");
const poRoutes               = require("./routes/po");
const sampleRoutes           = require("./routes/sample");
const installationRoutes     = require("./routes/installation");
const inventoryRoutes        = require("./routes/inventory");
const inventoryHistoryRoutes = require("./routes/inventory_history");
const deliveryChallanRoutes  = require("./routes/delivery_challan");
const vendorRoutes           = require("./routes/vendor");
const vendorPriceListRoutes  = require("./routes/vendor_price_list");
const prRoutes               = require("./routes/pr");
const attendanceRoutes       = require("./routes/attendance");
const quotationRoutes        = require("./routes/quotation");
const bulkInventoryRoutes    = require("./routes/vendor_price_list_bulk_inventory");
const traceRoutes            = require("./routes/inventory_trace");
const accessControlRoutes    = require("./routes/access_control");
const apiLogsRoutes          = require("./routes/api_logs"); // ← NEW
const leaveRoutes = require("./routes/leave");
const backpathRoutes = require("./routes/backpath");
const vendorComparisonRoutes = require("./routes/vendor_comparison");
const lodhaInvoiceRoutes     = require("./routes/lodha_invoice");
const hiranandaniInvoiceRoutes = require("./routes/hiranandani_invoice");
const signatureRoutes        = require("./routes/signatures");
const notificationRoutes     = require("./routes/notifications");

// Dashboard + Activity + WebSocket
const { router: dashboardRouter, wsHandler } = require("./routes/dashboard");
const { startAttendanceCrons } = require("./cron/attendanceCron");

const app = express();

// ─────────────────────────────────────────────────────────────────────────────
// ✅ Increase JSON payload limit from default 100kb → 50mb
// This resolves "PayloadTooLargeError" when submitting large quotations
// with many items (like the Oakwood / Lodha BOQ with 300+ line items).
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));
app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);

// Swagger
const swaggerOptions = {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: "Madhuram API Docs",
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    filter: true,
    tryItOutEnabled: true,
    // Add theme selection logic if needed, but standard UI supports simple CSS injection
  }
};

// Dark mode can be toggled via a simple CSS injection in Swagger UI setup
const darkThemeCss = `
  .swagger-ui { filter: invert(88%) hue-rotate(180deg); background: #1b1b1b; }
  .swagger-ui .microlight { filter: invert(100%) hue-rotate(180deg); }
`;

app.use("/docs", swaggerUi.serve, (req, res) => {
  const theme = req.query.theme || 'light';
  const options = { ...swaggerOptions };
  if (theme === 'dark') {
    options.customCss = (options.customCss || '') + darkThemeCss;
  }
  swaggerUi.setup(swaggerSpec, options)(req, res);
});

// Health check (not logged — see apiLogger skip list)
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ─────────────────────────────────────────────────────────────────────────────
// ✅ NEW: Live API request logger
// Must be registered AFTER body parsers and BEFORE route handlers so the
// middleware can read req.body and intercept res.json / res.send correctly.
// ─────────────────────────────────────────────────────────────────────────────
app.use(apiLogger);

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use("/api/auth",              authRoutes);
app.use("/api/projects",          projectRoutes);
app.use("/api/compress",          compressionRoutes);
app.use("/api/boq",               boqRoutes);
app.use("/api/po-parser",         poParserRoutes);
app.use("/api/mir",               mirRoutes);
app.use("/api/mir-parser",        mirParserRoutes);
app.use("/api/itr",               itrRoutes);
app.use("/api/po",                poRoutes);
app.use("/api/sample",            sampleRoutes);
app.use("/api/installation",      installationRoutes);
app.use("/api/inventory",         inventoryRoutes);
app.use("/api/inventory-history", inventoryHistoryRoutes);
app.use("/api/dc",                deliveryChallanRoutes);
app.use("/api/vendors",           vendorRoutes);
app.use("/api/vendor-price-list", vendorPriceListRoutes);
app.use("/api/pr",                prRoutes);
app.use("/api/attendance",        attendanceRoutes);
app.use("/api/quotations",        quotationRoutes);
app.use("/api/quotation",         quotationRoutes); // supports both singular and plural
app.use("/api/vendor-price-list", bulkInventoryRoutes);
app.use("/api/inventory-trace",   traceRoutes);
app.use("/api/access",            accessControlRoutes);
app.use("/api/leave", leaveRoutes);
app.use("/api/logs",              apiLogsRoutes); // ← NEW: live API log viewer
app.use("/api/backpath", backpathRoutes);
app.use("/api/vendor-comparison", vendorComparisonRoutes);
app.use("/api/lodha-invoice",     lodhaInvoiceRoutes);
app.use("/api/hiranandani-invoice", hiranandaniInvoiceRoutes);
app.use("/api/signatures",        signatureRoutes);
app.use("/api/notifications",     notificationRoutes);

// Dashboard + Activityroutes
app.use("/api/dashboard", dashboardRouter);

// 404
app.use((req, res) => {
  res.status(404).json({ error: "not found" });
});

// ─── Create HTTP server (needed for WebSocket to share same port) ─────────────
const server = http.createServer(app);

// ─── WebSocket server on /ws/activity ────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws/activity" });
wss.on("connection", wsHandler);
console.log("WebSocket server ready at ws://localhost:<port>/ws/activity");

// ─── Start ────────────────────────────────────────────────────────────────────
const port = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
  startAttendanceCrons();
});
