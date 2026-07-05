import crypto from "node:crypto";
import plist from "plist";
import { aesKeyUnwrap, aesKeyWrap } from "./keywrap.js";
import { marshalSlots, parseSlots, Slot, SlotType, trimZeroPadding } from "./slots.js";

/** Parsed contents of the `encrypted` metadata plist at the root of a store. */
export interface EncryptionMetadata {
  method: string; // "password"
  algorithm: string; // "PBKDF2; aes128-wrap"
  rounds: number;
  salt: Buffer;
  prf?: "sha1" | "sha256" | "sha512";
  key: Buffer; // RFC 3394-wrapped slot blob
}

const PRF_TO_DIGEST: Record<string, string> = {
  sha1: "sha1",
  sha256: "sha256",
  sha512: "sha512",
};

function coerceBuffer(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  throw new Error("Expected <data> value in encryption metadata");
}

/** Parse the `encrypted` file. Top level is a 1-element array or a bare dict. */
export function parseEncryptionMetadata(xml: string | Buffer): EncryptionMetadata {
  let parsed = plist.parse(xml.toString("utf8")) as unknown;
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) throw new Error("Unexpected encryption metadata array length");
    parsed = parsed[0];
  }
  const m = parsed as Record<string, unknown>;
  return {
    method: String(m.method),
    algorithm: String(m.algorithm),
    rounds: Number(m.rounds),
    salt: coerceBuffer(m.salt),
    prf: m.prf ? (String(m.prf) as EncryptionMetadata["prf"]) : undefined,
    key: coerceBuffer(m.key),
  };
}

export function buildEncryptionMetadata(m: EncryptionMetadata): string {
  const dict: Record<string, unknown> = {
    method: m.method,
    algorithm: m.algorithm,
    rounds: m.rounds,
    salt: m.salt,
    key: m.key,
  };
  if (m.prf) dict.prf = m.prf;
  // OmniFileStore stores a 1-element array of dictionaries.
  return plist.build([dict] as unknown as plist.PlistValue);
}

/**
 * Holds the unwrapped key slots for a database and knows how to look up file
 * keys and apply filename encryption policy.
 */
export class DocumentKey {
  constructor(public readonly slots: Slot[]) {}

  /** Derive the AES key-wrapping key from the passphrase (PBKDF2). */
  static deriveWrappingKey(m: EncryptionMetadata, passphrase: string): Buffer {
    if (m.method !== "password") {
      throw new Error(`Unsupported key method: ${m.method}`);
    }
    if (m.algorithm !== "PBKDF2; aes128-wrap") {
      throw new Error(`Unsupported key algorithm: ${m.algorithm}`);
    }
    const prf = m.prf ?? "sha1";
    const digest = PRF_TO_DIGEST[prf];
    if (!digest) throw new Error(`Unsupported PRF: ${prf}`);
    // KEK length follows the PRF: 16 bytes for sha1, 32 for sha256/sha512.
    const length = prf === "sha1" ? 16 : 32;
    // Normalize (NFC) before UTF-8 encoding, matching OFSDocumentKey.m.
    const pw = Buffer.from(passphrase.normalize("NFC"), "utf8");
    return crypto.pbkdf2Sync(pw, m.salt, m.rounds, length, digest);
  }

  /** Unwrap the document keys from the metadata using a passphrase. */
  static fromMetadata(m: EncryptionMetadata, passphrase: string): DocumentKey {
    const kek = DocumentKey.deriveWrappingKey(m, passphrase);
    let unwrapped: Buffer;
    try {
      unwrapped = aesKeyUnwrap(kek, m.key);
    } catch {
      throw new Error(
        "Could not unwrap the document key — the encryption passphrase is incorrect.",
      );
    }
    return new DocumentKey(parseSlots(unwrapped));
  }

  /** Re-wrap the current slots for storage in the `encrypted` metadata. */
  wrap(kek: Buffer): Buffer {
    return aesKeyWrap(kek, marshalSlots(this.slots));
  }

  slotById(id: number): Slot | undefined {
    return this.slots.find((s) => s.id === id);
  }

  activeCtrHmacSlot(): Slot | undefined {
    return this.slots.find((s) => s.type === SlotType.ActiveAES_CTR_HMAC);
  }

  /** Returns the policy for a filename: 'plaintext' (mask), 'legacy', or null. */
  plaintextPolicy(filename: string): "plaintext" | "legacy" | null {
    const fnbytes = Buffer.from(filename, "utf8");
    let policy: "plaintext" | "legacy" | null = null;
    for (const slot of this.slots) {
      if (slot.type === SlotType.PlaintextMask || slot.type === SlotType.RetiredPlaintextMask) {
        const suffix = trimZeroPadding(slot.contents);
        if (suffix.length > 0 && fnbytes.subarray(fnbytes.length - suffix.length).equals(suffix)) {
          if (slot.type === SlotType.PlaintextMask) policy = "plaintext";
          else if (policy !== "plaintext") policy = "legacy";
        }
      }
    }
    return policy;
  }
}
