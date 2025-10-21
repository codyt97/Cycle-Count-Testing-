// api/inventory/rebuild-store.js
/* eslint-disable no-console */
const XLSX = require("xlsx");
const { ok, bad, method, withCORS } = require("../_lib/respond");
const Store = require("../_lib/store");
const { driveClient } = require("./_drive-cred");

function pick(row, ...keys) {
  for (const k of keys) {
    const hit = Object.keys(row).find(x => x.toLowerCase().trim() === k.toLowerCase());
    if (hit) return String(row[hit] ?? "").trim();
  }
  return "";
}
function numifyAny(v) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  const m = s.match(/-?\d[\d,]*/);
  if (!m) return undefined;
  const n = Number(m[0].replace(/,/g,""));
  return Number.isFinite(n) ? n : undefined;
}
function normalizeRows(json) {
  return json.map(r => {
    const systemImei = pick(r, "systemimei","imei","serial","lotorserialno","serialno");
    const hasSerial = !!systemImei;

    const qtyFromSheet = (() => {
      // explicit headers first
      for (const [k, v] of Object.entries(r)) {
        const key = String(k).toLowerCase().trim();
        if (/(qty|quantity|on\s*hand|qoh|soh|available)/.test(key) && !/uom|unit/.test(key)) {
          const n = numifyAny(v);
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
}

async function fetchInventoryWorkbook(fileId) {
  const drive = driveClient();
  const meta = await drive.files.get({ fileId, fields: "id,name,mimeType" });
  const name = meta.data.name || "inventory";
  const mime = meta.data.mimeType || "";

  if (mime === "application/vnd.google-apps.spreadsheet") {
    const csv = await drive.files.export({ fileId, mimeType: "text/csv" }, { responseType: "arraybuffer" });
    return { wb: XLSX.read(Buffer.from(csv.data), { type: "buffer" }), source: name + ".csv" };
  } else {
    const bin = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
    const buf = Buffer.from(bin.data);
    const looksText = name.toLowerCase().endsWith(".csv") || /^text\//.test(mime);
    const wb = looksText ? XLSX.read(buf.toString("utf8"), { type: "string" }) : XLSX.read(buf, { type: "buffer" });
    return { wb, source: name };
  }
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { withCORS(res); return res.status(204).end(); }
  if (req.method !== "POST" && req.method !== "GET") return method(res, ["POST","GET","OPTIONS"]);
  withCORS(res);

  const fileId = process.env.INVENTORY_SHEET_ID || process.env.DRIVE_FILE_ID || "";
  if (!fileId) return bad(res, "Missing INVENTORY_SHEET_ID (or DRIVE_FILE_ID)", 500);

  try {
    const t0 = Date.now();
    const { wb, source } = await fetchInventoryWorkbook(fileId);
    const sheetName = wb.SheetNames[0];
    const json = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
    const rows = normalizeRows(json);

    await Store.setInventory(rows);
    const meta = await Store.setInventoryMeta({
      source: "drive",
      filename: source,
      count: rows.length,
      updatedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
    });

    return ok(res, { ok:true, restored: rows.length, meta });
  } catch (e) {
    console.error("[rebuild-store] fail:", e);
    return bad(res, "rebuild failed: " + (e?.message || String(e)), 500);
  }
};
