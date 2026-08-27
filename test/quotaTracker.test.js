const assert = require('assert');
const { AlertManager } = require('../dist/alertManager');
const { BurnRateTracker } = require('../dist/burnRateTracker');
const { HistoryTracker } = require('../dist/historyTracker');

// 1. Existing Point-to-point precision tests
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

// 2. Feature 1: Multi-Tier Quota Alerts & State Machine Tests
function testAlertManagerStateMachine() {
  console.log('🧪 Testing Multi-Tier Alerts State Machine (Crossing, Debounce, Reset-on-refill)...');

  const config = {
    infoThreshold: 20,
    criticalThreshold: 10,
    severeThreshold: 5,
    globalAlertCooldownMinutes: 2,
    creditsInfoThreshold: 25,
    creditsCriticalThreshold: 10,
    creditsSevereThreshold: 3
  };

  const modelLabel = 'Gemini 3.6 Flash (Medium)';
  const pinned = [modelLabel];
  const makeModel = (pct) => ({
    label: modelLabel,
    modelId: 'gemini_3_6_flash_medium',
    remainingPercentage: pct,
    remainingFraction: pct / 100,
    isExhausted: pct === 0,
    resetTime: new Date(),
    timeUntilResetFormatted: 'Ready'
  });

  const am = new AlertManager();
  let baseTime = 1000000;

  // Poll 1: 50% (no alert)
  let events = am.processSnapshot([makeModel(50)], pinned, undefined, config, baseTime);
  assert.strictEqual(events.length, 0, 'No alert at 50%');

  // Poll 2: 19% (crosses below 20% Info threshold, cycle 1 of debounce)
  events = am.processSnapshot([makeModel(19)], pinned, undefined, config, baseTime + 30000);
  assert.strictEqual(events.length, 0, 'Debounce cycle 1: should not fire yet');

  // Poll 3: 18% (cycle 2 of debounce) -> Info alert fires!
  events = am.processSnapshot([makeModel(18)], pinned, undefined, config, baseTime + 60000);
  assert.strictEqual(events.length, 1, 'Debounce cycle 2: Info alert should fire');
  assert.strictEqual(events[0].tier, 'info');
  assert.strictEqual(events[0].threshold, 20);

  // Poll 4: 17% (already alerted at 20% tier, no new downward threshold crossed)
  events = am.processSnapshot([makeModel(17)], pinned, undefined, config, baseTime + 90000);
  assert.strictEqual(events.length, 0, 'Should not re-fire at same threshold in same cycle');

  // Poll 5: 9% (crosses below 10% Critical threshold, cycle 1)
  events = am.processSnapshot([makeModel(9)], pinned, undefined, config, baseTime + 120000);
  assert.strictEqual(events.length, 0, 'Critical debounce cycle 1: should not fire yet');

  // Poll 6: 8% (cycle 2, advance time by 3 mins for cooldown) -> Critical alert fires!
  events = am.processSnapshot([makeModel(8)], pinned, undefined, config, baseTime + 300000);
  assert.strictEqual(events.length, 1, 'Critical alert should fire after debounce + cooldown');
  assert.strictEqual(events[0].tier, 'critical');
  assert.strictEqual(events[0].threshold, 10);

  // Poll 7: Quota Refill detected: rises from 8% to 60%
  events = am.processSnapshot([makeModel(60)], pinned, undefined, config, baseTime + 330000);
  assert.strictEqual(events.length, 0, 'No alert on refill');
  const state = am.getModelState(modelLabel);
  assert.strictEqual(state.lastAlertedThreshold, null, 'State must be reset on refill');

  // Poll 8: Drops back to 19% (cycle 1)
  events = am.processSnapshot([makeModel(19)], pinned, undefined, config, baseTime + 500000);
  assert.strictEqual(events.length, 0, 'Debounce cycle 1 after refill');

  // Poll 9: 18% (cycle 2) -> Info alert fires again because state was reset!
  events = am.processSnapshot([makeModel(18)], pinned, undefined, config, baseTime + 530000);
  assert.strictEqual(events.length, 1, 'Info alert should re-fire after refill reset');
  assert.strictEqual(events[0].tier, 'info');

  console.log('✅ Multi-Tier Alerts State Machine tests passed!');
}

