'use strict';
/**
 * asar 追加式改写（MSIX 场景专用：零解包、零重打包）
 *
 * 核心约束：Electron 对 asar 的完整性校验 = sha256(头部 JSON 字节 [16, 16+jsonLen))。
 * 因此只要保持头部 JSON 字节长度不变（用尾部空格 padding 精确复原，JSON.parse
 * 容忍尾部空白），pickle 尺寸与 dataOffset 均不变，所有旧条目 offset 继续有效；
 * 新内容追加到文件 EOF，仅更新目标条目的 offset/size/integrity 字段
 * （字段全是数字/等长 hex，序列化后长度只会变短，padding 兜底）。
 *
 * 实测基线（Claude 5.1231.2.0 app.asar）：
 *   [0..4]   = 4 (常量)
 *   [4..8]   = pickleSize (289384)
 *   [8..12]  = 4 (常量)
 *   [12..16] = jsonLen (289376)
 *   [16..]   = 头部 JSON；dataOffset = 8 + pickleSize
 */

const fs = require('fs');
const crypto = require('crypto');

const BLOCK_SIZE = 4194304; // 4MB，与 @electron/asar 官方打包器一致

function fileIntegrity(content, blockSize) {
  const bs = blockSize || BLOCK_SIZE;
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const blocks = [];
  for (let i = 0; i < content.length; i += bs) {
    blocks.push(
      crypto.createHash('sha256').update(content.subarray(i, Math.min(i + bs, content.length))).digest('hex')
    );
  }
  return { algorithm: 'SHA256', hash: hash, blockSize: bs, blocks: blocks };
}

function readLayout(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const pickleSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
    return {
      pickleSize: pickleSize,
      jsonLen: jsonLen,
      jsonBuf: jsonBuf,
      json: jsonBuf.toString('utf8'),
      dataOffset: 8 + pickleSize,
      fileSize: fs.fstatSync(fd).size
    };
  } finally {
    fs.closeSync(fd);
  }
}

function headerJsonHash(jsonBuf) {
  return crypto.createHash('sha256').update(jsonBuf).digest('hex');
}

function walkEntry(header, pathParts) {
  let node = header;
  for (const p of pathParts) {
    if (!node.files || !node.files[p]) return null;
    node = node.files[p];
  }
  return node;
}

/** 读取 asar 内某文件的原始内容 */
function extractFile(asarPath, pathParts) {
  const layout = readLayout(asarPath);
  const header = JSON.parse(layout.json);
  const node = walkEntry(header, pathParts);
  if (!node || node.files) throw new Error('asar 条目不存在或为目录: ' + pathParts.join('/'));
  const off = layout.dataOffset + parseInt(node.offset, 10);
  const fd = fs.openSync(asarPath, 'r');
  try {
    const content = Buffer.alloc(node.size);
    fs.readSync(fd, content, 0, node.size, off);
    return content;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 追加式替换某文件条目内容。
 * @returns {{newHeaderHash: string, newOffset: number, newFileSize: number}}
 *          newHeaderHash 供 claude.exe 内嵌哈希同步使用
 */
function rewriteEntryAppend(asarPath, destPath, pathParts, newContent) {
  const layout = readLayout(asarPath);
  const header = JSON.parse(layout.json);
  const node = walkEntry(header, pathParts);
  if (!node || node.files) throw new Error('asar 条目不存在或为目录: ' + pathParts.join('/'));

  const srcSize = layout.fileSize;
  const newOffset = srcSize - layout.dataOffset; // 追加在原 EOF
  node.offset = String(newOffset);
  node.size = newContent.length;
  // 沿用原条目的 blockSize（若存在）——不自造分块尺寸，包格式变化时自适应
  node.integrity = fileIntegrity(newContent, node.integrity && node.integrity.blockSize);

  const newJson = JSON.stringify(header);
  if (newJson.length > layout.jsonLen) {
    throw new Error(
      '新头部 JSON 超长（' + newJson.length + ' > 原 ' + layout.jsonLen + '），无法安全 padding'
    );
  }
  const jsonBuf2 = Buffer.from(newJson + ' '.repeat(layout.jsonLen - newJson.length), 'utf8');
  if (jsonBuf2.length !== layout.jsonLen) {
    throw new Error('JSON utf8 字节数与字符数不一致（混入非 ASCII），拒绝改写');
  }
  const newHeaderHash = headerJsonHash(jsonBuf2);

  // destPath 为 null/undefined = 原地改写（真机模式：先 copy 到自身再 r+ 两次定点写）
  const target = destPath || asarPath;
  if (destPath) {
    fs.copyFileSync(asarPath, destPath);
  }
  const fd = fs.openSync(target, 'r+');
  try {
    fs.writeSync(fd, jsonBuf2, 0, jsonBuf2.length, 16);
    fs.writeSync(fd, newContent, 0, newContent.length, srcSize);
  } finally {
    fs.closeSync(fd);
  }
  return { newHeaderHash: newHeaderHash, newOffset: newOffset, newFileSize: srcSize + newContent.length };
}

module.exports = {
  readLayout: readLayout,
  headerJsonHash: headerJsonHash,
  fileIntegrity: fileIntegrity,
  walkEntry: walkEntry,
  extractFile: extractFile,
  rewriteEntryAppend: rewriteEntryAppend
};
