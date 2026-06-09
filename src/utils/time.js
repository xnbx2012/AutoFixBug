/**
 * 时区工具 — 统一使用 Asia/Shanghai (+08:00)
 *
 * 设计要点：
 * 1. 数据库中所有时间戳以"无时区"的 ISO 字符串存储（如 "2026-06-08T14:00:00.000"），
 *    但语义是 Asia/Shanghai 的本地时间。读取时必须按 Shanghai 解析，否则会偏差 8 小时。
 * 2. 日志文件名 / 看板"今天"等场景，需要 Shanghai 当天 YYYY-MM-DD。
 * 3. 所有 now*() 函数的输出不带时区后缀，与数据库约定保持一致。
 */

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 返回当前 Asia/Shanghai 时间的 Date 对象（真实时刻，非字符串）
 */
function nowShanghaiDate() {
  return new Date(Date.now() + SHANGHAI_OFFSET_MS);
}

/**
 * 返回 Asia/Shanghai 当前时间，ISO-like 字符串（无时区后缀）
 * 格式: 2026-06-08T14:00:00.000
 * 用于数据库写入、poller cursor 等
 */
function nowShanghai() {
  return new Date(Date.now() + SHANGHAI_OFFSET_MS)
    .toISOString()
    .replace('Z', '');
}

/**
 * 将任意 Date / 字符串 / 毫秒数规范为 Asia/Shanghai ISO-like 字符串
 * - Date: 内部存储是 UTC 毫秒，转 Shanghai 后输出无时区格式
 * - 字符串（"2026-06-08T14:00:00.000" 或 ISO with Z）: 先解析为 UTC ms，再转 Shanghai
 * - number (ms): 同上
 */
function toShanghaiString(input) {
  if (input == null) return null;
  let ms;
  if (input instanceof Date) ms = input.getTime();
  else if (typeof input === 'number') ms = input;
  else {
    // 字符串：先尝试直接 parse
    const d = new Date(input);
    if (isNaN(d.getTime())) return null;
    ms = d.getTime();
  }
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().replace('Z', '');
}

/**
 * 格式化为 Shanghai 时区的可读字符串
 * 格式: "2026-06-08 14:00:00"
 */
function formatShanghai(input) {
  if (input == null) return '-';
  let d;
  if (input instanceof Date) d = input;
  else if (typeof input === 'number') d = new Date(input);
  else d = new Date(input);
  if (isNaN(d.getTime())) return '-';
  const sh = new Date(d.getTime() + SHANGHAI_OFFSET_MS);
  const yyyy = sh.getUTCFullYear();
  const mm = String(sh.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(sh.getUTCDate()).padStart(2, '0');
  const HH = String(sh.getUTCHours()).padStart(2, '0');
  const MM = String(sh.getUTCMinutes()).padStart(2, '0');
  const SS = String(sh.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
}

/**
 * 格式化为 Shanghai 时区日志头（含毫秒）
 * 格式: "2026-06-08T14:00:00.000+08:00"
 */
function formatShanghaiIso(input = Date.now()) {
  let ms;
  if (input instanceof Date) ms = input.getTime();
  else if (typeof input === 'number') ms = input;
  else ms = new Date(input).getTime();
  const sh = new Date(ms + SHANGHAI_OFFSET_MS);
  const yyyy = sh.getUTCFullYear();
  const mm = String(sh.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(sh.getUTCDate()).padStart(2, '0');
  const HH = String(sh.getUTCHours()).padStart(2, '0');
  const MM = String(sh.getUTCMinutes()).padStart(2, '0');
  const SS = String(sh.getUTCSeconds()).padStart(2, '0');
  const mmm = String(sh.getUTCMilliseconds()).padStart(3, '0');
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}.${mmm}+08:00`;
}

/**
 * Shanghai 当天日期 YYYY-MM-DD
 */
function dateOnlyShanghai(input = Date.now()) {
  let ms;
  if (input instanceof Date) ms = input.getTime();
  else if (typeof input === 'number') ms = input;
  else ms = new Date(input).getTime();
  const sh = new Date(ms + SHANGHAI_OFFSET_MS);
  const yyyy = sh.getUTCFullYear();
  const mm = String(sh.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(sh.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

module.exports = {
  SHANGHAI_OFFSET_MS,
  nowShanghai,
  nowShanghaiDate,
  toShanghaiString,
  formatShanghai,
  formatShanghaiIso,
  dateOnlyShanghai,
};
