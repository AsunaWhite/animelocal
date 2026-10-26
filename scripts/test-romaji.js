'use strict';

/**
 * 罗马音别名（AniList）自测 —— 全部离线，用假请求代替网络
 *   node scripts/test-romaji.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const romaji = require('../src/main/romaji');

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

// ---------------------------------------------------------------- 归一化

check('去空格问号小写', romaji.normalizeForMatch('Tensei Goblin Dakedo Shitsumon Aru?'), 'tenseigoblindakedoshitsumonaru');
check('长音符 ō → o', romaji.normalizeForMatch('Majo no Tabitabi Ō'), 'majonotabitabio');
check('全角与标点', romaji.normalizeForMatch('ＤＯＵＭＯ，好き！'), 'doumo好き');

// ---------------------------------------------------------------- 是不是同一部

const goblin = {
  title: { romaji: 'Tensei Goblin Dakedo Shitsumon Aru?', english: 'So What is Wrong with My Reincarnation as a Goblin?', native: '転生ゴブリンだけど質問ある？' },
  synonyms: ['転ゴブ'],
};
checkTrue('日文原名一致', romaji.isSameShow('転生ゴブリンだけど質問ある？', goblin));
checkTrue('续作后缀不影响（Ⅱ vs 第2期）', romaji.isSameShow('転生したら剣でしたⅡ', { title: { native: '転生したら剣でした 第2期', romaji: 'Tensei Shitara Ken Deshita 2nd Season' } }));
checkTrue('完全无关要拒绝', !romaji.isSameShow('転生ゴブリンだけど質問ある？', { title: { romaji: 'Black Clover', native: 'ブラッククローバー' } }));

// ---------------------------------------------------------------- 别名去重

const aliases = romaji.aliasesOf({
  title: { romaji: 'PSYREN', english: 'PSYREN', native: 'PSYREN -サイレン-' },
  synonyms: ['PSYREN', '  ', 'PSYЯEN', 'サイレン'],
});
check('别名去重去空', aliases, ['PSYREN', 'PSYЯEN', 'サイレン']);

// ---------------------------------------------------------------- 批量查

/** 假 AniList：把每条查询的日文名原样当 native 返回 */
function fakeRequest(counter) {
  return async (query, variables) => {
    const n = Object.keys(variables).length;
    counter.calls += 1;
    counter.queryLengths.push(n);
    const data = {};
    for (let i = 0; i < n; i += 1) {
      const q = variables[`q${i}`];
      data[`p${i}`] = { media: [{ title: { native: q, romaji: 'Romaji of ' + q }, synonyms: [] }] };
    }
    return data;
  };
}

const many = Array.from({ length: 10 }, (_, i) => ({ id: `id${i}`, title: `番${i}`, titleJp: `日本語${i}` }));

const counter = { calls: 0, queryLengths: [] };
romaji
  .lookupRomaji(many, { request: fakeRequest(counter), delayMs: 0 })
  .then((found) => {
    check('10 部要 2 次请求（每批 8）', counter.calls, 2);
    check('每批条数', counter.queryLengths, [romaji.BATCH, 2]);
    check('全部命中', found.size, 10);
    check('别名第一个是 romaji', found.get('id3')[0], 'Romaji of 日本語3');

    // 返回的是别的番 → 跳过
    const mismatch = async (query, variables) => ({ p0: { media: [{ title: { native: '全然違うアニメ', romaji: 'Zenzen Chigau' } }] } });
    return romaji.lookupRomaji([{ id: 'x', titleJp: '転生ゴブリンだけど質問ある？' }], { request: mismatch, delayMs: 0 });
  })
  .then((found) => {
    check('对不上的要跳过', found.size, 0);

    // ---------------------------------------------------------- 存盘复用
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animelocal-romaji-'));
    const entries = [
      { id: 'e1', title: '转生成哥布林有什么问题吗', titleJp: '転生ゴブリンだけど質問ある？' },
      { id: 'e2', title: '没日文名的', titleJp: '' },
    ];
    const c2 = { calls: 0, queryLengths: [] };
    return romaji
      .attachAliases(entries, dir, '202610', { request: fakeRequest(c2), log: () => {} })
      .then((res) => {
        check('第一次查网络', c2.calls, 1);
        checkTrue('写进存盘', fs.existsSync(romaji.aliasesPath(dir, '202610')));
        check('挂上别名', entries[0].aliases.length, 1);
        checkTrue('没日文名的不查也不挂', !entries[1].aliases);
        check('返回命中数', res.matched, 1);

        // 第二次：请求函数直接抛错，证明压根没联网
        const boom = async () => {
          throw new Error('不该发请求');
        };
        const entries2 = [
          { id: 'e1', title: '转生成哥布林有什么问题吗', titleJp: '転生ゴブリンだけど質問ある？' },
        ];
        return romaji.attachAliases(entries2, dir, '202610', { request: boom, log: () => {} }).then((res2) => {
          checkTrue('第二次走存盘', res2.fromStore === true);
          check('存盘读回来的别名', entries2[0].aliases, entries[0].aliases);

          // 存盘坏了 → 重新查
          fs.writeFileSync(romaji.aliasesPath(dir, '202610'), '{ 坏掉的 json', 'utf8');
          const c3 = { calls: 0, queryLengths: [] };
          const entries3 = [{ id: 'e1', title: 'x', titleJp: '転生ゴブリンだけど質問ある？' }];
          return romaji.attachAliases(entries3, dir, '202610', { request: fakeRequest(c3), log: () => {} }).then(() => {
            check('存盘坏掉会重查', c3.calls, 1);
            fs.rmSync(dir, { recursive: true, force: true });
          });
        });
      });
  })
  .catch((err) => {
    failures.push(`抛错: ${err.stack}`);
  })
  .finally(() => {
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
