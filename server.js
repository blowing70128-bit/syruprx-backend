
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.SYRUPRX_ADMIN_SECRET || '';
const RELAY_SECRET = process.env.SYRUPRX_RELAY_SECRET || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const DATA_DIR = path.join(__dirname, 'data');
const LICENSES_FILE = path.join(DATA_DIR, 'licenses.json');

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LICENSES_FILE)) {
    fs.writeFileSync(LICENSES_FILE, JSON.stringify({ licenses: {} }, null, 2));
  }
}

function loadDb() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(LICENSES_FILE, 'utf8'));
}

function saveDb(db) {
  fs.writeFileSync(LICENSES_FILE, JSON.stringify(db, null, 2));
}

function normalizeKey(value) {
  return String(value || '').trim();
}

function makeLicenseId(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16).toUpperCase();
}

function adminOnly(req, res, next) {
  if (!ADMIN_SECRET) return res.status(500).json({ ok: false, message: 'Missing SYRUPRX_ADMIN_SECRET' });
  if (req.header('X-SyrupRX-Secret') !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
  next();
}

function relayAuth(req, res, next) {
  if (!RELAY_SECRET) return next();
  if (req.header('X-SyrupRX-Secret') !== RELAY_SECRET) {
    return res.status(401).json({ ok: false, status: 'unauthorized', message: 'Unauthorized relay client' });
  }
  next();
}

function validateLicensePayload(body) {
  const { licenseKey, productCode, tier, framework, fingerprint } = body || {};
  const key = normalizeKey(licenseKey);
  if (!key || !productCode || !tier || !framework || !fingerprint) {
    return { ok: false, status: 'missing_fields', message: 'licenseKey, productCode, tier, framework, and fingerprint are required' };
  }
  const db = loadDb();
  const record = db.licenses[key];
  if (!record) return { ok: false, status: 'not_found', message: 'License not found' };
  if (record.status && record.status !== 'active') return { ok: false, status: 'inactive', message: 'License is not active' };
  if (record.productCode && record.productCode !== productCode) return { ok: false, status: 'product_mismatch', message: 'Wrong product build' };
  if (record.tier && record.tier !== tier) return { ok: false, status: 'tier_mismatch', message: 'Wrong tier build' };
  if (record.framework && record.framework !== framework) return { ok: false, status: 'framework_mismatch', message: 'Wrong framework build' };
  if (!record.boundFingerprint) {
    record.boundFingerprint = fingerprint;
    record.firstActivatedAt = new Date().toISOString();
  } else if (record.boundFingerprint !== fingerprint) {
    return { ok: false, status: 'fingerprint_mismatch', message: 'License is already bound to another server', boundFingerprint: record.boundFingerprint };
  }
  record.lastValidatedAt = new Date().toISOString();
  record.validationCount = Number(record.validationCount || 0) + 1;
  if (body.serverLabel) record.serverLabel = body.serverLabel;
  if (body.resourceName) record.lastResourceName = body.resourceName;
  if (body.version) record.lastVersion = body.version;
  db.licenses[key] = record;
  saveDb(db);
  return { ok: true, record, licenseId: record.licenseId || makeLicenseId(key) };
}

function agentSystemPrompt(agent, tier, framework) {
  const common = `You are part of the SyrupRX AI system for FiveM servers. Brand voice: premium, concise, technically honest, and framework-aware. Tier: ${tier}. Framework: ${framework}. Never claim to have changed files or server state unless explicitly told execution already happened. Focus on safe, practical, operator-ready advice.`;
  const prompts = {
    syrupcore: common + ' Role: orchestrator. Summarize scan or optimization outcomes with clear sequencing and confidence.',
    dripmind: common + ' Role: analysis engine. Diagnose bottlenecks, prioritize issues, and explain why they matter.',
    dripintel: common + ' Role: telemetry and reporting. Turn raw metrics into concise findings and trend notes.',
    dripguard: common + ' Role: safety gate. Flag risky actions, preserve stability, and recommend guarded next steps.',
    dripflow: common + ' Role: execution planner. Convert approved ideas into staged optimization actions without pretending execution already happened.',
    smokebot: common + ' Role: operator helper. Answer admin questions in short, direct language with one best next step.',
    smoketrace: common + ' Role: anomaly tracer. Focus on unusual patterns, spikes, loops, and suspicious chains.',
    drippaw: common + ' Role: watchdog companion. Give early-warning cues in a short alert style. Light personality is allowed, but stay useful.'
  };
  return prompts[String(agent || '').toLowerCase()] || prompts.syrupcore;
}

async function callOpenAI({ agent, prompt, tier, framework }) {
  if (!OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY');
  }
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: agentSystemPrompt(agent, tier, framework) }] },
        { role: 'user', content: [{ type: 'input_text', text: String(prompt || '') }] }
      ],
      reasoning: { effort: 'medium' }
    })
  });
  const data = await response.json();
  if (!response.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : `OpenAI HTTP ${response.status}`;
    throw new Error(msg);
  }
  const text = Array.isArray(data.output)
    ? data.output.flatMap(item => Array.isArray(item.content) ? item.content : [])
        .filter(part => part.type === 'output_text' && part.text)
        .map(part => part.text)
        .join('\n')
    : '';
  if (!text) throw new Error('Empty OpenAI response');
  return text.trim();
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'syruprx-backend', openaiConfigured: !!OPENAI_API_KEY });
});

