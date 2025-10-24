// api/inventory/status.js 
const { ok, method, withCORS } = require("../_lib/respond");
const Store = require("../_lib/store");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { withCORS(res); return res.status(204).end(); }
  if (req.method !== "GET") return method(res, ["GET","OPTIONS"]);
  withCORS(res);

  const meta = await Store.getInventoryMeta();
  const count = (await Store.getInventory()).length;
  return ok(res, { ok: true, meta: { count, ...(meta || {}) } });
};
