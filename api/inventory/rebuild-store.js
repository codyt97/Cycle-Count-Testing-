// api/inventory/rebuild-store.js
/* Rebuilds the inventory snapshot from the Drive file into Redis (Store).
   - Preserves leading zeros via XLSX { raw:false }
   - Merges Site+Bin into a single `location`
*/
const XLSX = require("xlsx");
const { ok, bad, method, withCORS } = require("../_lib/respond");
const Store = require("../_lib/store");
const { driveClient } = require("./_drive-cred");

const asStr = (v) => (v == null ? "" : String(v).trim());
const toNum = (v) => {
  const n = Number(asStr(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
};
const pick = (row, ...keys) => {
  for (const k of keys) {
    const hit = Object.keys(row).find(x => x.toLowerCase().trim() === k.toLowerCase());
    if (hit) return asStr(row[hit]);
  }
  return "";
};

function normalizeRows(json) {
  return json.map(r => {
    const systemImei = pick(r, "systemImei","imei","serial","lot/serial","lotorserialno","serialno","serial number");
    const hasSerial = !!systemImei;

    const qtyFromSheet =
      toNum(pick(r, "systemQty","qty","quantity","on hand","onhand","qty on hand")) ??
      (hasSerial ? 1 : 0);

    const site   = pick(r, "site","warehouse","sitecode","locationref.name","site name");
    const bin    = pick(r, "bin","location","locationbin","locationbinref.name","bin location");
    const merged = site && bin ? `${site}:${bin}` : (bin || site || "");

    const sku         = pick(r, "sku","item","item ","itemcode","itemref.code","item number");
    const description = pick(r, "description","itemname","itemref.name","desc","item description");

    return {
      location: merged,
      sku,
      description,
      systemImei,
      hasSerial,
      systemQty: hasSerial ? 1 : (qtyFromSheet ?? 0),
    };
  }).filter(x => x.location || x.sku || x.systemImei);
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return withCORS(res), res.status(204).end();
  if (req.method !== "GET")     return method(res, ["GET","OPTIONS"]);
  withCORS(res);

  const t0 = Date.now();
  try {
    const fileId = asStr(req.query.fileId) || process.env.INVENTORY_SHEET_ID || process.env.DRIVE_FILE_ID;
    if (!fileId) return bad(res, "INVENTORY_SHEET_ID (or DRIVE_FILE_ID) not set", 500);

    const d = driveClient();
    const meta = await d.files.get({ fileId, fields: "id,mimeType,name" });
    const mime = meta.data.mimeType;

    let wb;
    if (mime === "application/vnd.google-apps.spreadsheet") {
      const csv = await d.files.export({ fileId, mimeType: "text/csv" }, { responseType: "arraybuffer" });
      wb = XLSX.read(Buffer.from(csv.data), { type: "buffer" });
    } else {
      const bin = await d.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
      wb = XLSX.read(Buffer.from(bin.data), { type: "buffer" });
    }

    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    // IMPORTANT: raw:false keeps leading zeros intact
    const json = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });

    const rows = normalizeRows(json);

    await Store.setInventory(rows);
    const metaSaved = await Store.setInventoryMeta({
      source: "drive",
      filename: meta.data.name,
      count: rows.length,
      updatedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
    });

    return ok(res, { ok: true, restored: rows.length, meta: metaSaved, sheet: sheetName });
  } catch (e) {
    console.error("[rebuild-store] fail:", e);
    return bad(res, "rebuild failed: " + (e?.message || String(e)), 500);
  }
};
