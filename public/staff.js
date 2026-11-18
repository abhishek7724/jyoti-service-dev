import { printInvoice, printPurchase } from './documents.js';

const $ = (id) => document.getElementById(id);
const e = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = (value) => new Intl.NumberFormat('en-IN',{ style:'currency',currency:'INR' }).format(Number(value));
const date = (value) => new Date(value).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'});
const options = (values,selected) => values.map(v => {
  const [value,label] = typeof v === 'string' ? [v,v] : v;
  return '<option value="'+e(value)+'"'+(String(value) === String(selected) ? ' selected' : '')+'>'+e(label)+'</option>';
}).join('');
const input = (label,name,attributes = '') => '<label>'+label+'<input name="'+name+'" '+attributes+'></label>';
const select = (label,name,values,value) => '<label>'+label+'<select name="'+name+'" required>'+options(values,value)+'</select></label>';
const btn = (label,id,secondary = false) => '<button type="button" id="'+id+'"'+(secondary ? ' class="secondary"' : '')+'>'+label+'</button>';
const formData = form => Object.fromEntries(new FormData(form));
const submitButton = (label) => '<button>'+label+'</button>';
const placeholder = (label) => ['',label];
const applianceOptions = ['Refrigerator','Washing Machine','Air Conditioner','Television','Microwave','Water Purifier','Water Heater','Dishwasher','Chimney','Mixer Grinder','Induction Cooktop','Air Cooler','Other'];
const brandOptions = ['LG','Samsung','Whirlpool','Godrej','IFB','Bosch','Siemens','Haier','Panasonic','Sony','Voltas','Blue Star','Daikin','Hitachi','Carrier','Lloyd','Onida','Philips','Prestige','Bajaj','Havells','Crompton','Kent','Aquaguard','AO Smith','Racold','Other','Unknown'];
const localityOptions = ['Bhagwanpur','Godhanpur','Bhatti Road','Pratappur Naka','D.C. Road','Other'];
const pages = { tickets:'Service tickets',catalog:'Items and suppliers',purchases:'Purchasing',billing:'Billing' };
const originalTicket = new URL(location.href).searchParams.get('ticket') || '';
let filter = /^[1-9][0-9]{4}$/.test(originalTicket) ? originalTicket : '';
let ticketScope = filter ? 'all' : 'open';
const ticketStatuses = ['New','Assigned','In Progress','Awaiting Parts','Repair Complete'];
let offset = 0;
let user, refresh, page = 'tickets', pageGeneration = 0, noticeTimer;
let session;
try { session = JSON.parse(localStorage.getItem('jyoti-staff') || 'null'); } catch { session = null; }

function persistSession(value) {
  session = value;
  if (value) localStorage.setItem('jyoti-staff', JSON.stringify(value));
  else localStorage.removeItem('jyoti-staff');
}

function notice(text) {
  clearTimeout(noticeTimer);
  $('notice').textContent = text;
  noticeTimer = setTimeout(() => { $('notice').textContent = ''; },6500);
}

async function request(action,input = {},auth = true) {
  if (auth && session?.expires_at && session.expires_at < Date.now() / 1000 + 30) {
    refresh ||= request('refresh',{refresh_token:session.refresh_token},false).then(persistSession).finally(() => { refresh = null; });
    try { await refresh; } catch (error) { if (error.status === 401) showLogin(); throw error; }
  }
  const headers = {'Content-Type':'application/json'};
  if (auth && session) headers.Authorization = 'Bearer ' + session.access_token;
  const response = await fetch('/api/service',{method:'POST',headers,body:JSON.stringify({action,input})});
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    if (auth && response.status === 401) showLogin();
    const error = new Error(payload.error || 'The service is temporarily unavailable');
    error.status = response.status;
    throw error;
  }
  return payload.result;
}

function showLogin() {
  persistSession(null);
  pageGeneration++;
  $('boot-status').hidden = true;
  $('desk').hidden = true;
  $('logout').hidden = true;
  $('staff-name').textContent = '';
  $('content').replaceChildren();
  $('dialog').close();
  user = null;
  $('push-onboarding')?.close();
  $('install-onboarding')?.close();
  $('sign-in').hidden = false;
}

function submit(form, handler, errorTarget) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter || form.querySelector('button:not([type="button"])');
    if (button?.disabled) return;
    const label = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = form.id === 'login-form' ? 'Signing in…' : form.id === 'ticket-filter' ? 'Searching…' : 'Working…';
    }
    if (errorTarget) errorTarget.textContent = '';
    try { await handler(formData(form), form); }
    catch (error) { if (errorTarget) errorTarget.textContent = error.message; else notice(error.message); }
    finally { if (button) { button.disabled = false; button.textContent = label; } }
  });
}

