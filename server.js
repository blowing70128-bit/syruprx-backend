const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.options("*", cors());

const LICENSES_FILE = path.join(__dirname, "data", "licenses.json");

function readLicenses() {
  if (!fs.existsSync(LICENSES_FILE)) {
    return { licenses: {} };
  }

  try {
    const raw = fs.readFileSync(LICENSES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.licenses || typeof parsed.licenses !== "object") {
      return { licenses: {} };
    }
    return parsed;
  } catch (err) {
    console.error("Failed to read licenses.json:", err);
    return { licenses: {} };
  }
}

function writeLicenses(data) {
  fs.writeFileSync(LICENSES_FILE, JSON.stringify(data, null, 2));
}

function makeLicenseKey(tier, framework, db) {
  const prefixMap = {
    demo: "DEMO",
    pro: "PRO",
    master: "MASTER",
    ultimate: "ULT"
  };

  const frameworkMap = {
    qbcore: "QB",
    esx: "ESX",
    qbox: "QBOX"
  };

  const tierPrefix = prefixMap[tier];
  const frameworkPrefix = frameworkMap[framework];

  if (!tierPrefix || !frameworkPrefix) {
    return null;
  }

  let licenseKey = "";
  do {
    const randomPart = crypto.randomBytes(3).toString("hex").toUpperCase();
    licenseKey = `SRX-${tierPrefix}-${frameworkPrefix}-${randomPart}`;
  } while (db.licenses[licenseKey]);

  return licenseKey;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "SyrupRX backend is live"
  });
});

app.post("/v1/licenses/validate", (req, res) => {
  const { licenseKey, productCode, tier, framework, fingerprint } = req.body || {};

  if (!licenseKey || !productCode || !tier || !framework || !fingerprint) {
    return res.status(400).json({
      valid: false,
      status: "missing_fields",
      message: "licenseKey, productCode, tier, framework, and fingerprint are required"
    });
  }

  if (String(productCode).toLowerCase() !== "syruprx") {
    return res.status(400).json({
      valid: false,
      status: "invalid_product",
      message: "Invalid product code"
    });
  }

  const db = readLicenses();
  const key = String(licenseKey).trim();
  const requestedTier = String(tier).toLowerCase().trim();
  const requestedFramework = String(framework).toLowerCase().trim();
  const requestedFingerprint = String(fingerprint).trim();

  const license = db.licenses[key];

  if (!license) {
    return res.status(404).json({
      valid: false,
      status: "not_found",
      message: "Invalid License"
    });
  }

  if (!license.active) {
    return res.status(403).json({
      valid: false,
      status: "inactive",
      message: "License is inactive"
    });
  }

  if (String(license.tier).toLowerCase() !== requestedTier) {
    return res.status(403).json({
      valid: false,
      status: "tier_mismatch",
      message: "Tier does not match license"
    });
  }

  if (String(license.framework).toLowerCase() !== requestedFramework) {
    return res.status(403).json({
      valid: false,
      status: "framework_mismatch",
      message: "Framework does not match license"
    });
  }

  if (license.boundFingerprint && license.boundFingerprint !== requestedFingerprint) {
    return res.status(403).json({
      valid: false,
      status: "fingerprint_mismatch",
      message: "License is already bound to another device"
    });
  }

  const now = new Date().toISOString();

  if (!license.boundFingerprint) {
    license.boundFingerprint = requestedFingerprint;
    license.firstActivatedAt = now;
  }

  license.lastValidatedAt = now;
  license.validationCount = (license.validationCount || 0) + 1;

  db.licenses[key] = license;
  writeLicenses(db);

  return res.json({
    valid: true,
    status: "active",
    licenseId: Buffer.from(key).toString("hex").slice(0, 16).toUpperCase(),
    boundFingerprint: license.boundFingerprint,
    message: "License validated"
  });
});

