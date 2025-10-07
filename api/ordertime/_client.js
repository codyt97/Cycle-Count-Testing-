// api/ordertime/_client.js
const BASE = process.env.OT_BASE_URL; // https://services.ordertime.com/api
const API_KEY = (process.env.OT_API_KEY || "").trim();
const EMAIL   = (process.env.OT_EMAIL || "").trim();
const PASS    = (process.env.OT_PASSWORD || "").trim();    // or use DEVKEY
const DEVKEY  = (process.env.OT_DEVKEY || "").trim();

if (!BASE) throw new Error("OT_BASE_URL not set");
if (!API_KEY) throw new Error("OT_API_KEY not set");
if (!EMAIL) throw new Error("OT_EMAIL not set");
if (!PASS && !DEVKEY) throw new Error("Set OT_PASSWORD or OT_DEVKEY");

function authHeaders() {
  const h = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "apiKey": API_KEY,
    "email": EMAIL,
  };
  if (DEVKEY) h["DevKey"] = DEVKEY; else h["password"] = PASS;
  return h;
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OT ${res.status} [${path}] ${text}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// Generic list call – IMPORTANT: Type is NUMERIC enum (RecordTypeEnum)
async function otList({ Type, Filters = [], PageNumber = 1, NumberOfRecords = 500 }) {
  const out = await post("/list", { Type, Filters, PageNumber, NumberOfRecords });
  const records = Array.isArray(out?.Records) ? out.Records
                : (Array.isArray(out?.records) ? out.records : []);
  return records;
}

module.exports = { otList };
