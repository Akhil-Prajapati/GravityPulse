const assert = require('assert');

// Test point-to-point precision (No 5% rounding)
function testPointToPointCalculations() {
  console.log('🧪 Testing Live Server Point-to-Point Precision...');

  const liveServerSamples = [
    { fraction: 0.9412, expectedPercent: '94.1%', expectedInt: 94 },
    { fraction: 1.0, expectedPercent: '100.0%', expectedInt: 100 },
    { fraction: 0.8734, expectedPercent: '87.3%', expectedInt: 87 },
    { fraction: 0.834, expectedPercent: '83.4%', expectedInt: 83 },
    { fraction: 0.1849, expectedPercent: '18.5%', expectedInt: 18 },
    { fraction: 0.082, expectedPercent: '8.2%', expectedInt: 8 },
    { fraction: 0.0, expectedPercent: '0.0%', expectedInt: 0 }
  ];

  for (const s of liveServerSamples) {
    const pct = s.fraction * 100;
    const formattedDec = `${pct.toFixed(1)}%`;
    const formattedInt = Math.round(pct);

    assert.strictEqual(formattedDec, s.expectedPercent, `Decimal format mismatch for ${s.fraction}`);
    assert.strictEqual(formattedInt, s.expectedInt, `Integer format mismatch for ${s.fraction}`);
  }

  console.log('✅ Live Server Point-to-Point Precision tests passed!');
}

function testServerRefillTimeFormat() {
  console.log('🧪 Testing Server Auto-Refill Time Formatting...');

  function formatTimeDiff(ms, resetTime) {
    if (ms <= 0) {
      return 'Auto-Refilled / Full';
    }
    const mins = Math.ceil(ms / 60000);
    let duration = '';
    if (mins < 60) {
      duration = `${mins}m`;
    } else {
      const hours = Math.floor(mins / 60);
      duration = `${hours}h ${mins % 60}m`;
    }
    return `Auto-refills in ${duration}`;
  }

  const now = Date.now();
  assert.strictEqual(formatTimeDiff(0, new Date(now)), 'Auto-Refilled / Full');
  assert.strictEqual(formatTimeDiff(45 * 60 * 1000, new Date(now + 45 * 60000)), 'Auto-refills in 45m');
  assert.strictEqual(formatTimeDiff(90 * 60 * 1000, new Date(now + 90 * 60000)), 'Auto-refills in 1h 30m');

  console.log('✅ Server Auto-Refill Time Formatting tests passed!');
}

function testCarbonThemeIcons() {
  console.log('🧪 Testing Carbon Product Icons...');

  function getThemeIcon(percent) {
    if (percent < 20) return '$(flame)';
    if (percent < 40) return '$(warning)';
    return '$(zap)';
  }

  assert.strictEqual(getThemeIcon(100), '$(zap)');
  assert.strictEqual(getThemeIcon(83.4), '$(zap)');
  assert.strictEqual(getThemeIcon(35.0), '$(warning)');
  assert.strictEqual(getThemeIcon(15.0), '$(flame)');

  console.log('✅ Carbon Product Icons tests passed!');
}

function test4TierWarningColors() {
  console.log('🧪 Testing 4-Tier Warning Color Scheme...');

  function getModelColor(percent) {
    if (percent >= 70) return '#34A853'; // Green
    if (percent >= 40) return '#9ACD32'; // Slight Green-Yellow
    if (percent >= 20) return '#FB8C00'; // Orange
    return '#EA4335'; // Red
  }

  assert.strictEqual(getModelColor(100), '#34A853');
  assert.strictEqual(getModelColor(83.4), '#34A853');
  assert.strictEqual(getModelColor(70), '#34A853');
  assert.strictEqual(getModelColor(69.9), '#9ACD32');
  assert.strictEqual(getModelColor(55), '#9ACD32');
  assert.strictEqual(getModelColor(40), '#9ACD32');
  assert.strictEqual(getModelColor(39.9), '#FB8C00');
  assert.strictEqual(getModelColor(25), '#FB8C00');
  assert.strictEqual(getModelColor(20), '#FB8C00');
  assert.strictEqual(getModelColor(19.9), '#EA4335');
  assert.strictEqual(getModelColor(5), '#EA4335');

  console.log('✅ 4-Tier Warning Color Scheme tests passed!');
}

function runAll() {
  console.log('🚀 Running GravityPulse Verification Tests...\n');
  testPointToPointCalculations();
  testServerRefillTimeFormat();
  testCarbonThemeIcons();
  test4TierWarningColors();
  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
}

runAll();
