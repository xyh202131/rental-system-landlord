import './furnishing.css';
import { mountViewer } from './viewer.js';
import { createFurnitureStage } from './furnishing-stage.js';

const h = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const sources = { builtin_sample: '内置样例', local_import: '导入案例', reconstruction: '重建成果' };
const button = (command, text, extra = '') => `<button type="button" class="btn secondary small-btn" data-furnishing-command="${command}" ${extra}>${text}</button>`;

export function mountFurnishing(root, { api, initialRoomId, signal, onRoomChange, onError }) {
  const events = new AbortController();
  let catalog, room, layout, viewer, stage, sceneAbort, selected = '', dirty = false, saving = false, loading = true, placing = false, disposed = false;
  const $ = selector => root.querySelector(selector);
  const active = () => layout?.placements.find(item => item.id === selected);
  root.innerHTML = `<div class="notice furnishing-notice"><p><strong>本地家具试摆 · 比例示意</strong><br/>房间尚未标定真实尺寸；家具比例与地面位置可手动调整，不能据此判断实际能否放下。</p></div>
    <section class="panel furnishing-room-bar"><div><label for="furnishing-room">房间成果</label><select id="furnishing-room" disabled aria-label="选择试摆房间"></select></div><div class="furnishing-room-meta"><span id="furnishing-source" class="badge"></span><span id="layout-save-status" role="status" aria-live="polite">正在准备…</span></div></section>
    <div id="furnishing-error" class="notice warning" role="alert" hidden></div>
    <div class="furnishing-layout"><section class="panel furnishing-preview"><div class="section-heading"><h2 id="furnishing-room-title">房间预览</h2><span class="badge blue">家具试摆</span></div>
      <div id="furnishing-viewer" class="model-viewer large"><div class="viewer-loading">正在读取可用房间…</div></div><p id="furnishing-viewer-status" class="small muted" role="status"></p>
      <div class="furnishing-preview-actions">${button('place', '点选落位', 'aria-pressed="false" disabled')}${button('focus', '聚焦家具', 'disabled')}${button('ground', '贴到地面', 'disabled')}<label><input id="furnishing-grid" type="checkbox"/>显示参考网格</label><label><input id="furnishing-xray" type="checkbox" checked/>辅助透显家具</label></div>
      <p id="furnishing-visibility-hint" class="small muted">辅助透显已开启：家具优先显示，方便定位；关闭后查看原始点云遮挡。</p>
      <p id="furnishing-place-hint" class="small muted">选择一件家具后，可点选地面放置，也可在右侧微调位置。</p>
      <details class="furnishing-floor"><summary>调整参考地面</summary><p class="small muted">自动建议可能落在家具或伪影上。这里调整的是参考平面，不是实测地面。</p><label for="furnishing-floor">地面高度（场景单位）</label><input id="furnishing-floor" type="number" min="-10000" max="10000" step="0.01" disabled/></details>
    </section><aside class="furnishing-sidebar"><section class="panel"><div class="section-heading"><h2>家具库</h2><span class="muted small">本地模型</span></div><div id="furnishing-library" class="furnishing-library"></div><p class="small muted form-hint">示例家具来自实验材料；尺寸为估计值。最多摆放 20 件，可重复添加。</p></section>
      <section class="panel"><div class="section-heading"><h2>当前布局 <span id="furnishing-count" class="count">0</span></h2>${button('clear', '清空', 'disabled')}</div><div id="furnishing-instances" class="furnishing-instances"></div>
        <fieldset id="furnishing-editor" disabled><legend class="sr-only">调整选中的家具</legend><h3 id="furnishing-selection">选择家具以调整</h3><div class="furnishing-position">
          <label>X 位置<input id="furnishing-x" type="number" step="0.01" min="-10000" max="10000"/></label>
          <label>Z 位置<input id="furnishing-z" type="number" step="0.01" min="-10000" max="10000"/></label>
          <label>离地高度<input id="furnishing-y" type="number" step="0.01" min="-10000" max="10000"/></label></div>
          <label for="furnishing-rotation">旋转 <output id="furnishing-rotation-value">0°</output></label><input id="furnishing-rotation" type="range" min="-180" max="180" step="1" value="0"/>
          <label for="furnishing-scale">相对比例 <output id="furnishing-scale-value">1.00×</output></label><input id="furnishing-scale" type="range" min="0.05" max="8" step="0.05" value="1"/>
          <p class="small muted">位置与高度使用场景单位，未换算为米。</p><div class="furnishing-editor-actions">${button('reset', '重置位置')}${button('remove', '移除家具')}</div></fieldset>
        <div class="furnishing-save-actions"><button type="button" class="btn primary full" data-furnishing-command="save" disabled>保存布局</button>${button('reload', '重新载入已保存布局', 'disabled')}</div>
      </section></aside></div>`;

  function message(text = '') { const el = $('#furnishing-error'); el.textContent = text; el.hidden = !text; }
  function report(error) {
    if (disposed || signal.aborted || error.name === 'AbortError') return;
    message(error.message || '试摆未完成，请重试。');
    if (error.status === 401) onError(error);
  }
  function updateControls() {
    if (disposed) return;
    const busy = loading || saving;
    $('#furnishing-room').disabled = busy || !catalog?.rooms.length;
    $('#furnishing-editor').disabled = busy || !stage || !active();
    $('#furnishing-floor').disabled = busy || !stage;
    $('#furnishing-grid').disabled = busy || !stage;
    $('#furnishing-xray').disabled = busy || !stage;
    root.querySelectorAll('[data-furnishing-command]').forEach(el => {
      const command = el.dataset.furnishingCommand;
      if (command === 'reload') { el.disabled = busy || !room; return; }
      el.disabled = busy || !stage ||
        (command === 'save' && !dirty) ||
        (['focus', 'place', 'ground', 'reset', 'remove'].includes(command) && !active()) ||
        (command === 'clear' && !layout?.placements.length) ||
        (command === 'add' && (!catalog?.furniture.find(item => item.id === el.dataset.asset)?.available || layout?.placements.length >= 20));
    });
    root.querySelectorAll('[data-placement]').forEach(el => { el.disabled = busy || !stage; });
    const status = $('#layout-save-status');
    status.textContent = loading ? '正在载入…' : saving ? '正在保存…' : dirty ? '有未保存的调整' : layout?.updated ? '布局已保存到本机' : '首次试摆 · 尚未保存';
    status.classList.toggle('furnishing-dirty', dirty);
  }
  function changed() { dirty = true; message(); updateControls(); }
  function select(id) { selected = id; stage?.select(id); renderInstances(); }
  function renderInstances() {
    const placements = layout?.placements || [];
    $('#furnishing-count').textContent = placements.length;
    $('#furnishing-instances').innerHTML = placements.length ? placements.map((item, i) => `<button type="button" data-placement="${h(item.id)}" aria-pressed="${item.id === selected}"><span>${h(catalog.furniture.find(a => a.id === item.assetId)?.name || '家具')} <small>#${i + 1}</small></span><span>${item.id === selected ? '已选中' : '选择'}</span></button>`).join('') : '<p class="furnishing-empty">还没有家具。<br/>从上方家具库添加一件试试。</p>';
    syncEditor(); updateControls();
  }
  function syncEditor() {
    const item = active();
    $('#furnishing-selection').textContent = item ? catalog.furniture.find(a => a.id === item.assetId)?.name || '家具' : '选择家具以调整';
    if (!item) return;
    const values = { x: item.position[0], y: item.position[1] - (layout.floorY ?? stage?.frame.floorY ?? 0), z: item.position[2],
      rotation: item.rotationY * 180 / Math.PI, scale: item.scale };
    for (const [key, value] of Object.entries(values)) {
      const input = $(`#furnishing-${key}`);
      if (document.activeElement !== input) input.value = Number(value.toFixed(key === 'rotation' ? 0 : 3));
    }
    $('#furnishing-rotation-value').textContent = `${Math.round(values.rotation)}°`;
    $('#furnishing-scale-value').textContent = `${values.scale.toFixed(2)}×`;
  }
  function closeScene() { sceneAbort?.abort(); stage?.dispose(); viewer?.dispose(); stage = null; viewer = null; }
  async function loadRoom(id) {
    if (saving || loading && room) return;
    if (dirty && !confirm('当前布局尚未保存，放弃这些调整并重新载入？')) { $('#furnishing-room').value = room.id; return; }
    closeScene();
    loading = true; dirty = false; selected = ''; placing = false; message(); updateControls();
    $('[data-furnishing-command="place"]').setAttribute('aria-pressed', 'false');
    $('#furnishing-place-hint').textContent = '选择一件家具后，可点选地面放置，也可在右侧微调位置。';
    sceneAbort = new AbortController();
    const sceneSignal = AbortSignal.any([signal, sceneAbort.signal]);
    $('#furnishing-viewer-status').textContent = '';
    $('#furnishing-viewer').innerHTML = '<div class="viewer-loading">正在准备房间…</div>';
    try {
      const data = await api(`/api/furnishing/rooms/${id}`, { signal: sceneSignal });
      sceneSignal.throwIfAborted(); room = data.room; layout = data.layout;
      $('#furnishing-room').value = room.id;
      $('#furnishing-room-title').textContent = room.title;
      $('#furnishing-source').textContent = sources[room.sourceType];
      onRoomChange(room.id);
      viewer = await mountViewer($('#furnishing-viewer'), room.modelUrl, { upAxis: room.upAxis, initialView: room.initialView, format: room.format,
        signal: sceneSignal, onStatus: text => { if (!sceneSignal.aborted) $('#furnishing-viewer-status').textContent = text; } });
      sceneSignal.throwIfAborted();
      $('#furnishing-viewer .viewer-model-tag').textContent = '房间 + 家具';
      stage = createFurnitureStage(viewer, catalog.furniture, { signal: sceneSignal, onSelect: select,
        onPlace: (placementId, point) => {
          if (loading || saving) return;
          const item = layout.placements.find(p => p.id === placementId);
          if (!item) return;
          item.position = point; stage.update(item); changed(); syncEditor();
        } });
      stage.setFloor(layout.floorY ?? stage.frame.floorY);
      $('#furnishing-floor').value = (layout.floorY ?? stage.frame.floorY).toFixed(3);
      stage.setGrid($('#furnishing-grid').checked);
      stage.setXray($('#furnishing-xray').checked);
      const errors = [];
      for (const item of layout.placements) {
        try { await stage.add(item); }
        catch (error) { sceneSignal.throwIfAborted(); errors.push(error.message); }
      }
      sceneSignal.throwIfAborted();
      select(layout.placements[0]?.id || '');
      if (errors.length) message(`布局已保留，但有 ${errors.length} 件家具未加载：${errors[0]}。可移除或恢复模型后重新载入。`);
      $('#furnishing-viewer-status').textContent = '房间已载入 · 可移动查看；参考地面与家具比例均为示意';
    } catch (error) {
      if (!sceneSignal.aborted) {
        closeScene(); report(error);
        $('#furnishing-viewer').classList.remove('viewer-enhanced');
        $('#furnishing-viewer').innerHTML = '<div class="viewer-loading">房间未能加载，请检查本地模型后重新载入。</div>';
      }
    } finally { if (!signal.aborted && !disposed) { loading = false; renderInstances(); } }
  }
  async function command(name, el) {
    if (loading || saving) return;
    if (name === 'reload') return loadRoom(room.id);
    if (!stage) return;
    if (name === 'save') {
      saving = true; updateControls(); message();
      try {
        const data = await api(`/api/furnishing/rooms/${room.id}/layout`, { method: 'PUT',
          data: { sceneVersion: room.sceneVersion, revision: layout.revision, floorY: layout.floorY ?? stage.frame.floorY, placements: layout.placements },
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
        if (disposed) return;
        layout = data.layout; dirty = false;
      } catch (error) { report(error); }
      finally { saving = false; updateControls(); }
      return;
    }
    if (name === 'add') {
      if (layout.placements.length >= 20) return;
      loading = true; updateControls();
      try {
        const item = { id: crypto.randomUUID(), assetId: el.dataset.asset, position: stage.suggestedPosition(), rotationY: 0, scale: 1 };
        await stage.add(item); signal.throwIfAborted();
        layout.placements.push(item); select(item.id); changed();
      } finally { loading = false; updateControls(); }
      return;
    }
    if (name === 'clear') {
      if (!confirm('清空当前房间的家具布局？保存后才会更新本机记录。')) return;
      layout.placements.forEach(item => stage.remove(item.id)); layout.placements = []; selected = ''; renderInstances(); changed(); return;
    }
    const item = active(); if (!item) return;
    if (name === 'place') {
      placing = !placing; stage.setPlacing(placing); el.setAttribute('aria-pressed', String(placing));
      $('#furnishing-place-hint').textContent = placing ? '点击参考地面放置选中家具；拖动可继续转动视角。放好后再次点击“点选落位”结束。' : '选择一件家具后，可点选地面放置，也可在右侧微调位置。';
      return;
    }
    if (name === 'focus') {
      const focusedViewer = viewer;
      stage.focus(item.id); await focusedViewer.whenSettled();
      if (!disposed && viewer === focusedViewer) $('#furnishing-viewer-status').textContent = '已聚焦选中家具 · 可拖动查看细节，初始点可返回房间视角';
      return;
    }
    if (name === 'ground') item.position[1] = layout.floorY ?? stage.frame.floorY;
    if (name === 'reset') { item.position = stage.suggestedPosition(); item.rotationY = 0; item.scale = 1; }
    if (name === 'remove') { stage.remove(item.id); layout.placements = layout.placements.filter(p => p.id !== item.id); select(layout.placements[0]?.id || ''); }
    else { stage.update(item); syncEditor(); }
    changed();
  }
  root.addEventListener('click', event => {
    const el = event.target.closest('[data-furnishing-command], [data-placement]');
    if (!el || el.disabled) return;
    if (el.dataset.placement) select(el.dataset.placement);
    else command(el.dataset.furnishingCommand, el).catch(report);
  }, { signal: events.signal });
  root.addEventListener('input', event => {
    if (loading || saving || !stage || !active()) return;
    const input = event.target, value = input.valueAsNumber, item = active();
    if (!Number.isFinite(value) || !input.validity.valid) return;
    const key = input.id.replace('furnishing-', '');
    if (key === 'x') item.position[0] = value;
    else if (key === 'z') item.position[2] = value;
    else if (key === 'y') item.position[1] = (layout.floorY ?? stage.frame.floorY) + value;
    else if (key === 'rotation') item.rotationY = value * Math.PI / 180;
    else if (key === 'scale') item.scale = value;
    else return;
    stage.update(item); changed(); syncEditor();
  }, { signal: events.signal });
  root.addEventListener('change', event => {
    const input = event.target;
    if (input.id === 'furnishing-room') { loadRoom(input.value).catch(report); return; }
    if (input.id === 'furnishing-grid') { stage?.setGrid(input.checked); return; }
    if (input.id === 'furnishing-xray') {
      stage?.setXray(input.checked);
      $('#furnishing-visibility-hint').textContent = input.checked ? '辅助透显已开启：家具优先显示，方便定位；关闭后查看原始点云遮挡。' : '辅助透显已关闭：按场景深度显示，点云伪影可能遮住家具。';
      return;
    }
    if (input.id === 'furnishing-floor' && stage && !loading && !saving) {
      if (!input.validity.valid || !Number.isFinite(input.valueAsNumber)) return;
      const next = input.valueAsNumber, delta = next - (layout.floorY ?? stage.frame.floorY);
      layout.floorY = next; stage.setFloor(next);
      layout.placements.forEach(item => { item.position[1] += delta; stage.update(item); }); changed(); syncEditor();
    }
  }, { signal: events.signal });
  function dispose() { if (disposed) return; disposed = true; events.abort(); signal.removeEventListener('abort', dispose); closeScene(); }
  signal.addEventListener('abort', dispose, { once: true });
  (async () => {
    catalog = await api('/api/furnishing/rooms', { signal }); signal.throwIfAborted();
    $('#furnishing-room').innerHTML = catalog.rooms.map(item => `<option value="${h(item.id)}">${h(item.title)} · ${sources[item.sourceType]}</option>`).join('');
    $('#furnishing-library').innerHTML = catalog.furniture.map(item => `<article><span class="furnishing-asset-icon" aria-hidden="true">${item.id === 'plant' ? '♧' : '◇'}</span><div><h3>${h(item.name)}</h3><p>${h(item.description)}</p><small>参考高度 ${item.heightMm} mm · 估计</small></div>${button('add', item.available ? '添加' : '未准备', `data-asset="${h(item.id)}" disabled`)}</article>`).join('');
    if (!catalog.rooms.length) {
      loading = false; updateControls(); $('#furnishing-viewer').innerHTML = '<div class="viewer-loading">暂无可用房间，请先在“重建样例”导入 PLY/SPZ，或完成一次重建。</div>'; return;
    }
    await loadRoom(catalog.rooms.find(item => item.id === initialRoomId)?.id || catalog.rooms[0].id);
  })().catch(report);
  return { dispose, get hasUnsavedChanges() { return dirty; }, get busy() { return saving; } };
}
