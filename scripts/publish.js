#!/usr/bin/env node

/**
 * GravityPulse Open VSX Publishing Script
 * Polyfills File class for Node.js 18 compatibility with undici/ovsx
 */

globalThis.File = globalThis.File || class File {};

const ovsx = require('ovsx');
const path = require('path');
const fs = require('fs');

async function publish() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/OVSX_PAT\s*=\s*["']?([^"'\r\n]+)["']?/);
    if (match && !process.env.OVSX_PAT) {
      process.env.OVSX_PAT = match[1];
    }
  }

  const token = process.argv[2] || process.env.OVSX_PAT;
  if (!token) {
    console.error('❌ Usage: node scripts/publish.js <OPEN_VSX_TOKEN>');
    console.error('   Or set OVSX_PAT in your .env file or environment variables.');
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const vsixFile = path.join(__dirname, '..', `gravity-pulse-${pkg.version}.vsix`);

  if (!fs.existsSync(vsixFile)) {
    console.error(`❌ VSIX file not found: ${vsixFile}`);
    process.exit(1);
  }

  console.log(`🚀 Publishing ${pkg.publisher}.${pkg.name} v${pkg.version} to Open VSX Registry...`);
  console.log(`📦 File: ${vsixFile}`);

  try {
    await ovsx.publish({
      packagePath: vsixFile,
      pat: token
    });
    console.log(`\n🎉 Successfully published ${pkg.publisher}.${pkg.name} v${pkg.version} to Open VSX!`);
    console.log(`🔗 Link: https://open-vsx.org/extension/${pkg.publisher}/${pkg.name}`);
  } catch (err) {
    console.error('❌ Error publishing to Open VSX:', err);
    process.exit(1);
  }
}

publish();
