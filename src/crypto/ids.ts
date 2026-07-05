import crypto from "node:crypto";

// Almost URL-safe base64, but with upper/lower case swapped. OmniFocus relies on
// this exact byte->char mapping, so it must not change. (OFXMLIdentifier.m)
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
const ID_LENGTH = 11;

/**
 * Generate an 11-character OmniFocus identifier encoding 64 random bits. The
 * first character encodes only 4 bits so it is always a letter (a-p), which the
 * XML NAME production requires. Used for object ids and transaction tail ids.
 */
export function createId(): string {
  let value = crypto.randomBytes(8).readBigUInt64LE(0);
  const chars: string[] = [];
  chars.push(ID_ALPHABET[Number(value & 0xfn)]);
  value >>= 4n;
  for (let i = 1; i < ID_LENGTH; i++) {
    chars.push(ID_ALPHABET[Number(value & 0x3fn)]);
    value >>= 6n;
  }
  return chars.join("");
}

export function isValidId(id: string): boolean {
  if (id.length !== ID_LENGTH) return false;
  for (const ch of id) if (!ID_ALPHABET.includes(ch)) return false;
  // First char must be a letter (a-p region of the alphabet, but any letter is valid XML).
  return /[a-zA-Z]/.test(id[0]);
}
