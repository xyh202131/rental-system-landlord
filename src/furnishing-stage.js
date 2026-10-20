import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { normalizeFurniture, roomFrame } from './furnishing-geometry.js';

function disposeModel(root) {
  const resources = new Set();
  root.traverse(node => {
    if (node.geometry) resources.add(node.geometry);
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials.filter(Boolean)) {
      resources.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
    }
  });
  const images = new Set();
  for (const resource of resources) { if (resource.isTexture && typeof resource.image?.close === 'function') images.add(resource.image); resource.dispose(); }
  images.forEach(bitmap => bitmap.close());
}

export function createFurnitureStage(viewer, furniture, { signal, onPlace, onSelect }) {
  let disposed = false, placing = false, selected = '', pointerStart, xray = true;
  const instances = new Map(), templates = new Map();
  const points = [], packed = viewer.splat.packedSplats;
  if (packed) {
    const count = packed.getNumSplats(), step = Math.max(1, Math.ceil(count / 20000));
    for (let i = 0; i < count; i += step) {
      const point = packed.getSplat(i);
      if (point.opacity < .3) continue;
      points.push(point.center.clone().applyMatrix4(viewer.splat.matrixWorld).toArray());
    }
  }
  const frame = roomFrame(points, viewer.bounds);
  let floorY = frame.floorY;
  const lights = [new THREE.HemisphereLight(0xffffff, 0xa1a9b6, 2.2), new THREE.DirectionalLight(0xffffff, 2)];
  lights[1].position.set(3, 7, 4); lights.forEach(light => { light.layers.enable(1); viewer.scene.add(light); });
  const grid = new THREE.GridHelper(frame.span * 1.2, 20, 0x7d9ac1, 0xb6c6da);
  grid.position.set((frame.min[0] + frame.max[0]) / 2, floorY, (frame.min[2] + frame.max[2]) / 2);
  grid.material.transparent = true; grid.material.opacity = .35; grid.visible = false; viewer.scene.add(grid);
  const outline = new THREE.BoxHelper(new THREE.Object3D(), 0x315cce);
  outline.layers.set(1); outline.material.depthTest = false; outline.renderOrder = 20;
  outline.visible = false; viewer.scene.add(outline);
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  raycaster.layers.enable(1);
  const events = new AbortController();
  const abort = () => events.abort();
  signal.addEventListener('abort', abort, { once: true });
  // Auxiliary visibility is explicit in the UI. A second depth pass keeps GLB
  // surfaces crisp when foreground Gaussian floaters obscure the placement.
  const removePass = viewer.addRenderPass(renderer => {
    if (!xray || !instances.size) return;
    const mask = viewer.camera.layers.mask, autoClear = renderer.autoClear;
    try {
      renderer.autoClear = false; renderer.clearDepth(); viewer.camera.layers.set(1);
      renderer.render(viewer.scene, viewer.camera);
    } finally { viewer.camera.layers.mask = mask; renderer.autoClear = autoClear; }
  });
  function setLayers(root) { root.traverse(node => node.layers.set(xray ? 1 : 0)); }

  function select(id) {
    selected = id;
    const root = instances.get(id);
    outline.visible = Boolean(root);
    if (root) outline.setFromObject(root);
  }
  async function template(assetId) {
    if (!templates.has(assetId)) templates.set(assetId, (async () => {
      const asset = furniture.find(item => item.id === assetId && item.available);
      if (!asset) throw new Error('本机缺少这件家具模型，请恢复模型文件后重试。');
      const response = await fetch(asset.url, { signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error(`家具读取失败（${response.status}）。`);
      const buffer = await response.arrayBuffer(); signal.throwIfAborted();
      const manager = new THREE.LoadingManager(), failures = [];
      manager.onError = url => failures.push(url);
      const gltf = await new GLTFLoader(manager).parseAsync(buffer, '');
      if (disposed || signal.aborted) { disposeModel(gltf.scene); throw new DOMException('试摆已关闭', 'AbortError'); }
      if (failures.length) { disposeModel(gltf.scene); throw new Error('家具纹理未能读取，请重试或恢复本地模型文件。'); }
      return normalizeFurniture(gltf.scene, asset.heightMm / 1000 * frame.unitsPerMeter);
    })().catch(error => { templates.delete(assetId); throw error; }));
    return templates.get(assetId);
  }
  async function add(placement) {
    const source = await template(placement.assetId);
    signal.throwIfAborted();
    if (disposed) throw new DOMException('试摆已关闭', 'AbortError');
    const root = source.clone(true);
    setLayers(root);
    root.userData.placementId = placement.id;
    instances.set(placement.id, root); viewer.scene.add(root); update(placement);
  }
  function update(placement) {
    const root = instances.get(placement.id);
    if (!root) return;
    root.position.fromArray(placement.position); root.rotation.y = placement.rotationY; root.scale.setScalar(placement.scale);
    root.updateMatrixWorld(true); if (selected === placement.id) outline.setFromObject(root);
  }
  function suggestedPosition() {
    const direction = viewer.camera.getWorldDirection(new THREE.Vector3()); direction.y = 0;
    if (direction.lengthSq() < .001) direction.set(0, 0, -1);
    direction.normalize().multiplyScalar(Math.min(2, Math.max(.2, frame.span * .12)));
    const point = viewer.camera.position.clone().add(direction);
    return [THREE.MathUtils.clamp(point.x, frame.min[0], frame.max[0]), floorY,
      THREE.MathUtils.clamp(point.z, frame.min[2], frame.max[2])];
  }
  function focus(id) {
    const root = instances.get(id);
    if (!root) return;
    const box = new THREE.Box3().setFromObject(root), center = box.getCenter(new THREE.Vector3());
    const distance = Math.max(.15, box.getSize(new THREE.Vector3()).length() * 1.6);
    const damping = viewer.controls.enableDamping; viewer.controls.enableDamping = false; viewer.controls.update();
    viewer.controls.target.copy(center); viewer.camera.position.copy(center).add(new THREE.Vector3(.7, .35, 1).multiplyScalar(distance));
    viewer.camera.lookAt(center); viewer.controls.update(); viewer.controls.enableDamping = damping;
  }
  viewer.canvas.addEventListener('pointerdown', event => {
    if (event.isPrimary && event.button === 0) pointerStart = { x: event.clientX, y: event.clientY };
  }, { signal: events.signal });
  viewer.canvas.addEventListener('pointercancel', () => { pointerStart = null; }, { signal: events.signal });
  viewer.canvas.addEventListener('pointerup', event => {
    if (!event.isPrimary || !pointerStart) return;
    const start = pointerStart; pointerStart = null;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
    const rect = viewer.canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, viewer.camera);
    if (placing && selected) {
      const point = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY), new THREE.Vector3());
      if (point && point.x >= frame.min[0] && point.x <= frame.max[0] && point.z >= frame.min[2] && point.z <= frame.max[2]) onPlace(selected, point.toArray());
      return;
    }
    const hit = raycaster.intersectObjects([...instances.values()], true)[0];
    if (hit) { let root = hit.object; while (root && !root.userData.placementId) root = root.parent; if (root) onSelect(root.userData.placementId); }
  }, { signal: events.signal });
  return { frame, add, update, select, focus, suggestedPosition,
    setXray(value) { xray = value; instances.forEach(setLayers); outline.layers.set(xray ? 1 : 0); },
    setFloor(value) { floorY = value; grid.position.y = value; },
    setGrid(value) { grid.visible = value; },
    setPlacing(value) { placing = value; viewer.canvas.classList.toggle('furnishing-placing', value); },
    remove(id) { const root = instances.get(id); if (root) viewer.scene.remove(root); instances.delete(id); if (selected === id) select(''); },
    dispose() {
      if (disposed) return;
      disposed = true; events.abort(); signal.removeEventListener('abort', abort); removePass();
      instances.forEach(root => viewer.scene.remove(root)); instances.clear();
      templates.forEach(promise => promise.then(disposeModel).catch(() => {})); templates.clear();
      lights.forEach(light => viewer.scene.remove(light));
      viewer.scene.remove(grid, outline); grid.geometry.dispose(); grid.material.dispose(); outline.geometry.dispose(); outline.material.dispose();
    },
  };
}
