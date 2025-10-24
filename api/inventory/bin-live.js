 // api/inventory/bin-live.js 
const { google } = require("googleapis");
const XLSX = require("xlsx");
const { ok, bad, method, withCORS } = require("../_lib/respond");

// tiny in-memory cache per instance (optional)
let cache = { at: 0, rows: [] };
const TTL_MS = 30_000; // 30s

const { driveClient } = require("./_drive-cred");
...
const d = driveClient();

  const meta = await d.files.get({ fileId, fields: "id,mimeType,name" });
  const mime = meta.data.mimeType;
  let wb;
  if (mime === "application/vnd.google-apps.spreadsheet") {
    const csv = await d.files.export({ fileId, mimeType: "text/csv" }, { responseType: "arraybuffer" });
    wb = XLSX.read(Buffer.from(csv.data), { type: "buffer" });
  } else {
    const bin = await d.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
    const buf = Buffer.from(bin.data);
    wb = XLSX.read(buf, { type: "buffer" });
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const rows = json.map(r => {
    const systemImei = pick(r, "systemimei","imei","serial","lotorserialno","serialno");
    const hasSerial = !!systemImei;
    const qtyFromSheet = (() => {
  const numify = v => {
    if (v === null || v === undefined) return undefined;
    const s = String(v).trim();
    const m = s.match(/-?\d[\d,]*/);
    if (!m) return undefined;
    const n = Number(m[0].replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  };

  // First try plain numeric columns (add plain "available")
const aliased =
  pickNum(
    r,
    "systemqty","system qty","qty","quantity",
    "onhand","on hand","on_hand","qtyonhand","qty on hand","qoh","soh",
    "available","available qty","availableqty","avail qty","availqty",
    "stock","inventory","bin qty","binqty","location qty","locationqty"
  );
if (aliased !== undefined) return aliased;

// If "available" contains units like "4 EA", parse its number explicitly
if (r.hasOwnProperty("available")) {
  const n = numify(r["available"]);
  if (n !== undefined) return n;
}


  for (const [k, v] of Object.entries(r)) {
    const key = String(k).toLowerCase().trim();
    if (/(qty|quantity|on\s*hand|qoh|soh|available)/.test(key) && !/uom|unit/.test(key)) {
      const n = numify(v);
      if (n !== undefined) return n;
    }
  }
  return undefined;
})();


    return {
      location:    pick(r, "bin","location","locationbin","locationbinref.name"),
      sku:         pick(r, "sku","item","item ","itemcode","itemref.code"),
      description: pick(r, "description","itemname","itemref.name","desc"),
      systemImei,
      hasSerial,
      systemQty: hasSerial ? 1 : (qtyFromSheet ?? 0),
    };
  }).filter(x => x.location || x.sku || x.systemImei);

  cache = { at: Date.now(), rows };
  return rows;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { withCORS(res); return res.status(204).end(); }
  if (req.method !== "GET") return method(res, ["GET","OPTIONS"]);
  withCORS(res);

  const fileId = process.env.DRIVE_FILE_ID || "";
  if (!fileId) return bad(res, "Missing DRIVE_FILE_ID", 500);

  const match = String(req.query.bin || "").trim().toLowerCase();
  if (!match) return bad(res, "bin is required", 400);

  try {
    const rows = await loadRowsFromSheet(fileId);
    const records = rows
      .filter(r => (r.location || "").trim().toLowerCase() === match)
      .map(r => ({
        location: r.location,
        sku: r.sku,
        description: r.description,
        systemImei: r.systemImei,
        hasSerial: r.hasSerial,
        systemQty: r.systemQty
      }));
    return ok(res, { records, meta: { totalRows: rows.length, cachedMs: Math.max(0, TTL_MS - (Date.now() - cache.at)) }});
  } catch (e) {
    return bad(res, "Live sheet fetch failed: " + (e?.message || String(e)), 500);
  }
};