function modal(title, fields, label, handler) {
  $('dialog-title').textContent = title;
  $('dialog-content').innerHTML = '<form class="grid">' + fields + submitButton(label) + '</form>';
  const form = $('dialog-content').querySelector('form');
  $('dialog-error').textContent = '';
  $('dialog').showModal();
  submit(form, async (data) => {
    const result = await handler(data);
    $('dialog').close();
    notice(typeof result === 'string' ? result : 'Saved');
    await load();
  },$('dialog-error'));
  return form;
}

function numberFields(data, ...names) {
  for (const name of names) data[name] = Number(data[name]);
  return data;
}

async function load() {
  const generation = ++pageGeneration;
  const selectedPage = page;
  $('boot-status').textContent = 'Loading '+pages[selectedPage].toLowerCase()+'…';
  $('boot-status').hidden = false;
  try {
    const data = await request(selectedPage === 'tickets' ? 'dashboard' : selectedPage,
      selectedPage === 'tickets' ? { offset, openOnly:ticketScope === 'open', status:ticketStatuses.includes(ticketScope) ? ticketScope : undefined, ticket:filter } : {});
    if (generation !== pageGeneration) return;
    if (selectedPage === 'tickets') user = data.staff;
    $('staff-name').textContent = user.name;
    $('boot-status').hidden = true;
    $('desk').hidden = false;
    $('logout').hidden = false;
    $('sign-in').hidden = true;
    $('page-title').textContent = selectedPage === 'tickets' && user.role === 'technician' ? 'My assignments' : pages[selectedPage];
    $('nav').innerHTML = Object.entries(pages).filter(([key])=>key === 'tickets' || user.role !== 'technician')
      .map(([key,label]) => '<button data-page="'+key+'" '+(key === selectedPage ? 'aria-current="page"' : '')+'>'+label+'</button>').join('');
    $('nav').querySelectorAll('[data-page]').forEach(button => { button.onclick = () => { page = button.dataset.page; load(); }; });
    $('page-actions').replaceChildren();
    if (selectedPage === 'tickets') renderTickets(data);
    if (selectedPage === 'catalog') renderCatalog(data);
    if (selectedPage === 'purchases') renderPurchases(data);
    if (selectedPage === 'billing') renderBilling(data);
  } catch (error) {
    if (generation !== pageGeneration || error.status === 401) return;
    if (!$('boot-status').hidden) {
      const retry = document.createElement('button');
      retry.textContent = 'Retry';
      retry.onclick = () => { $('boot-status').textContent = 'Loading service tickets…'; load(); };
      $('boot-status').replaceChildren(error.message + ' ', retry);
    } else notice(error.message);
  }
}

function mapsLink(t) {
  if (t.maps_url) {
    try { const candidate = new URL(t.maps_url); if (candidate.protocol === 'https:') return candidate.href; } catch {}
  }
  const query = t.latitude != null ? [t.latitude,t.longitude].join(',') : [t.service_address,t.locality,t.city].join(', ');
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(query);
}