function testDebounceReversalCancellation() {
  console.log('🧪 Testing Debounce Reversal Cancellation (Flapping Protection)...');

  const config = {
    infoThreshold: 20,
    criticalThreshold: 10,
    severeThreshold: 5,
    globalAlertCooldownMinutes: 2,
    creditsInfoThreshold: 25,
    creditsCriticalThreshold: 10,
    creditsSevereThreshold: 3
  };

  const modelLabel = 'Gemini 3.7 Flash (High)';
  const pinned = [modelLabel];
  const makeModel = (pct) => ({
    label: modelLabel,
    modelId: 'gemini_3_7_flash_high',
    remainingPercentage: pct,
    remainingFraction: pct / 100,
    isExhausted: false,
    resetTime: new Date(),
    timeUntilResetFormatted: 'Ready'
  });

  const am = new AlertManager();
  let baseTime = 2000000;

  // Cycle 1: 25%
  am.processSnapshot([makeModel(25)], pinned, undefined, config, baseTime);

  // Cycle 2: Dips to 19.5% (below 20, candidate crossing cycle 1)
  let events = am.processSnapshot([makeModel(19.5)], pinned, undefined, config, baseTime + 30000);
  assert.strictEqual(events.length, 0, 'Candidate cycle 1');

  // Cycle 3: Reverses back up to 21% before cycle 2!
  events = am.processSnapshot([makeModel(21.0)], pinned, undefined, config, baseTime + 60000);
  assert.strictEqual(events.length, 0, 'Reversal above threshold: no alert');

  // Verify pending crossing was discarded
  const state = am.getModelState(modelLabel);
  assert.strictEqual(state.pendingCrossing, null, 'Pending crossing must be discarded on reversal');
  assert.strictEqual(state.lastAlertedThreshold, null, 'No alerted threshold');

  console.log('✅ Debounce Reversal Cancellation tests passed!');
}

function testGlobalCooldown() {
  console.log('🧪 Testing Global Alert Cooldown Across Sources...');

  const config = {
    infoThreshold: 20,
    criticalThreshold: 10,
    severeThreshold: 5,
    globalAlertCooldownMinutes: 2, // 2-minute cooldown
    creditsInfoThreshold: 25,
    creditsCriticalThreshold: 10,
    creditsSevereThreshold: 3
  };

  const modelA = 'Gemini 3.6 Flash (Medium)';
  const modelB = 'Gemini 3.7 Flash (High)';
  const pinned = [modelA, modelB];

  const makeModel = (label, pct) => ({
    label,
    modelId: label.toLowerCase().replace(/[^a-z0-9]/g, '_'),
    remainingPercentage: pct,
    remainingFraction: pct / 100,
    isExhausted: false,
    resetTime: new Date(),
    timeUntilResetFormatted: 'Ready'
  });

  const am = new AlertManager();
  let baseTime = 3000000;

  // Cycle 1: Both models drop to 19%
  am.processSnapshot([makeModel(modelA, 19), makeModel(modelB, 19)], pinned, undefined, config, baseTime);

  // Cycle 2: Both models at 18% (debounce met for both simultaneously)
  let events = am.processSnapshot([makeModel(modelA, 18), makeModel(modelB, 18)], pinned, undefined, config, baseTime + 30000);

  // Exactly 1 alert should fire, the second should be suppressed by global cooldown!
  assert.strictEqual(events.length, 1, 'Only 1 alert should fire due to global cooldown');
  assert.strictEqual(events[0].modelLabel, modelA);

  // Cycle 3: 30 seconds later (within 2m cooldown), Model B is at 17% -> still suppressed
  events = am.processSnapshot([makeModel(modelA, 18), makeModel(modelB, 17)], pinned, undefined, config, baseTime + 60000);
  assert.strictEqual(events.length, 0, 'Suppressed during cooldown window');

  // Cycle 4: 2.5 minutes later (cooldown expired), Model B drops to 9% (Critical cycle 1)
  events = am.processSnapshot([makeModel(modelA, 18), makeModel(modelB, 9)], pinned, undefined, config, baseTime + 200000);
  assert.strictEqual(events.length, 0, 'Critical cycle 1 for Model B');

  // Cycle 5: Model B at 8% (Critical cycle 2) -> Fires because cooldown expired!
  events = am.processSnapshot([makeModel(modelA, 18), makeModel(modelB, 8)], pinned, undefined, config, baseTime + 230000);
  assert.strictEqual(events.length, 1, 'Model B Critical alert fires after cooldown expired');
  assert.strictEqual(events[0].modelLabel, modelB);
  assert.strictEqual(events[0].tier, 'critical');

  console.log('✅ Global Alert Cooldown tests passed!');
}

