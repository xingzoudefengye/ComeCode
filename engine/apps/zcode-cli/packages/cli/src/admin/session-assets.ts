export const ADMIN_SESSIONS_SCRIPT = String.raw`
let sessionOffset = 0, sessionGeneration = 0, sessionView = 'all', currentSessions = [], selectedSessionId = '';
const sessionIcons = {
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6Z"></path><path d="m14 5 5 5"></path></svg>',
  archive: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"></path></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4"></path></svg>'
};
function sessionIconButton(name, icon, action, className = 'session-icon') {
  const control = button('', action, className);
  control.innerHTML = sessionIcons[icon]; control.setAttribute('aria-label', name); control.title = name;
  return control;
}
async function setSessionArchived(session, control) {
  if (control.disabled) return;
  control.disabled = true; sessionStatus('正在保存…');
  try {
    await api('sessions/' + encodeURIComponent(session.id), 'PATCH', {expectedUpdated:session.time.updated, archived:!session.time.archived});
    await loadSessions();
    if (selectedSessionId === session.id) await loadSessionDetail(session.id);
    sessionStatus(session.time.archived ? '已取消归档' : '会话已归档');
  } catch (error) { sessionStatus(error.message); }
  finally { control.disabled = false; }
}
const SESSION_MINUTE_MS = 60_000, SESSION_HOUR_MS = 60 * SESSION_MINUTE_MS, SESSION_DAY_MS = 24 * SESSION_HOUR_MS;
function validSessionUpdated(timestamp) {
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 && !Number.isNaN(new Date(timestamp).getTime());
}
function formatSessionUpdated(timestamp, now = Date.now()) {
  if (!validSessionUpdated(timestamp)) return '更新时间未知';
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < SESSION_MINUTE_MS) return '刚刚';
  if (elapsed < SESSION_HOUR_MS) return Math.floor(elapsed / SESSION_MINUTE_MS) + '分钟前';
  if (elapsed < SESSION_DAY_MS) return Math.floor(elapsed / SESSION_HOUR_MS) + '小时前';
  return Math.floor(elapsed / SESSION_DAY_MS) + '天前';
}
function renderSessionList() {
  const now = Date.now();
  const list = $('session-list'); list.replaceChildren();
  const append = (session, parent) => {
    const row = node('div', undefined, 'session-list-row');
    const item = button('', () => { selectedSessionId = session.id; renderSessionList(); loadSessionDetail(session.id); }, 'session-item');
    if (selectedSessionId === session.id) row.className += ' is-selected';
    item.setAttribute('aria-pressed', String(selectedSessionId === session.id));
    const metadata = node('span', undefined, 'session-item-meta');
    const directory = node('small', session.directory + (session.time.archived ? ' · 已归档' : ''), 'session-item-directory');
    directory.title = session.directory;
    const updated = node('small', formatSessionUpdated(session.time.updated, now), 'session-item-updated');
    updated.title = validSessionUpdated(session.time.updated) ? '更新时间：' + new Date(session.time.updated).toLocaleString('zh-CN') : '更新时间未知';
    updated.setAttribute('aria-label', '更新时间：' + updated.textContent);
    metadata.append(directory, updated);
    item.append(node('span', session.title || '未命名会话', 'session-item-title'), metadata);
    const rename = sessionIconButton('重命名会话', 'edit', () => renameSessionInList(session, row), 'session-icon session-rename');
    const archive = sessionIconButton(session.time.archived ? '取消归档会话' : '归档会话', 'archive', () => setSessionArchived(session, archive));
    const actions = node('div', undefined, 'session-row-actions'); actions.append(rename, archive);
    row.append(item, actions); parent.append(row);
  };
  if (sessionView === 'all') currentSessions.forEach(session => append(session, list));
  else {
    const projects = new Map();
    for (const session of currentSessions) {
      const key = session.workspaceIdentity?.trim() || session.directory;
      if (!projects.has(key)) projects.set(key, []); projects.get(key).push(session);
    }
    for (const [key, sessions] of projects) {
      const group = node('section'); group.append(node('h2', key || '未指定项目', 'session-project-title'));
      sessions.forEach(session => append(session, group)); list.append(group);
    }
  }
  $('session-filter').value = $('session-archived').checked ? 'archived' : sessionView;
  $('session-view-hint').textContent = sessionView === 'all' ? '按最近更新排序' : '当前页结果按项目分组；非全量项目索引';
}
async function renameSessionInList(session, row) {
  const input = node('input'); input.value = session.title; input.maxLength = 30;
  input.setAttribute('aria-label', '会话标题');
  const save = button('保存', async () => {
    if (save.disabled) return;
    save.disabled = true;
    try {
      await api('sessions/' + encodeURIComponent(session.id), 'PATCH', {expectedUpdated:session.time.updated, title:input.value});
      await loadSessions();
      if (selectedSessionId === session.id) await loadSessionDetail(session.id);
      sessionStatus('会话已重命名');
    } catch (error) { sessionStatus(error.message); save.disabled = false; }
  });
  input.onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); return save.onclick(); }
    if (event.key === 'Escape') { event.preventDefault(); renderSessionList(); }
  };
  row.replaceChildren(input, save, button('取消', renderSessionList)); input.focus(); input.select();
}
$('session-filter').onchange = () => {
  const filter = $('session-filter').value;
  sessionView = filter === 'project' ? 'project' : 'all';
  $('session-archived').checked = filter === 'archived';
  sessionOffset = 0;
  return loadSessions();
};
const sessionStatus = text => { $('session-status').textContent = text; };
for (const [id, page] of [['nav-models', 'models-page'], ['nav-sessions', 'sessions-page']]) {
  $(id).onclick = () => {
    for (const [nav, target] of [['nav-models', 'models-page'], ['nav-sessions', 'sessions-page']]) {
      $(target).hidden = target !== page; $(nav).setAttribute('aria-pressed', String(nav === id));
    }
    if (page === 'sessions-page') loadSessions();
  };
}
async function loadSessions() {
  const generation = ++sessionGeneration;
  sessionStatus('正在读取会话…');
  try {
    const query = new URLSearchParams({offset:String(sessionOffset), limit:'25', search:$('session-search').value, archived:String($('session-archived').checked)});
    const data = await api('sessions?' + query);
    if (generation !== sessionGeneration) return;
    currentSessions = data.sessions; renderSessionList();
    $('session-prev').disabled = sessionOffset === 0;
    $('session-next').disabled = !data.hasMore;
    sessionStatus(data.sessions.length ? '第 ' + (sessionOffset + 1) + ' 项起，共 ' + data.sessions.length + ' 项' : '没有匹配的会话');
  } catch (error) { if (generation === sessionGeneration) sessionStatus(error.message); }
}
let detailGeneration = 0, loadedConversation = [], loadedCopyButton;
function messageContent(message) {
  return message.content + (message.truncated ? '\n[内容已截断]' : '');
}
async function copyConversationContent(text) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const previous = document.activeElement, selection = document.getSelection();
      const ranges = selection ? Array.from({length:selection.rangeCount}, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
      const field = document.createElement('textarea'); field.value = text;
      field.style.position = 'fixed'; field.style.opacity = '0';
      document.body.append(field);
      try {
        field.select();
        if (!document.execCommand('copy')) throw new Error('copy rejected');
      } finally {
        field.remove(); previous?.focus();
        if (selection) { selection.removeAllRanges(); ranges.forEach(range => selection.addRange(range)); }
      }
    }
    sessionStatus('内容已复制');
  } catch { sessionStatus('复制失败，请选择正文手动复制。'); }
}
async function loadSessionDetail(id, offset = 0, append = false) {
  const generation = ++detailGeneration;
  try {
    const data = await api('sessions/' + encodeURIComponent(id) + '?offset=' + offset);
    if (generation !== detailGeneration) return;
    const detail = $('session-detail');
    if (!append) {
      loadedConversation = [];
      detail.replaceChildren();
      const actions = node('div', undefined, 'actions');
      const change = async patch => {
        try {
          await api('sessions/' + encodeURIComponent(id), 'PATCH', {expectedUpdated:data.session.time.updated, ...patch});
          await loadSessionDetail(id); await loadSessions(); sessionStatus('会话已保存');
        } catch (error) { sessionStatus(error.message); }
      };
      actions.append(button(data.session.time.archived ? '取消归档' : '归档', () => change({archived:!data.session.time.archived})));
      actions.append(button('复制会话 ID', () => copyConversationContent(id)));
      const copyLoaded = button('复制已加载对话', () => copyConversationContent(loadedConversation.map(message => (message.role === 'user' ? '用户' : '助手') + '\n' + messageContent(message)).join('\n\n')));
      loadedCopyButton = copyLoaded; copyLoaded.disabled = true;
      actions.append(copyLoaded);
      const recovery = node('div', undefined, 'session-recovery');
      recovery.append(node('pre', data.resumeCommand), sessionIconButton('复制恢复命令', 'copy', () => copyConversationContent(data.resumeCommand)));
      const heading = node('div', undefined, 'session-detail-header');
      heading.append(node('h2', data.session.title || '未命名会话', 'session-detail-title'), node('p', data.session.directory, 'session-detail-directory'), recovery);
      actions.className = 'actions session-secondary-actions';
      const more = node('details', undefined, 'session-more-actions'); more.append(node('summary', '更多操作'), actions);
      heading.append(more);
      detail.append(heading, node('div', undefined, 'session-history'));
      if (data.desktopResumeAvailable === true) {
        const resume = button('在桌面恢复', async () => {
          if (resume.disabled) return;
          resume.disabled = true;
          try { await api('sessions/' + encodeURIComponent(id) + '/resume', 'POST', {}); sessionStatus('已请求桌面恢复会话'); }
          catch (error) { sessionStatus(error.message); }
          finally { resume.disabled = false; }
        });
        actions.append(resume);
      }
    }
    const history = detail.querySelector('.session-history');
    history.querySelector('.history-more')?.remove();
    for (const message of data.messages) {
      if (typeof message.content !== 'string' || !message.content.trim()) continue;
      loadedConversation.push(message);
      const isUser = message.role === 'user';
      const entry = node('article', undefined, 'session-message ' + (isUser ? 'session-message-user' : 'session-message-assistant'));
      const heading = node('div', undefined, 'session-message-heading');
      const copy = button('', () => copyConversationContent(messageContent(message)), 'session-message-copy');
      copy.setAttribute('aria-label', '复制正文'); copy.title = '复制正文';
      copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4"></path></svg>';
      heading.append(node('strong', isUser ? '用户' : '助手'), copy);
      const bubble = node('div', undefined, 'session-message-bubble');
      bubble.append(node('pre', messageContent(message)));
      entry.append(heading, bubble);
      history.append(entry);
    }
    if (loadedCopyButton) loadedCopyButton.disabled = loadedConversation.length === 0;
    if (data.hasMore) history.append(button('读取下一页历史', () => loadSessionDetail(id, data.nextOffset, true), 'history-more'));
  } catch (error) { if (generation === detailGeneration) sessionStatus(error.message); }
}
$('session-search-form').onsubmit = event => { event.preventDefault(); sessionOffset = 0; loadSessions(); };
function syncSearchVisibility() {
  $('session-search-form').hidden = false;
  $('session-search-toggle').setAttribute('aria-expanded', 'true');
}
if (typeof ResizeObserver !== 'undefined') {
  const toolbar = $('session-search-toggle').closest('.session-toolbar');
  if (toolbar) new ResizeObserver(syncSearchVisibility).observe(toolbar);
}
syncSearchVisibility();
$('session-search-toggle').onclick = () => {
  sessionOffset = 0; return loadSessions();
};
$('session-search').onkeydown = event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  $('session-search').value = ''; syncSearchVisibility(); $('session-search-toggle').focus();
  sessionOffset = 0; return loadSessions();
};
$('session-archived').onchange = () => { sessionOffset = 0; return loadSessions(); };
$('sessions-reload').onclick = () => loadSessions();
$('session-prev').onclick = () => { sessionOffset = Math.max(0, sessionOffset - 25); loadSessions(); };
$('session-next').onclick = () => { sessionOffset += 25; loadSessions(); };
`;
export const ADMIN_SESSIONS_STYLE = `
[hidden]{display:none!important}.admin-nav{position:fixed;top:52px;bottom:0;left:0;width:180px;padding:24px 12px;background:var(--surface);border-right:1px solid var(--line)}.admin-nav button{display:block;width:100%;margin-bottom:8px;text-align:left}.admin-nav button[aria-pressed=true]{border-color:var(--accent)}main{margin-left:180px;max-width:none}.session-layout{display:grid;grid-template-columns:minmax(340px,2fr) minmax(300px,3fr);gap:0;margin-top:24px;align-items:start}.session-list-pane{min-width:0;padding-right:24px;border-right:1px solid var(--line)}.session-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:16px;overflow-x:auto}.session-toolbar>strong{white-space:nowrap;margin-right:auto}.session-toolbar .actions{gap:4px;flex-wrap:nowrap}.session-toolbar button{padding:6px 8px}.session-toolbar #session-search-form{margin:0;flex:0 0 auto}.session-toolbar #session-search{width:calc(5em + 16px);min-height:30px;padding:5px 8px}.session-toolbar button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}#session-detail .actions{flex-wrap:wrap}.session-list-row{display:flex;align-items:flex-start;gap:4px;margin-bottom:8px}.session-list-row .session-item{flex:1;min-width:0;margin-bottom:0}.session-list-row input{min-width:0}.session-rename{padding:6px;margin-top:4px;flex-shrink:0}.session-recovery{position:relative;font-size:calc(var(--ui-font-size) - 2px);color:var(--muted)}.session-recovery summary{cursor:pointer}.session-recovery pre{max-width:100%;overflow-wrap:anywhere}#session-detail>.actions>button{padding:6px 10px}.session-item{display:block;width:100%;text-align:left;margin-bottom:8px;white-space:normal;overflow-wrap:anywhere}.session-item small{display:block;color:var(--muted);margin-top:8px}.session-message{border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:12px;background:var(--surface)}.session-message-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.session-message-heading button{padding:5px 10px}.session-message pre{overflow-wrap:anywhere}#session-detail{min-width:0}@media(max-width:720px){.admin-nav{position:static;width:auto;display:flex;gap:8px;padding:12px}.admin-nav button{margin:0}main{margin-left:0}.session-layout{grid-template-columns:1fr}}
`;
