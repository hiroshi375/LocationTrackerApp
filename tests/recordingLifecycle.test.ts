import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRecordingLifecycleStore,
  LIFECYCLE_SCHEMA,
  initializeRecordingLifecycleDatabase,
  mayReplayStoppedPoint,
} from "../src/services/recordingLifecycleCore";
const { DatabaseSync } = require("node:sqlite");
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(LIFECYCLE_SCHEMA);
  const adapter = {
    async execAsync(s: string) {
      db.exec(s);
    },
    async runAsync(s: string, v: any[]) {
      return db.prepare(s).run(...v);
    },
    async getFirstAsync<T>(s: string, v: any[]): Promise<T | null> {
      return db.prepare(s).get(...v) ?? null;
    },
    async getAllAsync<T>(s: string, v: any[]): Promise<T[]> {
      return db.prepare(s).all(...v);
    },
  };
  return {
    db,
    store: createRecordingLifecycleStore(async () => adapter),
    restart: () => createRecordingLifecycleStore(async () => adapter),
  };
}
const r = {
  userId: "A",
  sessionId: "one",
  stoppedAtMs: 1000,
  intervalMs: 30000,
  distanceMeters: 50,
  sharedOwners: ["viewer"],
};
test("stop intent survives restart; repeat stop cannot extend boundary or reopen saved session", async () => {
  const f = fixture();
  await f.store.requestStop(r);
  await f.restart().requestStop({ ...r, stoppedAtMs: 2000 });
  assert.equal((await f.store.read("A", "one"))!.stoppedAtMs, 1000);
  await f.store.stopped("A", "one");
  await f.store.prepareSave("A", "one");
  await f.store.saved("A", "one");
  await f.restart().requestStop({ ...r, stoppedAtMs: 3000 });
  assert.equal((await f.store.read("A", "one"))!.state, "SAVED");
  await assert.rejects(f.store.prepareDiscard("A", "one"));
  assert.equal((await f.store.read("A", "one"))!.state, "SAVED");
});
test("save/discard race has one winner across independent store instances", async () => {
  const f = fixture();
  await f.store.requestStop(r);
  await f.store.stopped("A", "one");
  const results = await Promise.allSettled([
    f.store.prepareSave("A", "one"),
    f.restart().prepareDiscard("A", "one"),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
});
test("normal unsaved discard succeeds and late stop does not undo its fence", async () => {
  const f = fixture();
  await f.store.requestStop(r);
  await f.store.stopped("A", "one");
  await f.store.prepareDiscard("A", "one");
  await f.store.discarded("A", "one");
  await assert.rejects(f.store.stopped("A", "one"));
  assert.equal((await f.restart().read("A", "one"))!.state, "DISCARDED");
});
test("pending replay boundary is inclusive, post-stop fixes retained rather than sent, owners isolated", async () => {
  const f = fixture();
  await f.store.requestStop(r);
  const entry = await f.store.read("A", "one");
  assert.equal(mayReplayStoppedPoint(entry, 1000), true);
  assert.equal(mayReplayStoppedPoint(entry, 1001), false);
  assert.equal(await f.store.read("B", "one"), null);
  assert.equal(await f.store.read("A", "other"), null);
  assert.equal((await f.store.pending("B")).length, 0);
  assert.equal((await f.restart().pending("A")).length, 1);
});
test("unconfirmed save survives restart and cannot silently change into discard", async () => {
  const f = fixture();
  await f.store.requestStop(r);
  await f.store.stopped("A", "one");
  await f.store.prepareSave("A", "one");
  await assert.rejects(f.restart().prepareDiscard("A", "one"));
  await f.restart().prepareSave("A", "one");
  await f.store.saved("A", "one");
  assert.equal((await f.store.pending("A")).length, 0);
});

test("save retry preserves chosen name even after server success and lost local UI acknowledgment", async () => {
  const f = fixture();
  await f.store.requestStop(r);
  await f.store.stopped("A", "one");
  await f.store.prepareSave("A", "one", "original name");
  assert.equal(
    (await f.restart().prepareSave("A", "one", "replacement")).saveName,
    "original name",
  );
  await f.store.saved("A", "one");
  assert.equal(
    (await f.restart().prepareSave("A", "one", "replacement")).state,
    "SAVED",
  );
});

test("durable stop survives closing and reopening the SQLite file", async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const directory = fs.mkdtempSync(path.resolve(".amplify/login-recording-incident-20261103/lifecycle-test-"));
    const file = path.join(directory,"journal.db");
    const connect = () => {
        const db = new DatabaseSync(file);db.exec(LIFECYCLE_SCHEMA);
        const adapter = {async execAsync(s:string){db.exec(s)},async runAsync(s:string,v:any[]){return db.prepare(s).run(...v)},
            async getFirstAsync<T>(s:string,v:any[]):Promise<T|null>{return db.prepare(s).get(...v)??null},async getAllAsync<T>(s:string,v:any[]):Promise<T[]>{return db.prepare(s).all(...v)}};
        return {db,store:createRecordingLifecycleStore(async()=>adapter)};
    };
    let connection=connect();
    try {
        await connection.store.requestStop(r);connection.db.close();connection=connect();
        assert.equal((await connection.store.read("A","one"))?.state,"STOP_REQUESTED");
        assert.equal((await connection.store.read("A","one"))?.stoppedAtMs,r.stoppedAtMs);
    } finally {connection.db.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("known zero-point save can return to normal unsaved discard; confirmed save cannot be rolled back",async()=>{
 const f=fixture();await f.store.requestStop(r);await f.store.stopped("A","one");await f.store.prepareSave("A","one","empty");
 await f.store.releaseUnsentSave("A","one");await f.store.prepareDiscard("A","one");await f.store.discarded("A","one");
 const g=fixture();await g.store.requestStop(r);await g.store.stopped("A","one");await g.store.prepareSave("A","one","saved");await g.store.saved("A","one");
 await assert.rejects(g.store.releaseUnsentSave("A","one"));assert.equal((await g.store.read("A","one"))?.state,"SAVED");
});


test("start and stop are frozen across restart and repeated stop", async()=>{
 const f=fixture();await f.store.requestStop({...r,startedAtMs:100});
 await f.restart().requestStop({...r,startedAtMs:200,stoppedAtMs:3000});
 const value=await f.restart().read('A','one');assert.equal(value!.startedAtMs,100);assert.equal(value!.stoppedAtMs,1000);
});
test("invalid inverted bounds preserve the original pending journal",async()=>{
 const f=fixture();await assert.rejects(f.store.requestStop({...r,startedAtMs:1001}));
 assert.equal(await f.store.read('A','one'),null);
});
test("additive migration preserves a legacy receipt and is repeatable",async()=>{
 const db=new DatabaseSync(':memory:');db.exec(LIFECYCLE_SCHEMA.replace(', started_at_ms REAL',''));
 db.exec("INSERT INTO recording_lifecycle VALUES ('A','old','STOPPED',1000,30000,50,'[]',NULL)");
 const adapter={async execAsync(s:string){db.exec(s);},async runAsync(s:string,v:any[]){return db.prepare(s).run(...v);},async getFirstAsync<T>(s:string,v:any[]){return db.prepare(s).get(...v) as T;},async getAllAsync<T>(s:string,v:any[]){return db.prepare(s).all(...v) as T[];}};
 await initializeRecordingLifecycleDatabase(adapter);await initializeRecordingLifecycleDatabase(adapter);
 const receipt=await createRecordingLifecycleStore(async()=>adapter).read('A','old');
 assert.equal(receipt!.stoppedAtMs,1000);assert.equal(receipt!.startedAtMs,null);assert.equal(receipt!.state,'STOPPED');
});
