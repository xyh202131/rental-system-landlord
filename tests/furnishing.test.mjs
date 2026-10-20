import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { passwordHash } from '../server/store.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rental-furnishing-'));
  const samplesRoot = join(dir, 'samples'), furnitureDir = join(dir, 'furniture');
  await mkdir(join(samplesRoot, '3FO4K4VCF7LG'), { recursive: true });
  await writeFile(join(samplesRoot, '3FO4K4VCF7LG', 'meeting-room.spz'), 'sample-model');
  await mkdir(furnitureDir);
  await writeFile(join(furnitureDir, 'plant.glb'), 'glTF-local-furniture');
  const options = { dataDir: dir, samplesRoot, furnitureDir, username: 'landlord', password: 'test-local-only', env: {} };
  let app = createApp(options);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  function client() {
    let cookie = '', csrf = '';
    return {
      async request(path, { method = 'GET', data, headers = {} } = {}) {
        const res = await fetch(base + path, { method, headers: {
          Origin: base, Cookie: cookie, 'X-CSRF-Token': csrf, Connection: 'close',
          ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
        }, body: data === undefined ? undefined : JSON.stringify(data) });
        if (res.headers.has('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
        const value = res.headers.get('content-type')?.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
        if (value.csrf) csrf = value.csrf;
        return { status: res.status, value, headers: res.headers };
      },
      login(username = 'landlord') { return this.request('/api/login', { method: 'POST', data: { username, password: 'test-local-only' } }); },
    };
  }
  const owner = app.store.db.prepare('SELECT id FROM users WHERE username=?').get('landlord').id;
  const other = randomUUID();
  app.store.db.prepare('INSERT INTO users(id,username,password) VALUES(?,?,?)').run(other, 'other', passwordHash('test-local-only'));
  const user = client(); await user.login();
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.db.close(); await rm(dir, { recursive: true, force: true }); });
  return { app, dir, samplesRoot, user, owner, other, client, async restart() {
    const port = app.server.address().port;
    await new Promise(resolve => app.server.close(resolve)); app.store.db.close();
    app = createApp(options); await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  } };
}

const roomPath = '/api/furnishing/rooms/sample-3FO4K4VCF7LG';
const placement = () => ({ id: randomUUID(), assetId: 'plant', position: [1, 0, -2], rotationY: .5, scale: 1.2 });
async function payload(user, placements = [placement()]) {
  const { room, layout } = (await user.request(roomPath)).value;
  return { sceneVersion: room.sceneVersion, revision: layout.revision, floorY: -.8, placements };
}

test('local furnishing catalog requires login and includes only accessible usable sources', async t => {
  const { app, dir, owner, other, user, client } = await fixture(t);
  assert.equal((await client().request('/api/furnishing/rooms')).status, 401);
  const importId = 'I' + 'A'.repeat(32);
  await mkdir(join(dir, 'imports', importId), { recursive: true });
  await writeFile(join(dir, 'imports', importId, 'model.ply'), 'private-import');
  app.store.db.prepare('INSERT INTO sample_imports VALUES(?,?,?,?,?,?)').run(importId, owner, 'file:private', 'ply', JSON.stringify({ title: '我的房间', upAxis: 'Y', kind: '文件导入', note: 'private note' }), Date.now());
  for (const [ownerId, state] of [[owner, 'SUCCEEDED'], [owner, 'RUNNING'], [other, 'SUCCEEDED']]) {
    const draft = randomUUID(), job = randomUUID();
    app.store.db.prepare('INSERT INTO drafts(id,user_id,property,room,notes,created,updated) VALUES(?,?,?,?,?,?,?)').run(draft, ownerId, '房屋', '卧室', 'private draft note', 1, 1);
    app.store.db.prepare('INSERT INTO jobs(id,draft_id,revision,state,world_id,created,updated,result,media_ids) VALUES(?,?,?,?,?,?,?,?,?)').run(job, draft, 1, state, 'WORLD123', 1, 1, JSON.stringify({ spz: 'https://example.com/room.spz?signature=one', upAxis: 'Z' }), '[]');
  }
  const result = await user.request('/api/furnishing/rooms');
  assert.equal(result.status, 200);
  assert.deepEqual(result.value.rooms.map(r => r.sourceType).sort(), ['builtin_sample', 'local_import', 'reconstruction']);
  assert.equal(result.value.rooms.find(r => r.sourceType === 'local_import').upAxis, 'Y');
  assert.ok(result.value.rooms.every(r => r.reviewStatus === 'unreviewed' && r.metersPerUnit === null));
  assert.doesNotMatch(JSON.stringify(result.value), /private note|private draft note|user_id|filename/);
  assert.equal(result.value.furniture.find(a => a.id === 'plant').available, true);
});

