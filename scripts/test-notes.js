'use strict';

/**
 * notes.js 单测：吐槽记录的增删改查。
 * 跑法：node scripts/test-notes.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const notes = require('../src/main/notes');

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

function throws(name, fn) {
  try {
    fn();
    fail += 1;
    console.log(`  ✗ ${name}：应该抛错但没抛`);
  } catch {
    pass += 1;
    console.log(`  ✓ ${name}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animelocal-notes-'));
const SHOW = '74b362aa1f66';
const basis = { season: '202610', showId: SHOW, showTitle: '转生成哥布林有什么问题吗', episode: 3 };

console.log('notes.noteKey');
check('正常键', notes.noteKey(basis), '202610|74b362aa1f66|3');
check(
  '没集数时退回路径',
  notes.noteKey({ season: '202610', showId: SHOW, episode: null, filePath: 'D:\\Anime\\a.mkv' }),
  `path|${path.resolve('D:\\Anime\\a.mkv')}`,
);
check('什么都没有返回 null', notes.noteKey({}), null);
check('季度号不合法也退回路径', notes.noteKey({ season: '19', showId: SHOW, episode: 1, filePath: 'D:\\a.mkv' }), `path|${path.resolve('D:\\a.mkv')}`);

console.log('notes 空库');
check('空目录读到空库', notes.listNotes(dir).length, 0);
check('读不存在的 key 是 null', notes.getNote(dir, '202610|74b362aa1f66|1'), null);

console.log('notes 保存');
const r1 = notes.saveNote(dir, { ...basis, text: '  这集节奏有点闷  ' });
check('存进去返回 ok', r1.ok, true);
check('文字被 trim', r1.note.text, '这集节奏有点闷');
check('createdAt 有值', r1.note.createdAt > 0, true);
check('落盘能读回', notes.getNote(dir, r1.key).text, '这集节奏有点闷');

const r2 = notes.saveNote(dir, { ...basis, rating: 4 });
check('只改评分文字还在', r2.note.text, '这集节奏有点闷');
check('评分记下', r2.note.rating, 4);
check('createdAt 不变', r2.note.createdAt, r1.note.createdAt);
check('updatedAt 变了', r2.note.updatedAt >= r1.note.updatedAt, true);

check('评分超过 5 被夹到 5', notes.saveNote(dir, { ...basis, rating: 99 }).note.rating, 5);
check('评分负数夹到 0', notes.saveNote(dir, { ...basis, rating: -3 }).note.rating, 0);
check('评分非法变 0', notes.saveNote(dir, { ...basis, rating: 'abc' }).note.rating, 0);

const long = '啊'.repeat(5000);
check('超长文字被截断', notes.saveNote(dir, { ...basis, text: long }).note.text.length, notes.MAX_TEXT);

const r3 = notes.saveNote(dir, { ...basis, playedAt: 1759999999999 });
check('看过时间记下', r3.note.playedAt, 1759999999999);
check('playedAt 只增不减', notes.saveNote(dir, { ...basis, playedAt: 1 }).note.playedAt, 1759999999999);

console.log('notes 多集');
notes.saveNote(dir, { ...basis, episode: 4, text: '第四集好嗑' });
notes.saveNote(dir, { ...basis, episode: 5, text: 'PA 社的演出真顶' });
check('三条记录', notes.listNotes(dir).length, 3);
const counts = notes.noteCounts(dir, '202610');
check('按作品计数', counts.get(SHOW), 3);
check('别的季度为空', notes.noteCounts(dir, '202601').size, 0);

console.log('notes 删除');
check('清空文字 + 评分 + 看过 = 整条删除', notes.saveNote(dir, { ...basis, episode: 4, text: '', rating: 0 }).removed, true);
check('删完剩两条', notes.listNotes(dir, { season: '202610' }).length, 2);
check('deleteNote 返回 true', notes.deleteNote(dir, notes.noteKey({ ...basis, episode: 5 })), true);
check('deleteNote 再删返回 false', notes.deleteNote(dir, notes.noteKey({ ...basis, episode: 5 })), false);

console.log('notes 排序');
const stamp = Date.now();
fs.writeFileSync(
  notes.notesPath(dir),
  JSON.stringify({
    version: 1,
    notes: {
      '202610|74b362aa1f66|1': { season: '202610', showId: SHOW, episode: 1, text: 'A', updatedAt: stamp - 1000 },
      '202610|74b362aa1f66|2': { season: '202610', showId: SHOW, episode: 2, text: 'B', updatedAt: stamp },
    },
  }),
);
check('按最近更新排前面', notes.listNotes(dir)[0].text, 'B');
check('limit 生效', notes.listNotes(dir, { limit: 1 }).length, 1);

console.log('notes 脏数据');
fs.writeFileSync(notes.notesPath(dir), '这不是 json');
check('坏文件当空库', notes.listNotes(dir).length, 0);
fs.writeFileSync(
  notes.notesPath(dir),
  JSON.stringify({
    version: 1,
    notes: {
      'bad key': { text: 'x' },
      '202610|74b362aa1f66|9': { text: 'ok', rating: 3, season: '202610', showId: SHOW },
      '202610|74b362aa1f66|10': { text: '', rating: 0 },
    },
  }),
);
const cleaned = notes.listNotes(dir);
check('坏 key 被丢', cleaned.length, 1);
check('空记录被丢', cleaned[0].text, 'ok');

console.log('notes 参数校验');
throws('没有 key 直接抛', () => notes.saveNote(dir, { text: '没主儿' }));

// 不留临时文件
const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
check('没有残留 .tmp', leftovers.length, 0);

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n通过 ${pass}/${pass + fail}`);
if (fail) {
  console.log('有失败 ❌');
  process.exit(1);
}
console.log('全部通过 ✅');
