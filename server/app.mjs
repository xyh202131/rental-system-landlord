import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve, join, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { openStore, passwordMatches, passwordHash, tokenHash } from './store.mjs';
import { createProviders, reconstructionInput } from './providers.mjs';
import { createSampleCatalog } from './samples.mjs';
import { createSampleImports, MAX_MODEL_BYTES, parseProjectLink } from './sample-imports.mjs';
import { createSampleSettings } from './sample-settings.mjs';
import { createFurnishing } from './furnishing.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_MEDIA = 50 * 1024 * 1024;
const formats = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/webm': '.webm', 'video/mp4': '.mp4' };
const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };
const text = (value, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, '填写内容为空或超出长度限制。');
  return value.trim();
};
async function body(req, limit = 64 * 1024) {
  if (Number(req.headers['content-length'] || 0) > limit) fail(413, '文件或请求过大。');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, '文件或请求过大。');
    chunks.push(chunk);
  }
  req.verifyAccess?.();
  return Buffer.concat(chunks);
}
async function jsonBody(req, limit) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, '请求格式不支持。');
  try { const parsed = JSON.parse((await body(req, limit)).toString()); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, '请求无效。'); return parsed; }
  catch (error) { if (error.status) throw error; fail(400, '请求内容无法读取。'); }
}
function send(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function streamFile(req, res, path, mime, downloadName) {
  if (!existsSync(path)) fail(404, '文件不存在或已丢失，请重新拍摄。');
  const size = statSync(path).size;
  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes' };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename="${downloadName}"`;
  let start = 0, end = size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    if (!match) fail(416, '无法读取此范围。');
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start > end || start >= size) fail(416, '无法读取此范围。');
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(path, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
function validMagic(bytes, mime) {
  if (bytes.length < 12) return false;
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'video/mp4') return bytes.toString('ascii', 4, 8) === 'ftyp';
  return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

export function createApp(options = {}) {
  const env = options.env || process.env;
  const store = openStore(options.dataDir || join(root, '.data'), options);
  const { db } = store;
  const providers = options.providers || createProviders(env);
  const samples = createSampleCatalog(options.samplesRoot || join(root, 'outputs', 'aholo'), options.sampleDir);
  const imports = createSampleImports(store, { fetchImpl: options.importFetch });
  const sampleSettings = createSampleSettings(store);
  const furnishing = createFurnishing(store, { samples, imports, sampleSettings, furnitureDir: options.furnitureDir });
  const ownSamples = userId => [...imports.list(userId), ...samples.list()];
  const dist = join(root, 'dist');
  const loginAttempts = new Map();
  const liveRequests = new Map();
  const reviewRequests = new Set();
  const uploading = new Set();
  const sessionTTL = Math.max(0.001, Math.min(24, Number(env.SESSION_HOURS) || 8)) * 3600_000;
  const dummyPassword = passwordHash(randomBytes(12).toString('hex'));
  const cookie = (value, clear = false) => `rental_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : Math.floor(sessionTTL / 1000)}${env.COOKIE_SECURE === '1' || env.PUBLIC_ORIGIN?.startsWith('https:') ? '; Secure' : ''}`;
  function ownDraft(id, user) { const found = store.draft(id, user.id); if (!found) fail(404, '采集记录不存在。'); return found; }
  function ownJob(id, user) { const job = db.prepare('SELECT j.* FROM jobs j JOIN drafts d ON d.id=j.draft_id WHERE j.id=? AND d.user_id=?').get(id, user.id); if (!job) fail(404, '任务不存在。'); return job; }
  function requireVerified(user, revision) {
    const check = store.verification(user.id);
    if (check.status !== 'passed' || !Object.values(check.documents).every(Boolean) || (revision !== undefined && revision !== check.revision)) {
      fail(403, '请先在用户中心完成身份证与房产证核验，通过后才能继续采集。', 'VERIFICATION_REQUIRED');
    }
    return check.revision;
  }
  function auth(req) {
    const token = /(?:^|;\s*)rental_session=([a-zA-Z0-9_-]+)/.exec(req.headers.cookie || '')?.[1];
    if (!token) fail(401, '请登录后继续。');
    const session = db.prepare('SELECT s.*,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE token=? AND expires>?').get(tokenHash(token), Date.now());
    if (!session) fail(401, '登录已过期，请重新登录。已保存的采集仍然保留。');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== session.csrf) fail(403, '请求校验失败，请刷新页面。');
    return { session, user: { id: session.user_id, username: session.username } };
  }
  async function runJob(jobId, draft) {
    let creating = false;
    try {
      const worldId = await providers.reconstruct(draft, store.mediaPath, () => { creating = true; });
      db.prepare("UPDATE jobs SET state='RUNNING',world_id=?,updated=?,message='平台已受理，请刷新任务状态。' WHERE id=?").run(worldId, Date.now(), jobId);
    } catch (error) {
      const state = creating && !error.rejected ? 'UNKNOWN' : 'FAILED';
      db.prepare('UPDATE jobs SET state=?,updated=?,message=? WHERE id=?').run(state, Date.now(), state === 'UNKNOWN' ? '创建结果不明，请先核对平台任务；本版本不会自动重复提交。' : '上传或平台受理失败，请核对服务配置、额度与素材。', jobId);
    }
  }
  async function route(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob: https:; frame-src https://studio.aholo3d.cn; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const host = req.headers.host;
    const boundPort = server.address()?.port || options.port || 4317;
    const localHosts = [`localhost:${boundPort}`, `127.0.0.1:${boundPort}`, `[::1]:${boundPort}`];
    const publicHost = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).host : null;
    if (!localHosts.includes(host) && host !== publicHost) fail(403, '访问地址未获允许。');
    const origin = publicHost && host === publicHost ? new URL(env.PUBLIC_ORIGIN).origin : `http://${host}`;
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) fail(403, '请求来源不匹配。');
    const url = new URL(req.url, origin);
    const path = url.pathname;
    const method = req.method;
    if (path === '/api/health' && method === 'GET') return send(res, { ok: true });
    if (path === '/api/login' && method === 'POST') {
      const data = await jsonBody(req);
      const username = text(data.username, 60, true);
      if (typeof data.password !== 'string' || !data.password.length || data.password.length > 256) fail(400, '密码长度无效。');
      const password = data.password;
      const ip = req.socket.remoteAddress;
      const now = Date.now();
      for (const [key, value] of loginAttempts) if (value.until <= now) loginAttempts.delete(key);
      const attempts = loginAttempts.get(ip) || { count: 0, until: now + 10 * 60_000 };
      if (attempts.count >= 10) fail(429, '尝试次数过多，请 10 分钟后再试。');
      const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
      const matches = passwordMatches(password, user?.password || dummyPassword);
      if (!user || !matches) { attempts.count++; loginAttempts.set(ip, attempts); fail(401, '账号或密码不正确。'); }
      loginAttempts.delete(ip);
      const token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url');
      const prior = /(?:^|;\s*)rental_session=([a-zA-Z0-9_-]+)/.exec(req.headers.cookie || '')?.[1];
      if (prior) db.prepare('DELETE FROM sessions WHERE token=?').run(tokenHash(prior));
      db.prepare('DELETE FROM sessions WHERE expires<?').run(now);
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(tokenHash(token), user.id, csrf, now + sessionTTL);
      res.setHeader('Set-Cookie', cookie(token));
      return send(res, { user: store.publicUser(user), csrf });
    }
    if (path.startsWith('/api/')) {
      const { user, session } = auth(req);
      if (path === '/api/session' && method === 'GET') return send(res, { user: store.publicUser(user), csrf: session.csrf });
      if (path === '/api/logout' && method === 'POST') { db.prepare('DELETE FROM sessions WHERE token=?').run(session.token); res.setHeader('Set-Cookie', cookie('', true)); return send(res, { ok: true }); }
      if (path === '/api/config' && method === 'GET') return send(res, { vision: providers.visionEnabled, reconstruction: providers.reconstructionEnabled, sample: Boolean(samples.asset('3FO4K4XNH9NX', 'spz')), samples: ownSamples(user.id).map(sample => sampleSettings.apply(sample, user.id)), maxModelBytes: MAX_MODEL_BYTES, maxMediaBytes: MAX_MEDIA, maxSeconds: 60 });
      if (path === '/api/furnishing/rooms' && method === 'GET') return send(res, { rooms: furnishing.rooms(user.id), furniture: furnishing.furniture() });
      const furnishingRoom = /^\/api\/furnishing\/rooms\/([a-zA-Z0-9-]+)(?:\/(layout))?$/.exec(path);
      if (furnishingRoom) {
        const [, id, action] = furnishingRoom;
        if (!action && method === 'GET') {
          const room = furnishing.room(user.id, id);
          return send(res, { room, layout: furnishing.layout(user.id, room) });
        }
        if (action === 'layout' && method === 'PUT') {
          const data = await jsonBody(req);
          auth(req);
          return send(res, furnishing.save(user.id, id, data));
        }
        fail(405, '不支持的布局操作。');
      }
      const furnishingAsset = /^\/api\/furnishing\/furniture\/([a-zA-Z0-9-]+)\/model\.glb$/.exec(path);
      if (furnishingAsset && ['GET', 'HEAD'].includes(method)) {
        const asset = furnishing.furnitureAsset(furnishingAsset[1]);
        if (!asset) fail(404, '本机没有这件家具模型，请先准备演示资产。');
        return streamFile(req, res, asset.path, 'model/gltf-binary');
      }
      const sampleSettingsMatch = /^\/api\/samples\/([A-Z0-9]+)\/settings$/.exec(path);
      if (sampleSettingsMatch && method === 'PATCH') {
        const data = await jsonBody(req);
        auth(req);
        const sample = ownSamples(user.id).find(item => item.id === sampleSettingsMatch[1]);
        if (!sample) fail(404, '找不到此案例。');
        return send(res, { sample:sampleSettings.update(sample, user.id, data) });
      }
      if (['/api/samples/import-link', '/api/samples/import-file'].includes(path) && method === 'POST') {
        const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(110000)]);
        const disconnect = () => { if (!res.writableEnded) abort.abort(); };
        res.once('close', disconnect);
        const context = { signal, authorize: () => auth(req) };
        try {
          let result;
          if (path.endsWith('import-link')) {
            const data = await jsonBody(req), project = parseProjectLink(data.url);
            const builtin = samples.list().find(item => item.id === project.projectId && item.available);
            result = builtin ? { sample:builtin, duplicate:true } : await imports.fromLink(user.id, data, context);
          } else {
            if (req.headers['content-type'] !== 'application/octet-stream') fail(415, '请以模型文件格式上传。');
            if (Number(req.headers['content-length']) > MAX_MODEL_BYTES) fail(413, '单个模型不能超过 150 MB。');
            let data;
            try { data = JSON.parse(decodeURIComponent(req.headers['x-model-meta'] || '')); } catch { fail(400, '模型信息无效。'); }
            if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, '模型信息无效。');
            result = await imports.fromFile(user.id, data, req, context);
          }
          auth(req); return send(res, { ...result, sample:sampleSettings.apply(result.sample, user.id) }, result.duplicate ? 200 : 201);
        } finally { res.removeListener('close', disconnect); }
      }
      if (path === '/api/identity-mock' && method === 'POST') {
        fail(410, '身份检查已迁移至用户中心，请完成身份证与房产证核验。');
      }
      if (path === '/api/verification/reset' && method === 'POST') {
        db.prepare(`INSERT INTO user_verifications(user_id,revision) VALUES (?,1)
          ON CONFLICT(user_id) DO UPDATE SET status='unverified',front=0,back=0,property=0,result=NULL,checked_at=NULL,revision=revision+1`).run(user.id);
        return send(res, { user: store.publicUser(user) });
      }
      if (path === '/api/verification/mock' && method === 'POST') {
        const data = await jsonBody(req);
        const documents = data.documents;
        if (!['pass', 'glare', 'edge', 'property', 'failed'].includes(data.result) || Object.keys(data).some(k => !['result', 'documents', 'revision'].includes(k)) ||
            !documents || typeof documents !== 'object' || Array.isArray(documents) || Object.keys(documents).length !== 3 ||
            !['front', 'back', 'property'].every(k => documents[k] === true) || !Number.isSafeInteger(data.revision) || data.revision < 0) {
          fail(400, '请补齐身份证人像面、国徽面和房产证。此接口仅接受模拟状态，不接受证件图片或个人资料。');
        }
        if (data.revision !== store.verification(user.id).revision) fail(409, '核验资料已在其他页面更新，请刷新核验状态后重试。');
        const status = data.result === 'pass' ? 'passed' : 'failed';
        db.prepare(`INSERT INTO user_verifications(user_id,status,front,back,property,result,checked_at,revision) VALUES (?,?,1,1,1,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET status=excluded.status,front=1,back=1,property=1,result=excluded.result,checked_at=excluded.checked_at,revision=excluded.revision`).run(user.id, status, data.result, Date.now(), data.revision + 1);
        return send(res, { user: store.publicUser(user) });
      }
      // Main workflow writes share one gate, including direct requests from a stale tab.
      if (!['GET', 'HEAD'].includes(method)) {
        const revision = requireVerified(user);
        req.verifyAccess = () => requireVerified(user, revision);
      }
      if (path === '/api/drafts' && method === 'GET') return send(res, { drafts: db.prepare('SELECT d.*, (SELECT COUNT(*) FROM media m WHERE m.draft_id=d.id AND m.purpose<>\'video-frame\') AS media_count FROM drafts d WHERE user_id=? ORDER BY updated DESC').all(user.id).map(d => ({ ...d, review: undefined })) });
      if (path === '/api/drafts' && method === 'POST') {
        const data = await jsonBody(req), id = randomUUID(), now = Date.now();
        if (db.prepare('SELECT COUNT(*) AS count FROM drafts WHERE user_id=?').get(user.id).count >= 100) fail(409, '本机 MVP 最多保存 100 次采集。');
        db.prepare('INSERT INTO drafts (id,user_id,property,room,created,updated) VALUES (?,?,?,?,?,?)').run(id, user.id, text(data.property, 80, true), text(data.room, 40, true), now, now);
        return send(res, store.draft(id, user.id), 201);
      }
      const draftMatch = /^\/api\/drafts\/([a-f0-9-]+)(?:\/(media|review|confirm|report|jobs|issues))?$/.exec(path);
      if (draftMatch) {
        const [, id, action] = draftMatch;
        let draft = ownDraft(id, user);
        if (!action && method === 'GET') return send(res, draft);
        if (!action && method === 'PATCH') {
          const data = await jsonBody(req);
          db.prepare('UPDATE drafts SET notes=?,updated=? WHERE id=?').run(text(data.notes, 2000), Date.now(), id);
          return send(res, store.draft(id, user.id));
        }
        if (action === 'media' && method === 'POST') {
          if (uploading.has(user.id)) fail(409, '上一份素材仍在保存，请稍后重试。');
          const mime = (req.headers['content-type'] || '').split(';')[0];
          if (!formats[mime]) fail(415, '仅支持相机产生的 JPEG、PNG、WebP、MP4 或 WebM。');
          let meta;
          try { meta = JSON.parse(decodeURIComponent(req.headers['x-capture-meta'] || '')); } catch { fail(400, '缺少实时拍摄信息。'); }
          if (!meta || meta.source !== 'live-camera' || !['reconstruction', 'check', 'video-frame'].includes(meta.purpose) || !Number.isFinite(Date.parse(meta.capturedAt))) fail(400, '实时拍摄信息无效。');
          if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(meta.captureId || '')) fail(400, '缺少本次拍摄编号。');
          const kind = mime.startsWith('image/') ? 'photo' : 'video';
          if (kind === 'video' && meta.purpose !== 'reconstruction') fail(400, '录像仅用于房间采集。');
          if (meta.purpose === 'video-frame' && !draft.media.some(m => m.id === meta.parentId && m.kind === 'video')) fail(400, '录像抽帧缺少所属录像。');
          const mediaId = meta.captureId, filename = mediaId + formats[mime];
          uploading.add(user.id);
          try {
            const bytes = await body(req, MAX_MEDIA);
            if (!validMagic(bytes, mime)) fail(415, '文件内容与拍摄格式不一致。');
            draft = ownDraft(id, user);
            const prior = db.prepare('SELECT * FROM media WHERE id=?').get(mediaId);
            if (prior) {
              if (prior.draft_id !== id || prior.mime !== mime || prior.purpose !== meta.purpose || prior.captured !== meta.capturedAt || prior.parent_id !== (meta.parentId || null) || !bytes.equals(await readFile(store.mediaPath(prior.filename)))) fail(409, '拍摄编号冲突，请重新拍摄。');
              return send(res, { id: prior.id, draft });
            }
            if (draft.media.length >= 200) fail(409, '单次采集最多保存 200 份素材。');
            if (meta.purpose === 'video-frame' && !draft.media.some(m => m.id === meta.parentId && m.kind === 'video')) fail(409, '所属录像已被移除。');
            const used = db.prepare('SELECT COALESCE(SUM(m.size),0) AS size FROM media m JOIN drafts d ON d.id=m.draft_id WHERE d.user_id=?').get(user.id).size;
            if (used + bytes.length > 1024 * 1024 * 1024) fail(413, '本机每个账号最多保存 1 GiB 素材。');
            const metrics = {};
            for (const key of ['brightness', 'overexposure', 'detail']) if (typeof meta.metrics?.[key] === 'number' && Number.isFinite(meta.metrics[key])) metrics[key] = Math.max(0, Math.min(65535, meta.metrics[key]));
            await writeFile(store.mediaPath(filename), bytes, { flag: 'wx' });
            try {
              db.exec('BEGIN');
              req.verifyAccess();
              db.prepare('INSERT INTO media VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(mediaId, id, kind, meta.purpose, mime, bytes.length, filename, meta.capturedAt, Math.min(65, Math.max(0, Number(meta.duration) || 0)), JSON.stringify(metrics), meta.purpose === 'video-frame' ? meta.parentId : null);
              store.touch(id);
              db.exec('COMMIT');
            } catch (error) { db.exec('ROLLBACK'); await unlink(store.mediaPath(filename)); throw error; }
            return send(res, { id: mediaId, draft: store.draft(id, user.id) }, 201);
          } finally { uploading.delete(user.id); }
        }
        if (action === 'review' && method === 'POST') {
          const data = await jsonBody(req);
          draft = ownDraft(id, user);
          if (!draft.media.length) fail(422, '请先拍摄素材。');
          if (providers.visionEnabled && data.allowExternal !== true) fail(400, '请确认将采集图片发送到配置的视觉服务。');
          if (reviewRequests.has(id)) fail(409, '此次检查仍在进行。');
          reviewRequests.add(id);
          try {
            const review = await providers.review(draft, store.mediaPath);
            req.verifyAccess();
            if (ownDraft(id, user).revision !== draft.revision) fail(409, '检查期间素材已改变，请重新检查。');
            db.prepare('UPDATE drafts SET review=?,review_revision=?,confirmed_revision=NULL,updated=? WHERE id=?').run(JSON.stringify(review), draft.revision, Date.now(), id);
            return send(res, store.draft(id, user.id));
          } finally { reviewRequests.delete(id); }
        }
        if (action === 'issues' && method === 'PATCH') {
          const data = await jsonBody(req);
          draft = ownDraft(id, user);
          if (!draft.review || draft.review_revision !== draft.revision) fail(409, '素材已变化，请先重新检查。');
          const item = draft.review.issues.find(i => i.id === data.id);
          if (!item || !['pending', 'noted'].includes(data.status)) fail(400, '问题状态无效。');
          item.status = data.status;
          item.note = text(data.note || '', 500);
          if (data.status === 'noted' && !item.note) fail(400, '请填写处理说明。');
          db.prepare('UPDATE drafts SET review=?,confirmed_revision=NULL,updated=? WHERE id=?').run(JSON.stringify(draft.review), Date.now(), id);
          return send(res, store.draft(id, user.id));
        }
        if (action === 'confirm' && method === 'POST') {
          const data = await jsonBody(req);
          draft = ownDraft(id, user);
          if (!draft.review || draft.review_revision !== draft.revision || data.manual !== true) fail(409, '请先检查当前素材，并确认人工复核。');
          db.prepare('UPDATE drafts SET confirmed_revision=?,updated=? WHERE id=?').run(draft.revision, Date.now(), id);
          return send(res, store.draft(id, user.id));
        }
        if (action === 'report' && method === 'GET') {
          res.setHeader('Content-Disposition', `attachment; filename="capture-${id}.json"`);
          return send(res, { property: draft.property, room: draft.room, revision: draft.revision, capturedAt: draft.created, review: draft.review, reviewIsCurrent: draft.review_revision === draft.revision, manualConfirmed: draft.confirmed_revision === draft.revision, reconstructionAccepted: false, media: draft.media.map(({ id, kind, purpose, captured, mime, size, parent_id }) => ({ id, kind, purpose, captured, mime, size, parent_id })), jobs: draft.jobs });
        }
        if (action === 'jobs' && method === 'POST') {
          const data = await jsonBody(req);
          draft = ownDraft(id, user);
          if (!providers.reconstructionEnabled) fail(503, '重建服务尚未配置；采集与草稿功能可继续使用。');
          if (data.confirmCost !== true) fail(400, '请确认上传素材并消耗平台额度。');
          if (uploading.has(user.id)) fail(409, '素材仍在保存，请稍后重试。');
          if (draft.confirmed_revision !== draft.revision) fail(409, '请先复查并人工确认当前素材。');
          if (draft.jobs.some(j => j.revision === draft.revision)) fail(409, '当前素材版本已有任务，请查询原任务，不要重复提交。');
          const inputs = reconstructionInput(draft.media);
          const jobId = randomUUID(), now = Date.now();
          db.prepare('INSERT INTO jobs (id,draft_id,revision,state,created,updated,media_ids) VALUES (?,?,?,?,?,?,?)').run(jobId, id, draft.revision, 'SUBMITTING', now, now, JSON.stringify(inputs.map(m => m.id)));
          void runJob(jobId, draft);
          return send(res, { jobId, state: 'SUBMITTING' }, 202);
        }
      }
      const mediaMatch = /^\/api\/media\/([a-f0-9-]+)$/.exec(path);
      if (mediaMatch) {
        const m = db.prepare('SELECT m.* FROM media m JOIN drafts d ON d.id=m.draft_id WHERE m.id=? AND d.user_id=?').get(mediaMatch[1], user.id);
        if (!m) fail(404, '素材不存在。');
        if (['GET', 'HEAD'].includes(method)) return streamFile(req, res, store.mediaPath(m.filename), m.mime, url.searchParams.has('download') ? m.filename : null);
        if (method === 'DELETE') {
          if (uploading.has(user.id)) fail(409, '素材正在保存，请稍后再移除。');
          const draft = ownDraft(m.draft_id, user);
          if (draft.jobs.some(j => j.media_ids.includes(m.id))) fail(409, '该素材已关联重建任务，保留它以便对照。');
          const related = draft.media.filter(x => x.id === m.id || x.parent_id === m.id);
          for (const item of related) {
            try { await unlink(store.mediaPath(item.filename)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            db.prepare('DELETE FROM media WHERE id=?').run(item.id);
          }
          store.touch(m.draft_id);
          return send(res, store.draft(m.draft_id, user.id));
        }
      }
      if (path === '/api/guidance/live' && method === 'POST') {
        if (!providers.visionEnabled) fail(503, '视觉 Agent 未配置。');
        if ((liveRequests.get(user.id) || 0) > Date.now()) fail(429, '请稍候再请求指导。');
        const data = await jsonBody(req, 700_000);
        if (typeof data.frame !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(data.frame)) fail(400, '指导画面无效。');
        liveRequests.set(user.id, Date.now() + 8000);
        const tip = await providers.live(data.frame);
        req.verifyAccess();
        return send(res, tip);
      }
      const jobMatch = /^\/api\/jobs\/([a-f0-9-]+)(?:\/(refresh))?$/.exec(path);
      if (jobMatch) {
        const job = ownJob(jobMatch[1], user);
        if (method === 'POST' && jobMatch[2] === 'refresh' && job.world_id) {
          const result = await providers.status(job.world_id);
          req.verifyAccess();
          const known = ['SUCCEEDED', 'FAILED', 'RUNNING', 'PENDING', 'QUEUED', 'CANCELLED'];
          let state = known.includes(result.status) ? result.status : 'UNKNOWN';
          if (state === 'SUCCEEDED' && !result.spz && !result.ply) state = 'ASSET_MISSING';
          db.prepare('UPDATE jobs SET state=?,result=?,updated=?,message=? WHERE id=?').run(state, JSON.stringify(result), Date.now(), state === 'SUCCEEDED' ? '重建完成，仍需实拍对照与人工验收。' : state === 'ASSET_MISSING' ? '平台完成但尚无可用模型。' : '已更新平台状态。', job.id);
        } else if (method !== 'GET' && !(method === 'POST' && jobMatch[2] === 'refresh')) fail(405, '不支持的操作。');
        return send(res, ownDraft(job.draft_id, user));
      }
      const sampleMatch = /^\/api\/samples\/([A-Z0-9]+)\/model\.(spz|ply)$/.exec(path);
      const legacySampleMatch = /^\/api\/sample\/model\.(spz|ply)$/.exec(path);
      if ((sampleMatch || legacySampleMatch) && ['GET', 'HEAD'].includes(method)) {
        const id = sampleMatch ? sampleMatch[1] : '3FO4K4XNH9NX', format = sampleMatch ? sampleMatch[2] : legacySampleMatch[1];
        const asset = samples.asset(id, format) || imports.asset(id, format, user.id);
        if (!asset) fail(404, '本机未找到此样例模型文件，请参阅使用说明。');
        return streamFile(req, res, asset.path, 'application/octet-stream', url.searchParams.has('download') ? asset.name : null);
      }
      fail(404, '接口不存在。');
    }
    if (!['GET', 'HEAD'].includes(method)) fail(405, '不支持的操作。');
    let decoded;
    try { decoded = decodeURIComponent(path); } catch { fail(400, '地址无效。'); }
    const file = resolve(dist, '.' + (decoded === '/' ? '/index.html' : decoded));
    if (!file.startsWith(dist + sep) || !['.html', '.js', '.css', '.svg', '.jpg', '.png', '.wasm'].includes(extname(file))) fail(404, '页面不存在。');
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.wasm': 'application/wasm' }[extname(file)];
    return streamFile(req, res, file, mime);
  }
  const server = createServer((req, res) => {
    route(req, res).catch(error => {
      if (res.headersSent) return res.destroy();
      const status = error.status || 500;
      if (status === 500) console.error('Request failed:', error.code || error.name);
      send(res, { error: status === 500 ? '本机服务暂时无法完成操作，请保留当前页面并重试。' : error.message, ...(error.code === 'VERIFICATION_REQUIRED' ? { code: error.code } : {}) }, status);
    });
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  return { server, store, providers };
}
