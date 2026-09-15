'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'public', 'vendor', 'pdfjs');
fs.mkdirSync(dir, { recursive: true });

const files = [
  ['https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js', 'pdf.min.js'],
  ['https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js', 'pdf.worker.min.js']
];

function dl(url, out) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode + ' ' + url)); res.resume(); return; }
      const f = fs.createWriteStream(path.join(dir, out));
      res.pipe(f);
      f.on('finish', () => f.close(() => resolve(out)));
    }).on('error', reject);
  });
}

(async () => {
  for (const [u, o] of files) { console.log('downloading', o); await dl(u, o); }
  console.log('done');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
