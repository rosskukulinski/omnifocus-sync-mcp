export { aesKeyWrap, aesKeyUnwrap } from "./keywrap.js";
export {
  SlotType,
  parseSlots,
  marshalSlots,
  trimZeroPadding,
  type Slot,
} from "./slots.js";
export {
  DocumentKey,
  parseEncryptionMetadata,
  buildEncryptionMetadata,
  type EncryptionMetadata,
} from "./documentKey.js";
export { decryptFile, encryptFile } from "./segmentedFile.js";
export { createId, isValidId } from "./ids.js";
