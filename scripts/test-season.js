/**
 * 季度更新逻辑的单元测试（纯函数，不碰网络、不碰磁盘）
 * 跑：npm run test:season
 */
const assert = require('node:assert');
const { seasonUpdateAt, seasonStartAt, needsQuarterRefresh, updateLabel } = require('../src/shared/season');

let pass = 0;
function ok(name, fn) {
  fn();
  pass++;
  console.log(`  ✓ ${name}`);
}

console.log('季度更新日');

ok('202610 的更新日是 2026-10-15 00:00', () => {
  const d = seasonUpdateAt('202610');
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 9); // 0 基
  assert.strictEqual(d.getDate(), 15);
  assert.strictEqual(d.getHours(), 0);
});

ok('四个季度都落在首月 15 号', () => {
  const got = ['202601', '202604', '202607', '202610'].map((k) => {
    const d = seasonUpdateAt(k);
    return `${d.getMonth() + 1}-${d.getDate()}`;
  });
  assert.deepStrictEqual(got, ['1-15', '4-15', '7-15', '10-15']);
});

ok('季度号不合法返回 null', () => {
  for (const bad of ['', '2026', '202602', '202613', 'abc', null, undefined]) {
    assert.strictEqual(seasonUpdateAt(bad), null, `应为 null: ${String(bad)}`);
  }
});

ok('数字形式的季度号也能认（String 一下就行）', () => {
  assert.strictEqual(seasonUpdateAt(202610).getMonth(), 9);
});

ok('季度开始日是首月 1 号 00:00', () => {
  const d = seasonStartAt('202607');
  assert.strictEqual(d.getMonth(), 6);
  assert.strictEqual(d.getDate(), 1);
});

ok('updateLabel 说人话', () => {
  assert.strictEqual(updateLabel('202610'), '10 月 15 日');
  assert.strictEqual(updateLabel('bad'), '');
});

console.log('要不要强制刷');

ok('15 号之前不刷（哪怕缓存很旧）', () => {
  assert.strictEqual(
    needsQuarterRefresh({
      seasonKey: '202610',
      fetchedAt: '2026-09-01T00:00:00.000Z',
      now: new Date(2026, 9, 14, 23, 59), // 10-14 23:59
    }),
    false
  );
});

ok('15 号 00:00 整点，缓存旧了就刷', () => {
  assert.strictEqual(
    needsQuarterRefresh({
      seasonKey: '202610',
      fetchedAt: new Date(2026, 9, 10, 12).toISOString(),
      now: new Date(2026, 9, 15, 0, 0),
    }),
    true
  );
});

ok('15 号之后抓过了就不刷', () => {
  assert.strictEqual(
    needsQuarterRefresh({
      seasonKey: '202610',
      fetchedAt: new Date(2026, 9, 20, 9).toISOString(),
      now: new Date(2026, 9, 25, 9),
    }),
    false
  );
});

ok('15 号之后、缓存停在 14 号 → 刷', () => {
  assert.strictEqual(
    needsQuarterRefresh({
      seasonKey: '202610',
      fetchedAt: new Date(2026, 9, 14, 23).toISOString(),
      now: new Date(2026, 10, 2, 8),
    }),
    true
  );
});

ok('压根没缓存、已过 15 号 → 刷', () => {
  assert.strictEqual(
    needsQuarterRefresh({ seasonKey: '202601', fetchedAt: null, now: new Date(2026, 0, 20) }),
    true
  );
});

ok('坏时间戳当没缓存处理', () => {
  assert.strictEqual(
    needsQuarterRefresh({ seasonKey: '202601', fetchedAt: 'not-a-date', now: new Date(2026, 0, 20) }),
    true
  );
});

ok('季度号不合法一律不刷', () => {
  assert.strictEqual(needsQuarterRefresh({ seasonKey: '202602', fetchedAt: null }), false);
});

console.log(`\n通过 ${pass}/${pass} ✅`);
