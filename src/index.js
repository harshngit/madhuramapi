const express = require("express");
require("dotenv").config();
const cors = require("cors");

const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./swagger");

const authRoutes = require("./routes/auth");
const projectRoutes = require("./routes/projects");
const compressionRoutes = require("./routes/compression");
const boqRoutes = require("./routes/boq");
const mirRoutes = require("./routes/mir");

const app = express();

// Enable JSON parsing for incoming requests
app.use(express.json());
// Serve static files like images, etc.
app.use(express.static("public"));

// Serve uploaded files via the URL path "/uploads"
app.use("/uploads", express.static("uploads"));

// Enable CORS for frontend integration
app.use(
  cors({
    origin: "*", // for testing, later restrict to your frontend domain
    credentials: true,
  })
);

// Swagger Documentation Setup
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/compress", compressionRoutes);
app.use("/api/boq", boqRoutes);
app.use("/api/mir", mirRoutes);

// 404 Error for undefined routes
app.use((req, res) => {
  res.status(404).json({ error: "not found" });
});

// Set the port from the environment or use default
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