function renderTickets({tickets,technicians,pushKey,limit}) {
  if (user.role === 'manager') {
    $('page-actions').innerHTML = btn('New ticket','new-ticket') + btn('Add staff','new-staff',true);
    $('new-ticket').onclick = newTicket;
    $('new-staff').onclick = newStaff;
  }
  if (user.role === 'technician') {
    renderAlertButton(pushKey);
    showTechnicianOnboarding(pushKey);
  }
  const technicianOptions = [['','Unassigned'],...technicians.map(t => [t.user_id,t.name])];
  const repairStatuses = { Assigned:['In Progress','Awaiting Parts','Repair Complete'], 'In Progress':['Awaiting Parts','Repair Complete'], 'Awaiting Parts':['In Progress','Repair Complete'] };
  $('content').innerHTML = '<form id="ticket-filter" class="inline-form">' +
    input('Ticket number','ticket','inputmode="numeric" pattern="[1-9][0-9]{4}" maxlength="5" value="'+e(filter)+'"') +
    select('Status','scope',[['open','Open tickets'],['all','All statuses'],...ticketStatuses],ticketScope) + submitButton('Search') + btn('Refresh','refresh-tickets',true) + '</form>' +
    (tickets.length ? '<div class="list">'+tickets.map(t => {
      const actions = [];
      if (user.role === 'manager' && t.status !== 'Repair Complete') {
        actions.push('<form data-assign="'+e(t.id)+'">'+select('Technician','technician_id',technicianOptions,t.assigned_to).replace(' required','')+submitButton('Save assignment')+'</form>');
      }
      const awaitingParts = t.status === 'Awaiting Parts';
      if (user.role === 'manager' && awaitingParts) {
        actions.push('<button type="button" class="secondary" data-ticket-po="'+e(t.id)+'">Create PO</button>');
      }
      if (user.role === 'technician' && repairStatuses[t.status]) {
        const statuses = [placeholder('Choose progress'),...repairStatuses[t.status]];
        actions.push('<form data-status="'+e(t.id)+'">'+select('Progress','status',statuses)+submitButton('Update')+'</form>');
      }
      return '<article class="panel"'+(awaitingParts?' style="background:#fff1f2;border-color:#fca5a5"':'')+'><div class="section-title"><h2>#'+t.ticket_number+' · '+e(t.appliance)+'</h2><span class="badge"'+(awaitingParts?' style="'+lightRedAlert+'"':'')+'>'+e(t.status)+'</span></div>'+
        '<p>'+e(t.customer_name)+' · <a href="tel:+91'+e(t.mobile)+'">'+e(t.mobile)+'</a></p><p>'+e(t.issue)+'</p>'+
        '<p class="meta">'+[t.brand,t.service_type,t.intake_source,date(t.created_at)].map(e).join(' · ')+'</p>'+
        '<a href="'+e(mapsLink(t))+'" target="_blank" rel="noopener noreferrer">'+e(t.service_address)+', '+e(t.locality)+'</a>'+
        '<div class="card-actions">'+actions.join('')+'</div></article>';
    }).join('')+'</div>' : '<p class="panel muted">No tickets match this view.</p>') +
    '<div class="actions">'+(offset ? btn('Previous','page-prev',true) : '')+(tickets.length === limit ? btn('Next','page-next',true) : '')+'</div>';
  submit($('ticket-filter'),async data => {
    filter = data.ticket;
    ticketScope = filter && data.scope === 'open' ? 'all' : data.scope;
    offset = 0;
    await load();
  });
  $('refresh-tickets').onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Refreshing…';
    try { await load(); }
    finally { button.disabled = false; button.textContent = 'Refresh'; }
  };
  if ($('page-prev')) $('page-prev').onclick = () => { offset -= limit; load(); };
  if ($('page-next')) $('page-next').onclick = () => { offset += limit; load(); };
  $('content').querySelectorAll('[data-assign]').forEach(form => submit(form,async data => {
    const result = await request('assign',{ id:form.dataset.assign,technician_id:data.technician_id || null });
    notice(result.notification || 'Assignment saved');
    await load();
  }));
  for (const form of $('content').querySelectorAll('[data-status]')) {
    const progress = form.elements.status;
    progress.onchange = () => { if (progress.value === 'Repair Complete') form.requestSubmit(); };
    submit(form,async ({status}) => {
      const id = form.dataset.status;
      if (status === 'Repair Complete') {
        progress.value = '';
        const {items,parts} = await request('parts',{id});
        if (!form.isConnected || $('dialog').open) return;
        editableLines('Parts used',items,parts,false,async lines => {
          await request('saveParts',{id,parts:lines});
          await request('status',{id,status});
          return 'Repair completed and ready for billing';
        },'','Save parts and complete repair');
        return;
      }
      await request('status',{id,status});
      notice('Progress updated'); await load();
    });
  }
  for (const button of $('content').querySelectorAll('[data-ticket-po]')) button.onclick = async () => {
    const ticket = tickets.find(t => t.id === button.dataset.ticketPo);
    button.disabled = true;
    try {
      const catalog = await request('catalog');
      if (button.isConnected && !$('dialog').open) openPurchaseForm(catalog,ticket);
    } catch (error) {
      notice(error.message);
    } finally { button.disabled = false; }
  };
}

