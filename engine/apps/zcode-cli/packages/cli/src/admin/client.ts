import { ADMIN_PROVIDER_SCRIPT } from "./provider-assets.js";
// 页面只持有编辑草稿；原始凭据与有效配置均由服务端拥有。
export const ADMIN_SCRIPT = String.raw`
'use strict';
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('token') || sessionStorage.getItem('comecode-admin-token');
if (fragment.has('token')) { sessionStorage.setItem('comecode-admin-token', token); history.replaceState(null, '', location.pathname); }
let snapshot, draft, busy = false, editing = null, pendingNewProviderId = null;
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
  // 编辑用户事实源，不能把项目/环境的有效覆盖反写全局配置；仅空用户配置兼容旧 Provider 导入。
  if (snapshot.config.providers?.length) return structuredClone(snapshot.config);
  if (!effective || !Array.isArray(effective.providers) || effective.providers.length === 0) return structuredClone(snapshot.config);
  // 列表展示运行时有效模型；草稿不携带真实 Key，保存时由服务端按 ID 保留密钥。
  return {
    ...(effective.provider ? { provider: effective.provider } : {}),
    ...(effective.model ? { model: effective.model } : {}),
    providers: effective.providers.map(provider => ({
      id: provider.id,
      ...(provider.name ? { name: provider.name } : {}),
      ...(provider.type ? { type: provider.type } : {}),
      ...(provider.enabled === false ? { enabled: false } : {}),
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
        ...(model.reasoningLevel !== undefined ? { reasoningLevel: model.reasoningLevel } : {}),
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
  // Provider ID 是内部稳定主键，绝不由名称派生，也不随改名/改地址变化。
  // 与桌面端 personal-<uuid> 命名规则统一，避免同名供应商共用可读顺序名而互相错认。
  const ids = new Set(targetDraft.providers.map(provider => provider.id));
  let id = '';
  do { id = 'personal-' + randomId(); } while (ids.has(id));
  return id;
}
function randomId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const rand = Math.random() * 16 | 0;
    return (ch === 'x' ? rand : (rand & 0x3 | 0x8)).toString(16);
  });
}
function shortProviderId(id) { return typeof id === 'string' && id.length > 10 ? id.slice(-6) : id || ''; }
function allocateNewProviderId(targetDraft) {
  // 同一对话框会话（预览测试 → 保存）必须复用同一 Provider ID；
  // 否则测试连接识别出的 ID 与最终落盘的 ID 不一致，跨端操作就会按旧 ID 找不到配置。
  if (pendingNewProviderId && !targetDraft.providers.some(provider => provider.id === pendingNewProviderId)) return pendingNewProviderId;
  pendingNewProviderId = nextProviderId(targetDraft);
  return pendingNewProviderId;
}
function providerNameCounts() {
  const counts = new Map();
  for (const provider of draft.providers) {
    const key = provider.name || provider.id;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}
function providerDisplayName(provider, counts) {
  const base = provider.name || provider.id || '供应商';
  // 同名供应商追加 id 尾段消歧：名称可重复，但界面上必须能分辨具体是哪一个 Provider。
  return counts.get(base) > 1 ? base + '（' + shortProviderId(provider.id) + '）' : base;
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
    const item = button(option.textContent, () => { $('model-type').value = option.value; syncModelTypeDisplay(); closeModelTypeMenu(); renderModelTypeMenu(); }, 'protocol-picker-option');
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
  syncModelTypeDisplay(); closeModelEndpointMenu(); renderModelEndpointMenu(); updateModelKeyHint();
  if (!provider) $('model-url').focus();
}
function openModelDialog(entry) {
  editing = entry || null;
  pendingNewProviderId = null;
  const provider = entry && entry.provider;
  const model = entry && entry.model;
  $('model-dialog-title').textContent = entry ? '编辑模型' : '添加模型';
  populateModelEndpoints(entry);
  $('model-dialog-help').textContent = entry ? '修改这一个模型的连接信息；留空 API Key 表示保持原 Key。' : $('model-endpoint').hidden ? '只需要填写下面四项即可，其他设置可以保持默认。' : '直接填写接口地址，或点击右侧下拉选择已有接口以复用地址和 API Key。';
  $('model-id').value = model ? (model.id || '') : '';
  $('model-url').value = model && model.baseUrl ? model.baseUrl : (provider && provider.baseUrl ? provider.baseUrl : '');
  $('model-key').value = ''; $('model-key').type = 'password';
  $('model-key').placeholder = model && (model.hasApiKey || (provider && provider.hasApiKey)) ? '已配置，留空保持不变' : '输入服务商提供的 API Key';
  $('model-type').value = model && model.type ? model.type : (provider && provider.type ? provider.type : 'openai-chat');
  syncModelTypeDisplay(); renderModelTypeMenu(); closeModelTypeMenu();
  $('model-name').value = model && model.name ? model.name : '';
  $('model-context').value = model && model.contextWindow ? String(model.contextWindow) : '';
  $('model-output').value = model && model.maxOutputTokens ? String(model.maxOutputTokens) : '';
  $('model-tool').value = model && model.toolCalling !== undefined ? String(model.toolCalling) : '';
  $('model-vision').value = model && model.vision !== undefined ? String(model.vision) : '';
  $('model-reasoning').value = model && model.reasoningLevel ? model.reasoningLevel : 'high';
  $('clear-key').checked = false;
  $('model-more').open = false;
  $('model-dialog').showModal();
}
function closeModelDialog() { $('model-key').value = ''; editing = null; pendingNewProviderId = null; $('model-dialog').close(); }
function readOptionalNumber(id) { const value = $(id).value.trim(); return value ? Number(value) : undefined; }
function assignOptional(object, key, value) { if (value === undefined || value === '') delete object[key]; else object[key] = value; }
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
  else if (!provider || (editing && normalizeUrl(provider.baseUrl) !== normalizeUrl(baseUrl))) provider = { id: allocateNewProviderId(candidateDraft), name: nextProviderName(), type, baseUrl, models: [], hasApiKey: false };
  if (!provider) provider = { id: allocateNewProviderId(candidateDraft), name: nextProviderName(), type, baseUrl, models: [], hasApiKey: false };
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
  assignOptional(model, 'reasoningLevel', $('model-reasoning').value);
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
    // 模型已迁移到新 Provider：旧 Provider 若已无模型则立即移除，
    // 否则会留下同名空壳，让后续操作按旧 id 找不到配置。
    if (oldProvider.models.length === 0) candidateDraft.providers = candidateDraft.providers.filter(item => item !== oldProvider);
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
  const candidate = structuredClone(draft), result = applyModelDialogDraft(candidate);
  if (!result) return;
  busy = true;
  $('model-submit').disabled = true;
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
      $('model-dialog-help').textContent = '测试失败：' + message + ' 仍可保存配置。';
      status(message, true);
      return;
    }
    $('model-dialog-help').textContent = '测试连接成功；测试不会保存配置。';
    status(response.message || '连接测试成功。');
  } catch (error) {
    const message = error instanceof Error ? error.message : '连接测试失败，请检查配置。';
    $('model-dialog-help').textContent = '测试失败：' + message + ' 仍可保存配置。';
    status(message, true);
  } finally {
    busy = false;
    $('model-test').disabled = false;
    $('model-submit').disabled = false;
  }
}
async function saveModelDialog(event) {
  event.preventDefault();
  if (busy) return;
  // 测试只是诊断：保存读取当前表单，不能依赖旧测试结果或旧候选草稿。
  const candidate = structuredClone(draft);
  if (!applyModelDialogDraft(candidate)) return;
  const before = structuredClone(draft);
  draft = candidate;
  const saved = await save();
  if (saved) closeModelDialog();
  else { draft = before; render(); }
}
function defaults() {
  const modelSelect = $('default-model'); modelSelect.replaceChildren();
  const entries = allModels().filter(entry => entry.provider.enabled !== false && entry.model.enabled !== false), counts = new Map();
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
    const candidates = allModels().filter(candidate => candidate.provider.enabled !== false && candidate.model.enabled !== false);
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

async function deleteModel(entry) {
  if (!await confirmAction('删除模型', '删除“' + modelName(entry) + '”？此操作会立即保存。')) return;
  const before = structuredClone(draft);
  entry.provider.models = (entry.provider.models || []).filter(model => model !== entry.model);
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
${ADMIN_PROVIDER_SCRIPT}
for (const [eye, input] of [['model-key-eye','model-key'],['provider-key-eye','provider-edit-key']]) {
  $(eye).onclick = () => { const field = $(input); if (!field.value) return; field.type = field.type === 'password' ? 'text' : 'password'; $(eye).textContent = field.type === 'password' ? '查看' : '隐藏'; };
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
$('model-cancel').onclick = closeModelDialog;
$('provider-form').onsubmit = saveProviderDialog;
$('provider-cancel').onclick = closeProviderDialog;
$('add-model').onclick = () => openModelDialog(null);
$('reload').onclick = load;
if (!token) { status('请从终端运行 comecode admin 打开授权页面。', true); $('add-model').disabled = true; } else load();
`;
