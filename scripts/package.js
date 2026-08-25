#!/usr/bin/env node

/**
 * GravityPulse Marketplace Packaging Script
 * Compatible across Node versions with automatic global polyfills
 */

globalThis.File = globalThis.File || class File {};

const vsce = require('@vscode/vsce');
const path = require('path');
const fs = require('fs');

async function main() {
  console.log('📦 Compiling and packaging GravityPulse for Antigravity / VS Code Marketplace...');

  const packagePath = path.join(__dirname, '..', 'gravity-pulse-1.0.0.vsix');

  try {
    const result = await vsce.createVSIX({
      packagePath: packagePath,
      allowMissingRepository: true
    });

    if (fs.existsSync(packagePath)) {
      const stats = fs.statSync(packagePath);
      console.log(`\n🎉 Successfully generated marketplace VSIX package!`);
      console.log(`📁 File: ${packagePath}`);
      console.log(`📊 Size: ${(stats.size / 1024).toFixed(2)} KB`);
      console.log(`\nTo install directly into Antigravity IDE / VS Code:`);
      console.log(`  code --install-extension ${path.basename(packagePath)}`);
      console.log(`\nTo publish to Visual Studio Marketplace:`);
      console.log(`  npx vsce publish -p <YOUR_PERSONAL_ACCESS_TOKEN>\n`);
    } else {
      console.log('Result:', result);
    }
  } catch (err) {
    console.error('❌ Error creating VSIX package:', err);
    process.exit(1);
  }
}

main();
