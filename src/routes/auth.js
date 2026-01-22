const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");

const router = express.Router();
const ALLOWED_ROLES = new Set(["admin", "operational_manager", "po_officer", "labour"]);

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

function normalizePhone(phoneNumber) {
  return String(phoneNumber).trim();
}

function sanitizeUser(row) {
  return {
    user_id: row.user_id,
    username: row.name,
    name: row.name,
    email: row.email,
    phone_number: row.phone_number,
    role: row.role,
    project_list: row.project_list || [],
  };
}

function buildToken(user) {
  const payload = {
    user_id: user.user_id,
    email: user.email,
    role: user.role,
  };

  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });
}

router.post("/signup", async (req, res) => {
  try {
    const {
      username,
      name,
      email,
      phone_number,
      password,
      project,
      project_list,
      role,
    } = req.body;
    const usernameValue = username ?? name;

    if (!usernameValue || !email || !phone_number || !password || !role) {
      return res
        .status(400)
        .json({ error: "username, email, phone_number, password, and role are required" });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ error: "JWT_SECRET is not configured" });
    }

    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = normalizePhone(phone_number);
    const roleValue = String(role).trim();

    if (!ALLOWED_ROLES.has(roleValue)) {
      return res.status(400).json({ error: "invalid role" });
    }

    const existing = await pool.query(
      "SELECT email, phone_number FROM auth_users WHERE email = $1 OR phone_number = $2",
      [normalizedEmail, normalizedPhone]
    );

    if (existing.rowCount > 0) {
      const emailExists = existing.rows.some((row) => row.email === normalizedEmail);
      const phoneExists = existing.rows.some((row) => row.phone_number === normalizedPhone);
      if (emailExists) {
        return res.status(409).json({ error: "email already exists" });
      }
      if (phoneExists) {
        return res.status(409).json({ error: "phone number already exists" });
      }
    }

    const passwordHash = await bcrypt.hash(String(password), 12);
    const projects = Array.isArray(project_list)
      ? project_list.map((value) => String(value))
      : project
        ? [String(project).trim()]
        : [];

    const insert = await pool.query(
      `INSERT INTO auth_users (name, email, phone_number, password_hash, role, project_list)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING user_id, name, email, phone_number, role, project_list`,
      [String(usernameValue).trim(), normalizedEmail, normalizedPhone, passwordHash, roleValue, projects]
    );

    const user = sanitizeUser(insert.rows[0]);
    const token = buildToken(user);

    return res.status(201).json({ token, user, message: "signup successful" });
  } catch (error) {
    console.error("Signup error:", error);
    try { require('fs').writeFileSync("error.log", `Signup error: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}\n`); } catch (e) { console.error(e); }
    return res.status(500).json({ error: "failed to sign up" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ error: "JWT_SECRET is not configured" });
    }

    const normalizedEmail = normalizeEmail(email);

    const result = await pool.query(
      `SELECT user_id, name, email, phone_number, password_hash, role, project_list
       FROM auth_users
       WHERE email = $1`,
      [normalizedEmail]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "invalid credentials" });
    }

    const user = result.rows[0];
    const matches = await bcrypt.compare(String(password), user.password_hash);

    if (!matches) {
      return res.status(401).json({ error: "password does not match" });
    }

    const token = buildToken(user);
    const safeUser = sanitizeUser(user);

    return res.json({ token, user: safeUser, message: "login successful" });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "failed to log in" });
  }
});

router.post("/logout", (req, res) => {
  return res.json({ message: "logged out successfully" });
});

router.post("/forgot-password", async (req, res) => {
  try {
    const { email_id, password_change, re_typepassword } = req.body;

    if (!email_id || !password_change || !re_typepassword) {
      return res
        .status(400)
        .json({ error: "email_id, password_change, and re_typepassword are required" });
    }

    if (password_change !== re_typepassword) {
      return res.status(400).json({ error: "password does not match" });
    }

    const normalizedEmail = normalizeEmail(email_id);

    const existing = await pool.query(
      "SELECT user_id FROM auth_users WHERE email = $1",
      [normalizedEmail]
    );

    if (existing.rowCount === 0) {
      return res.status(401).json({ error: "email not found" });
    }

    const passwordHash = await bcrypt.hash(String(password_change), 12);
    await pool.query(
      "UPDATE auth_users SET password_hash = $1 WHERE email = $2",
      [passwordHash, normalizedEmail]
    );

    return res.json({ message: "password updated successfully" });
  } catch (error) {
    console.error("Forgot password error:", error);
    return res.status(500).json({ error: "failed to update password" });
  }
});

module.exports = router;
