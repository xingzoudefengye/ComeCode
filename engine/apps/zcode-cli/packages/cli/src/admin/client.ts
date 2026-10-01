// 页面只持有编辑草稿；原始凭据与有效配置均由服务端拥有。
export const ADMIN_SCRIPT = String.raw`
'use strict';
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('token') || sessionStorage.getItem('comecode-admin-token');
if (fragment.has('token')) { sessionStorage.setItem('comecode-admin-token', token); history.replaceState(null, '', location.pathname); }
let snapshot, draft, busy = false, dirty = false, editing = null;
const $ = id => document.getElementById(id);
const status = (text, error = false) => { $('status').textContent = text; $('status').className = error ? 'error' : ''; };
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const protocols = [
  ['openai-chat', 'Chat Completions（兼容）'],
  ['openai-responses', 'Responses'],
  ['anthropic', 'Anthropic Messages'],
];
const protocolName = type => (protocols.find(item => item[0] === type) || ['', type || '未设置'])[1];
const normalizeUrl = value => {
  try { const url = new URL(String(value || '').trim()); url.hash = ''; url.pathname = url.pathname.replace(/\/+$/, '') || '/'; return url.toString().replace(/\/$/, ''); }
  catch { return String(value || '').trim().replace(/\/+$/, '').toLowerCase(); }
};
async function api(path, method = 'GET', body) {
  const response = await fetch('/api/' + path, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? {'Content-Type':'application/json'} : {}) }, ...(body ? {body:JSON.stringify(body)} : {}) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '操作失败'); return data;
}
async function confirmAction(title, message) {
  $('confirm-title').textContent = title; $('confirm-message').textContent = message;
  const dialog = $('confirm'); dialog.returnValue = 'cancel'; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), {once:true}));
}
function markDirty() { dirty = true; status('有未保存的修改。保存后重启 ComeCode 生效。'); }
function button(text, action, className) { const item = node('button', text, className); item.type = 'button'; item.onclick = action; return item; }
function allModels() { return draft.providers.flatMap(provider => (provider.models || []).map(model => ({ provider, model }))); }
function modelName(entry) { return entry.model.name || entry.model.id || '未命名模型'; }
function environmentKeyName(source) { return typeof source === 'string' && source.startsWith('env:') ? source.slice(4) : ''; }
function editableDraftFromEffective() {
  const effective = snapshot.effective;
  if (!effective || !Array.isArray(effective.providers) || effective.providers.length === 0) return structuredClone(snapshot.config);
  // 列表展示运行时有效模型；草稿不携带真实 Key，保存时由服务端按 ID 保留密钥。
  return {
    ...(effective.provider ? { provider: effective.provider } : {}),
    ...(effective.model ? { model: effective.model } : {}),
    providers: effective.providers.map(provider => ({
      id: provider.id,
      ...(provider.name ? { name: provider.name } : {}),
      ...(provider.type ? { type: provider.type } : {}),
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      ...(environmentKeyName(provider.apiKeySource) ? { apiKeyEnv: environmentKeyName(provider.apiKeySource) } : {}),
      ...(provider.apiKey || provider.apiKeySource ? { hasApiKey: true } : {}),
      models: (provider.models || []).map(model => ({
        id: model.id,
        ...(model.name ? { name: model.name } : {}),
        ...(model.enabled === false ? { enabled: false } : {}),
        ...(model.type && model.type !== provider.type ? { type: model.type } : {}),
        ...(model.baseUrl && model.baseUrl !== provider.baseUrl ? { baseUrl: model.baseUrl } : {}),
        ...(environmentKeyName(model.apiKeySource) ? { apiKeyEnv: environmentKeyName(model.apiKeySource) } : {}),
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
        ...(model.toolCalling !== undefined ? { toolCalling: model.toolCalling } : {}),
        ...(model.vision !== undefined ? { vision: model.vision } : {}),
        ...(model.apiKey || model.apiKeySource ? { hasApiKey: true } : {}),
      })),
    })),
  };
}
function displayName(entry, counts) { return counts.get(modelName(entry)) > 1 ? (entry.provider.name || entry.provider.id || '供应商') + ' / ' + modelName(entry) : modelName(entry); }
function findProvider(baseUrl, except) {
  // 相同请求地址自动归入同一 Provider；协议差异由模型级覆盖保存。
  return draft.providers.find(provider => provider !== except && normalizeUrl(provider.baseUrl) === normalizeUrl(baseUrl));
}
function nextProviderId() {
  const ids = new Set(draft.providers.map(provider => provider.id)); let id = 'provider'; let number = 2;
  while (ids.has(id)) id = 'provider-' + number++;
  return id;
}
function nextProviderName() { return '模型服务'; }
function inputField(parent, id, title, value, type, placeholder) {
  const label = node('label', title), input = node('input'); input.id = id; input.type = type || 'text'; input.value = value || ''; input.placeholder = placeholder || ''; input.setAttribute('aria-label', title);
  if (input.type === 'password') input.autocomplete = 'new-password';
  if (input.type === 'number') { input.min = '1'; input.step = '1'; }
  label.append(input); parent.append(label); return input;
}
function selectField(parent, id, title, value, options) {
  const label = node('label', title), select = node('select'); select.id = id; select.setAttribute('aria-label', title);
  options.forEach(item => { const option = node('option', item[1]); option.value = item[0]; select.append(option); }); select.value = value || options[0][0]; label.append(select); parent.append(label); return select;
}
function modelConnectionProvider() {
  const selected = draft.providers.find(provider => provider.id === $('model-endpoint').value);
  const url = normalizeUrl($('model-url').value);
  return selected && normalizeUrl(selected.baseUrl) === url ? selected : findProvider($('model-url').value);
}
function updateModelKeyHint() {
  if (editing) return;
  const provider = modelConnectionProvider();
  // 浏览器只显示已配置状态；真实 Key 和环境变量来源由服务端按 Provider ID 保留。
  const hasKey = provider && provider.clearApiKey !== true && (provider.apiKey || provider.apiKeyEnv || provider.hasApiKey);
  $('model-key').placeholder = hasKey ? '已配置，留空复用' : '输入服务商提供的 API Key';
  $('model-key-hint').hidden = !provider;
  $('model-key-hint').textContent = provider ? (hasKey ? '将复用“' + (provider.name || provider.id) + '”的 API Key，留空即可。' : '该地址没有配置共享 API Key，请填写。') : '';
}
function handleModelUrlInput() {
  const selected = draft.providers.find(provider => provider.id === $('model-endpoint').value);
  if (selected && normalizeUrl(selected.baseUrl) !== normalizeUrl($('model-url').value)) $('model-endpoint').value = '';
  updateModelKeyHint();
}
function closeModelEndpointMenu() {
  $('model-endpoint-menu').hidden = true;
  $('model-endpoint-toggle').setAttribute('aria-expanded', 'false');
}
function toggleModelEndpointMenu() {
  const menu = $('model-endpoint-menu');
  if ($('model-endpoint-toggle').hidden) return;
  menu.hidden = !menu.hidden;
  $('model-endpoint-toggle').setAttribute('aria-expanded', String(!menu.hidden));
}
function renderModelEndpointMenu() {
  const select = $('model-endpoint'), menu = $('model-endpoint-menu');
  menu.replaceChildren();
  Array.from(select.options).forEach(option => {
    const item = button(option.textContent, () => { $('model-endpoint').value = option.value; selectModelEndpoint(); }, 'endpoint-picker-option');
    item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(option.value === select.value));
    menu.append(item);
  });
}
function populateModelEndpoints(entry) {
  const select = $('model-endpoint'); select.replaceChildren();
  const manual = node('option', '手动填写'); manual.value = ''; select.append(manual);
  draft.providers.filter(provider => provider.baseUrl).forEach(provider => {
    const option = node('option', (provider.name || provider.id) + ' · ' + provider.baseUrl); option.value = provider.id; select.append(option);
  });
  select.value = ''; select.hidden = true;
  $('model-endpoint-toggle').hidden = Boolean(entry) || select.options.length === 1;
  closeModelEndpointMenu(); renderModelEndpointMenu();
  $('model-url').hidden = false;
  $('model-key-hint').hidden = true;
}
function selectModelEndpoint() {
  const provider = draft.providers.find(item => item.id === $('model-endpoint').value);
  $('model-url').value = provider ? provider.baseUrl : '';
  // 输入框始终保留，右侧箭头只负责打开可编辑下拉选项。
  $('model-url').hidden = false;
  // 换地址时清空新输入的 Key，防止跨供应商误用；存量 Key 不进入表单。
  $('model-key').value = ''; $('clear-key').checked = false;
  $('model-type').value = provider && provider.type ? provider.type : 'openai-chat';
  closeModelEndpointMenu(); renderModelEndpointMenu(); updateModelKeyHint();
  if (!provider) $('model-url').focus();
}
function openModelDialog(entry) {
  editing = entry || null;
  const provider = entry && entry.provider;
  const model = entry && entry.model;
  $('model-dialog-title').textContent = entry ? '编辑模型' : '添加模型';
  populateModelEndpoints(entry);
  $('model-dialog-help').textContent = entry ? '修改这一个模型的连接信息；留空 API Key 表示保持原 Key。' : $('model-endpoint').hidden ? '只需要填写下面四项即可，其他设置可以保持默认。' : '直接填写接口地址，或点击右侧下拉选择已有接口以复用地址和 API Key。';
  $('model-id').value = model ? (model.id || '') : '';
  $('model-url').value = model && model.baseUrl ? model.baseUrl : (provider && provider.baseUrl ? provider.baseUrl : '');
  $('model-key').value = '';
  $('model-key').placeholder = model && (model.hasApiKey || (provider && provider.hasApiKey)) ? '已配置，留空保持不变' : '输入服务商提供的 API Key';
  $('model-type').value = model && model.type ? model.type : (provider && provider.type ? provider.type : 'openai-chat');
  $('model-name').value = model && model.name ? model.name : '';
  $('model-context').value = model && model.contextWindow ? String(model.contextWindow) : '';
  $('model-output').value = model && model.maxOutputTokens ? String(model.maxOutputTokens) : '';
  $('model-tool').value = model && model.toolCalling !== undefined ? String(model.toolCalling) : '';
  $('model-vision').value = model && model.vision !== undefined ? String(model.vision) : '';
  $('clear-key').checked = false;
  $('model-more').open = false;
  $('model-dialog').showModal();
}
function closeModelDialog() { editing = null; $('model-dialog').close(); }
function openProviderDialog(provider) {
  editing = { provider };
  $('provider-dialog-title').textContent = '编辑供应商';
  $('provider-dialog-help').textContent = '这里修改的是同一接口地址下模型共用的供应商信息。';
  $('provider-edit-id').value = provider.id || '';
  $('provider-edit-name').value = provider.name || '';
  $('provider-edit-url').value = provider.baseUrl || '';
  $('provider-edit-type').value = provider.type || 'openai-chat';
  $('provider-edit-key-env').value = provider.apiKeyEnv || '';
  $('provider-edit-key').value = '';
  $('provider-edit-key').placeholder = provider.hasApiKey ? '已配置，留空保持不变' : '输入服务商提供的 API Key';
  $('provider-clear-key').checked = false;
  $('provider-dialog').showModal();
}
function closeProviderDialog() { editing = null; $('provider-dialog').close(); }
function saveProviderDialog(event) {
  event.preventDefault();
  const provider = editing && editing.provider;
  const id = $('provider-edit-id').value.trim(), name = $('provider-edit-name').value.trim();
  const url = $('provider-edit-url').value.trim(), type = $('provider-edit-type').value;
  if (!provider || !id || !url || !type) { status('供应商 ID、接口地址和协议不能为空。', true); return; }
  if (draft.providers.some(item => item !== provider && item.id === id)) { status('供应商 ID 已存在，请换一个。', true); return; }
  const oldId = provider.id;
  provider.id = id; provider.name = name || nextProviderName(); provider.baseUrl = url; provider.type = type;
  const envName = $('provider-edit-key-env').value.trim();
  if (envName) provider.apiKeyEnv = envName; else delete provider.apiKeyEnv;
  if ($('provider-clear-key').checked) { provider.clearApiKey = true; delete provider.apiKey; }
  const key = $('provider-edit-key').value;
  if (key) { provider.apiKey = key; delete provider.clearApiKey; }
  if (draft.provider === oldId) draft.provider = id;
  markDirty(); closeProviderDialog(); render();
}
function readOptionalNumber(id) { const value = $(id).value.trim(); return value ? Number(value) : undefined; }
function assignOptional(object, key, value) { if (value === undefined || value === '') delete object[key]; else object[key] = value; }
function saveModelDialog(event) {
  event.preventDefault();
  const modelId = $('model-id').value.trim(), baseUrl = $('model-url').value.trim(), type = $('model-type').value, key = $('model-key').value;
  if (!modelId || !baseUrl || !type) { status('模型名、接口地址和协议不能为空。', true); return; }
  let provider = editing ? editing.provider : null;
  const oldProvider = provider;
  const target = !editing ? modelConnectionProvider() : findProvider(baseUrl, editing.provider);
  if (target) provider = target;
  else if (!provider || (editing && (provider.type !== type || normalizeUrl(provider.baseUrl) !== normalizeUrl(baseUrl)))) provider = { id: nextProviderId(), name: nextProviderName(), type, baseUrl, models: [], hasApiKey: false };
  if (!provider) provider = { id: nextProviderId(), name: nextProviderName(), type, baseUrl, models: [], hasApiKey: false };
  const isNewProvider = !draft.providers.includes(provider);
  // 复用已有 Provider 时保留它的默认协议；不同协议只记录在当前模型上。
  if (isNewProvider) { provider.type = type; provider.baseUrl = baseUrl; }
  provider.models ||= [];
  const oldModel = editing ? editing.model : null;
  const model = oldModel || { id: modelId };
  model.id = modelId;
  if ($('model-name').value.trim()) model.name = $('model-name').value.trim(); else delete model.name;
  // 同地址不同协议时只覆盖当前模型，避免改变同一 Provider 的其他模型。
  if (provider.type === type) { delete model.type; delete model.baseUrl; }
  else { model.type = type; model.baseUrl = baseUrl; }
  assignOptional(model, 'contextWindow', readOptionalNumber('model-context'));
  assignOptional(model, 'maxOutputTokens', readOptionalNumber('model-output'));
  const tool = $('model-tool').value; assignOptional(model, 'toolCalling', tool === '' ? undefined : tool === 'true');
  const vision = $('model-vision').value; assignOptional(model, 'vision', vision === '' ? undefined : vision === 'true');
  if ($('clear-key').checked) { provider.clearApiKey = true; delete provider.apiKey; model.clearApiKey = true; delete model.apiKey; }
  if (key) {
    if (!editing && !isNewProvider) { model.apiKey = key; delete model.apiKeyEnv; }
    else { provider.apiKey = key; delete provider.clearApiKey; delete model.apiKey; }
  }
  if (editing && oldProvider !== provider) {
    oldProvider.models = (oldProvider.models || []).filter(item => item !== oldModel);
    if (!oldProvider.models.length) draft.providers = draft.providers.filter(item => item !== oldProvider);
    if (draft.provider === oldProvider.id && draft.model === oldModel.id) { draft.provider = provider.id; draft.model = model.id; }
  }
  if (!draft.providers.includes(provider)) draft.providers.push(provider);
  provider.models ||= [];
  if (!provider.models.includes(model)) provider.models.push(model);
  if (model.enabled !== false && (!draft.provider || (editing && draft.provider === oldProvider.id && draft.model === oldModel.id))) { draft.provider = provider.id; draft.model = model.id; }
  markDirty(); closeModelDialog(); render();
}
function defaults() {
  const modelSelect = $('default-model'); modelSelect.replaceChildren();
  const entries = allModels().filter(entry => entry.model.enabled !== false), counts = new Map();
  entries.forEach(entry => counts.set(modelName(entry), (counts.get(modelName(entry)) || 0) + 1));
  const automatic = node('option', '按配置顺序自动选择'); automatic.value = ''; modelSelect.append(automatic);
  entries.forEach(entry => { const option = node('option', displayName(entry, counts)); option.value = JSON.stringify([entry.provider.id, entry.model.id]); modelSelect.append(option); });
  const current = draft.provider && draft.model ? JSON.stringify([draft.provider, draft.model]) : '';
  modelSelect.value = entries.some(entry => JSON.stringify([entry.provider.id, entry.model.id]) === current) ? current : '';
  modelSelect.onchange = () => { if (!modelSelect.value) { delete draft.provider; delete draft.model; } else { const selected = JSON.parse(modelSelect.value); draft.provider = selected[0]; draft.model = selected[1]; } markDirty(); };
}
function toggleModel(entry, enabled) {
  if (enabled) delete entry.model.enabled;
  else entry.model.enabled = false;
  if (!enabled && draft.provider === entry.provider.id && draft.model === entry.model.id) {
    const candidates = allModels().filter(candidate => candidate.model.enabled !== false);
    const fallback = candidates.find(candidate => candidate.provider === entry.provider) || candidates[0];
    if (fallback) { draft.provider = fallback.provider.id; draft.model = fallback.model.id; }
    else { delete draft.provider; delete draft.model; }
  }
  markDirty(); render();
  status('“' + modelName(entry) + '”已' + (enabled ? '启用' : '停用') + '。点击“保存配置”，重启 ComeCode 后生效。');
}
function modelSwitch(entry) {
  const label = node('label', undefined, 'model-toggle'), input = node('input'), track = node('span', undefined, 'switch-track'), text = node('span', entry.model.enabled === false ? '已停用' : '已启用', 'model-toggle-label');
  input.type = 'checkbox'; input.id = 'model-toggle-' + encodeURIComponent(JSON.stringify([entry.provider.id, entry.model.id])); input.setAttribute('role', 'switch'); input.checked = entry.model.enabled !== false; input.setAttribute('aria-label', '启用模型 ' + modelName(entry)); input.disabled = busy;
  input.onchange = () => { toggleModel(entry, input.checked); $(input.id).focus(); };
  label.append(input, track, text); return label;
}
function render() {
  defaults(); const container = $('providers'); container.replaceChildren(); const entries = allModels();
  if (!entries.length) { container.append(node('div', '还没有模型。点击“添加模型”，填写地址、API Key、协议和模型名即可开始。', 'empty')); }
  const counts = new Map(); entries.forEach(entry => counts.set(modelName(entry), (counts.get(modelName(entry)) || 0) + 1));
  // 仍以模型为主视图，只用轻量标题表达自动归类结果。
  draft.providers.filter(provider => (provider.models || []).length).forEach(provider => {
    const group = node('section', undefined, 'provider-group');
    const heading = node('div', undefined, 'provider-heading'), info = node('div');
    const enabledCount = (provider.models || []).filter(model => model.enabled !== false).length;
    const name = node('div', undefined, 'provider-name'), edit = button(undefined, () => openProviderDialog(provider), 'provider-edit');
    edit.title = '编辑供应商'; edit.setAttribute('aria-label', '编辑供应商');
    // 齿轮图标仅负责展示，保留原生按钮的键盘操作和无障碍名称。
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
    path.setAttribute('d', 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z');
    icon.append(path); edit.append(icon);
    name.append(node('strong', provider.name || provider.id || '未命名供应商'), edit);
    info.append(name, node('span', (provider.models || []).length + ' 个模型 · ' + enabledCount + ' 个已启用 · ' + (provider.baseUrl || '未设置地址'), 'provider-meta'));
    heading.append(info);
    group.append(heading);
    (provider.models || []).forEach(model => {
      const entry = { provider, model }, row = node('div', undefined, model.enabled === false ? 'model-row is-disabled' : 'model-row');
      const rowHeading = node('div', undefined, 'model-row-heading'), title = node('div');
      title.append(node('strong', displayName(entry, counts)), node('span', protocolName(model.type || provider.type), 'model-protocol'));
      const actions = node('div', undefined, 'actions'), testButton = button('测试连接', () => test(entry));
      if (model.enabled === false) { testButton.disabled = true; testButton.title = '请先启用模型再测试连接'; }
      actions.append(modelSwitch(entry), button('编辑', () => openModelDialog(entry)), testButton, button('删除', () => deleteModel(entry), 'danger'));
      rowHeading.append(title, actions); row.append(rowHeading);
      const meta = node('div', undefined, 'model-meta'); meta.append(node('span', model.contextWindow ? Math.round(model.contextWindow / 1000) + 'K 上下文' : '默认上下文'), node('span', model.vision === true ? '支持图片' : model.vision === false ? '不支持图片' : '图片能力默认'), node('span', model.toolCalling === true ? '支持工具' : model.toolCalling === false ? '不支持工具' : '工具能力默认')); row.append(meta);
      const url = node('p', model.baseUrl || provider.baseUrl || '未设置接口地址', 'model-url'); row.append(url); group.append(row);
    });
    container.append(group);
  });
  const sources = $('sources'); sources.replaceChildren();
  sources.append(node('p', '编辑用户配置：' + snapshot.source), node('p', '保存目标：' + snapshot.target));
  if (snapshot.effective.paths.project) sources.append(node('p', '项目覆盖：' + snapshot.effective.paths.project + '（只读，可能覆盖此页设置）'));
  sources.append(node('p', '优先级：CLI 参数 > 环境变量 > 项目配置 > 用户配置 > 旧配置 / 内置默认'));
  sources.append(node('pre', JSON.stringify(snapshot.effective, null, 2)));
  $('save').disabled = Boolean(snapshot.errors.length) || busy;
}

async function deleteModel(entry) {
  if (!await confirmAction('删除模型', '删除“' + modelName(entry) + '”？保存后才会真正生效。')) return;
  entry.provider.models = (entry.provider.models || []).filter(model => model !== entry.model);
  if (!entry.provider.models.length) draft.providers = draft.providers.filter(provider => provider !== entry.provider);
  if (draft.provider === entry.provider.id && draft.model === entry.model.id) { delete draft.provider; delete draft.model; }
  markDirty(); render();
}
async function load() {
  try { snapshot = await api('config'); draft = editableDraftFromEffective(); dirty = false; render(); status(snapshot.errors.length ? '配置有错误，未允许覆盖：' + snapshot.errors.join('；') : '配置已加载。修改后保存，重启 ComeCode 生效。', Boolean(snapshot.errors.length)); }
  catch(error) { status(error.message, true); }
}
async function save() {
  if (busy) return;
  let migrate = false; if (snapshot.requiresMigration) { migrate = await confirmAction('迁移为 JSON', '将保存为 JSON，原配置文件会保留并备份。注释不会迁入新文件。是否继续？'); if (!migrate) return; }
  busy = true; $('save').disabled = true; document.querySelectorAll('.model-toggle input').forEach(input => { input.disabled = true; });
  try { snapshot = await api('config', 'PUT', { revision: snapshot.revision, migrate, config: draft }); draft = structuredClone(snapshot.config); dirty = false; render(); status('已保存。请重启 ComeCode 使用新设置。' + (snapshot.backup ? '\\n原配置已备份。' : '')); }
  catch(error) { status(error.message, true); }
  finally { busy = false; $('save').disabled = Boolean(snapshot.errors && snapshot.errors.length); document.querySelectorAll('.model-toggle input').forEach(input => { input.disabled = false; }); }
}
async function test(entry) {
  if (dirty) { status('请先保存修改，再测试已保存的模型。', true); return; }
  if (!await confirmAction('测试模型连接', '将向 ' + modelName(entry) + ' 发起一次最小请求，服务商可能收费。是否继续？')) return;
  status('正在测试连接…');
  try { const result = await api('test', 'POST', { provider: entry.provider.id, model: entry.model.id, confirm: true }); status(result.message, !result.ok); }
  catch(error) { status(error.message, true); }
}
$('model-endpoint').onchange = selectModelEndpoint;
$('model-endpoint-toggle').onclick = toggleModelEndpointMenu;
$('model-url').oninput = handleModelUrlInput;
$('model-form').onsubmit = saveModelDialog;
$('model-cancel').onclick = closeModelDialog;
$('provider-form').onsubmit = saveProviderDialog;
$('provider-cancel').onclick = closeProviderDialog;
$('add-model').onclick = () => openModelDialog(null);
$('save').onclick = save;
$('reload').onclick = async () => { if (dirty && !await confirmAction('放弃修改', '重新加载会丢弃未保存修改。是否继续？')) return; await load(); };
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
if (!token) { status('请从终端运行 comecode admin 打开授权页面。', true); $('save').disabled = true; $('add-model').disabled = true; } else load();
`;
