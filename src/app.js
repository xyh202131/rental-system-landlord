import './style.css';
import { CaptureCamera } from './camera.js';
import { openSampleImport } from './sample-import.js';

const $ = selector => document.querySelector(selector);
const h = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const paths = {
  home: '<path d="m3 10 9-7 9 7v11H3Z"/><path d="M9 21v-8h6v8"/>',
  camera: '<path d="M4 7h4l2-3h4l2 3h4v14H4Z"/><circle cx="12" cy="13" r="4"/>',
  cube: '<path d="m12 2 9 5v10l-9 5-9-5V7Z"/><path d="m3 7 9 5 9-5M12 12v10M7 4.7l10 5.6"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  check: '<path d="m5 12 5 5L20 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  folder: '<path d="M3 6h7l2 3h9v11H3Z"/><path d="M3 6V4h7l2 2h9v3"/>',
  logout: '<path d="M9 3H4v18h5M10 12h11m-5-5 5 5-5 5"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6Z"/><path d="m8 12 3 3 5-6"/>',
  scan: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M6 12h12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v2"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  edit: '<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5ZM13 20h8"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.info}</svg>`;
const button = (action, label, name = '', cls = 'secondary', extra = '') => `<button class="btn ${cls}" data-action="${action}" ${extra}>${name ? icon(name) : ''}${label}</button>`;
const date = value => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const bytes = value => value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const state = { user: null, csrf: '', config: {}, view: 'home', drafts: [], draft: null, camera: null, viewer: null, sampleId: null, pending: [], uploading: false, cameraState: {}, target: '', id: { front: null, back: null, property: null, busy: false, scenario: 'pass', generation: 0 }, mediaFilter: 'all' };
let viewerAbort = null;
function closeViewer() {
  viewerAbort?.abort(); viewerAbort = null;
  state.furnishing?.dispose(); state.furnishing = null;
  state.viewer?.dispose(); state.viewer = null;
}
function furnishingHash() { return /^#\/furnishing\/([a-zA-Z0-9-]+)$/.exec(location.hash)?.[1] || null; }
function canLeaveFurnishing() {
  if (state.furnishing?.busy) throw new Error('布局正在保存，请稍候再离开。');
  return !state.furnishing?.hasUnsavedChanges || confirm('家具布局尚未保存，离开会放弃当前调整。继续离开？');
}
async function initialView() {
  state.furnishingRoomId = furnishingHash();
  return navigate(state.furnishingRoomId ? 'furnishing' : 'home');
}
const documentLabels = { front: '身份证人像面', back: '身份证国徽面', property: '房产证' };
const isVerified = () => state.user?.verification?.status === 'passed';
function verificationBadge() {
  const status = state.user?.verification?.status;
  return `<span class="badge ${status === 'passed' ? 'green' : status === 'failed' ? 'red' : ''}">${status === 'passed' ? '已通过 · Mock' : status === 'failed' ? '核验未通过' : '未核验'}</span>`;
}
async function refreshAccount() { const session = await api('/api/session'); state.user = session.user; state.csrf = session.csrf; }
let toastTimer, renderGeneration = 0;
function toast(message) { const el = $('#toast'); el.textContent = message; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 5500); }
async function api(path, { method = 'GET', data, blob, meta, signal } = {}) {
  const headers = {};
  if (method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (blob) { headers['Content-Type'] = blob.type; headers['X-Capture-Meta'] = encodeURIComponent(JSON.stringify(meta)); }
  const res = await fetch(path, { method, headers, body: blob || (data === undefined ? undefined : JSON.stringify(data)), credentials: 'same-origin', signal });
  let result;
  try { result = await res.json(); } catch { throw new Error('本机服务响应异常，请保留页面并重试。'); }
  if (!res.ok) throw Object.assign(new Error(result.error || '操作未完成。'), { status: res.status, code: result.code });
  return result;
}
async function handleError(error) {
  if (error.code === 'VERIFICATION_REQUIRED' && state.user) {
    $('#dialog')?.close();
    try {
      await refreshAccount();
      if (state.camera) { state.camera.remoteEnabled = false; try { await state.camera.close(); } catch { /* Keep unsaved captures in memory while re-verifying. */ } state.camera = null; }
      state.cameraState = {};
      await navigate('account');
    } catch (next) { if (next.status === 401) return handleError(next); toast(next.message); return; }
  }
  toast(error.message || '操作未完成，请重试。');
  if (error.status === 401 && state.user) {
    state.sampleImport?.close();
    $('#dialog')?.close();
    if (state.camera) { state.camera.remoteEnabled = false; try { await state.camera.close(); } catch { /* Pending captures are retained for re-login. */ } state.camera = null; }
    state.user = null; clearIdentity(); renderLogin('登录已过期。已保存草稿仍然保留，请重新登录。');
  }
}
function clearIdentity() {
  for (const side of Object.keys(documentLabels)) { if (state.id[side]?.url.startsWith('blob:')) URL.revokeObjectURL(state.id[side].url); }
  state.id = { front: null, back: null, property: null, busy: false, scenario: 'pass', generation: state.id.generation + 1 };
}
function roomIllustration() {
  return `<svg class="room-art" viewBox="0 0 560 360" fill="none" aria-hidden="true">
  <path d="m52 255 225 95 230-122-225-91Z" fill="#e8edf5"/><path d="M75 245V110l204-80v142Z" fill="#dce6f5"/><path d="m279 30 203 96v139l-203-93Z" fill="#eef3f9"/>
  <path d="M101 222V123l105-41v98Z" fill="#f8fbff" stroke="#bacde6" stroke-width="3"/><path d="m152 103 1 98m-52-31 104-41" stroke="#cfdbed" stroke-width="4"/>
  <path d="m291 172 106 46v42l-106-46Z" fill="#cad7e9"/><path d="m282 188 100 45 49-24-100-44Z" fill="#fff"/>
  <path d="m163 216 86-41 116 52-86 44Z" fill="#89a9d8"/><path d="m163 216 1 37 115 52v-34Z" fill="#5e85bd"/><path d="m279 271 86-44v37l-86 41Z" fill="#7396c9"/>
  <path d="m160 212 9-15 115 53-5 21Z" fill="#aec4e2"/><path d="m173 199 71-35 10 17-74 36Z" fill="#a3bddd"/>
  <path d="M437 259v-59" stroke="#607c74" stroke-width="5"/><ellipse cx="436" cy="266" rx="20" ry="11" fill="#b9cfc3"/><path d="M418 262v27q18 14 36-2v-25" fill="#d4dfd8"/>
  <ellipse cx="424" cy="215" rx="11" ry="26" transform="rotate(-30 424 215)" fill="#8faf9c"/><ellipse cx="447" cy="202" rx="12" ry="27" transform="rotate(25 447 202)" fill="#a4c0ad"/>
  <path d="M46 144v-34h34m386-43h35v35M50 293v29h34m386-15h34v-34" stroke="#537bd1" stroke-width="2" stroke-linecap="round"/>
  <path d="m63 243 220-91 221 101" stroke="#7d9de1" stroke-width="1.5" stroke-dasharray="5 7"/><circle cx="284" cy="153" r="5" fill="#315cce"/>
  </svg>`;
}
function brand() { return `<a href="#" class="brand" data-action="home"><img src="/icon.svg" width="40" height="40" alt=""/><span>房东采集台<small>RENTAL SPACE</small></span></a>`; }
function renderLogin(error = '') {
  closeViewer();
  renderGeneration++;
  $('#app').innerHTML = `<div class="login-page"><header class="login-header">${brand()}<span class="quiet-tag">房东端 · MVP</span></header>
    <main class="login-grid"><section class="login-story"><span class="eyebrow">从现场，到空间</span><h1>让房屋的每一面，<br/>都有迹可循。</h1><p>跟随指导完成现场采集，<br/>把真实细节留给每一次远程看房。</p><div class="art-wrap">${roomIllustration()}<span class="art-label">SPACE CAPTURE / 01</span></div><div class="story-foot"><span>${icon('camera')} 实时采集</span><span>${icon('folder')} 随时暂存</span><span>${icon('cube')} 空间预览</span></div></section>
    <section class="login-card"><span class="eyebrow">欢迎回来</span><h2>登录你的采集台</h2><p class="muted">从一次清晰、完整的房屋记录开始。</p><form id="login-form"><label for="username">账号</label><input id="username" name="username" autocomplete="username" maxlength="60" placeholder="输入房东账号" value="landlord" required/><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" placeholder="输入登录密码" required/><p id="login-error" class="error" role="alert">${h(error)}</p><button class="btn primary full" type="submit">登录并继续 ${icon('arrow')}</button></form><div class="local-note">${icon('shield')}<p>本机体验账号已预置。<br/><span>首次登录信息见项目的 <code>.data/local-login.txt</code>。</span></p></div>${state.pending.length ? '<p class="error">有未保存素材保留在当前页面，请使用原账号重新登录后重试。</p>' : ''}</section></main><footer class="login-footer">租房系统 · 房东端 <span>真实采集，清晰记录。</span></footer></div>`;
}
const stepLabels = ['现场采集', '拍后复查', '空间成果'];
function stepIndex() { return ({ capture: 0, review: 1, result: 2 })[state.view] ?? -1; }
function shell(content) {
  $('#toast').hidden = true;
  const step = stepIndex();
  $('#app').innerHTML = `<div class="app-shell"><aside class="sidebar">${brand()}<div class="nav-caption">工作空间</div><nav aria-label="主导航">${button('home', '我的采集', 'folder', state.view === 'home' ? 'nav active' : 'nav')}${button('sample', '重建样例', 'cube', state.view === 'sample' ? 'nav active' : 'nav')}${button('furnishing', '家具试摆', 'home', state.view === 'furnishing' ? 'nav active' : 'nav')}${button('account', '用户中心', 'shield', state.view === 'account' ? 'nav active' : 'nav')}</nav><div class="sidebar-bottom"><span class="connection-dot"></span><span>本机工作空间<small>素材保存在当前服务</small></span></div></aside><div class="app-main"><header class="topbar"><div class="breadcrumb">房东端 <span>/</span> ${h(state.view === 'home' ? '我的采集' : state.view === 'sample' ? '重建样例' : state.view === 'furnishing' ? '家具试摆' : state.view === 'account' ? '用户中心' : stepLabels[step])}</div><div class="account"><button class="account-link" data-action="account" aria-label="用户中心，查看核验状态"><span class="avatar">房</span><span class="account-name">${h(state.user.username)}</span>${verificationBadge()}</button>${button('logout', '<span class="logout-text">退出</span>', 'logout', 'icon-button', 'aria-label="退出登录"')}</div></header><main class="content">${step >= 0 ? `<div class="stepper" aria-label="采集步骤">${stepLabels.map((label, i) => `<div class="step ${i === step ? 'current' : i < step ? 'done' : ''}" ${i === step ? 'aria-current="step"' : ''}><span>${i < step ? icon('check') : `0${i + 1}`}</span><strong>${label}</strong></div>`).join('')}</div>` : ''}${content}</main><footer class="app-footer">租房系统 · 房东端 <span>本地 MVP / v0.2</span></footer></div></div>`;
}
function heading(kicker, title, subtitle, actions = '') { return `<div class="page-heading"><div><span class="eyebrow">${kicker}</span><h1>${title}</h1><p>${subtitle}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</div>`; }
function draftStatus(d) { if (!d.media_count && !d.media?.length) return '待拍摄'; if (d.confirmed_revision === d.revision) return '已人工复核'; if (d.review_revision === d.revision) return '待人工复核'; return '采集草稿'; }
function renderHome() {
  const drafts = state.drafts, verified = isVerified();
  shell(`${heading('房屋采集工作空间', '每一次记录，都从现场开始。', '创建一次房间采集，或从上次保存的位置继续。', button(verified ? 'new' : 'account', verified ? '开始新采集' : '前往用户中心核验', verified ? 'plus' : 'shield', 'primary'))}
  ${!verified ? `<div class="notice warning verification-gate">${icon('shield')}<p><strong>完成证件核验后，即可开始采集。</strong><br/>请在用户中心补齐身份证两面与房产证。未通过时，新建与继续采集暂不可用；已有记录会保留。</p></div>` : ''}<section class="home-hero"><div><span class="soft-label">你的现场采集助手</span><h2>拍得清楚，<br/>才能看得真实。</h2><p>实时拍摄 · 弹幕指导 · 拍后复查<br/>把房间全貌和重要细节，一起留下。</p><div class="hero-actions">${button(verified ? 'new' : 'account', verified ? (drafts.length ? '开始新的采集' : '创建我的第一次采集') : '完成核验，开启采集', verified ? 'arrow' : 'shield', 'primary')}${button('sample', '先看看重建样例', '', 'text-button')}</div></div><div class="hero-art">${roomIllustration()}</div></section>
  <section class="journey-strip" aria-label="采集流程">${[['camera','01','现场采集','在相机里完成照片或录像'],['scan','02','拍后复查','回看素材，补拍并人工确认'],['cube','03','空间成果','查看成果，对照实拍细节']].map(([i,n,t,d])=>`<div><span class="journey-icon">${icon(i)}</span><p><small>${n} / ${t}</small><strong>${d}</strong></p></div>`).join('')}</section>
  <section class="drafts-section"><div class="section-heading"><h2>最近的采集 <span class="count">${drafts.length}</span></h2><span class="muted small">按最近保存时间排序</span></div>${drafts.length ? `<div class="draft-grid">${drafts.map(d=>`<article class="draft-card"><div class="draft-icon">${icon('home')}</div><div class="draft-title"><h3>${h(d.property)}</h3><span class="badge">${draftStatus(d)}</span></div><p class="muted">${h(d.room)} · ${d.media_count} 份素材</p><div class="draft-bottom"><span>${icon('clock')} ${date(d.updated)}</span>${button(verified ? 'resume' : 'account', verified ? '继续采集' : '核验后继续', verified ? 'arrow' : 'shield', 'text-button', `data-id="${d.id}"`)}</div></article>`).join('')}</div>` : `<div class="empty-drafts">${icon('folder')}<h3>还没有采集记录</h3><p>拍摄完成后自动保存到本机，下次回来可以接着拍。</p>${button(verified ? 'new' : 'account', verified ? '创建采集' : '前往核验', verified ? 'plus' : 'shield', 'secondary')}</div>`}</section>`);
}
function idCard(side) {
  const selected = state.id[side], title = documentLabels[side];
  return `<article class="identity-card ${side === 'property' ? 'property-certificate' : ''}"><div class="section-heading"><h2>${title}</h2><span class="badge ${selected ? 'blue' : ''}">${selected ? '已选择' : '待选择'}</span></div><label class="upload-zone" for="id-${side}">${selected ? `<img src="${h(selected.url)}" alt="${title}测试图片预览"/>` : `${icon(side === 'property' ? 'home' : 'shield')}<strong>选择${title}图片</strong><small>JPG / PNG / WebP，单张不超过 8 MB</small>`}</label><input class="file-input" id="id-${side}" type="file" accept="image/jpeg,image/png,image/webp" data-side="${side}" aria-label="${title}测试图片"/><div class="card-links">${button('id-example', '使用示例图片', '', 'text-button', `data-side="${side}"`)}${selected ? button('id-remove', '移除', '', 'text-button danger-text', `data-side="${side}"`) : ''}</div></article>`;
}
function renderAccount() {
  const verification = state.user.verification, passed = isVerified(), busy = state.id.busy;
  const messages = { glare: '身份证人像面存在模拟反光，请重新选择或切换场景后重试。', edge: '身份证国徽面模拟边角缺失，请重新选择或切换场景后重试。', property: '房产证信息页模拟不完整，请补齐后重新核验。', failed: '模拟核验服务失败，请稍后重试。' };
  const feedback = busy ? '正在处理，请稍候…' : messages[verification.result] || '请补齐身份证人像面、国徽面和房产证，再提交模拟核验。';
  shell(`${heading('账号与核验', '用户中心', '在这里完成证件核验，通过后开启房屋采集。')}
    <section class="panel profile-strip"><div class="profile-account"><span class="avatar">房</span><div><h2>${h(state.user.username)}</h2><p>房东账号 · 本机工作空间</p></div></div><div class="profile-status"><span class="small muted">证件核验状态</span><span id="verification-status" role="status">${verificationBadge()}</span></div></section>
    ${state.pending.length ? '<div class="notice warning"><p>有尚未保存的拍摄素材保留在本页面内存中。请勿刷新或关闭页面，核验通过后可继续保存。</p></div>' : ''}
    <div class="section-heading verification-heading"><h2>证件核验</h2><span class="badge blue">流程 Mock</span></div>
    <div class="notice">${icon('info')}<p>请使用示例或测试图片。图片只在当前页面预览，离开后清除；仅保存模拟核验状态。Mock 不代表真实身份或房屋权属已核验。</p></div>
    ${passed ? `<section class="panel verification-approved"><span class="approval-symbol">${icon('check')}</span><h2>证件核验已通过 <small>（Mock）</small></h2><p>已满足本轮体验的采集准入条件。</p><div class="verified-documents">${Object.values(documentLabels).map(label => `<div>${icon('check')}<strong>${label}</strong><span>模拟通过</span></div>`).join('')}</div><p class="small muted">核验时间：${date(verification.checkedAt)} · 证件图片未留存</p><div class="verification-actions">${button(state.pending.length ? 'resume-pending' : 'home', state.pending.length ? '继续保存拍摄素材' : '返回我的采集', 'arrow', 'primary')}${button('id-reset', '重新核验', 'refresh', 'secondary', busy ? 'disabled' : '')}</div><p class="small muted">重新核验后，采集权限暂停，待再次通过后恢复。</p></section>` : `<fieldset class="verification-form" ${busy ? 'disabled' : ''}><legend class="sr-only">身份证与房产证模拟核验</legend><div class="identity-layout"><div><div class="identity-pair">${Object.keys(documentLabels).map(idCard).join('')}</div><div class="scenario-row"><label for="id-scenario">模拟检查场景</label><select id="id-scenario">${[['pass','正常通过'],['glare','身份证人像面反光'],['edge','身份证国徽面边角不完整'],['property','房产证信息页不完整'],['failed','核验服务失败']].map(([value,label]) => `<option value="${value}" ${state.id.scenario === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div><aside class="panel inspection"><span class="eyebrow">采集前的准备</span><h2>核验通过，即可采集</h2><ol class="check-steps"><li><span>1</span><div><strong>补齐三项资料</strong><p>身份证两面与房产证均需提供</p></div></li><li><span>2</span><div><strong>完成模拟核验</strong><p>未通过时可更换资料并重试</p></div></li><li><span>3</span><div><strong>获得采集权限</strong><p>新建或继续已有房间采集</p></div></li></ol><div id="id-feedback" class="result-note" role="status">${h(feedback)}</div>${button('id-check', busy ? '处理中…' : '提交模拟核验', 'scan', 'primary full', busy ? 'disabled' : '')}<p class="small muted verification-footnote">证件核验独立于采集流程，完成后无需每次重复。</p></aside></div></fieldset>`}`);
}
async function newDialog() {
  await refreshAccount();
  if (!isVerified()) return navigate('account');
  showDialog(`<span class="eyebrow">新建采集</span><h2>这次要记录哪个房间？</h2><p class="muted">每次采集对应一个房间，便于补拍和三维预览。</p><form id="new-form"><label for="property">房屋名称</label><input id="property" name="property" maxlength="80" placeholder="例如：湖畔公寓 2 栋 301" required/><label for="room">房间名称</label><input id="room" name="room" maxlength="40" placeholder="例如：客厅" required/><p class="small muted form-hint">仅用于区分本次记录，可使用你熟悉的名称。</p><div class="dialog-actions">${button('close-dialog', '取消', '', 'secondary')}<button class="btn primary" type="submit">创建并开始 ${icon('arrow')}</button></div></form>`);
}
function showDialog(content) { $('#dialog')?.remove(); const dialog = document.createElement('dialog'); dialog.id = 'dialog'; dialog.innerHTML = `${button('close-dialog', '', 'close', 'dialog-close icon-button', 'aria-label="关闭弹窗"')}${content}`; document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove()); dialog.showModal(); return dialog; }
function countMedia() { return state.draft.media.filter(m=>m.purpose !== 'video-frame').length; }
function captureStrip() {
  return state.draft.media.filter(m=>m.purpose !== 'video-frame').slice(-8).reverse().map(m=>`<button class="thumb" data-action="media" data-id="${m.id}" aria-label="查看${m.kind === 'photo' ? '照片' : '录像'}">${m.kind === 'photo' ? `<img src="${m.url}" alt="已拍照片"/>` : `<span>${icon('video')} ${Math.round(m.duration)}s</span>`}${m.purpose === 'check' ? '<small>检查</small>' : ''}</button>`).join('');
}
function renderCapture() {
  const d = state.draft;
  state.cameraState = {};
  shell(`${heading('01 / 现场采集', `${h(d.room)}，从一个稳定的视角开始`, `${h(d.property)} · 全部房屋素材仅通过实时相机采集`, button('save-exit', '暂存并退出', 'folder', 'secondary'))}
    ${state.target ? `<div class="notice">${icon('scan')}<p><strong>本次补拍目标：</strong>${h(state.target)}</p></div>` : ''}
    <div class="capture-layout"><section><div class="camera-stage"><video id="camera-video" autoplay muted playsinline aria-label="实时相机画面"></video><div class="camera-overlay" id="camera-empty"><span class="camera-symbol">${icon('camera')}</span><h2>准备好，开始现场记录</h2><p id="camera-error">开启相机后，可拍照或录制最长 60 秒的视频。</p>${button('open-camera', '开启实时相机', 'camera', 'primary')}</div><div class="frame-corners" aria-hidden="true"></div><div id="live-indicator" class="live-indicator" hidden><span></span> 实时画面</div><div class="camera-room-label">${icon('home')}${h(d.room)}</div><div id="danmaku" class="danmaku" role="status" hidden><span id="tip-source"></span><strong id="tip-text"></strong></div><div id="record-time" class="record-time" hidden>00:00</div></div>
    <div class="camera-controls"><div class="capture-select"><label for="capture-purpose">照片用途</label><select id="capture-purpose"><option value="reconstruction">重建照片</option><option value="check">检查近照（不参与重建）</option></select></div><div class="capture-buttons">${button('take-photo', '拍照', 'camera', 'capture-photo', 'disabled')}${button('record', '开始录像', 'video', 'secondary', 'disabled')}${button('pause', '暂停', '', 'secondary', 'hidden')}</div></div><div class="save-status" id="save-status">${icon('check')} <span>已保存 ${countMedia()} 份素材 · 本机持久保存</span></div><div id="pending-warning" class="notice warning" ${state.pending.length ? '' : 'hidden'}><p>有素材尚未保存，请保留此页面并重试。</p>${button('retry-save', '重试保存', 'refresh', 'secondary small-btn')}</div><div class="capture-strip" id="capture-strip">${captureStrip()}</div></section>
    <aside class="capture-aside"><section class="panel"><div class="section-heading"><h2>${icon('scan')} 拍摄指导</h2><span class="badge blue">${state.config.vision ? 'Agent 可用' : '本地模式'}</span></div><div class="toggle-row"><div><strong>实时弹幕</strong><small>在画面中显示简短建议</small></div><label class="switch"><input type="checkbox" id="tips-toggle" checked aria-label="实时弹幕"/><span></span></label></div>${state.config.vision ? `<label class="consent"><input type="checkbox" id="remote-toggle"/>启用 Agent 图像分析（约每 10 秒发送一帧到已配置服务）</label>` : '<p class="capability-note">当前提供本地亮度检查与基础拍摄建议。视觉 Agent 尚未连接，不判断空间是否完整。</p>'}<div class="capture-tips"><div>${icon('sun')}<p><strong>光线自然、画面清楚</strong><small>避免强反光和大面积过曝</small></p></div><div>${icon('camera')}<p><strong>慢慢移动，保持重叠</strong><small>覆盖墙角、门窗和遮挡位置</small></p></div><div>${icon('eye')}<p><strong>重要细节，额外拍一张</strong><small>检查近照将用于成果对照</small></p></div></div></section><section class="panel next-card"><span class="eyebrow">下一步</span><h2>拍完，再一起看一遍</h2><p>回看素材，记录需要补拍的位置，确认后再进入重建。</p>${button('finish-capture', '结束拍摄，进入复查', 'arrow', 'primary full')}<span class="small muted">结束录像后会先保存，再进入复查。</span></section></aside></div>`);
  state.camera = new CaptureCamera($('#camera-video'), {
    onState: updateCameraState,
    onCapture: async capture => { state.pending.push({ ...capture, draftId: state.draft.id, owner: state.user.id }); await uploadPending(); },
    onTip: (tip, source) => { if (state.view !== 'capture') return; $('#danmaku').hidden = false; $('#tip-source').textContent = source; $('#tip-text').textContent = tip; $('#danmaku').classList.remove('enter'); void $('#danmaku').offsetWidth; $('#danmaku').classList.add('enter'); },
    requestTip: frame => api('/api/guidance/live', { method: 'POST', data: { frame } }),
  });
}
function updateCameraState(next) {
  state.cameraState = { ...state.cameraState, ...next };
  if (state.view !== 'capture') return;
  const s = state.cameraState;
  if (next.error) { $('#camera-error').textContent = next.error; $('#camera-empty').hidden = false; if (!s.ready) $('#live-indicator').hidden = true; }
  else if (s.ready) { $('#camera-empty').hidden = true; $('#live-indicator').hidden = false; }
  $('[data-action="take-photo"]').disabled = !s.ready || s.recording || s.saving || state.uploading;
  const record = $('[data-action="record"]'); record.disabled = !s.ready || s.saving || state.uploading;
  record.innerHTML = `${icon(s.recording ? 'close' : 'video')}${s.recording ? '结束录像' : '开始录像'}`;
  $('[data-action="pause"]').hidden = !s.recording;
  $('[data-action="pause"]').textContent = s.paused ? '继续录像' : '暂停';
  $('#record-time').hidden = !s.recording;
  if (s.recording) { const sec = Math.floor(s.elapsed || 0); $('#record-time').textContent = `${s.paused ? '已暂停 · ' : '● '}${String(Math.floor(sec / 60)).padStart(2,'0')}:${String(sec % 60).padStart(2,'0')}`; }
}
async function uploadPending() {
  if (state.uploading) return;
  state.uploading = true;
  if (state.view === 'capture') { $('#save-status').textContent = '正在保存素材，请稍候…'; updateCameraState({}); }
  try {
    while (state.pending.length) {
      const capture = state.pending[0];
      if (capture.owner !== state.user?.id) throw new Error('请使用拍摄时的原账号保存这些素材。');
      capture.captureId ||= crypto.randomUUID();
      if (!capture.savedId) {
        const saved = await api(`/api/drafts/${capture.draftId}/media`, { method: 'POST', blob: capture.blob, meta: { source: 'live-camera', captureId: capture.captureId, purpose: capture.purpose, capturedAt: capture.capturedAt, duration: capture.duration, metrics: capture.metrics } });
        capture.savedId = saved.id; state.draft = saved.draft;
      }
      while (capture.frames?.length) {
        const frame = capture.frames[0];
        frame.captureId ||= crypto.randomUUID();
        const blob = new Blob([Uint8Array.from(atob(frame.data.split(',')[1]), char => char.charCodeAt(0))], { type: 'image/jpeg' });
        const saved = await api(`/api/drafts/${capture.draftId}/media`, { method: 'POST', blob, meta: { source: 'live-camera', captureId: frame.captureId, purpose: 'video-frame', parentId: capture.savedId, capturedAt: frame.capturedAt, metrics: frame.metrics } });
        state.draft = saved.draft; capture.frames.shift();
      }
      state.pending.shift();
    }
    if (state.view === 'capture') { $('#save-status').innerHTML = `${icon('check')}<span>已保存 ${countMedia()} 份素材 · 本机持久保存</span>`; $('#capture-strip').innerHTML = captureStrip(); $('#pending-warning').hidden = true; }
  } catch (error) {
    if (state.view === 'capture') { $('#pending-warning').hidden = false; $('#save-status').textContent = '保存未完成，请保留当前页面并重试。'; }
    throw error;
  } finally { state.uploading = false; updateCameraState({}); }
}
function mediaCard(m) {
  return `<article class="media-card"><button data-action="media" data-id="${m.id}" class="media-preview" aria-label="查看${m.kind === 'photo' ? '照片' : '录像'}">${m.kind === 'photo' ? `<img src="${m.url}" loading="lazy" alt="${m.purpose === 'check' ? '独立检查近照' : m.purpose === 'video-frame' ? '录像抽帧' : '现场重建照片'}"/>` : `<span>${icon('video')}<strong>现场录像</strong><small>${Math.round(m.duration)} 秒 · ${m.mime.includes('mp4') ? 'MP4' : 'WebM'}</small></span>`}</button><div class="media-info"><span>${m.purpose === 'check' ? '检查近照' : m.purpose === 'video-frame' ? '录像抽帧' : m.kind === 'video' ? '现场录像' : '重建照片'}</span><small>${bytes(m.size)}</small></div></article>`;
}
function renderReview() {
  const d = state.draft, current = d.review && d.review_revision === d.revision;
  const medias = state.mediaFilter === 'all' ? d.media.filter(m => m.purpose !== 'video-frame') : d.media.filter(m => m.purpose === state.mediaFilter);
  shell(`${heading('02 / 拍后复查', '看一遍，再补齐重要细节', `${h(d.property)} / ${h(d.room)} · 素材版本 ${d.revision}`, button('capture', '继续补拍', 'camera', 'secondary'))}
  <div class="review-layout"><section><div class="panel media-panel"><div class="section-heading"><h2>已拍素材 <span class="count">${countMedia()}</span></h2><select id="media-filter" aria-label="筛选素材"><option value="all">全部素材</option><option value="reconstruction" ${state.mediaFilter==='reconstruction'?'selected':''}>重建素材</option><option value="check" ${state.mediaFilter==='check'?'selected':''}>检查近照</option><option value="video-frame" ${state.mediaFilter==='video-frame'?'selected':''}>录像抽帧</option></select></div>${medias.length ? `<div class="media-grid">${medias.map(mediaCard).join('')}</div>` : '<div class="empty-inline">这里还没有素材，回到实时相机补拍吧。</div>'}<p class="small muted">检查近照不参与重建；录像抽帧仅辅助复查，不计作独立检查照片。</p></div><div class="panel notes-panel"><label for="draft-notes">现场备注 <span class="muted small">仅内部使用，默认不加入下载报告</span></label><textarea id="draft-notes" rows="3" maxlength="2000" placeholder="记录设施现状、补拍位置或需要人工确认的事项…">${h(d.notes)}</textarea>${button('save-notes', '保存备注', '', 'secondary small-btn')}</div></section>
  <aside><section class="panel guidance-panel"><div class="section-heading"><h2>${icon('scan')} 二次指导</h2><span class="badge blue">${state.config.vision ? '视觉 Agent' : '本地基础检查'}</span></div><p class="muted small">${state.config.vision ? '抽取最多 8 张照片或录像帧检查；未被抽中的部分仍需人工查看。' : '检查素材数量与粗略亮度，空间完整性由你人工确认。'}</p>${!current && d.review ? '<div class="notice warning">素材已更新，旧检查结果已失效，请重新检查。</div>' : ''}${button('run-review', current ? '重新检查当前素材' : '检查已拍素材', 'scan', 'primary full', d.media.length ? '' : 'disabled')}
  ${current ? `<div class="review-summary" role="status"><strong>${h(d.review.summary)}</strong><small>${d.review.mode === 'vision' ? '视觉抽样检查' : '本地规则检查'} · ${date(d.review.checkedAt)}</small></div><div class="issue-list">${d.review.issues.map(item=>`<article class="issue"><div class="issue-title"><span class="issue-dot ${item.level==='warning'?'warn':''}"></span><h3>${h(item.title)}</h3></div><p>${h(item.evidence)}</p><div class="issue-action">${h(item.action)}</div>${item.status === 'noted' ? `<p class="note-record">已记录说明：${h(item.note)}（不代表问题已解决）</p>` : ''}<div class="issue-buttons">${item.mediaId ? button('media', '查看依据', 'eye', 'text-button', `data-id="${item.mediaId}"`) : ''}${button('reshoot', '按建议补拍', 'camera', 'text-button', `data-issue="${item.id}"`)}${button('issue-note', '记录说明', '', 'text-button', `data-issue="${item.id}"`)}</div></article>`).join('')}</div>` : '<div class="review-placeholder">检查结果将关联具体素材。<br/>需要补拍时，可以直接回到相机。</div>'}</section>
  <section class="panel next-card"><h2>确认素材，进入成果</h2><label class="consent"><input type="checkbox" id="manual-confirm" ${d.confirmed_revision===d.revision?'checked':''}/>我已人工回看素材，并了解待补拍与无法判断的事项。</label>${button('confirm-review', '确认素材并继续', 'arrow', 'primary full', current ? '' : 'disabled')}<p class="small muted">确认采集不等于三维结果验收通过。</p></section></aside></div>`);
}
const jobLabels = { SUBMITTING: '正在上传与提交', RUNNING: '平台重建中', QUEUED: '排队中', PENDING: '等待处理', SUCCEEDED: '重建完成 · 待验收', UNKNOWN: '状态待核对', FAILED: '任务失败', CANCELLED: '已取消', ASSET_MISSING: '模型资产待处理' };
function resultPreview(job) {
  return `<section class="panel"><div class="section-heading"><h2>素材版本 ${job.revision} 三维预览${job.revision === state.draft.revision ? '' : '（补拍前）'}</h2><span class="badge blue">交互预览</span></div><div id="model-viewer" class="model-viewer"><div class="viewer-loading">正在准备三维预览…</div></div><p id="viewer-status" class="small muted" role="status">等待加载</p><div class="download-row">${button('furnishing', '送入本地试摆', 'home', 'primary', `data-room="job-${h(job.id)}"`)}${job.result.spz ? `<a class="btn secondary" href="${h(job.result.spz)}" target="_blank" rel="noopener noreferrer">${icon('download')} 下载 SPZ</a>` : ''}${job.result.ply ? `<a class="btn secondary" href="${h(job.result.ply)}" target="_blank" rel="noopener noreferrer">${icon('download')} 下载 PLY</a>` : ''}<a class="text-button" href="https://studio.aholo3d.cn/viewer?projectId=${encodeURIComponent(job.world_id)}" target="_blank" rel="noopener noreferrer">在平台查看</a></div></section>`;
}
function renderResult() {
  const d = state.draft;
  const latest = d.jobs.find(job => job.revision === d.revision), ready = latest?.state === 'SUCCEEDED' && (latest.result?.spz || latest.result?.ply);
  shell(`${heading('03 / 空间成果', '从现场记录，到空间预览', `${h(d.property)} / ${h(d.room)} · 当前采集版本 ${d.revision}`, button('review', '返回素材复查', 'eye', 'secondary'))}
  <div class="notice">${icon('info')}<p>三维成果需要结合独立检查近照人工对照，模糊、失真或未拍到的区域不视为真实现状。</p></div><div class="result-layout"><section>${ready ? resultPreview(latest) : `<div class="panel reconstruction-empty"><span class="result-cube">${icon('cube')}</span><h2>${latest ? (jobLabels[latest.state] || '任务状态待核对') : state.config.reconstruction ? '素材准备好了，开始空间重建' : '采集已保存，等待连接重建服务'}</h2><p>${latest ? h(latest.message || '当前版本已有重建任务，请在下方刷新原任务状态。') : state.config.reconstruction ? '将本次房间素材提交 Aholo，完成后在这里查看结果。' : '本机尚未配置 Aholo API Key。你可以继续采集、下载报告，或打开已有重建样例。'}</p>${button('create-job','提交空间重建','cube','primary',state.config.reconstruction && !latest?'':'disabled')}${!state.config.reconstruction ? button('sample','查看已有重建样例','arrow','text-button') : ''}<small>多图至少 20 张，或 MP4 录像。WebM 本版保留回看，不自动转码。</small></div>`}
  ${d.jobs.length ? `<div class="panel task-panel"><h2>重建任务</h2>${d.jobs.map(j=>`<div class="job-row"><div><strong>${jobLabels[j.state] || h(j.state)}</strong><p>素材版本 ${j.revision} · ${date(j.created)}${j.world_id ? ` · ${h(j.world_id)}` : ''}</p><small>${h(j.message)}</small></div>${button('refresh-job','刷新状态','refresh','secondary small-btn',`data-id="${j.id}"`)}</div>`).join('')}</div>` : ''}
  <div class="panel"><h2>独立检查近照</h2><p class="muted small">选择近照放大，与三维画面对应位置人工对照；视角无法对应时请标记无法比较。</p><div class="media-grid checks-grid">${d.media.filter(m=>m.purpose==='check').map(mediaCard).join('') || '<p class="empty-inline">还没有检查近照。可返回相机单独拍摄。</p>'}</div>${button('capture', '补拍检查近照', 'camera', 'secondary')}</div></section><aside><section class="panel"><span class="eyebrow">采集摘要</span><h2>${h(d.room)}</h2><dl class="summary-list"><div><dt>所属房屋</dt><dd>${h(d.property)}</dd></div><div><dt>已保存素材</dt><dd>${countMedia()} 份</dd></div><div><dt>检查状态</dt><dd>${d.review_revision===d.revision?'当前版本已检查':'需要重新检查'}</dd></div><div><dt>人工复核</dt><dd>${d.confirmed_revision===d.revision?'已记录确认':'尚未确认'}</dd></div><div><dt>重建质量</dt><dd>待人工验收</dd></div></dl><a class="btn secondary full" href="/api/drafts/${d.id}/report" download>${icon('download')} 下载采集报告</a><p class="small muted form-hint">JSON 报告保留素材清单、版本、指导和任务状态，不包含身份证图片与内部备注。</p></section></aside></div>`);
  if (ready) loadViewer(latest.result.spz || latest.result.ply, latest.result.upAxis);
}
function renderSample() {
  const samples = state.config.samples || [];
  const importAction = button('import-sample', '导入案例', 'plus', 'primary');
  const selected = samples.find(item => item.id === state.sampleId) || samples.find(item => item.available) || samples[0];
  if (!selected) {
    shell(`${heading('三维预览台', '走近空间，自由查看', '查看已有三维空间', importAction)}<div class="notice">还没有案例，导入项目链接或本地模型开始预览。</div>`);
    return;
  }
  state.sampleId = selected.id;
  const modelUrl = selected.assets.spz || selected.assets.ply;
  shell(`${heading('三维预览台', '走近空间，自由查看', `${h(selected.title)} · 通过移动、转向与缩放，查看不同位置的重建细节`, importAction)}
  <div class="sample-picker" role="group" aria-label="选择预览样例">${samples.map(item => `<button type="button" data-action="select-sample" data-id="${h(item.id)}" aria-pressed="${item.id === selected.id}">${icon('cube')}<span><strong>${h(item.title)}</strong><small>${h(item.kind)} · ${item.available ? '可预览' : '本机未安装'}</small></span>${item.id === selected.id ? icon('check') : ''}</button>`).join('')}</div>
  <div class="notice warning">${icon('info')}<p>${h(selected.notice)}</p></div>
  <div class="sample-layout"><section class="panel"><div class="section-heading"><h2>${icon('cube')} ${h(selected.title)}</h2><div class="sample-panel-actions"><span class="badge blue">交互预览</span>${button('edit-sample', '编辑信息', 'edit', 'secondary small-btn', `data-id="${h(selected.id)}"`)}</div></div><div id="model-viewer" class="model-viewer large"><div class="viewer-loading">${modelUrl ? '正在准备三维模型…' : '本机未找到此样例模型文件，请参阅使用说明。'}</div></div><p id="viewer-status" class="small muted" role="status"></p>
  <div class="download-row">${modelUrl ? button('furnishing', '送入本地试摆', 'home', 'primary', `data-room="sample-${h(selected.id)}"`) : ''}${['spz', 'ply'].filter(format => selected.assets[format]).map(format => `<a href="${h(selected.assets[format])}?download=1" class="btn secondary">${icon('download')} 下载 ${format.toUpperCase()}</a>`).join('')}${selected.source ? `<a class="text-button" href="${h(selected.source)}" target="_blank" rel="noopener noreferrer">在平台查看 ${icon('arrow')}</a>` : ''}</div></section>
  <aside class="panel sample-details"><span class="eyebrow">${h(selected.kind)}记录</span><h2>${selected.isImported ? '导入案例详情' : '从样例了解预览效果'}</h2><p>${h(selected.description)}</p>${selected.note ? `<div class="sample-case-note"><h3>案例备注</h3><p>${h(selected.note)}</p></div>` : ''}<dl class="summary-list">${selected.facts.map(([label, value]) => `<div><dt>${h(label)}</dt><dd>${h(value)}</dd></div>`).join('')}</dl>${button('new','开始自己的采集','camera','primary full')}</aside></div>`);
  if (modelUrl) loadViewer(modelUrl, selected.upAxis, selected.initialView);
}
function renderFurnishing() {
  shell(`${heading('本地试摆工作空间', '把家具放进空间看看', '选择一个房间成果，调整家具位置，保存自己的摆放布局。')}<div id="furnishing-root"></div>`);
  const generation = renderGeneration, abort = new AbortController();
  viewerAbort = abort;
  import('./furnishing.js').then(({ mountFurnishing }) => {
    if (abort.signal.aborted || generation !== renderGeneration) return;
    state.furnishing = mountFurnishing($('#furnishing-root'), { api, initialRoomId: state.furnishingRoomId, signal: abort.signal, onError: handleError,
      onRoomChange: id => { state.furnishingRoomId = id; history.replaceState(null, '', `${location.pathname}${location.search}#/furnishing/${id}`); } });
  }).catch(error => { if (!abort.signal.aborted) handleError(error); });
}
async function loadViewer(url, upAxis, initialView) {
  const generation = renderGeneration;
  viewerAbort?.abort();
  const abort = new AbortController(); viewerAbort = abort;
  try {
    const { mountViewer } = await import('./viewer.js');
    if (generation !== renderGeneration || abort.signal.aborted) return;
    const viewer = await mountViewer($('#model-viewer'), url, { upAxis, initialView, signal: abort.signal, onStatus: message => { if (generation === renderGeneration && $('#viewer-status')) $('#viewer-status').textContent = message; } });
    if (generation !== renderGeneration) viewer.dispose(); else state.viewer = viewer;
  } catch (error) { if (!abort.signal.aborted && generation === renderGeneration && $('#model-viewer')) { $('#model-viewer').classList.remove('viewer-enhanced'); $('#model-viewer').innerHTML = `<div class="viewer-loading">${icon('cube')}<h3>当前设备未能加载模型</h3><p>${h(error.message)}</p><p>可下载模型，或通过下方链接在平台查看。</p></div>`; $('#viewer-status').textContent = '预览未完成，不代表模型通过验收。'; } }
}
async function navigate(view, draftId) {
  if (!state.user) return renderLogin();
  if (!canLeaveFurnishing()) return;
  if (state.id.busy) throw new Error('证件资料正在处理，请稍候。');
  if (state.uploading) throw new Error('素材正在保存，请稍候。');
  await refreshAccount();
  if (['capture', 'review', 'result'].includes(view) && !isVerified()) view = 'account';
  if (state.pending.length && view !== 'capture' && !(view === 'account' && !isVerified())) throw new Error('请先重试保存尚未完成的素材。');
  if (state.camera && view !== 'capture') {
    try { await state.camera.close(); }
    catch (error) { if (view !== 'account' || error.code !== 'VERIFICATION_REQUIRED') throw error; }
    state.camera = null; updateCameraState({ ready: false, recording: false });
  }
  if (state.uploading) throw new Error('素材正在保存，请稍候。');
  if (state.view === 'account' && view !== 'account') clearIdentity();
  closeViewer();
  if (draftId && view !== 'account') state.draft = await api(`/api/drafts/${draftId}`);
  if (['capture', 'review', 'result'].includes(view) && !state.draft) view = 'home';
  if (view === 'home') state.drafts = (await api('/api/drafts')).drafts;
  if (view === 'sample') state.config = await api('/api/config');
  state.view = view; renderGeneration++;
  if (view !== 'furnishing' && furnishingHash()) history.replaceState(null, '', location.pathname + location.search);
  ({ home: renderHome, account: renderAccount, capture: renderCapture, review: renderReview, result: renderResult, sample: renderSample, furnishing: renderFurnishing })[view]();
  window.scrollTo(0,0);
}
async function updateVerification(work) {
  if (state.id.busy) return;
  state.id.busy = true; state.id.generation++; renderAccount();
  try { await work(); }
  catch (error) {
    if (error.status !== 401) { try { await refreshAccount(); } catch { /* Keep last known state; server still checks every main action. */ } }
    throw error;
  } finally { state.id.busy = false; if (state.user && state.view === 'account') renderAccount(); }
}
async function resetVerification() {
  const result = await api('/api/verification/reset', { method: 'POST' });
  state.user = result.user;
}
function removeIdentity(side) {
  if (state.id[side]?.url.startsWith('blob:')) URL.revokeObjectURL(state.id[side].url);
  state.id[side] = null;
}
async function identityFile(side, file) {
  if (!file || !documentLabels[side]) return;
  return updateVerification(async () => {
    await resetVerification(); removeIdentity(side);
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || !file.size || file.size > 8 * 1024 * 1024) throw new Error(`${documentLabels[side]}：请选择不超过 8 MB 的 JPG、PNG 或 WebP 图片。`);
    const url = URL.createObjectURL(file);
    try { const img = new Image(); img.src = url; await img.decode(); if (!img.naturalWidth || img.naturalWidth > 20000 || img.naturalHeight > 20000) throw new Error('图片尺寸过大。'); }
    catch { URL.revokeObjectURL(url); throw new Error('图片无法读取，请重新选择。'); }
    state.id[side] = { url };
  });
}
async function exampleId(side) {
  if (!documentLabels[side]) return;
  return updateVerification(async () => {
    await resetVerification(); removeIdentity(side);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" rx="18" fill="#edf3fc"/><rect x="22" y="22" width="436" height="256" rx="10" fill="none" stroke="#a9bdda" stroke-width="2"/><text x="40" y="70" font-family="sans-serif" font-size="24" fill="#395a86">${documentLabels[side]} · 流程示例</text><text x="40" y="135" font-family="sans-serif" font-size="19" fill="#5e7798">不含真实姓名、证件号或房屋信息</text><text x="40" y="230" font-family="sans-serif" font-size="30" fill="#91a7c5">MOCK / 仅供体验</text></svg>`;
    state.id[side] = { url: URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })) };
  });
}
function showMedia(id) {
  const m = state.draft?.media.find(m=>m.id === id); if (!m) throw new Error('找不到这份素材。');
  showDialog(`<h2>${m.kind==='video'?'现场录像':'现场照片'}</h2><p class="muted small">${date(m.captured)} · ${bytes(m.size)}</p><div class="media-modal">${m.kind==='video'?`<video src="${m.url}" controls playsinline></video>`:`<img src="${m.url}" alt="现场拍摄素材"/>`}</div><div class="dialog-actions"><a class="btn secondary" href="${m.url}?download=1">${icon('download')}下载原始素材</a>${button('delete-media','移除素材','trash','secondary danger-text',`data-id="${m.id}"`)}</div>`);
}
async function action(name, el) {
  if (name === 'close-dialog') { $('#dialog')?.close(); return; }
  if (state.id.busy) throw new Error('证件资料正在处理，请稍候。');
  if (name === 'account') return navigate('account');
  if (name === 'home') return navigate('home');
  if (name === 'sample') return navigate('sample');
  if (name === 'furnishing') { state.furnishingRoomId = el.dataset.room || null; return navigate('furnishing'); }
  if (name === 'edit-sample') {
    state.config = await api('/api/config');
    if (state.view !== 'sample') return;
    const sample = state.config.samples.find(item => item.id === el.dataset.id);
    if (!sample) throw new Error('找不到此案例，请重新打开案例列表。');
    const dialog = showDialog(`<span class="eyebrow">重建案例 / 设置</span><h2 id="sample-settings-title">编辑案例信息</h2><p class="muted small">名称、备注和查看方向仅对当前账号生效。</p>
      <form id="sample-settings-form" data-id="${h(sample.id)}" data-revision="${sample.settingsRevision}">
        <fieldset class="import-fields"><legend class="sr-only">案例设置</legend>
        <label for="sample-name">案例名称</label><input id="sample-name" name="title" value="${h(sample.title)}" maxlength="80" required autofocus/>
        <label for="sample-note">案例备注 <span class="muted">（选填）</span></label><textarea id="sample-note" name="note" rows="3" maxlength="500" placeholder="例如：客厅全景，窗边区域需要重点查看">${h(sample.note)}</textarea>
        <label for="sample-up-axis">模型向上方向</label><select id="sample-up-axis" name="upAxis"><option value="Z" ${sample.upAxis === 'Z' ? 'selected' : ''}>Z 轴向上（Aholo 常用）</option><option value="Y" ${sample.upAxis === 'Y' ? 'selected' : ''}>Y 轴向上</option></select>
        <p class="small muted form-hint">模型躺倒时可调整方向；保存后重新打开预览。</p></fieldset>
        <p id="sample-settings-error" class="error" role="alert" tabindex="-1" hidden></p>
        <div class="dialog-actions">${button('close-dialog', '取消', '', 'secondary', 'type="button"')}<button class="btn primary" type="submit">保存信息</button></div>
      </form>`);
    dialog.classList.add('sample-settings-dialog'); dialog.setAttribute('aria-labelledby', 'sample-settings-title');
    dialog.addEventListener('cancel', event => { if (dialog.querySelector('[type=submit]').disabled) event.preventDefault(); });
    return;
  }
  if (name === 'import-sample') {
    if (state.view !== 'sample' || state.sampleImport) return;
    const owner = state.user.id;
    $('#dialog')?.close();
    state.sampleImport = openSampleImport({
      csrf:state.csrf, maxBytes:state.config.maxModelBytes,
      onImported:async result => {
        if (state.user?.id !== owner) return;
        state.sampleId = result.sample.id; await navigate('sample');
        toast(result.duplicate ? '这个案例已存在，已为你打开。' : '案例已导入并保存，可随时回来预览。');
      },
      onError:handleError, onClose:() => { state.sampleImport = null; },
      onCancel:() => toast('已取消导入请求，已保存的案例会保留。'),
    });
    return;
  }
  if (name === 'select-sample') {
    if (state.view !== 'sample' || state.sampleId === el.dataset.id || !state.config.samples.some(item => item.id === el.dataset.id)) return;
    state.sampleId = el.dataset.id;
    await navigate('sample');
    if (state.user && state.view === 'sample') $('[data-action="select-sample"][aria-pressed="true"]')?.focus();
    return;
  }
  if (name === 'new') return newDialog();
  if (name === 'resume') return navigate('capture', el.dataset.id);
  if (name === 'capture') { state.target = ''; return navigate('capture'); }
  if (name === 'review') return navigate('review', state.draft.id);
  if (name === 'logout') {
    if (!canLeaveFurnishing()) return;
    if (state.camera) { await state.camera.close(); state.camera = null; }
    if (state.pending.length) throw new Error('有素材尚未保存，请先重试保存。');
    await api('/api/logout', { method: 'POST' });
    clearIdentity(); state.user = null; state.draft = null; renderLogin(); return;
  }
  if (name === 'id-example') return exampleId(el.dataset.side);
  if (name === 'id-remove') return updateVerification(async () => { await resetVerification(); removeIdentity(el.dataset.side); });
  if (name === 'id-reset') return updateVerification(async () => { await resetVerification(); for (const side of Object.keys(documentLabels)) removeIdentity(side); });
  if (name === 'id-check') {
    if (!Object.keys(documentLabels).every(side => state.id[side])) throw new Error('请补齐身份证人像面、国徽面和房产证。');
    return updateVerification(async () => {
      const result = await api('/api/verification/mock', { method: 'POST', data: { result: state.id.scenario, documents: { front: true, back: true, property: true }, revision: state.user.verification.revision } });
      state.user = result.user;
      if (isVerified()) for (const side of Object.keys(documentLabels)) removeIdentity(side);
    });
  }
  if (name === 'resume-pending') { await navigate('capture', state.pending[0]?.draftId); if (state.view === 'capture') await uploadPending(); return; }
  if (['open-camera', 'take-photo', 'record', 'pause', 'retry-save'].includes(name)) {
    await refreshAccount();
    if (!isVerified()) return navigate('account');
  }
  if (name === 'open-camera') return state.camera.open();
  if (name === 'take-photo') { await state.camera.photo($('#capture-purpose').value); return; }
  if (name === 'record') {
    if (state.cameraState.recording) await state.camera.stopRecording();
    else { const mime=state.camera.startRecording(); toast(mime.startsWith('video/mp4')?'开始录制 MP4，最长 60 秒。':'当前浏览器录制为 WebM；可保存回看，重建请使用实时照片。'); }
    return;
  }
  if (name === 'pause') return state.camera.pause();
  if (name === 'retry-save') { await uploadPending(); toast('素材已保存。'); return; }
  if (name === 'save-exit') { await navigate('home'); toast('采集已暂存，下次可从草稿继续。'); return; }
  if (name === 'finish-capture') return navigate('review',state.draft.id);
  if (name === 'media') return showMedia(el.dataset.id);
  if (name === 'delete-media') {
    if (!confirm('移除这份素材？对应检查结果将失效。')) return;
    state.draft=await api(`/api/media/${el.dataset.id}`,{method:'DELETE'}); $('#dialog')?.close();
    if(state.view==='capture'){ $('#capture-strip').innerHTML=captureStrip(); $('#save-status').textContent=`已保存 ${countMedia()} 份素材`; } else await navigate(state.view); return;
  }
  if (name === 'run-review') {
    if (state.config.vision && !confirm('将最多 8 张房屋照片或录像帧发送到已配置的视觉服务进行检查，可能消耗服务额度。继续？')) return;
    el.disabled=true; el.textContent='正在检查…';
    try { state.draft=await api(`/api/drafts/${state.draft.id}/review`,{method:'POST',data:{allowExternal:state.config.vision}}); renderReview(); } finally { if(el.isConnected){el.disabled=false;el.textContent='重新检查';} } return;
  }
  if (name === 'reshoot') { state.target=state.draft.review.issues.find(i=>i.id===el.dataset.issue)?.action||''; return navigate('capture'); }
  if (name === 'issue-note') {
    const item=state.draft.review.issues.find(i=>i.id===el.dataset.issue);
    showDialog(`<h2>记录处理说明</h2><p class="muted">${h(item.title)} · 记录说明不会将问题自动判为已解决。</p><form id="issue-form" data-id="${item.id}"><label for="issue-note">说明</label><textarea id="issue-note" name="note" rows="4" maxlength="500" required placeholder="例如：本次先保留，稍后补拍窗边…">${h(item.note||'')}</textarea><div class="dialog-actions"><button class="btn primary" type="submit">保存说明</button></div></form>`); return;
  }
  if (name === 'save-notes') { state.draft=await api(`/api/drafts/${state.draft.id}`,{method:'PATCH',data:{notes:$('#draft-notes').value}}); toast('现场备注已保存。'); return; }
  if (name === 'confirm-review') {
    if(!$('#manual-confirm').checked) throw new Error('请先勾选人工复核确认。');
    state.draft=await api(`/api/drafts/${state.draft.id}/confirm`,{method:'POST',data:{manual:true}}); return navigate('result');
  }
  if (name === 'create-job') {
    if (!confirm('确认将当前重建素材上传至 Aholo 并创建极速重建任务？这会使用平台额度；同一素材版本仅提交一次。')) return;
    await api(`/api/drafts/${state.draft.id}/jobs`,{method:'POST',data:{confirmCost:true}}); return navigate('result',state.draft.id);
  }
  if (name === 'refresh-job') { state.draft=await api(`/api/jobs/${el.dataset.id}/refresh`,{method:'POST'}); return navigate('result'); }
  if (name === 'reset-view') return state.viewer?.reset();
}
document.addEventListener('click', event => {
  const target=event.target.closest('[data-action]'); if(!target || target.disabled) return;
  event.preventDefault();
  if(target.dataset.busy) return; target.dataset.busy='1';
  Promise.resolve(action(target.dataset.action,target)).catch(handleError).finally(()=>delete target.dataset.busy);
});
document.addEventListener('submit', async event => {
  event.preventDefault(); const form=event.target, submit=form.querySelector('[type="submit"]');
  if(submit.disabled) return; submit.disabled=true;
  try {
    const data=Object.fromEntries(new FormData(form));
    if(form.id==='login-form') {
      const result=await api('/api/login',{method:'POST',data}); state.csrf=result.csrf; state.user=result.user;
      if(state.pending.some(c=>c.owner!==state.user.id)){await api('/api/logout',{method:'POST'});state.user=null;throw new Error('未保存素材属于原账号，请使用原账号重新登录。');}
      state.config=await api('/api/config');
      if(state.pending.length){await navigate('capture',state.pending[0].draftId); if(state.view==='capture') await uploadPending();} else await initialView();
    } else if(form.id==='sample-settings-form') {
      const dialog = form.closest('dialog'), fields = form.querySelector('fieldset');
      const closeButtons = dialog.querySelectorAll('[data-action="close-dialog"]');
      $('#sample-settings-error').hidden = true;
      fields.disabled = true; closeButtons.forEach(button => { button.disabled = true; }); submit.textContent = '正在保存…';
      try {
        const result = await api(`/api/samples/${form.dataset.id}/settings`, { method:'PATCH', data:{ ...data, revision:Number(form.dataset.revision) }, signal:AbortSignal.timeout(10000) });
        state.sampleId = result.sample.id; dialog.close(); await navigate('sample'); toast('案例信息已保存。');
      } finally { fields.disabled = false; closeButtons.forEach(button => { button.disabled = false; }); submit.textContent = '保存信息'; }
    } else if(form.id==='new-form') { state.draft=await api('/api/drafts',{method:'POST',data}); $('#dialog').close(); state.target=''; await navigate('capture'); }
    else if(form.id==='issue-form') { state.draft=await api(`/api/drafts/${state.draft.id}/issues`,{method:'PATCH',data:{id:form.dataset.id,status:'noted',note:data.note}}); $('#dialog').close(); renderReview(); }
  } catch(error) {
    if(form.id==='login-form' && $('#login-error')) $('#login-error').textContent=error.message;
    else if(form.id==='sample-settings-form' && error.status !== 401 && $('#sample-settings-error')) {
      const message = $('#sample-settings-error');
      message.textContent = error.name === 'TimeoutError' || error.name === 'TypeError' ? '连接中断或等待超时，请重新打开编辑窗口确认保存结果。' : error.message;
      message.hidden = false; message.focus();
    } else await handleError(error);
  }
  finally { if(submit.isConnected) submit.disabled=false; }
});
document.addEventListener('change', event => {
  const el=event.target;
  if(el.matches('[data-side][type=file]')) identityFile(el.dataset.side,el.files[0]).catch(handleError);
  if(el.id==='id-scenario'){const value=el.value;updateVerification(async()=>{await resetVerification();state.id.scenario=value;}).catch(handleError);}
  if(el.id==='tips-toggle'){state.camera.tipEnabled=el.checked;$('#danmaku').hidden=!el.checked;if(el.checked)state.camera.guide();}
  if(el.id==='remote-toggle'){state.camera.remoteEnabled=el.checked;state.camera.guide();}
  if(el.id==='media-filter'){state.mediaFilter=el.value;renderReview();}
});
window.addEventListener('beforeunload', event => { if(state.uploading||state.pending.length||state.cameraState.recording||state.sampleImport?.busy||state.furnishing?.hasUnsavedChanges||state.furnishing?.busy){event.preventDefault();event.returnValue='';} });
window.addEventListener('pagehide',()=>{state.camera?.stream?.getTracks().forEach(t=>t.stop());clearIdentity();});
try { const session=await api('/api/session'); state.user=session.user;state.csrf=session.csrf;state.config=await api('/api/config'); await initialView(); }
catch(error){renderLogin(error.status===401?'':error.message);}
