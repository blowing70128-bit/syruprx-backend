const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, '..', 'data', 'licenses.json');
const sample = { licenses: {} };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(sample, null, 2));
console.log('Seeded', out);
