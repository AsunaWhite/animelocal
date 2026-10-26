'use strict';

/**
 * 阶段 3 的测试：集数识别 + 标题匹配 + 真扫目录
 *   node scripts/test-scanner.js
 * 不联网，用 test/fixtures 里的当季页面当番剧表。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const catalog = require('../src/main/catalog');
const scanner = require('../src/main/scanner');

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else failures.push(`${name}\n    期望: ${JSON.stringify(expected)}\n    实际: ${JSON.stringify(actual)}`);
}

function checkTrue(name, cond, extra = '') {
  if (cond) pass++;
  else failures.push(`${name}${extra ? '\n    ' + extra : ''}`);
}

// ---------------------------------------------------------------- 1. 集数识别

const episodeCases = [
  ['[Lilith-Raws] Tensei Goblin - 03 [1080p][CHS].mkv', 3],
  ['你好我是受心上人所托来做恋爱药的魔女 第01话.mp4', 1],
  ['PSYREN 决战游戏 - 08.mp4', 8],
  ['[NC-Raws] 転生ゴブリン 第12話 [B-Global][1080P].mp4', 12],
  ['Some Show S02E07.mkv', 7],
  ['某动画 EP08.mkv', 8],
  ['某动画 EP.08.mkv', 8],
  ['[Group] Show [01].mkv', 1],
  ['[Group] Show [01v2].mkv', 1],
  ['Show 第5集.mkv', 5],
  ['[Lilith-Raws] 孤独摇滚 - 07 [Baha][WEB-DL][1080p][AVC AAC][CHT][MP4].mp4', 7],
  ['【字幕组】某个动画 08 【720P】.mkv', 8],
  ['Show - 12 -.mkv', 12],
];

for (const [name, expected] of episodeCases) {
  const r = scanner.parseEpisode(name);
  check(`集数 ${name}`, r.episode, expected);
  checkTrue(`集数 ${name} 判成正片`, r.kind === 'main', `kind=${r.kind}`);
}

// 合集
const batch = scanner.parseEpisode('Show 01-12 合集.mkv');
check('合集 episode', batch.episode, 1);
check('合集 range', batch.range, [1, 12]);
check('合集 kind', batch.kind, 'batch');

// 不该被当成集数的
const noEp = [
  'Show 2024 1080p.mkv',
  'Show - 2024.mkv',
  'readme.txt.mkv',
];
for (const name of noEp) {
  const r = scanner.parseEpisode(name);
  checkTrue(`无集数 ${name}`, r.episode === null, `得到 ${r.episode}（method=${r.method}）`);
}

// 片头片尾花絮
for (const name of ['Show NCOP.mkv', 'Show NCED1.mkv', 'Show OVA.mkv', 'Show PV.mp4', 'Show Menu.mkv']) {
  const r = scanner.parseEpisode(name);
  check(`非正片 ${name}`, r.kind, 'extra');
}

// ---------------------------------------------------------------- 2. 标题匹配

check('完全一致', scanner.scoreTitle('孤独摇滚', '孤独摇滚'), 1);
checkTrue('包含关系', scanner.scoreTitle('你好我是受心上人所托来做恋爱药的魔女03', '你好 我是受心上人所托来做恋爱药的魔女') >= 0.9);
checkTrue('字幕组前缀', scanner.scoreTitle('[Lilith-Raws] 转生成哥布林有什么问题吗', '转生成哥布林有什么问题吗') >= 0.9);
checkTrue('中文名部分重合', scanner.scoreTitle('转生成哥布林', '转生成哥布林有什么问题吗') >= 0.6);
checkTrue('无关目录', scanner.scoreTitle('D盘备份资料', '孤独摇滚') < 0.2);

// ---------------------------------------------------------------- 3. 真扫目录

const html = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', '202610.html'), 'utf8');
const shows = catalog.parseCatalog(html, '202610');
checkTrue('番剧表 72 部', shows.length === 72, `实际 ${shows.length}`);

const byTitle = new Map(shows.map((s) => [s.title, s]));

const magicTitle = '你好 我是受心上人所托来做恋爱药的魔女';
const goblinTitle = '转生成哥布林有什么问题吗';
const psyrenTitle = 'PSYREN 决战游戏';
for (const t of [magicTitle, goblinTitle, psyrenTitle]) {
  checkTrue(`番剧表里有「${t}」`, byTitle.has(t));
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'animelocal-scan-'));

function touch(relPath) {
  const full = path.join(tmpRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'fake video');
}

touch(path.join(magicTitle, '第01话.mkv'));
touch(path.join(magicTitle, '第02话.mkv'));
touch(path.join(magicTitle, 'NCOP.mkv'));
touch(path.join('[Lilith-Raws] ' + goblinTitle, '01.mkv'));
touch(path.join('[Lilith-Raws] ' + goblinTitle, '02.mkv'));
touch(path.join(psyrenTitle, 'PSYREN - 08.mp4'));
touch(path.join('D盘备份资料', 'random 01.mkv')); // 认不出来的
touch(path.join('D盘备份资料', 'notes.txt')); // 非视频，应被忽略

scanner
  .scanDirectory({ root: tmpRoot, shows, aliasMap: new Map() })
  .then((result) => {
    check('扫到视频数', result.files, 7);
    check('认出来的条数', result.matched.length, 5);
    check('待确认条数', result.unmatched.length, 1);
    check('非正片条数', result.extras.length, 1);

    const magic = result.matched.filter((r) => r.showId === byTitle.get(magicTitle).id);
    check('魔女集数', magic.map((r) => r.episode), [1, 2]);

    const goblin = result.matched.filter((r) => r.showId === byTitle.get(goblinTitle).id);
    check('哥布林集数', goblin.map((r) => r.episode), [1, 2]);
    checkTrue('哥布林靠文件夹名认出', goblin[0].matchedBy === '文件夹名', goblin[0].matchedBy);

    const psyren = result.matched.filter((r) => r.showId === byTitle.get(psyrenTitle).id);
    check('PSYREN 集数', psyren.map((r) => r.episode), [8]);

    check('认不出的文件', result.unmatched[0].name, 'random 01.mkv');

    // ---------------- 4. 别名记忆
    const aliasMap = new Map([[byTitle.get(psyrenTitle).id, ['D盘备份资料']]]);
    return scanner.scanDirectory({ root: tmpRoot, shows, aliasMap });
  })
  .then((result) => {
    // 加了别名之后，那个「认不出来」的文件夹应该靠别名认出来
    const talked = result.unmatched.find((r) => r.dir.endsWith('D盘备份资料'));
    checkTrue('别名生效后不再进待确认', !talked, talked ? `仍待确认: ${talked.name}` : '');
    check('别名生效后认出来 6 条', result.matched.length, 6);

    // ---------------- 5. 罗马音（字幕组常见命名）
    const goblinId = byTitle.get(goblinTitle).id;
    const romajiShows = shows.map((s) =>
      s.id === goblinId ? { ...s, aliases: ['Tensei Goblin Dakedo Shitsumon Aru?'] } : s
    );
    const romajiRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'animelocal-romaji-'));
    const put = (rel) => {
      const full = path.join(romajiRoot, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'fake video');
    };
    put(path.join('Tensei Goblin dakedo Shitsumon Aru', '[Lilith-Raws] Tensei Goblin dakedo Shitsumon Aru - 03 [1080p].mkv'));
    put(path.join('Tensei Goblin dakedo Shitsumon Aru', '[Lilith-Raws] Tensei Goblin dakedo Shitsumon Aru - 04 [1080p].mkv'));

    return scanner.scanDirectory({ root: romajiRoot, shows: romajiShows, aliasMap: new Map() }).then((r2) => {
      fs.rmSync(romajiRoot, { recursive: true, force: true });
      const goblin = r2.matched.filter((r) => r.showId === goblinId).map((r) => r.episode).sort();
      check('罗马音文件夹认出的集数', goblin, [3, 4]);
      checkTrue('罗马音不误判成别的番', r2.matched.every((r) => r.showId === goblinId), JSON.stringify(r2.matched.map((r) => [r.name, r.title, r.score])));
      check('罗马音没有落进待确认', r2.unmatched.length, 0);
    });
  })
  .catch((err) => {
    failures.push(`扫描过程抛错: ${err.stack}`);
  })
  .finally(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });

    const total = pass + failures.length;
    console.log(`\n通过 ${pass}/${total}`);
    if (failures.length) {
      console.log('\n失败：');
      for (const f of failures) console.log('  ✗ ' + f);
      process.exitCode = 1;
    } else {
      console.log('全部通过 ✅');
    }
  });
