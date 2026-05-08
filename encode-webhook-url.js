#!/usr/bin/env node
/**
 * Encodes your N8N webhook URL so it can be safely embedded in jobsearch.html
 * without appearing as plain text in the source code.
 *
 * Usage:
 *   node encode-webhook-url.js "https://your-n8n-instance.app.n8n.cloud/webhook/abc123"
 *
 * Then paste the two output lines into jobsearch.html, replacing the existing
 * _EP and _EK values inside the obfuscated endpoint block.
 */

const url = process.argv[2];

if (!url || !url.startsWith('http')) {
  console.error('\n  Error: provide a valid webhook URL as the first argument.\n');
  console.error('  Usage: node encode-webhook-url.js "https://your-n8n-webhook-url"\n');
  process.exit(1);
}

// 32-byte random key (different every run — regenerate any time you rotate the URL)
const key = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));

// XOR each character of the URL against the cycling key, then base64-encode
const encoded = Buffer.from(
  [...url].map((c, i) => c.charCodeAt(0) ^ key[i % key.length])
).toString('base64');

// Verify round-trip before printing
const decoded = Buffer.from(encoded, 'base64')
  .toString('binary')
  .split('')
  .map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ key[i % key.length]))
  .join('');

if (decoded !== url) {
  console.error('  Round-trip verification FAILED. Do not use these values.');
  process.exit(1);
}

console.log('\n  ✓ Encoded successfully. Paste these two lines into jobsearch.html,');
console.log('    replacing the existing _EP and _EK values:\n');
console.log(`    const _EP = '${encoded}';`);
console.log(`    const _EK = [${key.join(',')}];\n`);
console.log('  The original URL is NOT printed here for safety.\n');