function testUnpinnedModelAlertSuppression() {
  console.log('🧪 Testing Unpinned Model Alert Suppression...');

  const config = {
    infoThreshold: 20,
    criticalThreshold: 10,
    severeThreshold: 5,
    globalAlertCooldownMinutes: 2,
    creditsInfoThreshold: 25,
    creditsCriticalThreshold: 10,
    creditsSevereThreshold: 3
  };

  const unpinnedModel = 'Claude Opus 4.6 (Thinking)';
  const pinned = ['Gemini 3.6 Flash (Medium)']; // Unpinned model not in pinned list

  const makeModel = (pct) => ({
    label: unpinnedModel,
    modelId: 'claude_opus_4_6',
    remainingPercentage: pct,
    remainingFraction: pct / 100,
    isExhausted: false,
    resetTime: new Date(),
    timeUntilResetFormatted: 'Ready'
  });

  const am = new AlertManager();
  let baseTime = 4000000;

  // Cycle 1: 4% (Severe tier)
  let events = am.processSnapshot([makeModel(4)], pinned, undefined, config, baseTime);
  assert.strictEqual(events.length, 0);

  // Cycle 2: 3% (Severe tier)
  events = am.processSnapshot([makeModel(3)], pinned, undefined, config, baseTime + 30000);
  assert.strictEqual(events.length, 0, 'Unpinned model should never fire alerts');

  console.log('✅ Unpinned Model Alert Suppression tests passed!');
}

// 3. Feature 4: Prompt Credits Threshold Alerts
function testPromptCreditsAlerts() {
  console.log('🧪 Testing Prompt Credits Threshold Alerts Stream...');

  const config = {
    infoThreshold: 20,
    criticalThreshold: 10,
    severeThreshold: 5,
    globalAlertCooldownMinutes: 2,
    creditsInfoThreshold: 25,
    creditsCriticalThreshold: 10,
    creditsSevereThreshold: 3
  };

  const am = new AlertManager();
  let baseTime = 5000000;

  const makeCredits = (available, monthly = 50000) => ({
    available,
    monthly,
    usedPercentage: ((monthly - available) / monthly) * 100,
    remainingPercentage: (available / monthly) * 100
  });

  // Cycle 1: 50,000 / 50,000 (100%) -> no alert
  let events = am.processSnapshot([], [], makeCredits(50000), config, baseTime);
  assert.strictEqual(events.length, 0);

  // Cycle 2: 12,000 / 50,000 (24% -> Info tier <= 25%, cycle 1)
  events = am.processSnapshot([], [], makeCredits(12000), config, baseTime + 30000);
  assert.strictEqual(events.length, 0, 'Debounce cycle 1');

  // Cycle 3: 11,500 / 50,000 (23%, cycle 2) -> Credits Info alert fires!
  events = am.processSnapshot([], [], makeCredits(11500), config, baseTime + 60000);
  assert.strictEqual(events.length, 1, 'Credits Info alert should fire');
  assert.strictEqual(events[0].type, 'credits');
  assert.strictEqual(events[0].tier, 'info');
  assert.strictEqual(events[0].threshold, 25);
  assert.strictEqual(events[0].availableCredits, 11500);

  // Refill credits: 50,000 / 50,000
  events = am.processSnapshot([], [], makeCredits(50000), config, baseTime + 90000);
  assert.strictEqual(events.length, 0);
  assert.strictEqual(am.getCreditsState().lastAlertedThreshold, null, 'Credits state reset on refill');

  console.log('✅ Prompt Credits Threshold Alerts tests passed!');
}

// 4. Feature 2: Burn-Rate / Time-to-Empty Estimate
function testBurnRateTracker() {
  console.log('🧪 Testing Burn-Rate & Time-to-Empty Calculation...');

  const tracker = new BurnRateTracker();
  const model = 'Gemini 3.6 Flash (Medium)';
  const now = 1000000;

  // Less than 3 samples -> null
  tracker.recordSample(model, 100, now);
  tracker.recordSample(model, 98, now + 60000);
  assert.strictEqual(tracker.computeEstimate(model), null, 'Insufficient samples (< 3) must return null');

  // 3rd sample: at 2 mins, 96%
  tracker.recordSample(model, 96, now + 120000);
  // Rate: (100 - 96) / 2 min = 2%/min. Current = 96%. ETA = 96 / 2 = 48m.
  let est = tracker.computeEstimate(model);
  assert.notStrictEqual(est, null);
  assert.strictEqual(est.minutesToEmpty, 48);
  assert.strictEqual(est.formattedEta, '~48m until empty at current pace');

  // Test Flat Quota (no decline)
  const flatModel = 'FlatModel';
  tracker.recordSample(flatModel, 80, now);
  tracker.recordSample(flatModel, 80, now + 60000);
  tracker.recordSample(flatModel, 80, now + 120000);
  assert.strictEqual(tracker.computeEstimate(flatModel), null, 'Flat quota must return null (omit ETA)');

  // Test Increasing Quota (refill)
  const refillModel = 'RefillModel';
  tracker.recordSample(refillModel, 20, now);
  tracker.recordSample(refillModel, 50, now + 60000);
  tracker.recordSample(refillModel, 80, now + 120000);
  assert.strictEqual(tracker.computeEstimate(refillModel), null, 'Increasing quota must return null');

  // Test Hours Formatting
  assert.strictEqual(tracker.formatEta(38), '~38m until empty at current pace');
  assert.strictEqual(tracker.formatEta(60), '~1h until empty at current pace');
  assert.strictEqual(tracker.formatEta(75), '~1h 15m until empty at current pace');
  assert.strictEqual(tracker.formatEta(120), '~2h until empty at current pace');

  console.log('✅ Burn-Rate & Time-to-Empty tests passed!');
}

