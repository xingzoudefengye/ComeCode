export const ADMIN_PROVIDER_SCRIPT = String.raw`
function openProviderDialog(provider) {
  const isNew = !provider;
  provider ||= {id:nextProviderId(draft),models:[]};
  editing = { provider, isNew };
  $('provider-edit-key').type = 'password';
  $('provider-dialog-title').textContent = isNew ? '添加供应商' : '编辑供应商';
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
function closeProviderDialog() { $('provider-edit-key').value = ''; editing = null; $('provider-dialog').close(); }
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
  if (editing.isNew) draft.providers.push(provider);
  const saved = await save();
  if (saved) closeProviderDialog();
  else { draft = before; render(); }
}
let selectedProviderId = '';
async function toggleProvider(provider, enabled) {
  if (busy) return;
  const before = structuredClone(draft);
  if (enabled) delete provider.enabled; else provider.enabled = false;
  if (!enabled && draft.provider === provider.id) {
    const next = allModels().find(entry => entry.provider.enabled !== false && entry.model.enabled !== false);
    if (next) { draft.provider = next.provider.id; draft.model = next.model.id; }
    else { delete draft.provider; delete draft.model; }
  }
  if (!await save()) { draft = before; render(); }
}
function providerSwitch(provider) {
  const label = node('label', undefined, 'model-toggle'), input = node('input'), track = node('span', undefined, 'switch-track');
  input.type = 'checkbox'; input.checked = provider.enabled !== false; input.disabled = busy;
  input.setAttribute('role', 'switch'); input.setAttribute('aria-label', '启用供应商 ' + (provider.name || provider.id));
  input.onchange = () => toggleProvider(provider, input.checked);
  label.append(input, track); return label;
}
async function deleteProvider(provider) {
  if (!await confirmAction('删除供应商', '删除供应商及其模型配置？不会删除会话。')) return;
  const before = structuredClone(draft);
  draft.providers = draft.providers.filter(item => item !== provider);
  if (draft.provider === provider.id) { delete draft.provider; delete draft.model; }
  if (!await save()) { draft = before; render(); }
}
function openProviderModel(provider) {
  openModelDialog(null); $('model-endpoint').value = provider.id; selectModelEndpoint();
}
function render() {
  defaults(); const container = $('providers'); container.replaceChildren();
  const selector = $('provider-selector'); selector.replaceChildren();
  selector.append(button('全部供应商', () => { selectedProviderId = ''; render(); }, selectedProviderId ? '' : 'selected'));
  draft.providers.forEach(provider => selector.append(button(provider.name || provider.id, () => { selectedProviderId = provider.id; render(); }, selectedProviderId === provider.id ? 'selected' : '')));
  if (!draft.providers.some(provider => provider.id === selectedProviderId)) selectedProviderId = '';
  if (!draft.providers.length) container.append(node('div', '还没有供应商。添加供应商后可配置模型。', 'empty'));
  draft.providers.filter(provider => !selectedProviderId || provider.id === selectedProviderId).forEach(provider => {
    const group = node('section', undefined, 'provider-group');
    const heading = node('div', undefined, 'provider-heading'), info = node('div'), name = node('div', undefined, 'provider-name');
    name.append(node('strong', provider.name || provider.id), node('span', provider.enabled === false ? '已停用' : '已启用', 'enabled-badge'));
    info.append(name, node('span', (provider.models || []).length + ' 个模型', 'provider-meta'));
    const actions = node('div', undefined, 'actions'), menu = node('details', undefined, 'provider-menu');
    menu.append(node('summary', '菜单'));
    const edit = button('编辑供应商', () => openProviderDialog(provider)); edit.setAttribute('aria-label', '编辑供应商');
    menu.append(edit, button('删除供应商', () => deleteProvider(provider), 'danger'));
    actions.append(providerSwitch(provider), menu); heading.append(info, actions); group.append(heading);
    const fields = node('div', undefined, 'provider-fields');
    for (const [label, value] of [['Base URL', provider.baseUrl || '未设置'], ['API 格式', protocolName(provider.type)], ['API Key', provider.hasApiKey || provider.apiKeyEnv ? '已配置 · 不回显' : '未配置']]) {
      const field = node('div'); field.append(node('small', label), node('div', value)); fields.append(field);
    }
    group.append(fields);
    (provider.models || []).forEach(model => {
      const entry = {provider, model}, row = node('div', undefined, model.enabled === false ? 'model-row is-disabled' : 'model-row');
      const heading = node('div', undefined, 'model-row-heading'), title = node('div');
      title.append(node('strong', modelName(entry)), node('span', protocolName(model.type || provider.type), 'model-protocol'));
      const actions = node('div', undefined, 'actions'), testButton = button('测试连接', () => test(entry, testButton));
      testButton.disabled = model.enabled === false || provider.enabled === false;
      actions.append(button('编辑', () => openModelDialog(entry)), button('删除', () => deleteModel(entry), 'danger'), testButton, modelSwitch(entry));
      heading.append(title, actions); row.append(heading);
      const meta = node('div', undefined, 'model-meta');
      meta.append(node('span', model.contextWindow ? model.contextWindow + ' 上下文' : '默认窗口'), node('span', model.vision === true ? '视觉' : model.vision === false ? '无视觉' : '视觉默认'), node('span', model.toolCalling === true ? '工具' : model.toolCalling === false ? '无工具' : '工具默认'), node('span', model.reasoningLevel || '默认思考强度'));
      row.append(meta); group.append(row);
    });
    group.append(button('+ 添加模型', () => openProviderModel(provider), 'add-provider-model')); container.append(group);
  });
  const sources = $('sources'); sources.replaceChildren();
  sources.append(node('p', '编辑用户配置：' + snapshot.source), node('p', '保存目标：' + snapshot.target));
  if (snapshot.effective.paths.project) sources.append(node('p', '项目覆盖：' + snapshot.effective.paths.project + '（只读，可能覆盖此页设置）'));
  sources.append(node('p', '优先级：CLI 参数 > 环境变量 > 项目配置 > 用户配置 > 旧配置 / 内置默认'));
  sources.append(node('pre', JSON.stringify(snapshot.effective, null, 2)));
}

$('add-provider').onclick = () => openProviderDialog(null);
`;