app.get('/v1/agents/manifest', (_req, res) => {
  res.json({
    ok: true,
    brand: 'SyrupRX',
    agents: [
      { name: 'SyrupCore', role: 'orchestrator', tier: 'pro' },
      { name: 'SmokeBot', role: 'operator_help', tier: 'pro' },
      { name: 'DripIntel', role: 'telemetry_scan', tier: 'pro' },
      { name: 'DripMind', role: 'analysis', tier: 'pro' },
      { name: 'DripGuard', role: 'safety_gate', tier: 'master' },
      { name: 'DripPaw', role: 'watchdog', tier: 'master' },
      { name: 'DripFlow', role: 'execution', tier: 'ultimate' },
      { name: 'SmokeTrace', role: 'trace_diagnostics', tier: 'ultimate' }
    ]
  });
});

app.post('/v1/licenses/validate', (req, res) => {
  const result = validateLicensePayload(req.body || {});
  if (!result.ok) {
    return res.status(result.status === 'not_found' ? 404 : 403).json({ valid: false, status: result.status, message: result.message, boundFingerprint: result.boundFingerprint });
  }
  return res.json({ valid: true, status: 'active', licenseId: result.licenseId, boundFingerprint: result.record.boundFingerprint, message: 'License validated' });
});

app.post('/v1/ai/agent', relayAuth, async (req, res) => {
  const body = req.body || {};
  const result = validateLicensePayload(body);
  if (!result.ok) {
    return res.status(403).json({ ok: false, status: result.status, message: result.message, boundFingerprint: result.boundFingerprint });
  }
  const agent = String(body.agent || 'syrupcore').toLowerCase();
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ ok: false, status: 'missing_prompt', message: 'Prompt is required' });
  try {
    const text = await callOpenAI({ agent, prompt, tier: body.tier, framework: body.framework });
    return res.json({ ok: true, agent, text });
  } catch (err) {
    return res.status(502).json({ ok: false, status: 'ai_error', message: err.message || 'AI relay failed' });
  }
});

app.post('/v1/licenses/admin/upsert', adminOnly, (req, res) => {
  const { licenseKey, productCode, tier, framework, status, customerEmail, notes } = req.body || {};
  const key = normalizeKey(licenseKey);
  if (!key || !productCode || !tier || !framework) {
    return res.status(400).json({ ok: false, message: 'licenseKey, productCode, tier, and framework are required' });
  }
  const db = loadDb();
  const existing = db.licenses[key] || {};
  db.licenses[key] = {
    ...existing,
    licenseId: existing.licenseId || makeLicenseId(key),
    licenseKey: key,
    productCode,
    tier,
    framework,
    status: status || existing.status || 'active',
    customerEmail: customerEmail || existing.customerEmail || '',
    notes: notes || existing.notes || '',
    updatedAt: new Date().toISOString(),
  };
  saveDb(db);
  res.json({ ok: true, license: db.licenses[key] });
});

app.post('/v1/licenses/admin/unbind', adminOnly, (req, res) => {
  const key = normalizeKey(req.body && req.body.licenseKey);
  if (!key) return res.status(400).json({ ok: false, message: 'licenseKey is required' });
  const db = loadDb();
  const record = db.licenses[key];
  if (!record) return res.status(404).json({ ok: false, message: 'License not found' });
  delete record.boundFingerprint;
  delete record.firstActivatedAt;
  record.updatedAt = new Date().toISOString();
  db.licenses[key] = record;
  saveDb(db);
  res.json({ ok: true, license: record });
});

app.listen(PORT, () => {
  ensureDataFile();
  console.log(`SyrupRX backend listening on ${PORT}`);
});