// 5. Feature 3: History Sparkline & 24h Pruning
function testHistoryTrackerAndSparklines() {
  console.log('🧪 Testing Historical Usage Sparklines & 24h Pruning...');

  const mockGlobalStateData = {};
  const mockContext = {
    globalState: {
      get: (key) => mockGlobalStateData[key],
      update: (key, val) => {
        mockGlobalStateData[key] = val;
        return Promise.resolve();
      }
    }
  };

  const ht = new HistoryTracker(mockContext);
  const model = 'Gemini 3.7 Flash (High)';
  const now = Date.now();

  // Test block conversion
  assert.strictEqual(ht.percentageToBlock(0), ' ');
  assert.strictEqual(ht.percentageToBlock(50), '▅');
  assert.strictEqual(ht.percentageToBlock(100), '█');

  // Add 10 data points showing decline: 100, 90, 80, 70, 60, 50, 40, 30, 20, 10
  const pcts = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
  pcts.forEach((p, idx) => {
    ht.recordPoint(model, p, now + idx * 1000);
  });

  const sparkline = ht.getSparkline(model, 8);
  assert.strictEqual(sparkline.length, 8, 'Sparkline should contain 8 characters');
  assert.strictEqual(sparkline, '▇▆▅▅▄▃▂ ');

  // Test 24h pruning: point from 25 hours ago
  const oldTs = now - (25 * 60 * 60 * 1000);
  ht.recordPoint('OldModel', 100, oldTs);
  // Add a recent point
  ht.recordPoint('OldModel', 80, now);
  const oldHistory = ht.getHistory('OldModel');
  assert.strictEqual(oldHistory.length, 1, 'Points older than 24h must be pruned');
  assert.strictEqual(oldHistory[0].percentage, 80);

  // Test capping to 100 points
  for (let i = 0; i < 150; i++) {
    ht.recordPoint('HeavyModel', i % 100, now + i * 1000);
  }
  assert.strictEqual(ht.getHistory('HeavyModel').length, 100, 'Must cap history at 100 points');

  // Test Trend Direction: gathering (< 2 points)
  const newModelTrend = ht.getTrendInfo('BrandNewModel');
  assert.strictEqual(newModelTrend.direction, 'gathering');
  assert.strictEqual(newModelTrend.formatted, '— (gathering data)');

  // 1 point only -> still gathering
  ht.recordPoint('BrandNewModel', 100, now);
  const onePointTrend = ht.getTrendInfo('BrandNewModel');
  assert.strictEqual(onePointTrend.direction, 'gathering');
  assert.strictEqual(onePointTrend.formatted, '— (gathering data)');

  // Test Trend Direction: Declining
  const decliningTrend = ht.getTrendInfo(model, 8);
  assert.strictEqual(decliningTrend.direction, 'declining');
  assert.strictEqual(decliningTrend.formatted, '▇▆▅▅▄▃▂  (declining)');

  // Test Trend Direction: Stable (Flat data within 1% threshold)
  const flatModel = 'GenuinelyFlatModel';
  for (let i = 0; i < 6; i++) {
    ht.recordPoint(flatModel, 83.4, now + i * 1000);
  }
  const flatTrend = ht.getTrendInfo(flatModel, 6);
  assert.strictEqual(flatTrend.direction, 'stable');
  assert.strictEqual(flatTrend.formatted, '▇▇▇▇▇▇ (stable)', 'Flat data must show multi-char sparkline and (stable)');

  // Test Trend Direction: Rising (Refill / Recharge > 1%)
  const risingModel = 'RechargingModel';
  ht.recordPoint(risingModel, 30, now);
  ht.recordPoint(risingModel, 50, now + 1000);
  ht.recordPoint(risingModel, 80, now + 2000);
  const risingTrend = ht.getTrendInfo(risingModel, 3);
  assert.strictEqual(risingTrend.direction, 'rising');
  assert.strictEqual(risingTrend.formatted, '▃▅▇ (rising)');

  console.log('✅ Historical Usage Sparklines & 24h Pruning tests passed!');
}

function runAll() {
  console.log('🚀 Running GravityPulse Verification Tests...\n');
  testPointToPointCalculations();
  testServerRefillTimeFormat();
  testCarbonThemeIcons();
  test4TierWarningColors();
  testAlertManagerStateMachine();
  testDebounceReversalCancellation();
  testGlobalCooldown();
  testUnpinnedModelAlertSuppression();
  testPromptCreditsAlerts();
  testBurnRateTracker();
  testHistoryTrackerAndSparklines();
  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
}

runAll();

