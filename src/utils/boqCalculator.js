/**
 * boqCalculator.js
 *
 * Server-side BOQ calculation engine.
 * Mirrors the logic in QuotesCreate.jsx (handleBoqFile + updatePreviewCell)
 * exactly, so the backend can recompute / validate every row before saving.
 *
 * FORMULA (from the frontend spec):
 *   percentSum  = SUM of all percent_addon column values for this row
 *   basicRate   = row.basic_rate  (fallback: row.rate)  when > 0
 *   discount    = row.discount   (a percentage: 10 = 10 %)
 *
 *   total_rate  = basicRate
 *                 + (basicRate * percentSum / 100)
 *                 - (basicRate * discount   / 100)
 *
 *   amount                    = total_rate * quantity
 *   final_rate_after_discount = amount          (always an alias of amount)
 *
 * Usage:
 *   const { recalculateItem, recalculateItems, PERCENT_ADDON_KEYS } = require("./boqCalculator");
 */

"use strict";

// ─── Default percent-addon field keys ────────────────────────────────────────
// These match the frontend defaults in QuotesCreate.jsx.
// When a new dynamic field is added with field_role = 'percent_addon',
// its field_key should be appended to this list before calling recalculate*.
const PERCENT_ADDON_KEYS = [
  "fittings",
  "transportation",
  "support",
  "miscellaneous",
  "total_material_price",
  "labour",
  "material_plus_labour",
  "profit",
];

/**
 * Convert a value to a number, exactly as the frontend does:
 *   - Removes commas from strings ("1,200" → 1200)
 *   - Non-numeric → 0
 *   - null / undefined → 0
 */
function toNumber(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === "number") return isFinite(val) ? val : 0;
  // string path
  const cleaned = String(val).replace(/,/g, "");
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}

/**
 * Recalculate a single BOQ row (item object).
 *
 * @param {Object}   item              - The item/row object (fields as properties)
 * @param {string[]} percentAddonKeys  - Which keys count as percent add-ons
 *                                       (pass the extended list when custom fields exist)
 * @returns {Object} A NEW item object with total_rate, amount,
 *                   and final_rate_after_discount updated.
 *                   All original fields are preserved.
 */
function recalculateItem(item, percentAddonKeys = PERCENT_ADDON_KEYS) {
  // 1. basicRate: prefer basic_rate; fall back to rate
  const basicRate = toNumber(item.basic_rate) || toNumber(item.rate);

  // 2. discount percentage
  const discount = toNumber(item.discount);

  // 3. percentSum: sum of all percent-addon columns present on this row
  const percentSum = percentAddonKeys.reduce((acc, key) => {
    return acc + toNumber(item[key]);
  }, 0);

  // 4. total_rate
  const totalRate = basicRate
    + (basicRate * percentSum) / 100
    - (basicRate * discount)  / 100;

  // 5. quantity → amount
  const qty    = toNumber(item.quantity);
  const amount = parseFloat((totalRate * qty).toFixed(6));

  // 6. final_rate_after_discount is always = amount
  return {
    ...item,
    total_rate:                 parseFloat(totalRate.toFixed(6)),
    amount,
    final_rate_after_discount:  amount,
  };
}

/**
 * Recalculate every item in an array.
 *
 * @param {Object[]} items             - Array of item objects
 * @param {string[]} percentAddonKeys  - Which keys are percent add-ons
 * @returns {Object[]} New array with all items recalculated
 */
function recalculateItems(items, percentAddonKeys = PERCENT_ADDON_KEYS) {
  return items.map((item) => recalculateItem(item, percentAddonKeys));
}

/**
 * Build an extended percent-addon key list that includes any active
 * dynamic fields whose field_role is 'percent_addon'.
 *
 * Call this once per request when you have fetched field definitions
 * from the DB:
 *
 *   const fieldDefs   = await pool.query("SELECT * FROM quotation_field_definitions WHERE is_active");
 *   const addonKeys   = buildAddonKeys(fieldDefs.rows);
 *   const recalcItems = recalculateItems(items, addonKeys);
 *
 * @param {Object[]} fieldDefinitions - Rows from quotation_field_definitions
 * @returns {string[]}
 */
function buildAddonKeys(fieldDefinitions) {
  const dynamicAddonKeys = fieldDefinitions
    .filter((f) => f.field_role === "percent_addon" && f.is_active)
    .map((f) => f.field_key);

  // Merge: start with defaults, append any dynamic ones not already present
  const merged = [...PERCENT_ADDON_KEYS];
  for (const key of dynamicAddonKeys) {
    if (!merged.includes(key)) merged.push(key);
  }
  return merged;
}

/**
 * Compute the header totals shown at the bottom of the BOQ grid.
 * Matches the "Totals shown under the sheet" section of the spec.
 *
 * Summed fields (ignoring non-finite values):
 *   basic_rate, discount, final_rate_after_discount,
 *   fittings, transportation, support, miscellaneous,
 *   total_material_price, labour, material_plus_labour,
 *   profit, total_rate
 *
 * Total Amount = sum of each row's `amount` field.
 *
 * @param {Object[]} items
 * @returns {Object} totals keyed by field name, plus `total_amount`
 */
function computeTotals(items) {
  const sumFields = [
    "basic_rate", "discount", "final_rate_after_discount",
    "fittings", "transportation", "support", "miscellaneous",
    "total_material_price", "labour", "material_plus_labour",
    "profit", "total_rate",
  ];

  const totals = {};
  for (const field of sumFields) {
    totals[field] = items.reduce((acc, row) => {
      const n = Number(row[field]);
      return acc + (isFinite(n) ? n : 0);
    }, 0);
  }

  totals.total_amount = items.reduce((acc, row) => {
    const n = Number(row.amount);
    return acc + (isFinite(n) ? n : 0);
  }, 0);

  return totals;
}

module.exports = {
  PERCENT_ADDON_KEYS,
  toNumber,
  recalculateItem,
  recalculateItems,
  buildAddonKeys,
  computeTotals,
};
