const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const MAGIC = Buffer.from('UFT1');
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + SALT_LENGTH + IV_LENGTH;
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 32, SCRYPT_PARAMS, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function meter(total, onProgress) {
  let done = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      done += chunk.length;
      if (onProgress && total) onProgress(done / total);
      callback(null, chunk);
    },
  });
}

async function encryptFile(inputPath, outputPath, password, { onProgress, signal } = {}) {
  if (!password) throw new Error('A password is required');
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = await deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const { size } = await fsp.stat(inputPath);
  const partial = `${outputPath}.part`;
  try {
    await pipeline(
      fs.createReadStream(inputPath),
      meter(size, onProgress),
      cipher,
      async function* frame(source) {
        yield Buffer.concat([MAGIC, salt, iv]);
        for await (const chunk of source) yield chunk;
        yield cipher.getAuthTag();
      },
      fs.createWriteStream(partial),
      { signal },
    );
    await fsp.rename(partial, outputPath);
  } catch (error) {
    await fsp.rm(partial, { force: true });
    throw error;
  }
  return { success: true, result: outputPath };
}

async function isEncryptedFile(inputPath) {
  const handle = await fsp.open(inputPath, 'r');
  try {
    const magic = Buffer.alloc(MAGIC.length);
    await handle.read(magic, 0, MAGIC.length, 0);
    return magic.equals(MAGIC);
  } finally {
    await handle.close();
  }
}

async function decryptFile(inputPath, outputPath, password, { onProgress, signal } = {}) {
  if (!password) throw new Error('A password is required');
  const handle = await fsp.open(inputPath, 'r');
  let header;
  let tag;
  let size;
  try {
    ({ size } = await handle.stat());
    if (size < HEADER_LENGTH + TAG_LENGTH) throw new Error('This file is too small to be an encrypted file');
    header = Buffer.alloc(HEADER_LENGTH);
    tag = Buffer.alloc(TAG_LENGTH);
    await handle.read(header, 0, HEADER_LENGTH, 0);
    await handle.read(tag, 0, TAG_LENGTH, size - TAG_LENGTH);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This file was not encrypted with Ultimate File Tool');
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LENGTH);
  const iv = header.subarray(MAGIC.length + SALT_LENGTH);
  const key = await deriveKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const bodyLength = size - HEADER_LENGTH - TAG_LENGTH;
  const source = bodyLength > 0 ? fs.createReadStream(inputPath, { start: HEADER_LENGTH, end: size - TAG_LENGTH - 1 }) : Readable.from([]);
  const partial = `${outputPath}.part`;
  try {
    await pipeline(source, meter(bodyLength, onProgress), decipher, fs.createWriteStream(partial), { signal });
    await fsp.rename(partial, outputPath);
  } catch (error) {
    await fsp.rm(partial, { force: true });
    if (/unable to authenticate|unsupported state/i.test(error.message)) throw new Error('Wrong password or corrupted file');
    throw error;
  }
  return { success: true, result: outputPath };
}

module.exports = { encryptFile, decryptFile, isEncryptedFile };
