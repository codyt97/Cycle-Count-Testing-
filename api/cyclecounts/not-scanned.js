// api/cyclecounts/not-scanned.js
/* eslint-disable no-console */
const { ok, bad, method, withCORS } = require("../_lib/respond");
const { google } = require("googleapis");
const Store = require("../_lib/store");

function getSheets() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
  const key = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!email || !key) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_PRIVATE_KEY");
  const auth = new google.auth.JWT(email, null, key, [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
  ]);
  return google.sheets({ version: "v4", auth });
}

async function readTabObjects(spreadsheetId, tabName) {
  const sheets = getSheets();
  const range = `${tabName}!A1:Z100000`;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = resp.data.values || [];
  if (!values.length) return [];

  const headers = values[0].map(h => String(h || "").trim());
  const rows = values.slice(1);

  return rows.map(r => {
    const obj = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i] || `col${i}`] = r[i] ?? "";
    return obj;
  });
}

function norm(s){ return String(s ?? "").trim(); }
function looseUserMatch(counter, want) {
  const c = norm(counter).toLowerCase();
  const w = norm(want).toLowerCase();
  if (!c || !w) return false;
  if (c === w) return true;
  if (c.includes(w)) return true;            // substring match (“matt”, “max”)
  const [first, ...rest] = c.split(/\s+/);
  const last = rest.length ? rest[rest.length-1] : "";
  return first === w || last === w;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { withCORS(res); return res.status(204).end(); }
  if (req.method !== "GET")     return method(res, ["GET","OPTIONS"]);
  withCORS(res);

  try {
    const sheetId = process.env.LOGS_SHEET_ID || "";
    if (!sheetId) return bad(res, "Missing LOGS_SHEET_ID", 500);

    // Expected headers in NotScanned:
    // Bin, Counter, SKU, Description, Type, QtySystem, QtyEntered, (optional) SystemImei
    let all = await readTabObjects(sheetId, "NotScanned");

    // --- Always synthesize from Store (latest per bin) and merge with sheet rows ---
    const bins = await Store.listBins();

    // latest per bin
    const latestByBin = new Map();
    for (const b of bins) {
      const k = String(b.bin || "").trim().toUpperCase();
      const t = Date.parse(b.submittedAt || b.updatedAt || b.started || 0) || 0;
      const prev = latestByBin.get(k);
      const prevT = prev ? (Date.parse(prev.submittedAt || prev.updatedAt || prev.started || 0) || 0) : -1;
      if (!prev || t > prevT) latestByBin.set(k, b);
    }

    // Build rows where QtyEntered < QtySystem for ALL items (serial + non-serial)
    const fromStore = [];
    for (const b of latestByBin.values()) {
      const counter = String(b.counter || "—").trim();
      const items = Array.isArray(b.items) ? b.items : [];
      for (const it of items) {
        const sku         = String(it.sku || "—").trim();
        const description = String(it.description || "—").trim();
        const systemImei  = String(it.systemImei || "").trim();
        const hasSerial   = !!systemImei;
        const systemQty   = Number(it.systemQty != null ? it.systemQty : (hasSerial ? 1 : 0)) || 0;
        const qtyEntered  = Number(it.qtyEntered || 0);
        if (qtyEntered < systemQty) {
          fromStore.push({
            Bin: b.bin,
            Counter: counter,
            SKU: sku,
            Description: description,
            Type: hasSerial ? "serial" : "nonserial",
            QtySystem: systemQty,
            QtyEntered: qtyEntered,
            SystemImei: systemImei,
          });
        }
      }
    }

    // Also surface SERIAL deficits from missingImeis even if items[] wasn't sent
    for (const b of latestByBin.values()) {
      const counter = String(b.counter || "—").trim();
      const items = Array.isArray(b.items) ? b.items : [];
      const knownImeis = new Set(
        items.map(it => String(it.systemImei || "").trim()).filter(Boolean)
      );

      if (Array.isArray(b.missingImeis) && b.missingImeis.length) {
        for (const raw of b.missingImeis) {
          const mi = String(raw || "").trim();
          if (!mi) continue;
          if (knownImeis.has(mi)) continue;

          // Try to enrich SKU/Description from the inventory snapshot
          let sku = "—", description = "—";
          try {
            const found = await Store.findByIMEI(mi);
            if (found) {
              sku = String(found.sku || "—").trim();
              description = String(found.description || "—").trim();
            }
          } catch (_) {}

          fromStore.push({
            Bin: b.bin,
            Counter: counter,
            SKU: sku,
            Description: description,
            Type: "serial",
            QtySystem: 1,
            QtyEntered: 0,
            SystemImei: mi,
          });
        }
      }
    }

    // Merge Store rows with whatever we read from the sheet (sheet may be empty or non-serial only)
    all = (all || []).concat(fromStore);

    // Optional filters
    const wantUser = norm(req.query.user || "");
    const wantBin  = norm(req.query.bin || "").toUpperCase();

    if (wantUser) {
      all = all.filter(r => looseUserMatch(r.Counter || r.counter, wantUser));
    }
    if (wantBin) {
      all = all.filter(r => norm(r.Bin || r.bin).toUpperCase() === wantBin);
    }

    // Normalize + dedupe by Bin+SKU+Description+SystemImei (last write wins)
    const keyOf = (r) => [
      norm(r.Bin || r.bin),
      norm(r.SKU || r.sku),
      norm(r.Description || r.description),
      norm(r.SystemImei || r.systemImei)
    ].join("|");

    const map = new Map();
    for (const r of all) map.set(keyOf(r), r);
    const rows = Array.from(map.values());

    const records = rows.map(r => ({
      bin: norm(r.Bin ?? r.bin),
      counter: norm(r.Counter ?? r.counter) || "—",
      sku: norm(r.SKU ?? r.sku) || "—",
      description: norm(r.Description ?? r.description) || "—",
      systemImei: norm(r.SystemImei ?? r.systemImei),
      systemQty: Number(r.QtySystem ?? r.systemQty ?? 0),
      qtyEntered: Number(r.QtyEntered ?? r.qtyEntered ?? 0),
      type: norm(r.Type ?? r.type) || (norm(r.SystemImei ?? r.systemImei) ? "serial" : "nonserial"),
    }));

    return ok(res, { records });
  } catch (e) {
    console.error("[not-scanned] fail:", e);
    res.statusCode = 500;
    res.setHeader("content-type","application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok:false, error:String(e.message || e) }));
  }
};
