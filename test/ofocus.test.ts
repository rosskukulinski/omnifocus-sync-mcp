import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { DocumentKey, SlotType, decryptFile, encryptFile } from "../src/crypto/index.js";
import { Database } from "../src/ofocus/database.js";
import { buildAddTask, buildUpdateTask, buildDeleteTask } from "../src/ofocus/writer.js";
import { OmniFocusStore } from "../src/ofocus/store.js";
import { parseDigestChallenge, buildDigestAuth } from "../src/webdav/digest.js";

function docKey(): DocumentKey {
  return new DocumentKey([
    { type: SlotType.ActiveAES_CTR_HMAC, id: 5, contents: crypto.randomBytes(32) },
  ]);
}

test("builder -> parser round-trip for a new inbox task", () => {
  const { xml, id } = buildAddTask({ name: "Buy milk", flagged: true, note: "2%" });
  const db = new Database();
  db.applyTransaction(xml);
  const t = db.tasks.get(id);
  assert.ok(t, "task should exist");
  assert.equal(t!.name, "Buy milk");
  assert.equal(t!.flagged, true);
  assert.equal(t!.note, "2%");
  assert.equal(t!.inInbox, true);
  assert.equal(t!.isProject, false);
  assert.equal(db.view(t!).status, "active");
});

test("task assigned to a project has a parent and no inbox flag", () => {
  const { xml, id } = buildAddTask({ name: "Draft agenda", parentId: "projABCDEF01" });
  const db = new Database();
  db.applyTransaction(xml);
  const t = db.tasks.get(id)!;
  assert.equal(t.parentId, "projABCDEF01");
  assert.equal(t.inInbox, false);
});

test("op=update partial merge completes a task without clobbering other fields", () => {
  const { xml: addXml, id } = buildAddTask({ name: "Write report", flagged: true });
  const db = new Database();
  db.applyTransaction(addXml);
  const when = new Date("2026-07-05T20:00:00.000Z");
  db.applyTransaction(buildUpdateTask(id, { completed: when, added: db.tasks.get(id)!.added }));
  const t = db.tasks.get(id)!;
  assert.equal(db.view(t).status, "completed");
  assert.ok(t.completed);
  assert.equal(t.name, "Write report", "name preserved through partial update");
  assert.equal(t.flagged, true, "flag preserved through partial update");
});

test("clearing a date via empty element", () => {
  const { xml, id } = buildAddTask({ name: "Task", due: new Date("2026-07-08T17:00:00") });
  const db = new Database();
  db.applyTransaction(xml);
  assert.ok(db.tasks.get(id)!.due);
  db.applyTransaction(buildUpdateTask(id, { due: null }));
  assert.equal(db.tasks.get(id)!.due, null);
});

test("op=delete removes the task", () => {
  const { xml, id } = buildAddTask({ name: "Ephemeral" });
  const db = new Database();
  db.applyTransaction(xml);
  assert.ok(db.tasks.has(id));
  db.applyTransaction(buildDeleteTask(id));
  assert.ok(!db.tasks.has(id));
});

test("full encrypted store read pipeline: zip -> encrypt -> decrypt -> unzip -> parse", () => {
  const dk = docKey();
  const { xml, id } = buildAddTask({ name: "End to end", note: "through the whole stack" });
  const zipped = zipSync({ "contents.xml": strToU8(xml) });
  const filename = "20260705120000=aaaaaaaaaaa+bbbbbbbbbbb.zip";

  const encrypted = encryptFile(dk, filename, Buffer.from(zipped));
  // Simulate the store read path.
  const decrypted = decryptFile(dk, filename, encrypted);
  const files = unzipSync(new Uint8Array(decrypted));
  const contents = strFromU8(files["contents.xml"]);

  const db = new Database();
  db.applyTransaction(contents);
  assert.equal(db.tasks.get(id)!.name, "End to end");
});

test("tags: task-to-tag join and primary context both surface", () => {
  const db = new Database();
  db.applyTransaction(
    `<?xml version="1.0" encoding="UTF-8"?>
     <omnifocus xmlns="http://www.omnigroup.com/namespace/OmniFocus/v2">
       <context id="tag1111aaaa"><name>errand</name></context>
       <context id="tag2222bbbb"><name>home</name></context>
       <task id="taskAAAAAAA"><name>Do thing</name><context idref="tag1111aaaa"/></task>
       <task-to-tag id="taskAAAAAAA.tag2222bbbb">
         <task idref="taskAAAAAAA"/><context idref="tag2222bbbb"/>
       </task-to-tag>
     </omnifocus>`,
  );
  const view = db.view(db.tasks.get("taskAAAAAAA")!);
  assert.deepEqual([...view.tagNames].sort(), ["errand", "home"]);
});

test("computeHeadTail follows the chain to the unreferenced tail", () => {
  const store = new OmniFocusStore(null as never, "http://x/OmniFocus.ofocus/");
  const txns = [
    { name: "00000000000000=aaa+bbb.zip", timestamp: "00000000000000", parents: ["aaa"], tail: "bbb", isBaseline: true },
    { name: "20260101000000=bbb+ccc.zip", timestamp: "20260101000000", parents: ["bbb"], tail: "ccc", isBaseline: false },
    { name: "20260102000000=ccc+ddd.zip", timestamp: "20260102000000", parents: ["ccc"], tail: "ddd", isBaseline: false },
  ];
  assert.equal(store.computeHeadTail(txns), "ddd");
});

test("digest auth header is well formed", () => {
  const challenge = parseDigestChallenge('Digest realm="Omni Sync", nonce="deadbeef", algorithm=MD5, qop="auth"');
  assert.ok(challenge);
  const header = buildDigestAuth({
    challenge: challenge!,
    method: "PROPFIND",
    uri: "/ross/OmniFocus.ofocus/",
    username: "ross",
    password: "hunter2",
    nc: 1,
  });
  assert.match(header, /^Digest /);
  assert.match(header, /qop=auth/);
  assert.match(header, /nc=00000001/);
  assert.match(header, /response="[a-f0-9]{32}"/);
});