test('layouts persist over restart and stay isolated by owner and room with stale-write protection', async t => {
  const { user, client, restart, samplesRoot } = await fixture(t);
  const original = await payload(user);
  const saved = await user.request(roomPath + '/layout', { method: 'PUT', data: original });
  assert.equal(saved.status, 200);
  assert.equal(saved.value.layout.revision, 1);
  assert.deepEqual(saved.value.layout.placements, original.placements);
  await mkdir(join(samplesRoot, '3FO4K4XNH9NX'), { recursive: true });
  await writeFile(join(samplesRoot, '3FO4K4XNH9NX', 'workbench.spz'), 'another-room');
  const another = (await user.request('/api/furnishing/rooms/sample-3FO4K4XNH9NX')).value;
  assert.equal(another.layout.placements.length, 0);
  assert.equal((await user.request(roomPath + '/layout', { method: 'PUT', data: original })).status, 409);
  const second = client(); await second.login('other');
  assert.equal((await second.request(roomPath)).value.layout.placements.length, 0);
  const secondData = await payload(second, []);
  assert.equal((await second.request(roomPath + '/layout', { method: 'PUT', data: secondData })).status, 200);
  await restart();
  const restored = (await user.request(roomPath)).value.layout;
  assert.equal(restored.floorY, original.floorY);
  assert.deepEqual(restored.placements, original.placements);
  assert.equal((await user.request('/api/furnishing/rooms/sample-NONEXISTENT')).status, 404);
});

test('layout validation and CSRF failures preserve the existing saved layout', async t => {
  const { user } = await fixture(t);
  const base = await payload(user);
  assert.equal((await user.request(roomPath + '/layout', { method: 'PUT', data: base, headers: { 'X-CSRF-Token': '' } })).status, 403);
  for (const patch of [
    { placements: [{ ...placement(), assetId: '../secret' }] },
    { placements: [{ ...placement(), position: [null, 0, 0] }] },
    { placements: [{ ...placement(), scale: -1 }] },
    { placements: Array.from({ length: 21 }, placement) },
    { floorY: '0' }, { revision: -1 }, { arbitraryPath: 'C:/secret' },
  ]) {
    assert.equal((await user.request(roomPath + '/layout', { method: 'PUT', data: { ...base, ...patch } })).status, 400);
  }
  const duplicate = placement();
  assert.equal((await user.request(roomPath + '/layout', { method: 'PUT', data: { ...base, placements: [duplicate, duplicate] } })).status, 400);
  assert.equal((await user.request(roomPath)).value.layout.revision, 0);
});

test('changed room orientation creates a separate scene version and rejects old layout writes', async t => {
  const { user } = await fixture(t);
  const first = await payload(user);
  assert.equal((await user.request(roomPath + '/layout', { method: 'PUT', data: first })).status, 200);
  assert.equal((await user.request('/api/samples/3FO4K4VCF7LG/settings', { method: 'PATCH', data: { title: '我的会议室', note: '', upAxis: 'Y', revision: 0 } })).status, 200);
  const changed = (await user.request(roomPath)).value;
  assert.notEqual(changed.room.sceneVersion, first.sceneVersion);
  assert.equal(changed.layout.placements.length, 0);
  assert.equal((await user.request(roomPath + '/layout', { method: 'PUT', data: first })).status, 409);
  await user.request('/api/samples/3FO4K4VCF7LG/settings', { method: 'PATCH', data: { title: '恢复方向', note: '', upAxis: 'Z', revision: 1 } });
  assert.deepEqual((await user.request(roomPath)).value.layout.placements, first.placements);
});

test('furniture files use fixed authenticated asset IDs with ranges and no directory exposure', async t => {
  const { user, client } = await fixture(t);
  const path = '/api/furnishing/furniture/plant/model.glb';
  assert.equal((await client().request(path)).status, 401);
  const part = await user.request(path, { headers: { Range: 'bytes=0-3' } });
  assert.equal(part.status, 206);
  assert.equal(part.value.toString(), 'glTF');
  assert.match(part.headers.get('content-security-policy'), /connect-src 'self' blob: https:/);
  assert.equal((await user.request(path, { method: 'HEAD' })).status, 200);
  assert.equal((await user.request('/api/furnishing/furniture/secret/model.glb')).status, 404);
  assert.equal((await user.request('/.data/furniture/plant.glb')).status, 404);
});
