import crypto from "node:crypto";
import { DocumentKey } from "./documentKey.js";
import { Slot, SlotType } from "./slots.js";
import { aesKeyUnwrap } from "./keywrap.js";

// Container constants (OFSSegmentedEncryptionWorker.m / DecryptionExample.py).
const FILE_MAGIC = Buffer.from("OmniFileEncryption\x00\x00", "latin1"); // 20 bytes
const LEGACY_MAGIC = Buffer.from("OmniFileStore encryption\x00STRAWMAN-6", "latin1");
const SEG_IV_LEN = 12;
const SEG_MAC_LEN = 20; // truncated HMAC-SHA256
const SEG_PAGE_SIZE = 65536;
const FILE_MAC_PREFIX = Buffer.from([0x01]);
const FILE_MAC_LEN = 32;

interface SegmentRange {
  index: number;
  /** Offset of the segment's IV within the file. */
  start: number;
  /** Number of ciphertext bytes in this segment. */
  dataLen: number;
}

/** Resolve the 32-byte AES||HMAC key material for a file, given its header info. */
function fileKeyMaterial(docKey: DocumentKey, info: Buffer): Buffer {
  const keyid = info.readUInt16BE(0);
  const slot: Slot | undefined = docKey.slotById(keyid);
  if (!slot) throw new Error(`No key slot with id ${keyid}`);
  if (slot.type === SlotType.ActiveAES_CTR_HMAC || slot.type === SlotType.RetiredAES_CTR_HMAC) {
    if (info.length !== 2) throw new Error("Unexpected per-file key info for CTR+HMAC slot");
    return slot.contents;
  }
  if (slot.type === SlotType.ActiveAESWRAP || slot.type === SlotType.RetiredAESWRAP) {
    const wrapped = info.subarray(2);
    if (wrapped.length % 8 !== 0) throw new Error("Malformed AESWRAP file key");
    return aesKeyUnwrap(slot.contents, wrapped);
  }
  throw new Error(`Unusable key slot type for decryption: ${slot.type}`);
}

function segmentRanges(seg0Start: number, segNEnd: number): SegmentRange[] {
  const hdr = SEG_IV_LEN + SEG_MAC_LEN; // 32
  const full = hdr + SEG_PAGE_SIZE;
  const regionLen = segNEnd - seg0Start;
  if (regionLen < 0) throw new Error("Encrypted file is shorter than its header + MAC");
  if (regionLen === 0) return [];
  // Every full segment occupies `full` bytes; a final partial segment occupies
  // fewer. So the segment count is exactly ceil(regionLen / full).
  const count = Math.ceil(regionLen / full);
  const ranges: SegmentRange[] = [];
  let pos = seg0Start;
  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1;
    const dataLen = isLast ? segNEnd - pos - hdr : SEG_PAGE_SIZE;
    if (dataLen < 0) throw new Error("Truncated encrypted segment");
    ranges.push({ index: i, start: pos, dataLen });
    pos += hdr + dataLen;
  }
  return ranges;
}

function isEncrypted(data: Buffer): boolean {
  return (
    data.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC) ||
    data.subarray(0, LEGACY_MAGIC.length).equals(LEGACY_MAGIC)
  );
}

/**
 * Decrypt a single file from a sync store. Verifies every segment MAC and the
 * file MAC before returning plaintext. Honors PlaintextMask policy for files
 * that are stored unencrypted (e.g. `.client`).
 */
