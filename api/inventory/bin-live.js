// api/inventory/bin-live.js
/* Reads the Inventory sheet live (bypasses cache) and returns rows for a bin.
   - Preserves leading zeros via XLSX { raw:false }
   - Accepts both "SITE:BIN" and "BIN" lookups
*/
const { google } = require("googleapis");
const XLSX = require("xlsx");
const { ok, bad, method, withCORS } = require("../_lib/respond");
const { driveClient } = require("./_drive-cred");

// tiny per-instance cache to avoid hammering Drive
let cache = { at: 0, rows: [] };
const TTL_MS = 30_000; // 30s

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

    // Quantity tolerant
    const qtyFromSheet =
      toNum(pick(r, "systemQty","qty","quantity","on hand","onhand","qty on hand")) ??
      (hasSerial ? 1 : 0);

    // Site + Bin merge (fall back to whichever exists)
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

  try {
    const qBin = asStr(req.query.bin).toLowerCase();
    if (!qBin) return bad(res, "bin is required", 400);

    // serve from cache if young enough
    if (cache.rows.length && (Date.now() - cache.at) < TTL_MS) {
      const match = qBin;
      const records = cache.rows.filter(r => {
        const loc = asStr(r.location).toLowerCase();
        if (!loc) return false;
        const bare = loc.includes(":") ? loc.split(":")[1] : loc;
        return loc === match || bare === match;
      });
      return ok(res, { records, meta: { cachedMs: TTL_MS - (Date.now() - cache.at), totalRows: cache.rows.length, source: "memory" } });
    }

    const fileId = asStr(req.query.fileId) || process.env.INVENTORY_SHEET_ID || process.env.DRIVE_FILE_ID;
    if (!fileId) return bad(res, "INVENTORY_SHEET_ID (or DRIVE_FILE_ID) not set", 500);

    const d = driveClient();
    const meta = await d.files.get({ fileId, fields: "id,mimeType,name" });
    const mime = meta.data.mimeType;

    let wb;
    if (mime === "application/vnd.google-apps.spreadsheet") {
      // Export Google Sheet to CSV then parse so we can force raw:false on the worksheet
      const csv = await d.files.export({ fileId, mimeType: "text/csv" }, { responseType: "arraybuffer" });
      wb = XLSX.read(Buffer.from(csv.data), { type: "buffer" });
    } else {
      // Native xlsx/csv files
      const bin = await d.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
      wb = XLSX.read(Buffer.from(bin.data), { type: "buffer" });
    }

    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    // IMPORTANT: raw:false keeps leading zeros intact
    const json = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
    const rows = normalizeRows(json);

    // refresh cache
    cache = { at: Date.now(), rows };

    const match = qBin;
    const records = rows.filter(r => {
      const loc = asStr(r.location).toLowerCase();
      if (!loc) return false;
      const bare = loc.includes(":") ? loc.split(":")[1] : loc;
      return loc === match || bare === match;
    });

    return ok(res, {
      records,
      meta: {
        totalRows: rows.length,
        cachedMs: Math.max(0, TTL_MS - (Date.now() - cache.at)),
        fileName: meta.data.name,
        sheet: sheetName
      }
    });
  } catch (e) {
    return bad(res, "Live sheet fetch failed: " + (e?.message || String(e)), 500);
  }
};