function newTicket() {
  const key = crypto.randomUUID();
  let coordinates = {};
  const form = modal('New service ticket',
    '<div class="pair">'+input('Customer name','customer_name','required maxlength="100"')+
    input('Mobile number','mobile','required inputmode="numeric" type="tel" pattern="[6-9][0-9]{9}" maxlength="10"')+
    select('Service area','locality',[placeholder('Choose locality'),...localityOptions])+
    select('Brand','brand',[placeholder('Choose brand'),...brandOptions])+
    select('Appliance','appliance',[placeholder('Choose appliance'),...applianceOptions])+
    input('City','city','value="Ambikapur, CG" required')+
    select('Service type','service_type',['Bring to Shop','Home Visit','Home Pickup','Installation','Preventive Maintenance','Warranty Service'])+
    select('Complaint source','intake_source',['Walk-in','Phone'])+'</div>'+
    '<label>Service address<textarea name="service_address" required maxlength="500"></textarea></label>'+
    '<label>Issue<textarea name="issue" required maxlength="2000"></textarea></label>'+
    '<div id="ticket-location" hidden>'+btn('Capture current location','capture',true)+
    input('Google Maps share link','maps_url','type="url"')+'<p id="pin-status" role="status"></p></div>',
    'Register complaint',async data => {
      const result = await request('createTicket',{...data,...coordinates,key,maps_url:data.maps_url || null});
      return 'Ticket #'+result.ticket_number+' registered';
    });
  form.elements.mobile.addEventListener('blur', async () => {
    const mobile = form.elements.mobile.value;
    if (!/^[6-9][0-9]{9}$/.test(mobile)) return;
    try {
      const known = await request('customerLookup',{mobile});
      if (!known || form.elements.mobile.value !== mobile) return;
      for (const field of ['customer_name','locality','service_address']) {
        const control = form.elements[field];
        if (!control.value) control.value = known[field];
      }
    } catch {}
  });
  form.elements.service_type.onchange = () => {
    $('ticket-location').hidden = !['Home Visit','Home Pickup','Installation'].includes(form.elements.service_type.value);
    if ($('ticket-location').hidden) {coordinates = {};form.elements.maps_url.value = '';$('pin-status').textContent = '';}
  };
  $('capture').onclick = () => {
    if (!navigator.geolocation) { $('pin-status').textContent = 'Paste a Google Maps link for the service address.'; return; }
    $('pin-status').textContent = 'Getting your location…';
    navigator.geolocation.getCurrentPosition(({coords}) => {
      coordinates = {latitude:coords.latitude,longitude:coords.longitude};
      $('pin-status').textContent = 'Location pinned';
    }, () => { $('pin-status').textContent = 'Location was unavailable. Paste a Maps link instead.'; }, {enableHighAccuracy:true,timeout:10000});
  };
}

function newStaff() {
  modal('Create staff account',input('Name','name','required maxlength="100"')+
    input('Username','username','required minlength="3" maxlength="32" pattern="[a-zA-Z0-9][a-zA-Z0-9._\\-]{2,31}" autocomplete="off"')+
    input('Temporary password','password','required type="password" minlength="10" maxlength="72" autocomplete="new-password"')+
    select('Role','role',[['technician','Technician'],['billing','Billing']]),'Create account',async data => {
      const result = await request('createStaff',data);
      return result.name+' can sign in as '+result.username;
    });
}

let pushRegistration;
async function subscribe(registration,key) {
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const raw = atob(key.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(key.length/4)*4,'='));
    subscription = await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(raw,c=>c.charCodeAt(0))});
  }
  await request('subscribe',subscription.toJSON());
}
let pushDecisionPending = false;
let installEvent;

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installEvent = event;
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  localStorage.setItem('jyoti-app-installed','yes');
  $('install-onboarding')?.close();
});

const lightRedAlert = 'background:#fee2e2;color:#7f1d1d;border-color:#fca5a5';
const pushSupported = () => 'serviceWorker' in navigator && 'Notification' in window && 'PushManager' in window;
const installed = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone ||
  localStorage.getItem('jyoti-app-installed') === 'yes';

function onboardingDialog(id, icon, title, description, action, onAction, onClose) {
  const dialog = document.createElement('dialog');
  dialog.id = id;
  dialog.setAttribute('aria-labelledby',id+'-title');
  dialog.setAttribute('aria-describedby',id+'-description');
  dialog.style.width = 'min(420px, calc(100% - 24px))';
  dialog.style.textAlign = 'center';
  dialog.innerHTML = '<div aria-hidden="true" style="font-size:2.5rem;margin-bottom:.6rem">'+icon+'</div>'+
    '<h2 id="'+id+'-title">'+title+'</h2><p id="'+id+'-description">'+description+'</p>'+
    '<div class="grid" style="margin-top:1rem">'+btn(action,id+'-action')+btn('Not now',id+'-later',true)+'</div>';

  dialog.addEventListener('close',() => { dialog.remove(); onClose?.(); },{once:true});
  dialog.querySelector('#'+id+'-action').onclick = event => onAction(dialog,event.currentTarget);
  dialog.querySelector('#'+id+'-later').onclick = () => dialog.close();
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

function renderAlertButton(key) {
  $('page-actions').insertAdjacentHTML('beforeend',btn('Allow assignment alerts','push'));
  const button = $('push');
  button.style.cssText = lightRedAlert;
  button.onclick = () => enablePush(key);
  if (key && pushSupported() && Notification.permission === 'granted') {
    button.hidden = true;
    registerPush(key).then(() => button.remove()).catch(() => {
      if (!button.isConnected) return;
      button.hidden = false;
      notice('Could not register assignment alerts. Use Allow assignment alerts to try again.');
    });
  }
}

async function enablePush(key) {
  if (!key) { notice('Assignment alerts are unavailable right now.'); return; }
  if (!pushSupported()) { notice('Open Jyoti in a browser that supports push alerts, or install it on your home screen.'); return; }
  const staffId = user?.user_id;
  try {
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (permission === 'granted' && user?.user_id === staffId) {
      await registerPush(key);
      if (user?.user_id !== staffId) return;
      $('push')?.remove();
    } else if (permission === 'denied') {
      notice('Alerts are blocked. Allow notifications for Jyoti in your browser’s site settings.');
    }
  } catch {
    notice('Could not register assignment alerts. Please try again.');
  }
}

function registerPush(key) {
  pushRegistration ||= navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready)
    .then(reg => subscribe(reg,key))
    .catch(error => { pushRegistration = null; throw error; });
  return pushRegistration;
}

