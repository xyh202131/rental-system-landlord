import { Box3, Group, Vector3 } from 'three';

export function normalizeFurniture(model, height) {
  const box = new Box3().setFromObject(model);
  const size = box.getSize(new Vector3());
  if (!Number.isFinite(size.y) || size.y <= 0) throw new Error('家具模型没有可用的尺寸。');
  model.scale.multiplyScalar(height / size.y);
  model.updateMatrixWorld(true);
  box.setFromObject(model);
  const center = box.getCenter(new Vector3());
  model.position.sub(new Vector3(center.x, box.min.y, center.z));
  const root = new Group(); root.add(model);
  return root;
}

// This is a visual placement suggestion, never a measured room scale or floor survey.
export function roomFrame(points, bounds) {
  const axes = [0, 1, 2].map(axis => points.map(p => p[axis]).filter(Number.isFinite).sort((a, b) => a - b));
  const percentile = (axis, q) => axes[axis][Math.floor((axes[axis].length - 1) * q)];
  const min = [], max = [];
  for (let axis = 0; axis < 3; axis++) {
    min.push(axes[axis].length ? percentile(axis, .02) : bounds.min.getComponent(axis));
    max.push(axes[axis].length ? percentile(axis, .98) : bounds.max.getComponent(axis));
  }
  // Pick the first dense band in the lower half. A low percentile alone can sit
  // underneath the floor because Gaussian captures often include floating tails.
  const range = Math.max(.001, max[1] - min[1]), bins = 64, histogram = new Array(bins).fill(0);
  for (const y of axes[1]) {
    const index = Math.floor((y - min[1]) / range * bins);
    if (index >= 0 && index < bins) histogram[index]++;
  }
  const lower = histogram.slice(0, Math.ceil(bins * .5));
  const peak = Math.max(...lower), band = lower.findIndex(count => count > 0 && count >= peak * .65);
  const floorY = band >= 0 ? min[1] + (band + .75) / bins * range : min[1];
  const height = Math.max(.1, max[1] - floorY);
  return { min, max, floorY, span: Math.max(.2, max[0] - min[0], max[2] - min[2]),
    unitsPerMeter: Math.min(100, Math.max(.01, height / 2.8)),
  };
}
