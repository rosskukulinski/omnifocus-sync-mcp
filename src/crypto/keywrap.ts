import crypto from "node:crypto";

// RFC 3394 AES Key Wrap uses a fixed default IV of eight 0xA6 bytes.
const RFC3394_IV = Buffer.alloc(8, 0xa6);

function wrapAlgo(kek: Buffer): string {
  switch (kek.length) {
    case 16:
      return "aes128-wrap";
    case 24:
      return "aes192-wrap";
    case 32:
      return "aes256-wrap";
    default:
      throw new Error(`Unsupported key-encryption-key length: ${kek.length}`);
  }
}

/** RFC 3394 AES key wrap. `data` length must be a multiple of 8 and >= 16. */
export function aesKeyWrap(kek: Buffer, data: Buffer): Buffer {
  const cipher = crypto.createCipheriv(wrapAlgo(kek), kek, RFC3394_IV);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * RFC 3394 AES key unwrap. Throws if the built-in integrity check fails, which
 * for OmniFileStore means the passphrase-derived wrapping key is wrong.
 */
export function aesKeyUnwrap(kek: Buffer, data: Buffer): Buffer {
  const decipher = crypto.createDecipheriv(wrapAlgo(kek), kek, RFC3394_IV);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