function showInstallOnboarding() {
  if (user?.role !== 'technician' || !session || installed() ||
      $('install-onboarding')?.open || localStorage.getItem('jyoti-install-prompt')) return;
  const dialog = onboardingDialog('install-onboarding','📲','Install Jyoti Service Desk',
    'Add Jyoti to your home screen so you can open your assigned jobs in one tap.',
    'Install app', async (modal,button) => {
      if (!installEvent) {
        $('install-onboarding-description').textContent = /iPad|iPhone|iPod/.test(navigator.userAgent)
          ? 'In Safari, tap Share, then Add to Home Screen.'
          : 'Open your browser menu and choose Install app or Add to Home screen.';
        button.hidden = true;
        return;
      }
      const prompt = installEvent;
      installEvent = null;
      try { await prompt.prompt(); modal.close(); }
      catch { notice('Use your browser menu to install Jyoti Service Desk.'); }
    });
  localStorage.setItem('jyoti-install-prompt','shown');
  return dialog;
}

function showTechnicianOnboarding(key) {
  if (pushDecisionPending || $('push-onboarding')?.open) return;
  const marker = 'jyoti-push-onboarding:' + user.user_id;
  if (!key || !pushSupported() || Notification.permission !== 'default' || localStorage.getItem(marker)) {
    showInstallOnboarding();
    return;
  }

  const dialog = onboardingDialog('push-onboarding','🔔','Enable assignment alerts',
    'Get a notification on this device when a new job is assigned to you.',
    'Allow assignment alerts', async (modal,button) => {
      pushDecisionPending = true;
      button.disabled = true;
      try { await enablePush(key); }
      finally {
        pushDecisionPending = false;
        if (modal.open) modal.close(); else showInstallOnboarding();
      }
    },() => { if (!pushDecisionPending) showInstallOnboarding(); });
  dialog.querySelector('#push-onboarding-action').style.cssText = lightRedAlert;
  localStorage.setItem(marker,'shown');
}

function editableLines(title,items,existing,priced,save,fields = '',label = priced ? 'Create purchase order' : 'Save parts used') {
  const byId = new Map(items.map(i => [i.id,i]));
  const form = modal(title,fields+'<div id="lines"></div>'+
    btn('Add line','add-line',true)+(!priced ? '<p class="meta">Add at least one item and its quantity before completing the repair.</p>' : ''),
    label, (data) => {
      const lines = [...$('lines').children].map(row => ({
        item_id:row.querySelector('select').value,
        quantity:Number(row.querySelector('[name="quantity"]').value),
        ...(priced ? {unit_price:Number(row.querySelector('[name="unit_price"]').value)} : {}),
      }));
      if (!lines.length) throw new Error(priced ? 'Add at least one purchase order line' : 'Add at least one item in Parts used');
      return save(lines,data);
    });
  function addLine(line = {}) {
    const wrapper = document.createElement('div');
    wrapper.className = priced ? 'line' : 'line parts';
    wrapper.innerHTML = select('Item','item',[placeholder('Choose item'),...items.filter(i=>i.active || i.id === line.item_id).map(i=>[i.id,i.code+' · '+i.description+' ('+i.uom+')'])],line.item_id) +
      input('Quantity','quantity','type="number" min="0.001" step="0.001" required value="'+e(line.quantity ?? 1)+'"')+
      (priced ? input('Unit price','unit_price','type="number" min="0" step="0.01" required value="'+e(line.unit_price ?? '')+'"') : '')+
      '<button type="button" class="secondary">Remove</button>';
    wrapper.querySelector('button').onclick = () => wrapper.remove();
    if (priced) wrapper.querySelector('select').onchange = event => {
      wrapper.querySelector('[name="unit_price"]').value = byId.get(event.target.value)?.purchase_price ?? '';
    };
    $('lines').append(wrapper);
  }
  form.querySelector('#add-line').onclick = () => addLine();
  for (const line of existing) addLine(line);
  if (!existing.length) addLine();
}

