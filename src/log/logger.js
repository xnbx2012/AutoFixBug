const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { dateOnlyShanghai, formatShanghaiIso } = require('../utils/time');

const LOG_DIR = config.paths.logs;
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'INFO'] || LOG_LEVELS.INFO;

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getLogFilePath() {
  // 日志文件按 Asia/Shanghai 日期切分（凌晨 0~8 点产生的日志仍归入"昨天"）
  return path.join(LOG_DIR, `${dateOnlyShanghai()}.log`);
}

function formatMessage(level, message, meta = {}) {
  const timestamp = formatShanghaiIso();
  const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] [${level}] ${message}${metaStr}`;
}

function writeLog(level, message, meta) {
  if (LOG_LEVELS[level] > CURRENT_LEVEL) return;

  const formatted = formatMessage(level, message, meta);
  const logFile = getLogFilePath();

  fs.appendFileSync(logFile, formatted + '\n', 'utf8');

  // 同时输出到控制台（ERROR 和 WARN 输出到 stderr）
  if (level === 'ERROR' || level === 'WARN') {
    console.error(formatted);
  } else {
    console.log(formatted);
  }
}

module.exports = {
  error: (msg, meta) => writeLog('ERROR', msg, meta),
  warn: (msg, meta) => writeLog('WARN', msg, meta),
  info: (msg, meta) => writeLog('INFO', msg, meta),
  debug: (msg, meta) => writeLog('DEBUG', msg, meta),

  /**
   * 创建任务级 logger：所有调用会同时写入主日志和指定的 job 日志文件
   * @param {string} filePath job 日志文件绝对路径
   * @param {string} [prefix] 日志前缀（如 "[Pipeline Job#1]"）
   * @returns {{error, warn, info, debug}}
   */
  forJob(filePath, prefix = '') {
    const write = (level, msg, meta) => {
      if (LOG_LEVELS[level] > CURRENT_LEVEL) return;
      const formatted = formatMessage(level, prefix ? `${prefix} ${msg}` : msg, meta);
      try {
        fs.appendFileSync(filePath, formatted + '\n', 'utf8');
      } catch (_) { /* 忽略文件写入失败 */ }
      if (level === 'ERROR' || level === 'WARN') {
        console.error(formatted);
      } else {
        console.log(formatted);
      }
    };
    return {
      error: (msg, meta) => write('ERROR', msg, meta),
      warn: (msg, meta) => write('WARN', msg, meta),
      info: (msg, meta) => write('INFO', msg, meta),
      debug: (msg, meta) => write('DEBUG', msg, meta),
    };
  },
};
