// api/inventory/bin-live.js
const { google } = require("googleapis");
const XLSX = require("xlsx");
const { ok, bad, method, withCORS } = require("../_lib/respond");

// tiny in-memory cache per instance (optional)
let cache = { at: 0, rows: [] };
const TTL_MS = 30_000; // 30s

function drive() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
  const key = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!email || !key) throw new Error("Missing Google SA envs");
  const auth = new google.auth.JWT(email, null, key, ["https://www.googleapis.com/auth/drive.readonly"]);
  return google.drive({ version: "v3", auth });
}

function pick(row, ...keys) {
  for (const k of keys) {
    const hit = Object.keys(row).find(x => x.toLowerCase().trim() === k.toLowerCase());
    if (hit) return String(row[hit] ?? "").trim();
  }
  return "";
}
function pickNum(row, ...keys) {
  const v = pick(row, ...keys);
  if (v === "") return undefined;
  const n = Number(String(v).replace(/,/g,""));
  return Number.isFinite(n) ? n : undefined;
}

async function loadRowsFromSheet(fileId) {
  if (Date.now() - cache.at < TTL_MS && cache.rows.length) return cache.rows;
  const d = drive();
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
    const qtyFromSheet = pickNum(r, "systemqty","qty","quantity","onhand","on hand","on_hand");
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
