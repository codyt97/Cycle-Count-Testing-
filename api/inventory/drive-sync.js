const { driveClient } = require("./_drive-cred");  


function normalizeWorkbook(wb) {
  const name = wb.SheetNames[0];
  const sheet = wb.Sheets[name];
  const json = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const pick = (row, ...keys) => {
    for (const k of keys) {
      const hit = Object.keys(row).find(x => x.toLowerCase().trim() === k.toLowerCase());
      if (hit) return String(row[hit] ?? "").trim();
    }
    return "";
  };
  const pickNum = (row, ...keys) => {
    const v = pick(row, ...keys);
    if (v === "") return undefined;
    const n = Number(String(v).replace(/,/g,""));
    return Number.isFinite(n) ? n : undefined;
  };

  // New: systemQty & hasSerial
  return json.map(r => {
    const systemImei = pick(r, "systemimei","imei","serial","lotorserialno","serialno");
    const hasSerial = !!systemImei;
    // Robust quantity extractor: handles "4", " 4 ", "4 EA", and many header aliases
const qtyFromSheet = (() => {
  const numify = v => {
    if (v === null || v === undefined) return undefined;
    const s = String(v).trim();
    // pull the first number (handles "4", "4 EA", "4,000")
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


  // 2) Heuristic: any column containing qty/quantity/on hand/etc (but not UOM)
  for (const [k, v] of Object.entries(r)) {
    const key = String(k).toLowerCase().trim();
    if (
      /(qty|quantity|on\s*hand|qoh|soh|available)/.test(key) &&
      !/uom|unit/.test(key)
    ) {
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
}

async function fetchFromDrive(fileId) {
  const drive = driveClient();
  const meta = await drive.files.get({ fileId, fields: "id,name,mimeType" });
  const name = meta.data.name || "inventory";
  const mime = meta.data.mimeType || "";

  // Google Sheet → export CSV
  if (mime === "application/vnd.google-apps.spreadsheet") {
    const csv = await drive.files.export({ fileId, mimeType: "text/csv" }, { responseType: "arraybuffer" });
    const wb = XLSX.read(Buffer.from(csv.data), { type: "buffer" });
    return { wb, filename: name + ".csv", mimetype: "text/csv" };
  }

  // Drive file (XLSX/CSV)
  const bin = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  const buf = Buffer.from(bin.data);
  const looksText = name.toLowerCase().endsWith(".csv") || /^text\//.test(mime);
  const wb = looksText ? XLSX.read(buf.toString("utf8"), { type: "string" }) : XLSX.read(buf, { type: "buffer" });
  return { wb, filename: name, mimetype: mime || "application/octet-stream" };
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { withCORS(res); return res.status(204).end(); }
  if (req.method !== "POST") return method(res, ["POST","OPTIONS"]);
  withCORS(res);

  const token = String(req.headers["x-sync-token"] || "");
  if (!token || token !== (process.env.DRIVE_SYNC_TOKEN || "")) return bad(res, "Unauthorized", 401);

  const fileId = process.env.INVENTORY_SHEET_ID || process.env.DRIVE_FILE_ID || "";
if (!fileId) return bad(res, "Missing INVENTORY_SHEET_ID (or DRIVE_FILE_ID)", 500);

  try {
    const t0 = Date.now();
    const { wb, filename, mimetype } = await fetchFromDrive(fileId);
    const rows = normalizeWorkbook(wb);

    await Store.setInventory(rows);
    const meta = await Store.setInventoryMeta({
      source: "drive",
      filename,
      mimetype,
      count: rows.length,
      updatedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
    });

    return ok(res, { ok: true, meta });
  } catch (e) {
    console.error("[drive-sync] fail:", e);
    return bad(res, "Drive fetch failed: " + (e?.message || String(e)), 500);
  }
};
