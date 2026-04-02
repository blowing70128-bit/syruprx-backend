const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