app.post("/v1/licenses/generate", (req, res) => {
  const { tier, framework } = req.body || {};

  if (!tier || !framework) {
    return res.status(400).json({
      success: false,
      message: "Missing tier or framework"
    });
  }

  const cleanTier = String(tier).toLowerCase().trim();
  const cleanFramework = String(framework).toLowerCase().trim();

  const db = readLicenses();
  const licenseKey = makeLicenseKey(cleanTier, cleanFramework, db);

  if (!licenseKey) {
    return res.status(400).json({
      success: false,
      message: "Invalid tier or framework"
    });
  }

  db.licenses[licenseKey] = {
    active: true,
    tier: cleanTier,
    framework: cleanFramework,
    uses: 0,
    createdAt: new Date().toISOString(),
    source: "manual-generator"
  };

  writeLicenses(db);

  return res.json({
    success: true,
    licenseKey
  });
});

app.post("/v1/payhip/webhook", (req, res) => {
  const payload = req.body || {};

  const payhipApiKey = process.env.PAYHIP_API_KEY || "";
  const expectedSignature = crypto
    .createHash("sha256")
    .update(payhipApiKey)
    .digest("hex");

  if (!payload.signature || payload.signature !== expectedSignature) {
    return res.status(403).json({
      success: false,
      message: "Invalid Payhip signature"
    });
  }

  if (payload.type !== "paid") {
    return res.status(200).json({
      success: true,
      message: "Ignored non-paid event"
    });
  }

  const item = Array.isArray(payload.items) && payload.items.length > 0
    ? payload.items[0]
    : null;

  if (!item) {
    return res.status(400).json({
      success: false,
      message: "No item found in Payhip payload"
    });
  }

  const productName = String(item.product_name || "").toLowerCase();
  const buyerEmail = String(payload.email || "").trim();

  let tier = "";
  let framework = "";

  if (productName.includes("demo")) tier = "demo";
  else if (productName.includes("pro")) tier = "pro";
  else if (productName.includes("master")) tier = "master";
  else if (productName.includes("ultimate")) tier = "ultimate";

  if (productName.includes("qbcore")) framework = "qbcore";
  else if (productName.includes("esx")) framework = "esx";
  else if (productName.includes("qbox")) framework = "qbox";

  if (!tier || !framework) {
    return res.status(400).json({
      success: false,
      message: "Could not determine tier/framework from product name"
    });
  }

  const db = readLicenses();
  const licenseKey = makeLicenseKey(tier, framework, db);

  if (!licenseKey) {
    return res.status(400).json({
      success: false,
      message: "Could not generate license key"
    });
  }

  db.licenses[licenseKey] = {
    active: true,
    tier,
    framework,
    uses: 0,
    buyerEmail,
    payhipSaleId: payload.id || null,
    createdAt: new Date().toISOString(),
    source: "payhip-webhook"
  };

  writeLicenses(db);

  return res.status(200).json({
    success: true,
    message: "Webhook processed",
    licenseKey
  });
});

app.post("/v1/licenses/find-by-email", (req, res) => {
  const { email } = req.body || {};

  if (!email) {
    return res.status(400).json({
      success: false,
      message: "Missing email"
    });
  }

  const cleanEmail = String(email).toLowerCase().trim();
  const db = readLicenses();

  const matches = Object.entries(db.licenses)
    .map(([licenseKey, data]) => ({ licenseKey, ...data }))
    .filter(item => String(item.buyerEmail || "").toLowerCase().trim() === cleanEmail)
    .sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    });

  if (matches.length === 0) {
    return res.status(404).json({
      success: false,
      message: "No license found for that email"
    });
  }

  const latest = matches[0];

  return res.json({
    success: true,
    license: {
      licenseKey: latest.licenseKey,
      tier: latest.tier,
      framework: latest.framework,
      buyerEmail: latest.buyerEmail || "",
      createdAt: latest.createdAt || "",
      source: latest.source || ""
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} - generator + payhip webhook + admin key viewer enabled`);
});
