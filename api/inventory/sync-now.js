 // api/inventory/sync-now.js
const driveSync = require("./drive-sync");
module.exports = async (req, res) => {
  // allow GET for convenience
  req.method = "POST";
  // allow token via query string (?token=...)
  if (!req.headers["x-sync-token"] && req.query && req.query.token) {
    req.headers["x-sync-token"] = String(req.query.token);
  }
  return driveSync(req, res); 
};
