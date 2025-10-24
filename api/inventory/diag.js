// api/inventory/diag.js 
const { ok, bad, method, withCORS } = require("../_lib/respond");
const Store = require("../_lib/store");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { withCORS(res); return res.status(204).end(); }
  if (req.method !== "GET") return method(res, ["GET","OPTIONS"]);
  withCORS(res);

  try {
    const meta = await Store.getInventoryMeta();
    const data = await Store.getInventory();
    const head = data[0] || {};
    const sample = data.slice(0, 5);
    const env = {
      hasRedis: !!process.env.REDIS_URL,
      INVENTORY_SHEET_ID: !!process.env.INVENTORY_SHEET_ID,
      DRIVE_FILE_ID: !!process.env.DRIVE_FILE_ID,
      DRIVE_SHEET_TAB: process.env.DRIVE_SHEET_TAB || null,
      GOOGLE_CREDENTIALS_JSON: !!process.env.GOOGLE_CREDENTIALS_JSON,
      GOOGLE_SERVICE_ACCOUNT_EMAIL: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY,
      REDIS_PREFIX: process.env.REDIS_PREFIX || null,
    };
    return ok(res, { ok:true, env, meta, header: Object.keys(head), sample });
  } catch (e) {
    return bad(res, "diag failed: " + (e?.message || String(e)), 500);
  }
};
