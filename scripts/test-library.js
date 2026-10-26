'use strict';

/**
 * library.js 的离线测试：只碰临时目录，不动真实 userData。
 * 跑法：npm run test:library（或 node scripts/test-library.js）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const library = require('../src/main/library');

let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`);
  }
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'animelocal-lib-'));
}

const SEASON = '202610';
const A = '74b362aa1f66';
const B = '0123456789ab';

console.log('library.js 测试');

// 1. 目录是空的 —— 读库不炸，返回空
{
  const dir = freshDir();
  const lib = library.readLibrary(dir);
  check('空目录读出来是空库', lib.version === 1 && Object.keys(lib.seasons).length === 0);
  check('空目录时 ownedIds 是空数组', library.ownedIds(dir, SEASON).length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2. 勾上 → 落盘
{
  const dir = freshDir();
  const r1 = library.setOwned(dir, SEASON, A, true);
  check('勾上返回 count=1', r1.ownedCount === 1, JSON.stringify(r1));
  check('library.json 真的写出来了', fs.existsSync(library.libraryPath(dir)));
  check('ownedIds 读得到刚勾的 id', library.ownedIds(dir, SEASON).includes(A));

  const raw = JSON.parse(fs.readFileSync(library.libraryPath(dir), 'utf8'));
  check('文件里存的是 owned:true', raw.seasons[SEASON][A].owned === true);
  check('文件里带 updatedAt', typeof raw.seasons[SEASON][A].updatedAt === 'number');

  // 3. 再加一个
  const r2 = library.setOwned(dir, SEASON, B, true);
  check('再勾一部 count=2', r2.ownedCount === 2, JSON.stringify(r2));

  // 4. 取消一个 —— 记录应当被删掉，而不是留 owned:false
  const r3 = library.setOwned(dir, SEASON, A, false);
  check('取消后 count=1', r3.ownedCount === 1, JSON.stringify(r3));
  const raw2 = JSON.parse(fs.readFileSync(library.libraryPath(dir), 'utf8'));
  check('取消后记录被删除', raw2.seasons[SEASON][A] === undefined);
  check('另一个季度互不影响', library.ownedIds(dir, '202607').length === 0);

  fs.rmSync(dir, { recursive: true, force: true });
}

// 5. 脏数据：坏季度号、坏 id、坏记录统统丢掉，能用的留着
{
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    library.libraryPath(dir),
    JSON.stringify({
      version: 99,
      seasons: {
        [SEASON]: {
          [A]: { owned: true, updatedAt: 1 },
          ZZZZZZ: { owned: true }, // id 不合法
          [B]: { owned: 'yes' }, // owned 不是布尔 → 转成 true
          BADREC: null,
        },
        '2026-10': { x: { owned: true } }, // 季度号不合法
        '202601': 'not-an-object',
      },
    }),
    'utf8'
  );
  const lib = library.readLibrary(dir);
  check('坏季度号被丢掉', lib.seasons['2026-10'] === undefined);
  check('非对象桶被丢掉', lib.seasons['202601'] === undefined);
  const bucket = lib.seasons[SEASON] || {};
  check('非法 id 被丢掉', bucket.ZZZZZZ === undefined);
  check('坏的 null 记录被丢掉', bucket.BADREC === undefined);
  check('好记录保留', bucket[A] && bucket[A].owned === true);
  check('字符串 owned 被转成布尔 true', bucket[B] && bucket[B].owned === true);
  check('版本号被正常化成 1', lib.version === 1);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 6. 文件内容是垃圾 —— 当空库处理，不抛
{
  const dir = freshDir();
  fs.writeFileSync(library.libraryPath(dir), '{ 这不是 json', 'utf8');
  let threw = false;
  let lib;
  try {
    lib = library.readLibrary(dir);
  } catch {
    threw = true;
  }
  check('损坏的 json 不会抛错', !threw);
  check('损坏的 json 返回空库', lib && Object.keys(lib.seasons).length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 7. 非法参数要拦住
{
  const dir = freshDir();
  const boom = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  check('季度号乱写会抛错', boom(() => library.setOwned(dir, 'abc', A, true)));
  check('id 乱写会抛错', boom(() => library.setOwned(dir, SEASON, '../../etc', true)));
  check('拦截之后没有留下文件', !fs.existsSync(library.libraryPath(dir)));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 8. 原子写：写完不能留下 .tmp 残留
{
  const dir = freshDir();
  library.setOwned(dir, SEASON, A, true);
  library.setOwned(dir, SEASON, B, true);
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  check('没有 .tmp 残留', leftovers.length === 0, leftovers.join(','));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
