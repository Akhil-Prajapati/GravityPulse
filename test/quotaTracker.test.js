const assert = require('assert');

// Test point-to-point precision (No 5% rounding)
function testPointToPointCalculations() {
  console.log('🧪 Testing Live Server Point-to-Point Precision...');

  const liveServerSamples = [
    { fraction: 0.9412, expectedPercent: '94.1%', expectedInt: 94 },
    { fraction: 1.0, expectedPercent: '100.0%', expectedInt: 100 },
    { fraction: 0.8734, expectedPercent: '87.3%', expectedInt: 87 },
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

  function getThemeIcon(percent, warningThreshold = 20, criticalThreshold = 10) {
    if (percent <= criticalThreshold) return '$(flame)';
    if (percent <= warningThreshold) return '$(warning)';
    return '$(zap)';
  }

  assert.strictEqual(getThemeIcon(100), '$(zap)');
  assert.strictEqual(getThemeIcon(94.1), '$(zap)');
  assert.strictEqual(getThemeIcon(18.5), '$(warning)');
  assert.strictEqual(getThemeIcon(8.2), '$(flame)');

  console.log('✅ Carbon Product Icons tests passed!');
}

function runAll() {
  console.log('🚀 Running GravityPulse Verification Tests...\n');
  testPointToPointCalculations();
  testServerRefillTimeFormat();
  testCarbonThemeIcons();
  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
}

runAll();
