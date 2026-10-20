import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Box3, BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { normalizeFurniture, roomFrame } from '../src/furnishing-geometry.js';

test('furniture normalization preserves proportions and places its bottom at zero in a Y-up scene', () => {
  const model = new Group();
  const mesh = new Mesh(new BoxGeometry(2, 4, 6), new MeshBasicMaterial());
  mesh.position.set(10, -5, 8); model.add(mesh);
  const root = normalizeFurniture(model, .8);
  const box = new Box3().setFromObject(root);
  assert.ok(Math.abs(box.min.y) < 1e-6);
  assert.ok(Math.abs(box.getCenter(new Vector3()).x) < 1e-6);
  assert.ok(Math.abs(box.getCenter(new Vector3()).z) < 1e-6);
  assert.ok(Math.abs(box.getSize(new Vector3()).y - .8) < 1e-6);
  assert.ok(Math.abs(box.getSize(new Vector3()).z - 1.2) < 1e-6);
  mesh.geometry.dispose(); mesh.material.dispose();
});

test('room frame uses trimmed world-space points rather than floating outliers for placement suggestions', () => {
  const points = Array.from({ length: 1000 }, (_, i) => [i % 10, (i % 30) / 10, Math.floor(i / 100)]);
  points.push([-900, -900, -900], [900, 900, 900]);
  const box = new Box3(new Vector3(-900, -900, -900), new Vector3(900, 900, 900));
  const frame = roomFrame(points, box);
  assert.ok(frame.floorY >= 0 && frame.floorY <= .3);
  assert.ok(frame.span < 20);
  assert.ok(frame.unitsPerMeter > 0 && frame.unitsPerMeter < 2);
});

test('reference floor follows the first dense lower band instead of sparse under-floor Gaussian tails', () => {
  const points = [
    ...Array.from({ length: 100 }, (_, i) => [i % 10, -3 + i / 100, i % 7]),
    ...Array.from({ length: 600 }, (_, i) => [i % 10, -1.7 + i % 10 / 1000, i % 7]),
    ...Array.from({ length: 1000 }, (_, i) => [i % 10, -.8 + i % 10 / 1000, i % 7]),
    ...Array.from({ length: 500 }, (_, i) => [i % 10, i % 100 / 100, i % 7]),
  ];
  const frame = roomFrame(points, new Box3(new Vector3(-3, -3, -3), new Vector3(10, 1, 7)));
  assert.ok(frame.floorY > -1.8 && frame.floorY < -1.6, String(frame.floorY));
});
