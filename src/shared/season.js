/**
 * 季度相关的纯计算（主进程、渲染进程、Node 测试都用这一份）
 * ---------------------------------------------------------------------------
 * yuc.wiki 的季度号形如 202610：1/4/7/10 月各一档。
 * 「季度更新日」定在每个季度第一个月的 15 号 00:00（本地时区）——
 * 到了这天或之后，就要重新抓一次本季片单，因为开播前后名单会补。
 *
 * 写成 UMD 小模块：浏览器里挂到 window.SeasonUtil，Node 里走 module.exports，
 * 这样渲染进程和 mocha 风格的脚本测试能共用同一套逻辑。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SeasonUtil = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SEASON_MONTHS = [1, 4, 7, 10];
  const SEASON_KEY_RE = /^(\d{4})(01|04|07|10)$/;

  /** 季度号的「更新基准日」：首月 15 日 00:00；季度号不合法返回 null */
  function seasonUpdateAt(seasonKey) {
    const m = SEASON_KEY_RE.exec(String(seasonKey || ''));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, 15, 0, 0, 0, 0);
  }

  /** 季度号对应的首月 1 号 00:00，用来判断跨季 */
  function seasonStartAt(seasonKey) {
    const m = SEASON_KEY_RE.exec(String(seasonKey || ''));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, 1, 0, 0, 0, 0);
  }

  /**
   * 该不该为了「季度更新日」强制重抓一次片单。
   * - 还没到 15 号：false（照旧走 24 小时缓存）
   * - 过了 15 号，但缓存是 15 号之后抓的：false
   * - 过了 15 号，缓存更旧（或压根没有）：true
   */
  function needsQuarterRefresh({ seasonKey, fetchedAt, now = new Date() } = {}) {
    const due = seasonUpdateAt(seasonKey);
    if (!due) return false;
    if (now.getTime() < due.getTime()) return false;
    if (!fetchedAt) return true;
    const t = new Date(fetchedAt).getTime();
    if (Number.isNaN(t)) return true;
    return t < due.getTime();
  }

  /** 把基准日说成人话：「10 月 15 日」 */
  function updateLabel(seasonKey) {
    const due = seasonUpdateAt(seasonKey);
    if (!due) return '';
    return `${due.getMonth() + 1} 月 ${due.getDate()} 日`;
  }

  return { SEASON_MONTHS, seasonUpdateAt, seasonStartAt, needsQuarterRefresh, updateLabel };
});
