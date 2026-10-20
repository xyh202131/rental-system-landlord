import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.mjs';

const dir = mkdtempSync(join(tmpdir(), 'rental-browser-test-'));
const { server, store } = createApp({ dataDir: dir, furnitureDir: join(import.meta.dirname, '../../.data/furniture'), password: 'browser-test-only-123', port: 4318, env: {} });
server.listen(4318, '127.0.0.1');
function close() { server.close(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); process.exit(0); }); server.closeIdleConnections(); }
process.on('SIGINT', close); process.on('SIGTERM', close);
