// api/inventory/_drive-cred.js 
const { google } = require("googleapis");

function getAuth() {
  const json = process.env.GOOGLE_CREDENTIALS_JSON || "";
  if (json) {
    const creds = JSON.parse(json);
    // Normalize private_key newlines if needed
    const pk = (creds.private_key || "").replace(/\r\n/g, "\n");
    const auth = new google.auth.JWT(
      creds.client_email,
      null,
      pk,
      ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/spreadsheets.readonly"]
    );
    return auth;
  }
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
  const key   = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!email || !key) throw new Error("Missing Google SA credentials. Provide GOOGLE_CREDENTIALS_JSON or EMAIL/PRIVATE_KEY.");
  return new google.auth.JWT(
    email,
    null,
    key,
    ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/spreadsheets.readonly"]
  );
}

function driveClient() {
  const auth = getAuth();
  return google.drive({ version: "v3", auth });
}

module.exports = { getAuth, driveClient };
