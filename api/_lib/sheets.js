// api/_lib/sheets.js
/* eslint-disable no-console */
const { google } = require("googleapis");

function getJwt() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
  const key = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!email || !key) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY");
  }
  // Sheets write + Drive read
  return new google.auth.JWT(email, null, key, [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",
  ]);
}
 
function getSheets() {
  const auth = getJwt();
  return google.sheets({ version: "v4", auth });
}

async function ensureSheetTab(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets || []).some(
    (s) => s.properties && String(s.properties.title).trim().toLowerCase() === String(title).trim().toLowerCase()
  );
  if (exists) return true;

  // Create missing tab
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title } } }],
    },
  });
  return true;
}

/**
 * Append one row (array of cell values) to a tab starting at row 2 (keeps headers in row 1).
 * @param {string} tabName  e.g. "Bins"
 * @param {Array}  values   e.g. ["A-123", "John", 10, 9, 1, "2025-10-12T...", "2025-10-12T...", "investigation"]
 */
async function appendRow(tabName, values) {
  const spreadsheetId = process.env.LOGS_SHEET_ID || "";
  if (!spreadsheetId) throw new Error("Missing LOGS_SHEET_ID");

  const sheets = getSheets();
  await ensureSheetTab(sheets, spreadsheetId, tabName);

  // Use A2:Z to always append as new row after header
  const range = `${tabName}!A2:Z`;
  const resp = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [values],
    },
  });
  return { ok: true, updatedRange: resp.data.updates?.updatedRange || null };
}

module.exports = { appendRow };