const payable = (row) => Math.round((Number(row.total ?? row.amount) - (row.payments || []).reduce((sum,p)=>sum+Number(p.amount),0))*100)/100;
function paymentModal(row, type) {
  const key = crypto.randomUUID();
  const due = payable(row);
  modal('Record payment',input('Amount','amount','type="number" min="0.01" max="'+e(due)+'" step="0.01" value="'+e(due)+'" required')+
    select('Method','method',['Cash','UPI','Bank Transfer','Card','Other'])+input('Reference','reference','maxlength="100"'),'Save payment',async data => {
    await request('payment',{ id:key,[type]:row.id,...numberFields(data,'amount') });
    return 'Payment recorded';
  });
}

function renderCatalog({items,suppliers}) {
  $('page-actions').innerHTML = btn('New item','new-item')+btn('New supplier','new-supplier',true);
  $('content').innerHTML = '<section class="panel"><h2>Item master</h2><div class="table-wrap"><table><thead><tr><th>Item</th><th>Unit</th><th>Purchase price</th><th>Sale price</th><th></th></tr></thead><tbody>'+
    items.map(i=>'<tr><td>'+e(i.code)+' · '+e(i.description)+'</td><td>'+e(i.uom)+'</td><td>'+money(i.purchase_price)+'</td><td>'+money(i.sale_price)+'</td><td><button class="secondary" data-item="'+e(i.id)+'">Edit</button></td></tr>').join('')+
    '</tbody></table></div>'+(items.length ? '' : '<p class="muted">Add the parts you buy and use in repairs.</p>')+'</section><section class="panel"><h2>Suppliers</h2>'+
    suppliers.map(s=>'<p><strong>'+e(s.name)+'</strong> '+e(s.contact)+' <span class="meta">'+e(s.address)+'</span></p>').join('')+'</section>';
  const itemForm = (i={}) => {
    const textInput = (label,name,required = true) => input(label,name,(required?'required ':'')+'value="'+e(i[name] ?? '')+'"');
    const moneyInput = (label,name,max='') => input(label,name,'type="number" min="0" step="0.01" '+max+' required value="'+e(i[name] ?? '')+'"');
    modal(i.id ? 'Edit item' : 'New item','<div class="pair">'+input('Item code','code','required value="'+e(i.code ?? '')+'"'+(i.id?' readonly':''))+
      textInput('Unit of measure','uom')+'</div>'+textInput('Description','description')+textInput('HSN/SAC','hsn_sac',false)+
      '<div class="pair">'+moneyInput('Purchase price','purchase_price')+moneyInput('Customer price','sale_price')+'</div>'+
      moneyInput('Tax rate %','tax_rate','max="100"'),'Save item',data=>request('item',numberFields(data,'purchase_price','sale_price','tax_rate')));
  };
  $('new-item').onclick = () => itemForm();
  $('content').querySelectorAll('[data-item]').forEach(button => { button.onclick = () => itemForm(items.find(i=>i.id===button.dataset.item)); });
  $('new-supplier').onclick = () => modal('New supplier',input('Business name','name','required')+input('Contact','contact')+
    input('Address','address')+input('GSTIN','gstin'),'Save supplier',data=>request('supplier',data));
}

function openPurchaseForm({items,suppliers}, ticket = null) {
  if (!items.some(i=>i.active)) { notice('Add a part in the item master first'); return; }
  if (!suppliers.length) { notice('Add a supplier before creating a purchase order'); return; }
  const title = ticket ? 'New purchase order · Ticket #'+ticket.ticket_number : 'New purchase order';
  editableLines(title,items,[],true,async (lines,data) => {
    const response = await request('po',{supplier_id:data.supplier_id,ticket_id:ticket?.id ?? null,lines});
    return 'Purchase order #'+response.po_number+' created';
  },select('Supplier','supplier_id',suppliers.map(s=>[s.id,s.name])));
}

