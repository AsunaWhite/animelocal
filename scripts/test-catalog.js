'use strict';

/**
 * catalog 自测
 * ------------------------------------------------------------
 *   node scripts/test-catalog.js            只跑离线 fixture 回归
 *   node scripts/test-catalog.js --live     再联网抓一次当季
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const catalog = require('../src/main/catalog');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', '202610.html');
const EXPECTED = path.join(ROOT, 'test', 'fixtures', '202610.expected.json');

function testParse() {
  const html = fs.readFileSync(FIXTURE, 'utf8');
  const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
  const got = catalog.parseCatalog(html, '202610');

  console.log(`fixture 解析出 ${got.length} 部，旧版 Python 解析出 ${expected.length} 部`);

  const gotTitles = got.map((e) => e.title);
  const expTitles = expected.map((e) => e.title);
  const missing = expTitles.filter((t) => !gotTitles.includes(t));
  const extra = gotTitles.filter((t) => !expTitles.includes(t));

  if (missing.length) console.log('  缺少:', missing);
  if (extra.length) console.log('  多出:', extra);
  assert.deepStrictEqual(got.map((e) => e.title), expTitles, '标题列表与旧解析不一致');

  // 字段抽查：每条都得有 id / season / title，且有一半以上带封面和平台
  for (const e of got) {
    assert.ok(e.id && e.id.length === 12, `id 异常: ${e.title}`);
    assert.strictEqual(e.season, '202610');
    assert.ok(e.title.length > 0);
  }
  const withCover = got.filter((e) => e.cover).length;
  const withPlatform = got.filter((e) => e.platforms.length).length;
  console.log(`  带封面 ${withCover}/${got.length}，带平台 ${withPlatform}/${got.length}`);

  const sample = got[0];
  console.log('  样例:', JSON.stringify({
    id: sample.id,
    section: sample.section,
    time: sample.time,
    date: sample.date,
    title: sample.title,
    cover: sample.cover ? sample.cover.slice(0, 60) + '…' : null,
    platforms: sample.platforms.slice(0, 2),
    net: sample.net,
    episodes: sample.episodes,
  }, null, 2));

  assert.ok(withCover >= got.length * 0.8, '封面覆盖率太低，解析可能偏了');

  // 介绍区的日文原名：字幕组用罗马音命名时，靠它去 AniList 换罗马音
  const withJp = got.filter((e) => e.titleJp);
  console.log(`  带日文原名 ${withJp.length}/${got.length}`);
  assert.ok(withJp.length >= got.length * 0.85, '日文原名覆盖率太低，介绍区解析可能偏了');
  assert.strictEqual(withJp[0].titleJp, 'どうも、好きな人に惚れ薬を依頼された魔女です。', '第 1 部的日文原名不对');
  console.log('✓ fixture 解析通过');
}

async function testLive() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animelocal-cat-'));
  const season = catalog.currentSeason();
  console.log(`\n联网抓当季 ${season}（缓存目录 ${dir}）…`);
  const data = await catalog.loadSeason(dir, season, { log: (m) => console.log('  ' + m) });
  console.log(`  → ${data.entries.length} 部，stale=${data.stale}`);
  assert.ok(data.entries.length > 10, '当季条目太少');
  const covers = data.entries.filter((e) => e.coverFile).length;
  console.log(`  → 封面落地 ${covers} 个`);
  console.log('  周一分节前 3 部:', data.entries.filter((e) => e.section.startsWith('周一')).slice(0, 3).map((e) => e.title));

  // 第二次调用应该直接吃缓存
  const again = await catalog.loadSeason(dir, season, { log: (m) => console.log('  ' + m) });
  assert.strictEqual(again.fromCache, true, '第二次应当命中缓存');
  console.log('✓ 缓存命中通过');
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  testParse();
  if (process.argv.includes('--live')) await testLive();
  console.log('\n全部通过');
})().catch((err) => {
  console.error('\n✗ 失败:', err);
  process.exit(1);
});