export function decryptFile(docKey: DocumentKey, filename: string, data: Buffer): Buffer {
  const policy = docKey.plaintextPolicy(filename);
  if (!isEncrypted(data)) {
    // Not encrypted. Allowed only if a plaintext policy covers this filename.
    if (policy && !data.subarray(0, 32).includes(Buffer.from("crypt"))) {
      return Buffer.from(data);
    }
    throw new Error(`File ${filename} is not encrypted (or has bad magic)`);
  }

  const magicLen = data.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)
    ? FILE_MAGIC.length
    : LEGACY_MAGIC.length;

  let off = magicLen;
  const infoLength = data.readUInt16BE(off);
  off += 2;
  const info = data.subarray(off, off + infoLength);
  off += infoLength;

  // Header is zero-padded to a 16-byte boundary; padding must be all zero.
  const padLen = (16 - (off % 16)) % 16;
  const padding = data.subarray(off, off + padLen);
  if (!padding.every((b) => b === 0)) throw new Error("Non-zero header padding");
  off += padLen;

  const keyMaterial = fileKeyMaterial(docKey, info);
  const aeskey = keyMaterial.subarray(0, 16);
  const hmackey = keyMaterial.subarray(16, 32);

  const seg0Start = off;
  const segNEnd = data.length - FILE_MAC_LEN;
  const fileMAC = data.subarray(segNEnd);
  const ranges = segmentRanges(seg0Start, segNEnd);

  // Verify integrity (encrypt-then-MAC) before releasing any plaintext.
  const fileHash = crypto.createHmac("sha256", hmackey);
  fileHash.update(FILE_MAC_PREFIX);
  for (const r of ranges) {
    const iv = data.subarray(r.start, r.start + SEG_IV_LEN);
    const storedMac = data.subarray(r.start + SEG_IV_LEN, r.start + SEG_IV_LEN + SEG_MAC_LEN);
    const ct = data.subarray(
      r.start + SEG_IV_LEN + SEG_MAC_LEN,
      r.start + SEG_IV_LEN + SEG_MAC_LEN + r.dataLen,
    );
    const segIndexBE = Buffer.alloc(4);
    segIndexBE.writeUInt32BE(r.index, 0);
    const segHash = crypto.createHmac("sha256", hmackey);
    segHash.update(iv);
    segHash.update(segIndexBE);
    segHash.update(ct);
    const computed = segHash.digest().subarray(0, SEG_MAC_LEN);
    if (!crypto.timingSafeEqual(computed, storedMac)) {
      throw new Error(`Segment ${r.index} MAC mismatch (corrupt or wrong key)`);
    }
    fileHash.update(storedMac);
  }
  const computedFileMac = fileHash.digest();
  if (!crypto.timingSafeEqual(computedFileMac, fileMAC)) {
    throw new Error("File MAC mismatch (corrupt or wrong key)");
  }

  // Decrypt.
  const out: Buffer[] = [];
  for (const r of ranges) {
    const iv = data.subarray(r.start, r.start + SEG_IV_LEN);
    const ct = data.subarray(
      r.start + SEG_IV_LEN + SEG_MAC_LEN,
      r.start + SEG_IV_LEN + SEG_MAC_LEN + r.dataLen,
    );
    const counter = Buffer.concat([iv, Buffer.alloc(4)]); // IV || 0x00000000
    const decipher = crypto.createDecipheriv("aes-128-ctr", aeskey, counter);
    out.push(decipher.update(ct));
    out.push(decipher.final());
  }
  return Buffer.concat(out);
}

/**
 * Encrypt a single file for a sync store using the active CTR+HMAC key.
 * Honors PlaintextMask policy (returns plaintext unchanged for masked names).
 */
export function encryptFile(docKey: DocumentKey, filename: string, plaintext: Buffer): Buffer {
  if (docKey.plaintextPolicy(filename) === "plaintext") {
    return Buffer.from(plaintext);
  }

  const slot = docKey.activeCtrHmacSlot();
  if (!slot) throw new Error("No active AES_CTR_HMAC key slot for encryption");
  const aeskey = slot.contents.subarray(0, 16);
  const hmackey = slot.contents.subarray(16, 32);

  // Header: magic + uint16(keyinfo len = 2) + uint16(slot id), zero-padded to 16.
  const header = Buffer.alloc(FILE_MAGIC.length + 4);
  FILE_MAGIC.copy(header, 0);
  header.writeUInt16BE(2, FILE_MAGIC.length);
  header.writeUInt16BE(slot.id, FILE_MAGIC.length + 2);
  const padLen = (16 - (header.length % 16)) % 16;

  const chunks: Buffer[] = [header, Buffer.alloc(padLen)];
  const fileHash = crypto.createHmac("sha256", hmackey);
  fileHash.update(FILE_MAC_PREFIX);

  let index = 0;
  let offset = 0;
  // Always emit at least one segment (matches the reference implementation).
  while (offset < plaintext.length || index === 0) {
    const segPlain = plaintext.subarray(offset, offset + SEG_PAGE_SIZE);
    const iv = crypto.randomBytes(SEG_IV_LEN);
    const counter = Buffer.concat([iv, Buffer.alloc(4)]);
    const cipher = crypto.createCipheriv("aes-128-ctr", aeskey, counter);
    const ct = Buffer.concat([cipher.update(segPlain), cipher.final()]);

    const segIndexBE = Buffer.alloc(4);
    segIndexBE.writeUInt32BE(index, 0);
    const segHash = crypto.createHmac("sha256", hmackey);
    segHash.update(iv);
    segHash.update(segIndexBE);
    segHash.update(ct);
    const segMac = segHash.digest().subarray(0, SEG_MAC_LEN);

    chunks.push(iv, segMac, ct);
    fileHash.update(segMac);

    offset += SEG_PAGE_SIZE;
    index += 1;
  }

  chunks.push(fileHash.digest().subarray(0, FILE_MAC_LEN));
  return Buffer.concat(chunks);
}

export const _internal = { segmentRanges, isEncrypted, FILE_MAGIC };
