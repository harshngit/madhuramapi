const express = require("express");
const router  = express.Router();
const { pool } = require("../db");

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: build full access object for a user
// Returns: { pages: [...], functions: [...], page_map, function_map }
// ─────────────────────────────────────────────────────────────────────────────
async function buildUserAccessMap(user_id) {
  // All pages + this user's page-level access
  const pagesRes = await pool.query(
    `SELECT
       p.page_id,
       p.page_path,
       p.page_title,
       p.category,
       p.description,
       p.sort_order,
       COALESCE(upa.has_access, FALSE) AS has_access,
       upa.granted_by_name,
       upa.updated_at
     FROM access_pages p
     LEFT JOIN user_page_access upa
            ON upa.page_id = p.page_id AND upa.user_id = $1
     WHERE p.is_active = TRUE
     ORDER BY p.sort_order ASC`,
    [user_id]
  );

  // All functions + this user's function-level access
  const funcsRes = await pool.query(
    `SELECT
       f.function_id,
       f.function_key,
       f.label,
       f.description,
       f.page_id,
       p.page_path,
       p.page_title,
       p.category,
       COALESCE(ufa.has_access, FALSE) AS has_access,
       ufa.granted_by_name,
       ufa.updated_at
     FROM access_functions f
     JOIN access_pages p ON p.page_id = f.page_id
     LEFT JOIN user_function_access ufa
            ON ufa.function_id = f.function_id AND ufa.user_id = $1
     WHERE f.is_active = TRUE AND p.is_active = TRUE
     ORDER BY p.sort_order ASC, f.function_id ASC`,
    [user_id]
  );

  // Flat map: { '/projects': true, '/inventory': false, ... }
  const page_map = {};
  pagesRes.rows.forEach(r => { page_map[r.page_path] = r.has_access; });

  // Flat map: { 'projects.create': true, 'inventory.delete': false, ... }
  const function_map = {};
  funcsRes.rows.forEach(r => { function_map[r.function_key] = r.has_access; });

  // Group pages with their nested functions
  const pages = pagesRes.rows.map(page => ({
    ...page,
    functions: funcsRes.rows
      .filter(f => f.page_id === page.page_id)
      .map(f => ({
        function_id:     f.function_id,
        function_key:    f.function_key,
        label:           f.label,
        description:     f.description,
        has_access:      f.has_access,
        granted_by_name: f.granted_by_name,
        updated_at:      f.updated_at,
      })),
  }));

  return { pages, page_map, function_map };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/access/catalog
// Returns all pages + functions from the DB (mirrors ACCESS_CONTROL_CATALOG)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/access/catalog:
 *   get:
 *     summary: Get all pages and their functions (the access catalog)
 *     tags: [Access Control]
 *     responses:
 *       200:
 *         description: Full catalog grouped by page
 */
router.get("/catalog", async (req, res) => {
  try {
    const pagesRes = await pool.query(
      `SELECT page_id, page_path, page_title, category, description, sort_order
       FROM access_pages WHERE is_active = TRUE ORDER BY sort_order ASC`
    );
    const funcsRes = await pool.query(
      `SELECT f.function_id, f.function_key, f.label, f.description, f.page_id
       FROM access_functions f
       JOIN access_pages p ON p.page_id = f.page_id
       WHERE f.is_active = TRUE AND p.is_active = TRUE
       ORDER BY f.function_id ASC`
    );

    // Group functions under their pages
    const catalog = pagesRes.rows.map(page => ({
      ...page,
      functions: funcsRes.rows.filter(f => f.page_id === page.page_id),
    }));

    res.json(catalog);
  } catch (err) {
    console.error("Error fetching catalog:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/access/user/:user_id
// Full access map for one user — pages + functions with has_access true/false
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/access/user/{user_id}:
 *   get:
 *     summary: Get full access map for a user (pages + granular functions)
 *     tags: [Access Control]
 *     description: |
 *       Returns:
 *         - pages[]  → each page with has_access + its functions[] with has_access
 *         - page_map → flat { '/projects': true, ... }
 *         - function_map → flat { 'projects.create': true, 'inventory.delete': false, ... }
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Full access map
 *       404:
 *         description: User not found
 */
router.get("/user/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;

    const userRes = await pool.query(
      "SELECT user_id, name, email, role FROM auth_users WHERE user_id = $1",
      [user_id]
    );
    if (userRes.rows.length === 0)
      return res.status(404).json({ error: "User not found" });

    const { pages, page_map, function_map } = await buildUserAccessMap(user_id);

    res.json({
      user:         userRes.rows[0],
      pages,           // Full nested structure: page → functions
      page_map,        // Flat: { '/projects': true }
      function_map,    // Flat: { 'projects.create': true }
    });
  } catch (err) {
    console.error("Error fetching user access:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/access/check/:user_id
// Quick check — pass ?keys=projects.create,inventory.delete as query param
// Returns: { 'projects.create': true, 'inventory.delete': false }
// OR pass ?page=/projects to check page-level only
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/access/check/{user_id}:
 *   get:
 *     summary: Quick access check for one or more function keys or a page
 *     tags: [Access Control]
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: keys
 *         schema: { type: string }
 *         description: Comma-separated function keys e.g. projects.create,inventory.delete
 *       - in: query
 *         name: page
 *         schema: { type: string }
 *         description: Page path e.g. /projects
 *     responses:
 *       200:
 *         description: Map of key → true/false
 */
router.get("/check/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;
    const { keys, page } = req.query;

    if (!keys && !page)
      return res.status(400).json({ error: "Provide ?keys=key1,key2 or ?page=/path" });

    // Page-level check
    if (page) {
      const result = await pool.query(
        `SELECT COALESCE(upa.has_access, FALSE) AS has_access
         FROM access_pages p
         LEFT JOIN user_page_access upa ON upa.page_id = p.page_id AND upa.user_id = $1
         WHERE p.page_path = $2 AND p.is_active = TRUE`,
        [user_id, page]
      );
      if (result.rows.length === 0)
        return res.status(404).json({ error: `Page '${page}' not found` });

      return res.json({ page, has_access: result.rows[0].has_access });
    }

    // Function-level check for multiple keys
    const keyList = keys.split(",").map(k => k.trim()).filter(Boolean);
    if (keyList.length === 0)
      return res.status(400).json({ error: "No valid keys provided" });

    const result = await pool.query(
      `SELECT
         f.function_key,
         COALESCE(ufa.has_access, FALSE) AS has_access
       FROM access_functions f
       LEFT JOIN user_function_access ufa
              ON ufa.function_id = f.function_id AND ufa.user_id = $1
       WHERE f.function_key = ANY($2) AND f.is_active = TRUE`,
      [user_id, keyList]
    );

    // Build result map
    const access_map = {};
    // Default all requested keys to false
    keyList.forEach(k => { access_map[k] = false; });
    // Override with DB values
    result.rows.forEach(r => { access_map[r.function_key] = r.has_access; });

    res.json(access_map);
  } catch (err) {
    console.error("Error checking access:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/access/all-users
// Returns all users with their full access maps — for the Settings page table
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/access/all-users:
 *   get:
 *     summary: Get all users with their complete access maps (for Settings page)
 *     tags: [Access Control]
 *     responses:
 *       200:
 *         description: Array of users each with page_map and function_map
 */
router.get("/all-users", async (req, res) => {
  try {
    const usersRes = await pool.query(
      "SELECT user_id, name, email, role FROM auth_users ORDER BY name ASC"
    );

    // Get all pages and functions in two queries (efficient, not N+1)
    const pagesRes = await pool.query(
      `SELECT page_id, page_path, page_title, category, sort_order
       FROM access_pages WHERE is_active = TRUE ORDER BY sort_order ASC`
    );
    const funcsRes = await pool.query(
      `SELECT f.function_id, f.function_key, f.label, f.page_id
       FROM access_functions f
       JOIN access_pages p ON p.page_id = f.page_id
       WHERE f.is_active = TRUE AND p.is_active = TRUE`
    );
    const pageAccessRes = await pool.query(
      "SELECT user_id, page_id, has_access FROM user_page_access"
    );
    const funcAccessRes = await pool.query(
      "SELECT user_id, function_id, has_access FROM user_function_access"
    );

    // Build lookup maps
    const pageAccessMap  = {}; // [user_id][page_id] = bool
    const funcAccessMap  = {}; // [user_id][function_id] = bool
    pageAccessRes.rows.forEach(r => {
      if (!pageAccessMap[r.user_id]) pageAccessMap[r.user_id] = {};
      pageAccessMap[r.user_id][r.page_id] = r.has_access;
    });
    funcAccessRes.rows.forEach(r => {
      if (!funcAccessMap[r.user_id]) funcAccessMap[r.user_id] = {};
      funcAccessMap[r.user_id][r.function_id] = r.has_access;
    });

    const users = usersRes.rows.map(user => {
      const uid = user.user_id;
      const page_map     = {};
      const function_map = {};

      const pages = pagesRes.rows.map(page => {
        const hasPageAccess = pageAccessMap[uid]?.[page.page_id] ?? false;
        page_map[page.page_path] = hasPageAccess;

        const functions = funcsRes.rows
          .filter(f => f.page_id === page.page_id)
          .map(f => {
            const hasFnAccess = funcAccessMap[uid]?.[f.function_id] ?? false;
            function_map[f.function_key] = hasFnAccess;
            return {
              function_id:  f.function_id,
              function_key: f.function_key,
              label:        f.label,
              has_access:   hasFnAccess,
            };
          });

        return {
          page_id:    page.page_id,
          page_path:  page.page_path,
          page_title: page.page_title,
          category:   page.category,
          has_access: hasPageAccess,
          functions,
        };
      });

      return { ...user, pages, page_map, function_map };
    });

    res.json({
      pages: pagesRes.rows,   // catalog reference
      users,
    });
  } catch (err) {
    console.error("Error fetching all users:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/access/user/:user_id/page/:page_path
// Set page-level access for a user (true / false)
// Body: { has_access: bool, granted_by: uuid, granted_by_name: string }
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/access/user/{user_id}/page/{page_path}:
 *   put:
 *     summary: Grant or revoke page-level access for a user
 *     tags: [Access Control]
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: page_path
 *         required: true
 *         schema: { type: string }
 *         description: URL-encoded page path e.g. %2Fprojects
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [has_access]
 *             properties:
 *               has_access:      { type: boolean }
 *               granted_by:      { type: string, format: uuid }
 *               granted_by_name: { type: string }
 *     responses:
 *       200:
 *         description: Page access updated
 *       404:
 *         description: User or page not found
 */
router.put("/user/:user_id/page/*wildcard_path", async (req, res) => {
  try {
    const { user_id, wildcard_path }                  = req.params;
    const page_path                                   = "/" + wildcard_path;
    const { has_access, granted_by, granted_by_name } = req.body;

    if (typeof has_access !== "boolean")
      return res.status(400).json({ error: "has_access must be a boolean" });

    const userRes = await pool.query(
      "SELECT user_id, name FROM auth_users WHERE user_id = $1", [user_id]
    );
    if (userRes.rows.length === 0)
      return res.status(404).json({ error: "User not found" });

    const pageRes = await pool.query(
      "SELECT page_id, page_title FROM access_pages WHERE page_path = $1 AND is_active = TRUE",
      [page_path]
    );
    if (pageRes.rows.length === 0)
      return res.status(404).json({ error: `Page '${page_path}' not found` });

    const page_id = pageRes.rows[0].page_id;

    await pool.query(
      `INSERT INTO user_page_access (user_id, page_id, has_access, granted_by, granted_by_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, page_id) DO UPDATE SET
         has_access      = EXCLUDED.has_access,
         granted_by      = EXCLUDED.granted_by,
         granted_by_name = EXCLUDED.granted_by_name,
         updated_at      = NOW()`,
      [user_id, page_id, has_access, granted_by || null, granted_by_name || null]
    );

    res.json({
      message:    `Page '${page_path}' access ${has_access ? "granted" : "revoked"}`,
      user_id,
      user_name:  userRes.rows[0].name,
      page_path,
      page_title: pageRes.rows[0].page_title,
      has_access,
    });
  } catch (err) {
    console.error("Error updating page access:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/access/user/:user_id/function/:function_key
// Set a single function-level access for a user
// Body: { has_access: bool, granted_by: uuid, granted_by_name: string }
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/access/user/{user_id}/function/{function_key}:
 *   put:
 *     summary: Grant or revoke a specific function for a user
 *     tags: [Access Control]
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: function_key
 *         required: true
 *         schema: { type: string }
 *         description: e.g. projects.create, inventory.delete
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [has_access]
 *             properties:
 *               has_access:      { type: boolean }
 *               granted_by:      { type: string, format: uuid }
 *               granted_by_name: { type: string }
 *     responses:
 *       200:
 *         description: Function access updated
 *       404:
 *         description: User or function not found
 */
router.put("/user/:user_id/function/:function_key", async (req, res) => {
  try {
    const { user_id, function_key }                   = req.params;
    const { has_access, granted_by, granted_by_name } = req.body;

    if (typeof has_access !== "boolean")
      return res.status(400).json({ error: "has_access must be a boolean" });

    const userRes = await pool.query(
      "SELECT user_id, name FROM auth_users WHERE user_id = $1", [user_id]
    );
    if (userRes.rows.length === 0)
      return res.status(404).json({ error: "User not found" });

    const fnRes = await pool.query(
      "SELECT function_id, label FROM access_functions WHERE function_key = $1 AND is_active = TRUE",
      [function_key]
    );
    if (fnRes.rows.length === 0)
      return res.status(404).json({ error: `Function '${function_key}' not found` });

    const function_id = fnRes.rows[0].function_id;

    await pool.query(
      `INSERT INTO user_function_access (user_id, function_id, has_access, granted_by, granted_by_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, function_id) DO UPDATE SET
         has_access      = EXCLUDED.has_access,
         granted_by      = EXCLUDED.granted_by,
         granted_by_name = EXCLUDED.granted_by_name,
         updated_at      = NOW()`,
      [user_id, function_id, has_access, granted_by || null, granted_by_name || null]
    );

    res.json({
      message:       `Function '${function_key}' access ${has_access ? "granted" : "revoked"}`,
      user_id,
      user_name:     userRes.rows[0].name,
      function_key,
      function_label: fnRes.rows[0].label,
      has_access,
    });
  } catch (err) {
    console.error("Error updating function access:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/access/user/:user_id/bulk
// Set many page + function permissions at once in one transaction
//
// Body:
// {
//   pages:     { '/projects': true, '/inventory': false },      ← page-level
//   functions: { 'projects.create': true, 'inventory.delete': false }, ← function-level
//   granted_by: "uuid",
//   granted_by_name: "Admin"
// }
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/access/user/{user_id}/bulk:
 *   put:
 *     summary: Set many page and function permissions at once
 *     tags: [Access Control]
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               pages:
 *                 type: object
 *                 description: page_path → boolean
 *                 example: { '/projects': true, '/inventory': false }
 *               functions:
 *                 type: object
 *                 description: function_key → boolean
 *                 example: { 'projects.create': true, 'inventory.delete': false }
 *               granted_by:      { type: string, format: uuid }
 *               granted_by_name: { type: string }
 *     responses:
 *       200:
 *         description: All permissions updated in one transaction
 *       404:
 *         description: User not found
 */
router.put("/user/:user_id/bulk", async (req, res) => {
  const client = await pool.connect();
  try {
    const { user_id }                                             = req.params;
    const { pages = {}, functions = {}, granted_by, granted_by_name } = req.body;

    const userRes = await pool.query(
      "SELECT user_id, name FROM auth_users WHERE user_id = $1", [user_id]
    );
    if (userRes.rows.length === 0)
      return res.status(404).json({ error: "User not found" });

    // Preload lookups
    const pageMapRes = await pool.query(
      "SELECT page_id, page_path FROM access_pages WHERE is_active = TRUE"
    );
    const fnMapRes   = await pool.query(
      "SELECT function_id, function_key FROM access_functions WHERE is_active = TRUE"
    );

    const pathToId   = {};
    const keyToId    = {};
    pageMapRes.rows.forEach(r => { pathToId[r.page_path]     = r.page_id; });
    fnMapRes.rows.forEach(r =>   { keyToId[r.function_key]   = r.function_id; });

    await client.query("BEGIN");

    const updatedPages     = [];
    const updatedFunctions = [];
    const skipped          = [];

    // Upsert page permissions
    for (const [page_path, has_access] of Object.entries(pages)) {
      if (typeof has_access !== "boolean") {
        skipped.push({ page_path, reason: "value must be boolean" }); continue;
      }
      const page_id = pathToId[page_path];
      if (!page_id) {
        skipped.push({ page_path, reason: "page not found" }); continue;
      }
      await client.query(
        `INSERT INTO user_page_access (user_id, page_id, has_access, granted_by, granted_by_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, page_id) DO UPDATE SET
           has_access = EXCLUDED.has_access,
           granted_by = EXCLUDED.granted_by,
           granted_by_name = EXCLUDED.granted_by_name,
           updated_at = NOW()`,
        [user_id, page_id, has_access, granted_by || null, granted_by_name || null]
      );
      updatedPages.push({ page_path, has_access });
    }

    // Upsert function permissions
    for (const [function_key, has_access] of Object.entries(functions)) {
      if (typeof has_access !== "boolean") {
        skipped.push({ function_key, reason: "value must be boolean" }); continue;
      }
      const function_id = keyToId[function_key];
      if (!function_id) {
        skipped.push({ function_key, reason: "function not found" }); continue;
      }
      await client.query(
        `INSERT INTO user_function_access (user_id, function_id, has_access, granted_by, granted_by_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, function_id) DO UPDATE SET
           has_access = EXCLUDED.has_access,
           granted_by = EXCLUDED.granted_by,
           granted_by_name = EXCLUDED.granted_by_name,
           updated_at = NOW()`,
        [user_id, function_id, has_access, granted_by || null, granted_by_name || null]
      );
      updatedFunctions.push({ function_key, has_access });
    }

    await client.query("COMMIT");

    res.json({
      message:          `${updatedPages.length} page(s) and ${updatedFunctions.length} function(s) updated`,
      user_id,
      user_name:        userRes.rows[0].name,
      updated_pages:    updatedPages,
      updated_functions: updatedFunctions,
      skipped,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error bulk updating access:", err);
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/access/user/:user_id
// Reset ALL page + function permissions for a user (revoke everything)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/access/user/{user_id}:
 *   delete:
 *     summary: Revoke all page and function permissions for a user
 *     tags: [Access Control]
 *     parameters:
 *       - in: path
 *         name: user_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: All permissions revoked
 *       404:
 *         description: User not found
 */
router.delete("/user/:user_id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { user_id } = req.params;

    const userRes = await pool.query(
      "SELECT user_id, name FROM auth_users WHERE user_id = $1", [user_id]
    );
    if (userRes.rows.length === 0)
      return res.status(404).json({ error: "User not found" });

    await client.query("BEGIN");
    const p = await client.query("DELETE FROM user_page_access     WHERE user_id = $1", [user_id]);
    const f = await client.query("DELETE FROM user_function_access WHERE user_id = $1", [user_id]);
    await client.query("COMMIT");

    res.json({
      message:            `All permissions revoked for '${userRes.rows[0].name}'`,
      user_id,
      pages_revoked:      p.rowCount,
      functions_revoked:  f.rowCount,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error resetting user access:", err);
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    client.release();
  }
});

module.exports = router;