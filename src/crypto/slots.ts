// The unwrapped document-key blob is a packed sequence of "slots", each holding
// a key or a filename policy. Layout per slot:
//   [type: uint8][length: uint8 (in 4-byte units)][id: uint16 BE][data: 4*length bytes]
// A type of 0 terminates the list; the remainder is zero padding.
// Ported from OFSKeySlots.m / DecryptionExample.py (parse_secrets / wrapped_secrets).

export enum SlotType {
  None = 0,
  ActiveAESWRAP = 1, // obsolete
  RetiredAESWRAP = 2, // obsolete
  ActiveAES_CTR_HMAC = 3,
  RetiredAES_CTR_HMAC = 4,
  PlaintextMask = 5,
  RetiredPlaintextMask = 6,
}

export interface Slot {
  type: SlotType;
  id: number;
  /** For CTR+HMAC slots: 16-byte AES key || 16-byte HMAC key. */
  contents: Buffer;
}

export function parseSlots(unwrapped: Buffer): Slot[] {
  const slots: Slot[] = [];
  let idx = 0;
  while (idx < unwrapped.length) {
    const type = unwrapped[idx];
    if (type === SlotType.None) break; // trailing padding pseudo-slot
    const length = 4 * unwrapped[idx + 1];
    const id = unwrapped.readUInt16BE(idx + 2);
    const contents = Buffer.from(unwrapped.subarray(idx + 4, idx + 4 + length));
    slots.push({ type, id, contents });
    idx += 4 + length;
  }
  return slots;
}

export function marshalSlots(slots: Slot[]): Buffer {
  const parts: Buffer[] = [];
  for (const slot of slots) {
    if (slot.contents.length % 4 !== 0) {
      throw new Error("Slot contents length must be a multiple of 4");
    }
    const header = Buffer.alloc(4);
    header[0] = slot.type;
    header[1] = slot.contents.length / 4;
    header.writeUInt16BE(slot.id, 2);
    parts.push(header, slot.contents);
  }
  let out = Buffer.concat(parts);
  // Pad to a multiple of 8 for AES key wrap.
  const fragment = out.length % 8;
  if (fragment > 0) {
    out = Buffer.concat([out, Buffer.alloc(8 - fragment)]);
  }
  return out;
}

/** Strip trailing NUL padding, as used by PlaintextMask suffix comparisons. */
export function trimZeroPadding(buf: Buffer): Buffer {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  return buf.subarray(0, end);
}
