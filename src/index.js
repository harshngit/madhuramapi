const express = require("express");
require("dotenv").config();
const cors = require("cors");



const authRoutes = require("./routes/auth");

const app = express();

app.use(express.json());
app.use(express.static("public"));

app.use(cors({
  origin: "*", // for testing (later restrict to your frontend domain)
  credentials: true
}));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/auth", authRoutes);

app.use((req, res) => {
  res.status(404).json({ error: "not found" });
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on port ${port}`);
});