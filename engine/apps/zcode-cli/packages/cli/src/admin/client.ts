/* eslint-disable max-lines -- 管理页面脚本与 DOM 模板需保持同一资源边界。 */
// 页面只持有编辑草稿；原始凭据与有效配置均由服务端拥有。
export const ADMIN_SCRIPT = String.raw`
'use strict';
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('token') || sessionStorage.getItem('comecode-admin-token');
if (fragment.has('token')) { sessionStorage.setItem('comecode-admin-token', token); history.replaceState(null, '', location.pathname); }
let snapshot, draft, busy = false, editing = null, modelTestCandidate = null, modelTestFingerprint = "";
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
function findProvider(targetDraft, baseUrl, except) {
  // 相同请求地址自动归入同一 Provider；协议差异由模型级覆盖保存。
  return targetDraft.providers.find(provider => provider !== except && normalizeUrl(provider.baseUrl) === normalizeUrl(baseUrl));
}
function nextProviderId(targetDraft) {
  const ids = new Set(targetDraft.providers.map(provider => provider.id)); let id = 'provider'; let number = 2;
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
function modelConnectionProvider(targetDraft) {
  const selected = targetDraft.providers.find(provider => provider.id === $('model-endpoint').value);
  const url = normalizeUrl($('model-url').value);
  return selected && normalizeUrl(selected.baseUrl) === url ? selected : findProvider(targetDraft, $('model-url').value);
}
function updateModelKeyHint() {
  if (editing) return;
  const provider = modelConnectionProvider(draft);
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
function closeModelTypeMenu() {
  $('model-type-menu').hidden = true;
  $('model-type-toggle').setAttribute('aria-expanded', 'false');
}
function toggleModelTypeMenu() {
  const menu = $('model-type-menu');
  menu.hidden = !menu.hidden;
  $('model-type-toggle').setAttribute('aria-expanded', String(!menu.hidden));
}
function modelTypeOptions() {
  const select = $('model-type');
  return select.options.length ? Array.from(select.options) : protocols.map(item => ({ value: item[0], textContent: item[1] }));
}
function syncModelTypeDisplay() {
  const select = $('model-type'), option = modelTypeOptions().find(item => item.value === select.value);
  $('model-type-display').value = option ? option.textContent : protocolName(select.value);
}
function renderModelTypeMenu() {
  const select = $('model-type'), menu = $('model-type-menu');
  menu.replaceChildren();
  modelTypeOptions().forEach(option => {
    const item = button(option.textContent, () => { $('model-type').value = option.value; syncModelTypeDisplay(); invalidateModelTest(); closeModelTypeMenu(); renderModelTypeMenu(); }, 'protocol-picker-option');
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
  syncModelTypeDisplay(); invalidateModelTest(); closeModelEndpointMenu(); renderModelEndpointMenu(); updateModelKeyHint();
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
  syncModelTypeDisplay(); renderModelTypeMenu(); closeModelTypeMenu();
  $('model-name').value = model && model.name ? model.name : '';
  $('model-context').value = model && model.contextWindow ? String(model.contextWindow) : '';
  $('model-output').value = model && model.maxOutputTokens ? String(model.maxOutputTokens) : '';
  $('model-tool').value = model && model.toolCalling !== undefined ? String(model.toolCalling) : '';
  $('model-vision').value = model && model.vision !== undefined ? String(model.vision) : '';
  $('clear-key').checked = false;
  $('model-more').open = false;
  invalidateModelTest();
  $('model-dialog').showModal();
}
function closeModelDialog() { editing = null; invalidateModelTest(); $('model-dialog').close(); }
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
async function saveProviderDialog(event) {
  event.preventDefault();
  if (busy) return;
  const before = structuredClone(draft), provider = editing && editing.provider;
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
  const candidate = (provider.models || []).find(model => model.enabled !== false) || (provider.models || [])[0];
  const saved = await save();
  if (saved) closeProviderDialog();
  else { draft = before; render(); }
}
function readOptionalNumber(id) { const value = $(id).value.trim(); return value ? Number(value) : undefined; }
function assignOptional(object, key, value) { if (value === undefined || value === '') delete object[key]; else object[key] = value; }
function modelDialogFingerprint() {
  return JSON.stringify([
    $('model-id').value.trim(), $('model-url').value.trim(), $('model-key').value,
    $('model-type').value, $('model-name').value.trim(), $('model-context').value.trim(),
    $('model-output').value.trim(), $('model-tool').value, $('model-vision').value,
    $('clear-key').checked,
  ]);
}
function invalidateModelTest() {
  modelTestCandidate = null;
  modelTestFingerprint = '';
  const submit = $('model-submit');
  if (submit) submit.disabled = true;
}
function applyModelDialogDraft(candidateDraft) {
  const modelId = $('model-id').value.trim(), baseUrl = $('model-url').value.trim(), type = $('model-type').value, key = $('model-key').value;
  if (!modelId || !baseUrl || !type) {
    const message = '模型名、接口地址和协议不能为空。';
    $('model-dialog-help').textContent = message; status(message, true); return null;
  }
  const editingProviderId = editing && editing.provider && editing.provider.id;
  const editingModelId = editing && editing.model && editing.model.id;
  let provider = editingProviderId ? candidateDraft.providers.find(item => item.id === editingProviderId) : null;
  const oldProvider = provider;
  const oldModel = provider && editingModelId ? (provider.models || []).find(item => item.id === editingModelId) : null;
  const wasDefault = Boolean(oldProvider && oldModel && candidateDraft.provider === oldProvider.id && candidateDraft.model === oldModel.id);
  const target = !editing ? modelConnectionProvider(candidateDraft) : findProvider(candidateDraft, baseUrl, oldProvider);
  if (target) provider = target;
  else if (!provider || (editing && normalizeUrl(provider.baseUrl) !== normalizeUrl(baseUrl))) provider = { id: nextProviderId(candidateDraft), name: nextProviderName(), type, baseUrl, models: [], hasApiKey: false };
  if (!provider) provider = { id: nextProviderId(candidateDraft), name: nextProviderName(), type, baseUrl, models: [], hasApiKey: false };
  const isNewProvider = !candidateDraft.providers.includes(provider);
  // 复用已有 Provider 时保留它的默认协议；不同协议只记录在当前模型上。
  if (isNewProvider) { provider.type = type; provider.baseUrl = baseUrl; }
  provider.models ||= [];
  const model = oldModel || { id: modelId };
  model.id = modelId;
  if ($('model-name').value.trim()) model.name = $('model-name').value.trim(); else delete model.name;
  // 同地址不同协议时只覆盖当前模型，避免改变同一 Provider 的其他模型。
  assignOptional(model, 'type', provider.type === type ? undefined : type);
  assignOptional(model, 'baseUrl', normalizeUrl(provider.baseUrl) === normalizeUrl(baseUrl) ? undefined : baseUrl);
  assignOptional(model, 'contextWindow', readOptionalNumber('model-context'));
  assignOptional(model, 'maxOutputTokens', readOptionalNumber('model-output'));
  const tool = $('model-tool').value; assignOptional(model, 'toolCalling', tool === '' ? undefined : tool === 'true');
  const vision = $('model-vision').value; assignOptional(model, 'vision', vision === '' ? undefined : vision === 'true');
  if ($('clear-key').checked) { provider.clearApiKey = true; delete provider.apiKey; model.clearApiKey = true; delete model.apiKey; }
  if (key) {
    if (!isNewProvider) { model.apiKey = key; delete model.apiKeyEnv; delete model.clearApiKey; }
    else { provider.apiKey = key; delete provider.apiKeyEnv; delete provider.clearApiKey; delete model.apiKey; delete model.apiKeyEnv; }
  } else if (oldModel && !$('clear-key').checked && (oldProvider !== provider || editingModelId !== modelId)) {
    // 改地址/模型名会改变 ID：只传原模型引用，由服务端恢复 Key，避免新分组丢失凭据。
    const owner = isNewProvider ? provider : model;
    owner.apiKeyFrom = { provider: editingProviderId, model: editingModelId };
    delete owner.apiKey; delete owner.apiKeyEnv;
  }
  if (editing && oldProvider && oldProvider !== provider && oldModel) {
    oldProvider.models = (oldProvider.models || []).filter(item => item !== oldModel);
    if (!oldProvider.models.length) candidateDraft.providers = candidateDraft.providers.filter(item => item !== oldProvider);
    if (wasDefault) { candidateDraft.provider = provider.id; candidateDraft.model = model.id; }
  }
  if (!candidateDraft.providers.includes(provider)) candidateDraft.providers.push(provider);
  provider.models ||= [];
  if (!provider.models.includes(model)) provider.models.push(model);
  if (model.enabled !== false && (!candidateDraft.provider || wasDefault)) { candidateDraft.provider = provider.id; candidateDraft.model = model.id; }
  return { provider, model };
}
async function testModelDialog() {
  if (busy) return;
  invalidateModelTest();
  const candidate = structuredClone(draft), result = applyModelDialogDraft(candidate);
  if (!result) return;
  const fingerprint = modelDialogFingerprint();
  busy = true;
  $('model-test').disabled = true;
  $('model-dialog-help').textContent = '正在测试连接，请稍候…';
  status('正在测试连接…');
  try {
    const response = await api('test-draft', 'POST', {
      revision: snapshot.revision,
      config: candidate,
      test: { provider: result.provider.id, model: result.model.id, confirm: true },
    });
    if (!response.ok) {
      const message = response.message || '连接失败，请检查接口地址、模型和 API Key。';
      $('model-dialog-help').textContent = '测试失败：' + message + ' 模型不会保存。';
      status(message, true);
      return;
    }
    modelTestCandidate = candidate;
    modelTestFingerprint = fingerprint;
    $('model-submit').disabled = false;
    $('model-dialog-help').textContent = '测试连接成功，现在可以保存此模型。';
    status(response.message || '连接测试成功。');
  } catch (error) {
    const message = error instanceof Error ? error.message : '连接测试失败，请检查配置。';
    $('model-dialog-help').textContent = '测试失败：' + message + ' 模型不会保存。';
    status(message, true);
  } finally {
    busy = false;
    $('model-test').disabled = false;
  }
}
async function saveModelDialog(event) {
  event.preventDefault();
  if (busy) return;
  if (!modelTestCandidate || modelTestFingerprint !== modelDialogFingerprint()) {
    const message = '请先点击“测试连接”，测试通过后才能保存模型。';
    $('model-dialog-help').textContent = message; status(message, true); return;
  }
  const before = structuredClone(draft);
  draft = structuredClone(modelTestCandidate);
  const saved = await save();
  if (saved) closeModelDialog();
  else { draft = before; invalidateModelTest(); render(); }
}
function defaults() {
  const modelSelect = $('default-model'); modelSelect.replaceChildren();
  const entries = allModels().filter(entry => entry.model.enabled !== false), counts = new Map();
  entries.forEach(entry => counts.set(modelName(entry), (counts.get(modelName(entry)) || 0) + 1));
  const automatic = node('option', '按配置顺序自动选择'); automatic.value = ''; modelSelect.append(automatic);
  entries.forEach(entry => { const option = node('option', displayName(entry, counts)); option.value = JSON.stringify([entry.provider.id, entry.model.id]); modelSelect.append(option); });
  const current = draft.provider && draft.model ? JSON.stringify([draft.provider, draft.model]) : '';
  modelSelect.value = entries.some(entry => JSON.stringify([entry.provider.id, entry.model.id]) === current) ? current : '';
  modelSelect.onchange = async () => { const before = structuredClone(draft); if (!modelSelect.value) { delete draft.provider; delete draft.model; } else { const selected = JSON.parse(modelSelect.value); draft.provider = selected[0]; draft.model = selected[1]; } render(); if (!await save()) { draft = before; render(); } };
}
async function toggleModel(entry, enabled) {
  const before = structuredClone(draft);
  if (enabled) delete entry.model.enabled;
  else entry.model.enabled = false;
  if (!enabled && draft.provider === entry.provider.id && draft.model === entry.model.id) {
    const candidates = allModels().filter(candidate => candidate.model.enabled !== false);
    const fallback = candidates.find(candidate => candidate.provider === entry.provider) || candidates[0];
    if (fallback) { draft.provider = fallback.provider.id; draft.model = fallback.model.id; }
    else { delete draft.provider; delete draft.model; }
  }
  render();
  if (!await save()) { draft = before; render(); return; }
  status('“' + modelName(entry) + '”已' + (enabled ? '启用' : '停用') + '，已保存。');
}
function modelSwitch(entry) {
  const label = node('label', undefined, 'model-toggle'), input = node('input'), track = node('span', undefined, 'switch-track'), text = node('span', entry.model.enabled === false ? '已停用' : '已启用', 'model-toggle-label');
  input.type = 'checkbox'; input.id = 'model-toggle-' + encodeURIComponent(JSON.stringify([entry.provider.id, entry.model.id])); input.setAttribute('role', 'switch'); input.checked = entry.model.enabled !== false; input.setAttribute('aria-label', '启用模型 ' + modelName(entry)); input.disabled = busy;
  input.onchange = async () => { await toggleModel(entry, input.checked); $(input.id).focus(); };
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
      const actions = node('div', undefined, 'actions'), testButton = button('测试连接', () => test(entry, testButton));
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
}

async function deleteModel(entry) {
  if (!await confirmAction('删除模型', '删除“' + modelName(entry) + '”？此操作会立即保存。')) return;
  const before = structuredClone(draft);
  entry.provider.models = (entry.provider.models || []).filter(model => model !== entry.model);
  if (!entry.provider.models.length) draft.providers = draft.providers.filter(provider => provider !== entry.provider);
  if (draft.provider === entry.provider.id && draft.model === entry.model.id) { delete draft.provider; delete draft.model; }
  render();
  if (!await save()) { draft = before; render(); }
}
async function load() {
  try { snapshot = await api('config'); draft = editableDraftFromEffective(); render(); status(snapshot.errors.length ? '配置有错误，未允许覆盖：' + snapshot.errors.join('；') : '配置已加载。', Boolean(snapshot.errors.length)); }
  catch(error) { status(error.message, true); }
}
async function save() {
  if (busy) return false;
  let migrate = false;
  if (snapshot.requiresMigration) { migrate = await confirmAction('迁移为 JSON', '将保存为 JSON，原配置文件会保留并备份。注释不会迁入新文件。是否继续？'); if (!migrate) return false; }
  busy = true; document.querySelectorAll('.model-toggle input').forEach(input => { input.disabled = true; });
  try {
    const body = { revision: snapshot.revision, migrate, config: draft };
    snapshot = await api('config', 'PUT', body); draft = structuredClone(snapshot.config); render();
    status('已保存。' + (snapshot.backup ? '原配置已备份。' : ''));
    return true;
  } catch(error) { status('保存失败：' + error.message, true); return false; }
  finally { busy = false; document.querySelectorAll('.model-toggle input').forEach(input => { input.disabled = false; }); }
}

async function test(entry, control) {
  if (busy) return;
  // 点击按钮即表示测试意图，不重复弹窗；忙状态防止连点产生多次请求。
  busy = true;
  if (control) { control.disabled = true; control.textContent = '测试中…'; }
  status('正在测试连接…');
  try { const result = await api('test', 'POST', { provider: entry.provider.id, model: entry.model.id, confirm: true }); status(result.message, !result.ok); }
  catch(error) { status(error.message, true); }
  finally {
    busy = false;
    if (control) { control.disabled = entry.model.enabled === false; control.textContent = '测试连接'; }
  }
}
$('model-endpoint').onchange = selectModelEndpoint;
$('model-endpoint-toggle').onclick = toggleModelEndpointMenu;
$('model-type-toggle').onclick = toggleModelTypeMenu;
$('model-type').onchange = () => { syncModelTypeDisplay(); renderModelTypeMenu(); };
$('model-url').oninput = handleModelUrlInput;
window.addEventListener('click', event => {
  const target = event.target;
  if (!target || !target.closest || !target.closest('.endpoint-picker')) closeModelEndpointMenu();
  if (!target || !target.closest || !target.closest('.protocol-picker')) closeModelTypeMenu();
});
window.addEventListener('keydown', event => { if (event.key === 'Escape') { closeModelEndpointMenu(); closeModelTypeMenu(); } });
renderModelTypeMenu(); syncModelTypeDisplay();
$('model-form').onsubmit = saveModelDialog;
$('model-test').onclick = testModelDialog;
$('model-form').addEventListener('input', invalidateModelTest);
$('model-form').addEventListener('change', invalidateModelTest);
$('model-cancel').onclick = closeModelDialog;
$('provider-form').onsubmit = saveProviderDialog;
$('provider-cancel').onclick = closeProviderDialog;
$('add-model').onclick = () => openModelDialog(null);
$('reload').onclick = load;
if (!token) { status('请从终端运行 comecode admin 打开授权页面。', true); $('add-model').disabled = true; } else load();
`;
