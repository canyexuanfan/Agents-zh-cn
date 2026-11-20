'use strict';
/**
 * claude.exe 内嵌 asar 完整性 JSON 的读取与等长回写（MSIX 场景专用）
 *
 * 实测格式（Claude 5.1231.2.0）：exe 内以明文 ASCII 存在 JSON 数组：
 *   [{"file":"resources\\app.asar","alg":"SHA256","value":"<64hex>"},
 *    {"file":"resources\\ion-dist.asar","alg":"SHA256","value":"<64hex>"}]
 * Electron 校验算法（已用真文件对撞验证）：
 *   sha256(asar 文件 [16, 16+jsonLen) 的 JSON 字节) === value
 * 回写策略：value 为等长 64 位小写 hex，可原位字节替换，文件其余部分不动。
 */

const fs = require('fs');
const { readLayout, headerJsonHash } = require('./asar-append.js');

const START_MARKER = '[{"file":"resources\\\\app.asar"'; // JS 源里 \\\\ = 实际字节 \\

// 宽容匹配：条目顺序/空白/分隔符变化也能定位（主条目 = file 指向 app.asar 的那一项）
function findIntegritySpan(exeBuf) {
  const text = exeBuf.toString('latin1');
  const re = /"file"\s*:\s*"resources[\\\/]+app\.asar"/i;
  const m = text.match(re);
  if (!m) return null;
  const at = m.index;
  // 向前找数组起始 '['（条目是扁平对象，其间不含嵌套数组）
  let start = at;
  while (start > 0 && text.charCodeAt(start) !== 0x5b /* [ */) start--;
  if (start <= 0) return null;
  // 向后找数组结束 ']'（value 是 hex、file 是路径，无嵌套 ']'）
  let end = text.indexOf(']', at);
  if (end < 0) return null;
  return { start: start, end: end + 1 }; // 含 ]
}

function parseIntegrityJson(exePath) {
  const buf = fs.readFileSync(exePath);
  const span = findIntegritySpan(buf);
  if (!span) return null;
  const jsonText = buf.toString('latin1', span.start, span.end);
  let entries;
  try {
    entries = JSON.parse(jsonText);
  } catch (_) {
    return null;
  }
  return { buf: buf, span: span, entries: entries };
}

/** 取某 asar 的内嵌期望哈希（file 形如 'resources\\app.asar'） */
function expectedHash(exePath, file) {
  const p = parseIntegrityJson(exePath);
  if (!p) throw new Error('未在 exe 中找到内嵌完整性 JSON');
  const entry = p.entries.find((e) => e.file === file);
  return entry ? entry.value : null;
}

/** 计算目标 asar 当前的头部哈希（应与 exe 内嵌值一致，不一致说明包被改过） */
function computeAsarHeaderHash(asarPath) {
  return headerJsonHash(readLayout(asarPath).jsonBuf);
}

/**
 * 把 exe 内某 asar 的期望哈希等长替换为 newHashHex。
 * @param destPath 输出 exe（不覆盖源）；传 null 则原地写 exePath
 */
function patchHash(exePath, destPath, file, newHashHex) {
  if (!/^[0-9a-f]{64}$/.test(newHashHex)) throw new Error('新哈希格式非法');
  const p = parseIntegrityJson(exePath);
  if (!p) throw new Error('未在 exe 中找到内嵌完整性 JSON');
  const entry = p.entries.find((e) => e.file === file);
  if (!entry) throw new Error('exe 内嵌 JSON 中无条目: ' + file);
  const oldValue = Buffer.from(entry.value, 'latin1');
  const newValue = Buffer.from(newHashHex, 'latin1');
  if (oldValue.length !== newValue.length) throw new Error('哈希长度不一致，拒绝改写');

  // 定位该条目 value 的绝对偏移：在 span 内按 value 文本查找
  const valueOffset = p.buf.indexOf(oldValue, p.span.start, 'latin1');
  if (valueOffset < 0 || valueOffset >= p.span.end) throw new Error('未定位到 value 字节位置');

  const target = destPath || exePath;
  if (destPath) fs.copyFileSync(exePath, destPath);
  const fd = fs.openSync(target, 'r+');
  try {
    fs.writeSync(fd, newValue, 0, newValue.length, valueOffset + (destPath ? 0 : 0));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** 校验 exe 内嵌哈希与 asar 实际头哈希是否一致 */
function verify(exePath, asarAbsPaths /* { 'resources\\app.asar': 'C:/.../app.asar' } */) {
  const result = {};
  for (const file of Object.keys(asarAbsPaths)) {
    const embedded = expectedHash(exePath, file);
    const actual = computeAsarHeaderHash(asarAbsPaths[file]);
    result[file] = { embedded: embedded, actual: actual, match: embedded === actual };
  }
  return result;
}

module.exports = {
  parseIntegrityJson: parseIntegrityJson,
  expectedHash: expectedHash,
  computeAsarHeaderHash: computeAsarHeaderHash,
  patchHash: patchHash,
  verify: verify
};
