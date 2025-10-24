// api/inventory/debug-drive.js 
const { google } = require("googleapis");
const XLSX = require("xlsx");
const { ok, bad, method, withCORS } = require("../_lib/respond");

function drive() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
  const key = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const auth = new google.auth.JWT(email, null, key, ["https://www.googleapis.com/auth/drive.readonly"]);
  return google.drive({ version: "v3", auth });
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { withCORS(res); return res.status(204).end(); }
  if (req.method !== "GET") return method(res, ["GET","OPTIONS"]);
  withCORS(res);

  const fileId = process.env.DRIVE_FILE_ID || "";
  if (!fileId) return bad(res, "Missing DRIVE_FILE_ID", 500);

  try {
    const d = drive();
    const meta = await d.files.get({ fileId, fields: "id,name,mimeType" });
    const name = meta.data.name, mime = meta.data.mimeType;

    let rows = 0, error = null;
    try {
      if (mime === "application/vnd.google-apps.spreadsheet") {
        const csv = await d.files.export({ fileId, mimeType: "text/csv" }, { responseType: "arraybuffer" });
        const wb = XLSX.read(Buffer.from(csv.data), { type: "buffer" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(sheet, { defval: "" }).length;
      } else {
        const bin = await d.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
        const buf = Buffer.from(bin.data);
        const wb = XLSX.read(buf, { type: "buffer" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(sheet, { defval: "" }).length;
      }
    } catch (e) { error = e.message || String(e); }

    return ok(res, { meta: { name, mime }, probe: { rows, error } });
  } catch (e) {
    return bad(res, "Drive meta failed: " + (e?.message || String(e)), 500);
  }
};