function renderPurchases({orders,items,suppliers}) {
  $('page-actions').innerHTML = btn('New purchase order','new-po');
  $('new-po').onclick = () => openPurchaseForm({items,suppliers});
  const shareOrder = order => {
    const number = String(order.suppliers.contact || '').replace(/[^0-9]/g,'');
    const phone = /^[6-9][0-9]{9}$/.test(number) ? '91' + number : /^91[6-9][0-9]{9}$/.test(number) ? number : '';
    if (!phone) return '';
    const message = ['Purchase order #' + order.po_number + ' from Jyoti Service Unit', ...order.purchase_lines.map(l =>
      l.description + ' · ' + l.quantity + ' ' + l.uom + ' × ' + money(l.unit_price))].join('\n');
    return '<a href="https://wa.me/'+phone+'?text='+encodeURIComponent(message)+'" target="_blank" rel="noopener noreferrer">Share PO on WhatsApp</a>';
  };
  const bills = orders.flatMap(order => order.supplier_bills);
  $('content').innerHTML = '<section class="panel"><h2>Supplier balances</h2>'+
    suppliers.map(s => {
      const supplierBills = orders.filter(o=>o.suppliers.id===s.id).flatMap(o=>o.supplier_bills);
      const due = supplierBills.reduce((sum,b)=>sum + payable(b),0);
      const paid = supplierBills.reduce((sum,b)=>sum + Number(b.amount)-payable(b),0);
      return '<p><strong>'+e(s.name)+'</strong> · Paid '+money(paid)+' · Outstanding '+money(due)+'</p>';
    }).join('')+'</section>'+
    (orders.length ? orders.map(order => '<article class="panel"><div class="section-title"><h2>PO #'+order.po_number+' · '+e(order.suppliers.name)+'</h2><button class="secondary" data-po-print="'+e(order.id)+'">Print / PDF</button></div>'+
      (order.service_tickets ? '<p class="meta">Linked ticket #'+e(order.service_tickets.ticket_number)+'</p>' : '')+
      '<div class="table-wrap"><table><thead><tr><th>Part</th><th>Ordered</th><th>Received</th><th>Unit price</th><th></th></tr></thead><tbody>'+
      order.purchase_lines.map(line=>'<tr><td>'+e(line.description)+'</td><td>'+e(line.quantity)+' '+e(line.uom)+'</td><td>'+e(line.received)+'</td><td>'+money(line.unit_price)+'</td><td>'+
        (Number(line.received)<Number(line.quantity)?'<button class="secondary" data-receive="'+e(line.id)+'">Receive</button>':'')+'</td></tr>').join('')+
      '</tbody></table></div><div class="card-actions"><button data-bill="'+e(order.id)+'">Add supplier bill</button>'+shareOrder(order)+'</div>'+
      order.supplier_bills.map(b=>'<div class="card-actions"><strong>'+e(b.bill_number)+'</strong> '+money(b.amount)+' total · '+money(payable(b))+' due '+
        (payable(b)>0 ? '<button class="secondary" data-supplier-pay="'+e(b.id)+'">Record payment</button>' : '')+'</div>').join('')+'</article>').join('') : '<p class="panel muted">No purchase orders yet.</p>');
  for (const button of $('content').querySelectorAll('[data-po-print]')) button.onclick = () => printPurchase(orders.find(o=>o.id===button.dataset.poPrint));
  for (const button of $('content').querySelectorAll('[data-receive]')) button.onclick = () => {
    const line = orders.flatMap(o=>o.purchase_lines).find(l=>l.id===button.dataset.receive);
    const id = crypto.randomUUID();
    const due = Math.round((Number(line.quantity)-Number(line.received))*1000)/1000;
    modal('Receive '+line.description,input('Quantity received','quantity','type="number" min="0.001" step="0.001" max="'+e(due)+'" value="'+e(due)+'" required'),
      'Save receipt',data=>request('receipt',{id,line_id:line.id,quantity:Number(data.quantity)}));
  };
  for (const button of $('content').querySelectorAll('[data-bill]')) button.onclick = () => {
    modal('Add supplier bill',input('Supplier bill number','bill_number','required')+input('Bill date','bill_date','type="date" required')+
      input('Amount','amount','type="number" min="0.01" step="0.01" required'),'Save bill',
      data=>request('supplierBill',{...numberFields(data,'amount'),po_id:button.dataset.bill}));
  };
  for (const button of $('content').querySelectorAll('[data-supplier-pay]')) button.onclick = () => paymentModal(bills.find(b=>b.id===button.dataset.supplierPay),'supplier_bill_id');
}

function updateInvoiceDraft(form, parts) {
  const fields = form.elements;
  const type = fields.discount_type.value;
  const value = fields.discount_value;
  value.disabled = type === 'none';
  value.required = !value.disabled;
  const grossLine = (price, quantity, rate) => {
    const base = Math.round(Number(price) * 100) * Math.round(Number(quantity) * 1000);
    const paise = Math.round(base / 1000);
    return paise + 2 * Math.round(paise * Math.round(Number(rate) * 100) / 20000);
  };
  const gross = parts.reduce((sum, part) => sum + grossLine(
    fields['price-'+part.item_id].value, part.quantity, part.items.tax_rate
  ), grossLine(fields.fee.value, 1, fields.tax_rate.value));
  value.max = type === 'percent' ? '100' : String(gross / 100);
  const entered = Math.round(Number(value.value) * 100);
  const discount = type === 'none' ? 0 : type === 'fixed' ? entered : Math.round(gross * entered / 10000);
  const percent = type === 'percent' ? Number(value.value) : gross ? discount / gross * 100 : 0;
  form.querySelector('[data-invoice-summary]').innerHTML = '<p>Total before discount (incl. GST) '+money(gross/100)+'</p>'+
    (type === 'none' ? '' : '<p>Discount ('+percent.toFixed(2)+'%) −'+money(discount/100)+'</p>')+
    (value.validity.valid ? '<p><strong>Amount payable '+money((gross-discount)/100)+'</strong></p>' : '');
}

