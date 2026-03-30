const express = require("express");
require("dotenv").config();
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");

const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./swagger");

const authRoutes = require("./routes/auth");
const projectRoutes = require("./routes/projects");
const compressionRoutes = require("./routes/compression");
const boqRoutes = require("./routes/boq");
const mirRoutes = require("./routes/mir");
const mirParserRoutes = require("./routes/mir_parser");
const itrRoutes = require("./routes/itr");
const poParserRoutes = require("./routes/po_parser");
const poRoutes = require("./routes/po");
const sampleRoutes = require("./routes/sample");
const inventoryRoutes = require("./routes/inventory");
const deliveryChallanRoutes = require("./routes/delivery_challan");
const vendorRoutes = require("./routes/vendor");
const vendorPriceListRoutes = require("./routes/vendor_price_list");
const prRoutes = require("./routes/pr");
const attendanceRoutes = require("./routes/attendance");
const quotationRoutes = require("./routes/quotation");
const bulkInventoryRoutes = require("./routes/vendor_price_list_bulk_inventory");


// ✅ NEW: Dashboard + Activity + WebSocket
const { router: dashboardRouter, wsHandler } = require("./routes/dashboard");

const app = express();

app.use(express.json());
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));
app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);

// Swagger
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/compress", compressionRoutes);
app.use("/api/boq", boqRoutes);
app.use("/api/po-parser", poParserRoutes);
app.use("/api/mir", mirRoutes);
app.use("/api/mir-parser", mirParserRoutes);
app.use("/api/itr", itrRoutes);
app.use("/api/po", poRoutes);
app.use("/api/sample", sampleRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/dc", deliveryChallanRoutes);
app.use("/api/vendors", vendorRoutes);
app.use("/api/vendor-price-list", vendorPriceListRoutes);
app.use("/api/pr", prRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/quotations", quotationRoutes);
app.use("/api/vendor-price-list", bulkInventoryRoutes);

// ✅ NEW: Dashboard routes
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
});
