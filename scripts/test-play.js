'use strict';

/**
 * player.js 单测：只测「能不能播」的判定，不真的去开播放器。
 * 跑法：node scripts/test-play.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const player = require('../src/main/player');

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
  }
}

function checkOk(name, verdict, expectedOk) {
  if (verdict.ok === expectedOk) {
    pass += 1;
    console.log(`  ✓ ${name}${verdict.ok ? '' : ` → ${verdict.error}`}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}：期望 ok=${expectedOk}，实际 ${JSON.stringify(verdict)}`);
  }
}

// ---------------------------------------------------------------- 造现场

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animelocal-play-'));
const sub = path.join(root, '某部动画');
fs.mkdirSync(sub, { recursive: true });

const goodFile = path.join(sub, 'Show - 03.mkv');
fs.writeFileSync(goodFile, Buffer.alloc(2048));

const emptyFile = path.join(sub, 'empty.mp4');
fs.writeFileSync(emptyFile, '');

const exeFile = path.join(sub, 'evil.exe');
fs.writeFileSync(exeFile, Buffer.alloc(2048));

const outside = path.join(os.tmpdir(), `animelocal-outside-${process.pid}.mkv`);
fs.writeFileSync(outside, Buffer.alloc(2048));

const missing = path.join(sub, 'gone.mkv');

const scan = {
  root,
  matched: [
    {
      path: goodFile,
      name: path.basename(goodFile),
      size: 2048,
      showId: 'abc123abc123',
      showTitle: '某部动画',
      episode: 3,
      matchedBy: '文件名',
    },
    {
      path: inner(),
      name: 'inner.mkv',
      size: 2048,
      showId: 'abc123abc123',
      showTitle: '某部动画',
      episode: 4,
      matchedBy: '文件名',
    },
  ],
  unmatched: [],
  extras: [{ path: exeFile, name: 'evil.exe' }],
};

function inner() {
  return path.join(sub, 'inner.mkv');
}
fs.writeFileSync(inner(), Buffer.alloc(2048));

console.log('player.checkPlayable');
checkOk('正常文件可播', player.checkPlayable(scan, goodFile), true);
check('返回真实大小', player.checkPlayable(scan, goodFile).size, 2048);
check('带上集数', player.checkPlayable(scan, goodFile).episode, 3);

checkOk('没扫描时拒绝', player.checkPlayable(null, goodFile), false);
checkOk('空路径拒绝', player.checkPlayable(scan, ''), false);
checkOk('非字符串拒绝', player.checkPlayable(scan, 123), false);
checkOk('含 NUL 拒绝', player.checkPlayable(scan, `${goodFile}\u0000x`), false);
checkOk('root 外的文件拒绝', player.checkPlayable(scan, outside), false);
checkOk('`..` 逃逸拒绝', player.checkPlayable(scan, path.join(root, '..', path.basename(outside))), false);
checkOk('不在扫描结果里拒绝', player.checkPlayable(scan, path.join(sub, 'another.mkv')), false);
checkOk('非视频扩展名拒绝', player.checkPlayable(scan, exeFile), false);
checkOk('文件消失拒绝', player.checkPlayable(scan, missing), false);

// 空文件：先塞进扫描结果，再测体积判断
const scanWithEmpty = { ...scan, matched: [...scan.matched, { path: emptyFile, name: 'empty.mp4', size: 0, episode: 9 }] };
checkOk('空文件拒绝', player.checkPlayable(scanWithEmpty, emptyFile), false);

// 扫描之后被删掉的文件：在结果里、但磁盘上没了
const ghostPath = path.join(sub, 'ghost.mkv');
fs.writeFileSync(ghostPath, Buffer.alloc(1024));
const scanWithGhost = { ...scan, matched: [...scan.matched, { path: ghostPath, name: 'ghost.mkv', size: 1024, episode: 10 }] };
fs.rmSync(ghostPath, { force: true });
const ghostVerdict = player.checkPlayable(scanWithGhost, ghostPath);
check('文件被删时给的是「不见了」', ghostVerdict.ok === false && /不在了/.test(ghostVerdict.error), true);

// isInside
console.log('player.isInside');
check('子路径算里面', player.isInside(root, goodFile), true);
check('root 自己不算里面', player.isInside(root, root), false);
check('兄弟目录不算里面', player.isInside(root, outside), false);
check('前缀相同的兄弟目录不算里面', player.isInside(root, `${root}-evil\\x.mkv`), false);

// allFiles 摊平
console.log('player.allFiles');
check('摊平三类', player.allFiles(scan).length, 3);
check('null 安全', player.allFiles(null).length, 0);

// ---------------------------------------------------------------- 收尾
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(outside, { force: true });

console.log(`\n通过 ${pass}/${pass + fail}`);
if (fail) {
  console.log('有失败 ❌');
  process.exit(1);
}
console.log('全部通过 ✅');