function renderBilling({completed,invoices}) {
  $('content').innerHTML = '<section class="panel"><h2>Ready to bill</h2>'+
    (completed.length ? completed.map(t=>'<div class="card-actions"><strong>#'+t.ticket_number+' · '+e(t.customer_name)+'</strong><button data-draft="'+e(t.id)+'">Review invoice</button></div>').join('') :
      '<p class="muted">No completed repairs awaiting billing.</p>')+'</section>'+
    '<section class="panel"><h2>Issued invoices</h2>'+
    (invoices.length ? invoices.map(b=>{
      const due = payable(b);
      const state = !due ? 'Paid' : due === Number(b.total) ? 'Pending payment' : 'Part paid';
      return '<div class="card-actions"><strong>'+e(b.number)+' · '+e(b.customer_name)+'</strong><span class="badge">'+state+'</span> '+money(due)+' due'+
        '<button class="secondary" data-invoice-print="'+e(b.id)+'">Print / PDF</button>'+
        (due>0?'<button data-invoice-pay="'+e(b.id)+'">Record payment</button>' +
          (b.service_tickets?.mobile ? '<a href="tel:+91'+e(b.service_tickets.mobile)+'">Call customer</a>' : '') : '')+'</div>';
    }).join('') : '<p class="muted">No invoices issued yet.</p>')+'</section>';
  for (const button of $('content').querySelectorAll('[data-draft]')) button.onclick = async () => {
    button.disabled = true;
    button.textContent = 'Loading invoice…';
    try {
      const {booking,parts} = await request('invoiceDraft',{id:button.dataset.draft});
      if (!button.isConnected || $('dialog').open) return;
      const form = modal('Invoice draft · Ticket #'+booking.ticket_number,
        '<p><strong>Bill To and Ship To</strong><br>'+e(booking.customer_name)+'<br>'+[booking.service_address,booking.locality,booking.city].map(e).join(', ')+'</p>'+
        parts.map(p=>input(e(p.items.description)+' · '+e(p.quantity)+' '+e(p.items.uom)+' · Unit price (₹)',
          'price-'+p.item_id,'type="number" min="0" max="9999999" step="0.01" required value="'+e(p.items.sale_price)+'"')).join('')+
        '<div class="pair">'+input('Service charge','fee','type="number" min="0" step="0.01" required')+
        input('Service tax rate %','tax_rate','type="number" min="0" max="100" step="0.01" required')+'</div>'+
        input('Customer GSTIN (optional)','gstin','maxlength="15"')+
        '<div class="pair">'+select('Discount','discount_type', [['none','No discount'],['percent','Percentage (%)'],['fixed','Fixed amount (₹)']],'none')+
        input('Discount value','discount_value','type="number" min="0" step="0.01" disabled')+'</div>'+
        '<div data-invoice-summary aria-live="polite"></div>',
        'Issue invoice',async data=>{
          const result = await request('invoice',{
            id:button.dataset.draft, fee:Number(data.fee), tax_rate:Number(data.tax_rate), gstin:data.gstin,
            prices:parts.map(p=>({item_id:p.item_id,price:Number(data['price-'+p.item_id])})),
            discount_type:data.discount_type, discount_value:Number(data.discount_value || 0),
          });
          return 'Invoice '+result.number+' issued';
        });
      const update = () => updateInvoiceDraft(form,parts);
      form.addEventListener('input',update);
      update();
    } catch (error) { notice(error.message); }
    finally { button.disabled = false; button.textContent = 'Review invoice'; }
  };
  for (const button of $('content').querySelectorAll('[data-invoice-print]')) button.onclick = () => printInvoice(invoices.find(b=>b.id===button.dataset.invoicePrint));
  for (const button of $('content').querySelectorAll('[data-invoice-pay]')) button.onclick = () => paymentModal(invoices.find(b=>b.id===button.dataset.invoicePay),'invoice_id');
}

$('close-dialog').onclick = () => $('dialog').close();
$('logout').onclick = async () => {
  try { await request('logout'); } catch {}
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const subscription = await reg?.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
    } catch {}
  }
  pushRegistration = null;
  showLogin();
};
submit($('login-form'),async (data,form) => {
  const result = await request('login',data,false);
  persistSession(result);
  form.reset();
  page = 'tickets';
  await load();
});
if (session) load();
else showLogin();
