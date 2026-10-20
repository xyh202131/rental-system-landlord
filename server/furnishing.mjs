import { statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const assets = [
  { id: 'plant', name: '盆栽', file: 'plant.glb', heightMm: 650, description: '会议室与窗边的绿植点缀' },
  { id: 'blue-cat', name: '蓝色猫咪摆件', file: 'blue-cat.glb', heightMm: 140, description: '桌面小物，适合检查摆放位置' },
];
function fileSignature(path) {
  try {
    const info = statSync(path);
    return info.isFile() && info.size > 0 ? [info.size, info.mtimeMs] : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function remoteAsset(result) {
  for (const format of ['spz', 'ply']) {
    try {
      const url = new URL(result?.[format]);
      if (url.protocol === 'https:' && !url.username && !url.password) return { url: url.href, identity: url.origin + url.pathname, format };
    } catch { /* A completed task can still lack a usable asset. */ }
  }
  return null;
}

// One authenticated catalog bridges samples, private imports and completed jobs.
// Only fixed asset IDs resolve to local files; private capture data is never exported.
export function createFurnishing(store, { samples, imports, sampleSettings, furnitureDir = join(store.dir, 'furniture') }) {
  const { db } = store;
  db.exec(`CREATE TABLE IF NOT EXISTS furnishing_layouts (
    user_id TEXT NOT NULL REFERENCES users(id), room_id TEXT NOT NULL, scene_version TEXT NOT NULL,
    revision INTEGER NOT NULL, floor_y REAL, placements TEXT NOT NULL, updated INTEGER NOT NULL,
    PRIMARY KEY(user_id,room_id,scene_version)
  )`);
  const findLayout = db.prepare('SELECT * FROM furnishing_layouts WHERE user_id=? AND room_id=? AND scene_version=?');
  const saveLayout = db.prepare(`INSERT INTO furnishing_layouts VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(user_id,room_id,scene_version) DO UPDATE SET
      revision=excluded.revision,floor_y=excluded.floor_y,placements=excluded.placements,updated=excluded.updated
    WHERE furnishing_layouts.revision=?`);

  function furnitureAsset(id) {
    const asset = assets.find(item => item.id === id);
    if (!asset) return null;
    const path = join(furnitureDir, asset.file);
    return fileSignature(path) ? { path, name: asset.file } : null;
  }
  function furniture() {
    return assets.map(({ file, ...item }) => ({ ...item, available: Boolean(furnitureAsset(item.id)),
      url: `/api/furnishing/furniture/${item.id}/model.glb`, sizeStatus: 'estimated',
    }));
  }
  function manifest(data, identity) {
    return { ...data, schemaVersion: 1, sceneVersion: digest([1, identity, data.upAxis]),
      metersPerUnit: null, calibration: { status: 'unknown' }, reviewStatus: 'unreviewed',
    };
  }
  function rooms(userId) {
    const local = [...imports.list(userId), ...samples.list()].flatMap(raw => {
      const sample = sampleSettings.apply(raw, userId);
      if (!sample.available) return [];
      const format = sample.assets.spz ? 'spz' : 'ply';
      const asset = samples.asset(sample.id, format) || imports.asset(sample.id, format, userId);
      const signature = asset && fileSignature(asset.path);
      if (!signature) return [];
      return [manifest({ id: `sample-${sample.id}`, sourceId: sample.id,
        sourceType: sample.isImported ? 'local_import' : 'builtin_sample',
        title: sample.title, upAxis: sample.upAxis || 'Z', initialView: sample.initialView || null,
        modelUrl: sample.assets[format], format, demoOnly: !sample.isImported,
      }, [sample.id, format, signature])];
    });
    const jobs = db.prepare(`SELECT j.*,d.property,d.room FROM jobs j JOIN drafts d ON d.id=j.draft_id
      WHERE d.user_id=? AND j.state='SUCCEEDED' ORDER BY j.created DESC LIMIT 100`).all(userId);
    const completed = jobs.flatMap(job => {
      const result = job.result ? JSON.parse(job.result) : null;
      const asset = remoteAsset(result);
      if (!asset) return [];
      const upAxis = result.upAxis === 'Y' ? 'Y' : 'Z';
      return [manifest({ id: `job-${job.id}`, sourceId: job.id, sourceType: 'reconstruction',
        title: `${job.property} / ${job.room} · 版本 ${job.revision}`, upAxis, initialView: null,
        modelUrl: asset.url, format: asset.format, demoOnly: false,
      }, [job.id, job.revision, asset.format, asset.identity])];
    });
    return [...local, ...completed];
  }
  function room(userId, id) {
    const found = rooms(userId).find(item => item.id === id);
    if (!found) fail(404, '房间成果不存在或当前账号无权查看。');
    return found;
  }
  function layout(userId, selected) {
    const row = findLayout.get(userId, selected.id, selected.sceneVersion);
    return row ? { revision: row.revision, floorY: row.floor_y, placements: JSON.parse(row.placements), updated: row.updated }
      : { revision: 0, floorY: null, placements: [], updated: null };
  }
  function save(userId, id, data) {
    const selected = room(userId, id);
    if (Object.keys(data).some(key => !['sceneVersion', 'revision', 'floorY', 'placements'].includes(key)) ||
        !Number.isSafeInteger(data.revision) || data.revision < 0 ||
        !(data.floorY === null || (Number.isFinite(data.floorY) && Math.abs(data.floorY) <= 10000)) ||
        !Array.isArray(data.placements) || data.placements.length > 20) fail(400, '布局内容无效，最多可摆放 20 件家具。');
    if (data.sceneVersion !== selected.sceneVersion) fail(409, '房间成果或朝向已更新，请重新打开试摆台；旧版本布局仍保留。');
    const ids = new Set();
    const placements = data.placements.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          Object.keys(item).some(key => !['id', 'assetId', 'position', 'rotationY', 'scale'].includes(key)) ||
          typeof item.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(item.id) || ids.has(item.id) ||
          !furnitureAsset(item.assetId) || !Array.isArray(item.position) || item.position.length !== 3 ||
          !item.position.every(n => Number.isFinite(n) && Math.abs(n) <= 10000) ||
          !Number.isFinite(item.rotationY) || Math.abs(item.rotationY) > 1000 ||
          !Number.isFinite(item.scale) || item.scale < .01 || item.scale > 100) fail(400, '家具、位置或比例无效，请重新调整后保存。');
      ids.add(item.id);
      return { id: item.id, assetId: item.assetId, position: item.position, rotationY: item.rotationY, scale: item.scale };
    });
    const current = layout(userId, selected);
    if (data.revision !== current.revision) fail(409, '此布局已在另一页面保存。请先重新载入，避免覆盖。');
    const written = saveLayout.run(userId, selected.id, selected.sceneVersion, data.revision + 1, data.floorY,
      JSON.stringify(placements), Date.now(), data.revision);
    if (!written.changes) fail(409, '布局版本冲突，请重新载入后再保存。');
    return { room: selected, layout: layout(userId, selected) };
  }
  return { rooms, room, layout, save, furniture, furnitureAsset };
}
