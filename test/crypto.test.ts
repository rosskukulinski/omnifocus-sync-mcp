import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  DocumentKey,
  EncryptionMetadata,
  aesKeyUnwrap,
  aesKeyWrap,
  buildEncryptionMetadata,
  createId,
  decryptFile,
  encryptFile,
  isValidId,
  marshalSlots,
  parseEncryptionMetadata,
  parseSlots,
  SlotType,
} from "../src/crypto/index.js";

// Build a DocumentKey with a single active CTR+HMAC slot from fixed key material.
function makeDocKey(): DocumentKey {
  const keyMaterial = crypto.randomBytes(32);
  return new DocumentKey([{ type: SlotType.ActiveAES_CTR_HMAC, id: 7, contents: keyMaterial }]);
}

test("RFC 3394 key wrap round-trips", () => {
  const kek = crypto.randomBytes(16);
  const data = crypto.randomBytes(32);
  const wrapped = aesKeyWrap(kek, data);
  assert.equal(wrapped.length, data.length + 8);
  assert.ok(aesKeyUnwrap(kek, wrapped).equals(data));
});

test("key wrap unwrap with wrong KEK throws", () => {
  const data = crypto.randomBytes(32);
  const wrapped = aesKeyWrap(crypto.randomBytes(16), data);
  assert.throws(() => aesKeyUnwrap(crypto.randomBytes(16), wrapped));
});

test("slot blob marshals and parses back", () => {
  const slots = [
    { type: SlotType.ActiveAES_CTR_HMAC, id: 3, contents: crypto.randomBytes(32) },
    { type: SlotType.PlaintextMask, id: 9, contents: Buffer.from(".client\0", "utf8") },
  ];
  const parsed = parseSlots(marshalSlots(slots));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, 3);
  assert.ok(parsed[0].contents.equals(slots[0].contents));
  assert.equal(parsed[1].type, SlotType.PlaintextMask);
});

test("encrypt then decrypt round-trips at size boundaries", () => {
  const dk = makeDocKey();
  const sizes = [0, 1, 15, 16, 100, 65535, 65536, 65537, 131072, 200000];
  for (const n of sizes) {
    const plain = crypto.randomBytes(n);
    const enc = encryptFile(dk, "20260101000000=aaa+bbb.zip", plain);
    const dec = decryptFile(dk, "20260101000000=aaa+bbb.zip", enc);
    assert.ok(dec.equals(plain), `size ${n} round-trip failed`);
  }
});

test("tampering with ciphertext is detected", () => {
  const dk = makeDocKey();
  const enc = encryptFile(dk, "f.zip", Buffer.from("hello world, this is secret"));
  enc[enc.length - 40] ^= 0xff; // flip a byte inside a segment
  assert.throws(() => decryptFile(dk, "f.zip", enc), /MAC mismatch/);
});

test("full metadata + passphrase pipeline", () => {
  const passphrase = "correct horse battery staple é";
  const keyMaterial = crypto.randomBytes(32);
  const dk = new DocumentKey([
    { type: SlotType.ActiveAES_CTR_HMAC, id: 42, contents: keyMaterial },
  ]);

  const salt = crypto.randomBytes(20);
  const rounds = 20000; // low for test speed
  const kek = DocumentKey.deriveWrappingKey(
    { method: "password", algorithm: "PBKDF2; aes128-wrap", rounds, salt, key: Buffer.alloc(0) },
    passphrase,
  );
  const metadata: EncryptionMetadata = {
    method: "password",
    algorithm: "PBKDF2; aes128-wrap",
    rounds,
    salt,
    key: dk.wrap(kek),
  };

  // Serialize to plist and read it back, as we would from the `encrypted` file.
  const xml = buildEncryptionMetadata(metadata);
  const reparsed = parseEncryptionMetadata(xml);
  assert.equal(reparsed.rounds, rounds);
  assert.ok(reparsed.salt.equals(salt));

  const recovered = DocumentKey.fromMetadata(reparsed, passphrase);
  assert.equal(recovered.slots.length, 1);
  assert.ok(recovered.activeCtrHmacSlot()!.contents.equals(keyMaterial));

  // Wrong passphrase must fail cleanly.
  assert.throws(() => DocumentKey.fromMetadata(reparsed, "wrong"), /passphrase is incorrect/);

  // And a file encrypted under dk decrypts under the recovered key.
  const plain = Buffer.from("a real contents.xml would go here");
  const enc = encryptFile(dk, "x.zip", plain);
  assert.ok(decryptFile(recovered, "x.zip", enc).equals(plain));
});

test("plaintext-mask files are stored unencrypted", () => {
  const dk = new DocumentKey([
    { type: SlotType.ActiveAES_CTR_HMAC, id: 1, contents: crypto.randomBytes(32) },
    { type: SlotType.PlaintextMask, id: 2, contents: Buffer.from(".client\0", "utf8") },
  ]);
  const plain = Buffer.from("<plist>client info</plist>");
  const stored = encryptFile(dk, "20260101=abc.client", plain);
  assert.ok(stored.equals(plain), "masked file should not be encrypted");
  assert.ok(decryptFile(dk, "20260101=abc.client", stored).equals(plain));
});

test("id format", () => {
  for (let i = 0; i < 1000; i++) {
    const id = createId();
    assert.equal(id.length, 11);
    assert.ok(isValidId(id), `invalid id: ${id}`);
    assert.ok(/[a-p]/.test(id[0]), `first char not a-p: ${id}`);
  }
  assert.ok(!isValidId("1abcdefghij")); // digit first
  assert.ok(!isValidId("short"));
});
