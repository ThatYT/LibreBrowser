'use strict';
let engine='stream';let isPrototype=false;
let lang=localStorage.getItem('language')==='zh'?'zh':'en';let csrf='';let me=null;let signing=false;let loggingOut=false;let startController=null;
const $=s=>document.querySelector(s);const text=(en,zh)=>lang==='zh'?zh:en;
function translate(){document.documentElement.lang=lang==='zh'?'zh-CN':'en';document.querySelectorAll('[data-en]').forEach(e=>e.textContent=e.dataset[lang]);document.querySelectorAll('[data-nav-en]').forEach(e=>e.setAttribute('aria-label',e.dataset[lang==='zh'?'navZh':'navEn']));}
$('#language').onclick=()=>{lang=lang==='en'?'zh':'en';localStorage.setItem('language',lang);translate();};translate();
async function api(path,body,signal){const res=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin',cache:'no-store',signal});if(!res.ok){const error=new Error(res.status===401?text('Sign in again.','请重新登录。'):res.status===429?text('Too many attempts. Try again later.','尝试次数过多，请稍后再试。'):text('Request failed. Check your details or try again.','请求失败。请检查输入或重试。'));error.status=res.status;error.detail=(await res.text()).trim().slice(0,300);throw error;}return res.status===204?null:res.json();}
function show(id){['login','browser','account','users'].forEach(v=>$('#'+v).hidden=v!==id);}
async function start() {
  startController?.abort();
  const controller = new AbortController();
  startController = controller;
  show('browser');
  $('#retry').hidden = true;
  $('#browser-message').textContent = '';
  $('#stream').removeAttribute('src');
  $('#stop-browser').disabled = false;
  $('#loading').textContent = text('Starting your browser…', '正在启动浏览器…');
  try {
    await api('/api/browser/start', {}, controller.signal);
    for (let n = 0; n < 90; n++) {
      if (controller.signal.aborted) return;
      if (engine === 'dom') {
        try {
          const result = await api('/api/browser/viewer', {}, controller.signal);
          const url = new URL(result.url);
          url.searchParams.set('lang', lang);
          $('#stream').setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads allow-forms');
          $('#stream').src = url.href;
          $('#loading').textContent = '';
          return;
        } catch (error) {
          if (error.status === 401) { signedOut(); return; }
          if (error.status !== 503) throw error;
        }
      } else {
        const r = await fetch('/browser/', {cache: 'no-store', signal: controller.signal});
        if (r.ok) {
          $('#stream').removeAttribute('sandbox');
          $('#stream').src = '/browser/';
          $('#loading').textContent = '';
          return;
        }
        if (r.status === 401) { signedOut(); return; }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('timeout');
  } catch (error) {
    if (controller.signal.aborted) return;
    $('#loading').textContent = '';
    $('#retry').hidden = false;
    $('#browser-message').textContent = text('Browser unavailable. Reconnect to try again.', '浏览器暂不可用，请重新连接。');
  }
}
$('#stop-browser').onclick = async () => {
  startController?.abort();
  $('#stream').removeAttribute('src');
  $('#stop-browser').disabled = true;
  $('#loading').textContent = text('Stopping your browser…', '正在停止浏览器…');
  try {
    await api('/api/browser/stop', {});
    $('#browser-message').textContent = text('Browser stopped. Your saved profile is preserved.', '浏览器已停止，已保留个人配置。');
  } catch (error) {
    $('#browser-message').textContent = error.message;
  } finally {
    $('#loading').textContent = '';
    $('#retry').hidden = false;
  }
};
$('#login-form').onsubmit=async ev=>{ev.preventDefault();if(signing)return;signing=true;$('#login-form button').disabled=true;$('#login-error').textContent='';try{const data=Object.fromEntries(new FormData(ev.target));const result=await api('/api/login',data);csrf=result.csrf;me=result.user;engine=result.engine||'stream';isPrototype=result.prototype===true;ev.target.reset();await enterApp();}catch(e){$('#login-error').textContent=text('Unable to sign in. Check your credentials or try later.','无法登录。请检查用户名及密码，或稍后重试。');}finally{signing=false;$('#login-form button').disabled=false;}};
$('#reconnect').onclick=start;
$('#restart-browser').onclick=start;
function signedOut(){startController?.abort();$('#stream').removeAttribute('src');csrf='';me=null;location.replace('/');}
async function logout(){if(loggingOut)return;loggingOut=true;const buttons=document.querySelectorAll('[data-logout]');buttons.forEach(button=>button.disabled=true);$('#account-message').textContent='';$('#browser-message').textContent='';$('#users-message').textContent='';try{await api('/api/logout',{});signedOut();}catch(e){if(e.status===401){signedOut();return;}$('#account-message').textContent=e.message;$('#browser-message').textContent=e.message;$('#users-message').textContent=e.message;}finally{loggingOut=false;buttons.forEach(button=>button.disabled=false);}}
document.querySelectorAll('[data-logout]').forEach(button=>button.onclick=logout);
$('#password-form').onsubmit=async ev=>{ev.preventDefault();try{await api('/api/account/password',Object.fromEntries(new FormData(ev.target)));location.href='/';}catch(e){$('#account-message').textContent=e.message;}};


let usersBusy = false;
let selectedUser = null;

async function enterApp() {
  document.querySelectorAll('[data-prototype]').forEach(element => element.hidden = !isPrototype);
  if (isPrototype) $('#browser-toolbar > span').textContent = text('LibreBrowser · DOM test', 'LibreBrowser · DOM 测试');
  document.querySelectorAll('[data-admin-only]').forEach(link => link.hidden = me.role !== 'ADMIN');
  if (location.pathname === '/admin/users') {
    if (me.role !== 'ADMIN') {
      show('account');
      $('#account-message').textContent = text('Administrator access is required.', '需要管理员权限。');
      return;
    }
    show('users');
    await refreshUsers();
  } else if (location.pathname === '/account') {
    show('account');
  } else {
    await start();
  }
}

function userError(error) {
  if (error.status === 400 && error.detail.includes('last enabled administrator')) {
    return text('The last enabled administrator cannot be removed.', '无法删除最后一位启用的管理员。');
  }
  if (error.status === 400 && error.detail.includes('invalid or existing account')) {
    return text('The username already exists or the account details are invalid.', '用户名已存在或账户信息不符合要求。');
  }
  return error.message;
}

function setUsersBusy(busy) {
  usersBusy = busy;
  $('#users').querySelectorAll('[data-user-action], [data-close-dialog]').forEach(button => button.disabled = busy);
}

function userButton(label, user, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.userAction = '';
  button.onclick = () => {
    if (usersBusy) return;
    selectedUser = user;
    const dialog = $(action === 'reset' ? '#reset-user-dialog' : '#remove-user-dialog');
    dialog.querySelector('.selected-username').textContent = user.username;
    dialog.querySelector('.dialog-message').textContent = '';
    dialog.showModal();
  };
  return button;
}

async function loadUsers() {
  $('#user-list').setAttribute('aria-busy', 'true');
  try {
    const users = await api('/api/admin/users');
    const list = document.createDocumentFragment();
    for (const user of users) {
      const row = document.createElement('article');
      row.className = 'user-row';
      row.dataset.userId = user.id;
      const info = document.createElement('div');
      const name = document.createElement('h3');
      name.textContent = user.username;
      const details = document.createElement('p');
      details.textContent = [user.role === 'ADMIN' ? text('Administrator', '管理员') : text('User', '用户'), user.disabled ? text('Disabled', '已禁用') : text('Enabled', '已启用'), user.id === me.id ? text('You', '你') : ''].filter(Boolean).join(' · ');
      info.append(name, details);
      const actions = document.createElement('div');
      actions.className = 'user-actions';
      if (user.id === me.id) {
        const account = document.createElement('a');
        account.href = '/account';
        account.textContent = text('Change your password', '修改你的密码');
        actions.append(account);
      } else {
        const toggle = document.createElement('button');
        toggle.type = 'button'; toggle.dataset.userAction = '';
        toggle.textContent = user.disabled ? text('Enable', '启用') : text('Disable', '禁用');
        toggle.onclick = () => changeUsers(() => api('/api/admin/users/' + encodeURIComponent(user.id) + '/disabled', {value: String(!user.disabled)}), text('User updated.', '已更新用户。'));
        actions.append(toggle);
        actions.append(userButton(text('Reset password', '重置密码'), user, 'reset'), userButton(text('Remove', '删除'), user, 'remove'));
      }
      row.append(info, actions);
      list.append(row);
    }
    $('#user-list').replaceChildren(list);
  } finally {
    $('#user-list').setAttribute('aria-busy', 'false');
  }
}

function adminFailure(error, dialog) {
  if (error.status === 401) { signedOut(); return; }
  if (error.status === 403) {
    if (dialog?.open) dialog.close();
    document.querySelectorAll('[data-admin-only]').forEach(link => link.hidden = true);
    show('account');
    $('#account-message').textContent = text('Administrator access is required.', '需要管理员权限。');
    return;
  }
  (dialog?.open ? dialog.querySelector('.dialog-message') : $('#users-message')).textContent = userError(error);
}

async function refreshUsers() {
  if (usersBusy) return;
  setUsersBusy(true);
  $('#users-message').textContent = text('Loading users…', '正在加载用户…');
  try {
    await loadUsers();
    $('#users-message').textContent = '';
  } catch (error) {
    adminFailure(error);
  } finally {
    setUsersBusy(false);
  }
}

async function changeUsers(change, success, dialog) {
  if (usersBusy) return;
  setUsersBusy(true);
  $('#users-message').textContent = '';
  if (dialog) dialog.querySelector('.dialog-message').textContent = '';
  try {
    await change();
    if (dialog) dialog.close();
    $('#users-message').textContent = success;
    try { await loadUsers(); }
    catch (error) {
      if (error.status === 401 || error.status === 403) adminFailure(error);
      else $('#users-message').textContent = success + ' ' + text('Refresh to reload the user list.', '请刷新用户列表。');
    }
  } catch (error) {
    adminFailure(error, dialog);
  } finally {
    setUsersBusy(false);
  }
}

function validUserPassword(password) {
  const size = new TextEncoder().encode(password).length;
  if (size >= 12 && size <= 1024) return true;
  $('#users-message').textContent = text('Use a password of 12–1024 bytes.', '密码须为12至1024字节。');
  return false;
}

$('#refresh-users').onclick = refreshUsers;
$('#add-user-form').onsubmit = async event => {
  event.preventDefault();
  if (usersBusy) return;
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  if (!validUserPassword(data.password)) return;
  await changeUsers(async () => {
    await api('/api/admin/users', data);
    form.reset();
  }, text('User added.', '已添加用户。'));
  form.elements.password.value = '';
};
$('#reset-user-form').onsubmit = async event => {
  event.preventDefault();
  if (usersBusy || !selectedUser) return;
  const form = event.target;
  const password = form.elements.password.value;
  const size = new TextEncoder().encode(password).length;
  if (size < 12 || size > 1024) {
    $('#reset-user-dialog .dialog-message').textContent = text('Use a password of 12–1024 bytes.', '密码须为12至1024字节。');
    return;
  }
  const target = selectedUser.id;
  await changeUsers(() => api('/api/admin/users/' + encodeURIComponent(target) + '/password', {value: password}), text('Password reset. The user has been signed out.', '已重置密码并退出该用户的登录。'), $('#reset-user-dialog'));
  form.reset();
};
$('#confirm-remove-user').onclick = async () => {
  if (usersBusy || !selectedUser) return;
  const target = selectedUser.id;
  await changeUsers(() => api('/api/admin/users/' + encodeURIComponent(target) + '/delete', {}), text('User removed. Their saved browser profile is retained.', '已删除用户，保留其已保存的浏览器配置。'), $('#remove-user-dialog'));
};
document.querySelectorAll('[data-close-dialog]').forEach(button => button.onclick = () => button.closest('dialog').close());
document.querySelectorAll('#users dialog').forEach(dialog => {
  dialog.addEventListener('cancel', event => { if (usersBusy) event.preventDefault(); });
  dialog.addEventListener('close', () => { $('#reset-user-form').reset(); selectedUser = null; });
});

(async()=>{try{const result=await api('/api/me');csrf=result.csrf;me=result.user;engine=result.engine||'stream';isPrototype=result.prototype===true;await enterApp();}catch(e){show('login');}finally{$('#login-form button[type="submit"]').disabled=false;}})();
