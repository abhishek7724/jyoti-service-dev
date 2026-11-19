import { printInvoice, printPurchase } from './documents.js';
import { brandOptions, localityOptions, uomOptions } from './lookups.js';
import { attachSuggestions } from './combobox.js';
import { statusBadge,photoGallery,receiptHistory,financialSummary } from './ticket-display.js';
import { compressPhoto,uploadTicketMedia,mountPhotoControls,signaturePad,cameraIcon } from './ticket-media.js';

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
const pages = { tickets:'Service tickets',items:'Item master',suppliers:'Supplier master',purchases:'Purchasing',billing:'Billing' };
const originalTicket = new URL(location.href).searchParams.get('ticket') || '';
let filter = /^[1-9][0-9]{4}$/.test(originalTicket) ? originalTicket : '';
let ticketScope = filter ? 'all' : 'open';
const ticketStatuses = ['New','Assigned','In Progress','Inspection Complete','Awaiting Parts','Repair Complete','Paid, not billed','Billed','Paid'];
let offset = 0;
let detailTicketId = null;
let pendingTicketNumber = filter;
const completedStatuses = ['Repair Complete','Paid, not billed','Billed','Paid'];
let itemOffset = 0, itemSearch = '';
let user, refresh, page = 'tickets', pageGeneration = 0, noticeTimer;
let session;
try { session = JSON.parse(localStorage.getItem('jyoti-staff') || 'null'); } catch { session = null; }

function persistSession(value) {
  session = value;
  if (value) localStorage.setItem('jyoti-staff', JSON.stringify(value));
  else localStorage.removeItem('jyoti-staff');
}

function markRequiredFields(root = document) {
  for (const label of root.querySelectorAll('label')) {
    const control = label.querySelector('input,select,textarea');
    if (!control) continue;
    let caption = label.querySelector(':scope > .field-caption');
    if (!caption) {
      caption = document.createElement('span');
      caption.className = 'field-caption';
      for (const node of [...label.childNodes]) if (node.nodeType === Node.TEXT_NODE) caption.append(node);
      label.prepend(caption);
    }
    let marker = caption.querySelector('.required-mark');
    if (!marker && control.required) {
      marker = document.createElement('span');
      marker.className = 'required-mark';
      marker.textContent = ' *';
      marker.setAttribute('aria-hidden','true');
      caption.append(marker);
    }
    if (marker) marker.hidden = !control.required || control.disabled;
  }
}

function closeSidebar() {
  document.body.classList.remove('menu-open');
  $('menu-toggle').setAttribute('aria-expanded','false');
  $('sidebar-backdrop').hidden = true;
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
  closeSidebar();
  document.body.classList.remove('signed-in');
  $('sidebar').hidden = true;
  $('menu-toggle').hidden = true;
  persistSession(null);
  pageGeneration++;
  $('boot-status').hidden = true;
  $('desk').hidden = true;
  $('logout').hidden = true;
  $('staff-name').textContent = '';
  $('content').replaceChildren();
  $('dialog').close();
  user = null;
  detailTicketId = null;
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
  markRequiredFields(form);
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
  const initialLoad = $('desk').hidden;
  if (initialLoad) {
    $('boot-status').textContent = 'Loading service tickets…';
    $('boot-status').hidden = false;
  }
  try {
    const data = await request(selectedPage === 'tickets' ? (detailTicketId ? 'ticketDetail' : 'dashboard') : selectedPage,
      selectedPage === 'tickets' && detailTicketId ? {id:detailTicketId} : selectedPage === 'tickets' ? { offset, openOnly:ticketScope === 'open', status:ticketStatuses.includes(ticketScope) ? ticketScope : undefined, ticket:filter } :
        selectedPage === 'items' ? { offset:itemOffset,search:itemSearch } : {});
    if (generation !== pageGeneration) return;
    if (selectedPage === 'tickets') user = data.staff;
    if (selectedPage === 'tickets' && !detailTicketId && pendingTicketNumber) {
      const ticket = data.tickets.find(ticket=>String(ticket.ticket_number) === pendingTicketNumber);
      pendingTicketNumber = '';
      if (ticket) { detailTicketId=ticket.id; return load(); }
    }
    $('staff-name').textContent = user.name;
    $('boot-status').hidden = true;
    $('desk').hidden = false;
    document.body.classList.add('signed-in');
    $('sidebar').hidden = false;
    $('menu-toggle').hidden = false;
    $('logout').hidden = false;
    $('sign-in').hidden = true;
    $('page-title').textContent = selectedPage === 'tickets' && user.role === 'technician' ? 'My assignments' : pages[selectedPage];
    $('nav').innerHTML = Object.entries(pages).filter(([key])=>key === 'tickets' || user.role !== 'technician')
      .map(([key,label]) => '<button data-page="'+key+'" '+(key === selectedPage ? 'aria-current="page"' : '')+'>'+label+'</button>').join('');
    $('nav').querySelectorAll('[data-page]').forEach(button => { button.onclick = () => { page = button.dataset.page; detailTicketId=null; pendingTicketNumber=''; history.replaceState(null,'','/staff'); closeSidebar(); load(); }; });
    $('page-actions').replaceChildren();
    if (selectedPage === 'tickets') {
      if (detailTicketId) renderTicketDetail(data);
      else renderTickets(data);
    }
    if (selectedPage === 'items') renderItems(data);
    if (selectedPage === 'suppliers') renderSuppliers(data);
    if (selectedPage === 'purchases') renderPurchases(data);
    if (selectedPage === 'billing') renderBilling(data);
    markRequiredFields($('content'));
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
  $('content').innerHTML = '<form id="ticket-filter" class="inline-form">' +
    input('Ticket number','ticket','inputmode="numeric" pattern="[1-9][0-9]{4}" maxlength="5" value="'+e(filter)+'"') +
    select('Status','scope',[['open','Open tickets'],['all','All statuses'],...ticketStatuses],ticketScope) + submitButton('Search') + btn('Refresh','refresh-tickets',true) + '</form>' +
    (tickets.length ? '<div class="list">'+tickets.map(t => {
      const actions = [];
      if (user.role === 'manager' && !['Repair Complete','Paid, not billed','Billed','Paid'].includes(t.status)) {
        actions.push('<form data-assign="'+e(t.id)+'">'+select('Technician','technician_id',technicianOptions,t.assigned_to).replace(' required','')+submitButton('Save assignment')+'</form>');
      }
      const awaitingParts = t.status === 'Awaiting Parts';
      if (user.role === 'manager' && awaitingParts) {
        actions.push('<button type="button" class="secondary" data-ticket-po="'+e(t.id)+'">Create PO</button>');
      }
      actions.push('<button type="button" class="secondary" data-ticket-detail="'+e(t.id)+'" data-ticket-number="'+t.ticket_number+'">View details</button>');
      return '<article class="panel ticket-card"'+(awaitingParts?' style="background:#fff1f2;border-color:#fca5a5"':'')+'><div class="section-title"><h2>#'+t.ticket_number+' · '+e(t.appliance)+'</h2>'+statusBadge(t.status)+'</div>'+
        '<p>'+e(t.brand)+' · '+e(t.customer_name)+'</p><p class="issue-preview">'+e(t.issue)+'</p>'+
        '<p class="meta">'+e(t.locality)+'</p><div class="card-actions"><a class="action-link" href="tel:+91'+e(t.mobile)+'">Call</a>'+actions.join('')+'</div></article>';
    }).join('')+'</div>' : '<p class="panel muted">No tickets match this view.</p>') +
    '<div class="actions">'+(offset ? btn('Previous','page-prev',true) : '')+(tickets.length === limit ? btn('Next','page-next',true) : '')+'</div>';
  submit($('ticket-filter'),async data => {
    pendingTicketNumber = '';
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
  for (const button of $('content').querySelectorAll('[data-ticket-detail]')) button.onclick = () => {
    detailTicketId=button.dataset.ticketDetail;
    history.pushState(null,'','/staff?ticket='+button.dataset.ticketNumber);
    load();
  };
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

function renderTicketDetail(data) {
  const t=data.ticket;
  const assigned=user.role === 'technician' && t.assigned_to === user.user_id;
  const complete=completedStatuses.includes(t.status);
  const inspecting=t.status === 'In Progress';
  const inspected=['Inspection Complete','Awaiting Parts'].includes(t.status) || complete;
  const canCollect=(assigned || ['manager','billing'].includes(user.role)) && complete && (!data.invoice || data.remaining > 0);
  $('page-title').textContent='Ticket #'+t.ticket_number;
  $('page-actions').innerHTML=btn('Back to tickets','back-tickets',true);
  $('back-tickets').onclick=()=>{detailTicketId=null;pendingTicketNumber='';history.replaceState(null,'','/staff');load();};
  const customerUrl=new URL('/',location.origin);
  customerUrl.search=new URLSearchParams({view:'track',ticket:t.ticket_number,access:t.customer_view_key}).toString();
  customerUrl.hash='complaints';
  const detail=(label,value)=>'<div><dt>'+label+'</dt><dd>'+e(value || '—')+'</dd></div>';
  let sections='';
  if(inspecting || inspected)sections+='<section class="panel"><h2>Inspection'+(inspecting ? ' in progress' : ' complete')+'</h2>'+
    (assigned && inspecting ? '<form id="inspection-form" class="grid"><label>Inspection notes<textarea name="notes" maxlength="2000" rows="3">'+e(t.inspection_notes)+'</textarea></label><div class="actions">'+'<button type="submit" class="secondary">Save comments</button><button type="submit" name="finish_inspection" value="yes">Inspection complete</button></div></form>' : '<p class="preserve-lines">'+e(t.inspection_notes || 'No inspection comments.')+'</p>')+
    '<h3 class="section-gap">Before photos <small class="meta">Optional</small></h3><div id="inspection-photos"></div><div id="inspection-gallery">'+photoGallery(data.media,'inspection')+'</div></section>';
  if(complete)sections+='<section class="panel"><h2>Repair completion</h2><p class="preserve-lines">'+e(t.completion_notes || 'Repair completed.')+'</p>'+
    (data.parts.length ? '<h3>Parts used</h3><ul>'+data.parts.map(part=>'<li>'+e(part.items?.description)+' · '+e(part.quantity)+' '+e(part.items?.uom)+'</li>').join('')+'</ul>' : '')+
    '<h3 class="section-gap">After photos <small class="meta">Optional</small></h3>'+photoGallery(data.media,'completion')+'</section>'+
    '<section class="panel"><div class="section-title"><h2>Payments and billing</h2>'+(canCollect ? btn('Receive payment','receive-payment') : '')+'</div>'+financialSummary(data)+receiptHistory(data.payments,data.media)+'<div class="actions"><a class="action-link" href="'+e(customerUrl.href)+'" target="_blank" rel="noopener noreferrer">Customer view</a>'+btn('Copy customer link','copy-customer-link',true)+'</div><p class="meta section-gap">The customer needs this private link and their registered mobile number to view photos and receipts.</p></section>';
  $('content').innerHTML='<section class="panel"><div class="section-title"><h2>'+e(t.appliance)+' · '+e(t.brand)+'</h2>'+statusBadge(t.status)+'</div><p>'+e(t.customer_name)+'</p><p class="preserve-lines">'+e(t.issue)+'</p><div class="actions"><a class="action-link" href="tel:+91'+e(t.mobile)+'">Call '+e(t.mobile)+'</a><a class="action-link" target="_blank" rel="noopener noreferrer" href="'+e(mapsLink(t))+'">Directions</a></div><dl class="ticket-facts">'+detail('Service address',[t.service_address,t.locality,t.city].filter(Boolean).join(', '))+detail('Service type',t.service_type)+detail('Source',t.intake_source)+detail('Created',date(t.created_at))+'</dl><div class="actions" id="repair-actions"></div></section>'+sections;
  if($('copy-customer-link'))$('copy-customer-link').onclick=async()=>{try{await navigator.clipboard.writeText(customerUrl.href);notice('Customer link copied');}catch{notice('Open Customer view and copy its address to share the private link.');}};
  if(canCollect)$('receive-payment').onclick=()=>receivePaymentModal(data);
  if(assigned && t.status === 'Assigned'){
    $('repair-actions').innerHTML=btn('Start inspection','start-inspection');
    $('start-inspection').onclick=async event=>{
      const button=event.currentTarget;button.disabled=true;
      try{await request('inspection',{id:t.id,step:'start',notes:''});await load();}catch(error){notice(error.message);button.disabled=false;}
    };
  }
  if(assigned && inspecting){
    const form=$('inspection-form');
    // Preserve unsaved comments when a photo finishes uploading.
    mountPhotoControls($('inspection-photos'),{ticketId:t.id,stage:'inspection',request,onError:notice,onBusy:busy=>{for(const button of form.querySelectorAll('button'))button.disabled=busy;},onUploaded:async()=>{
      const latest=await request('ticketDetail',{id:t.id});
      $('inspection-gallery').innerHTML=photoGallery(latest.media,'inspection');
    }});
    form.addEventListener('submit',event=>{form.dataset.step=event.submitter?.name === 'finish_inspection' ? 'complete' : 'save';});
    submit(form,async values=>{await request('inspection',{id:t.id,step:form.dataset.step,notes:values.notes});notice(form.dataset.step === 'complete' ? 'Inspection completed' : 'Comments saved');await load();});
  }
  if(assigned && ['Inspection Complete','Awaiting Parts'].includes(t.status)){
    $('repair-actions').innerHTML=(t.status === 'Inspection Complete' ? btn('Awaiting parts','change-progress',true) : '')+btn('Complete repair','complete-repair');
    if($('change-progress'))$('change-progress').onclick=async event=>{
      const button=event.currentTarget;button.disabled=true;
      try{await request('status',{id:t.id,status:'Awaiting Parts'});await load();}catch(error){notice(error.message);button.disabled=false;}
    };
    $('complete-repair').onclick=async event=>{
      const button=event.currentTarget;button.disabled=true;
      try{const catalog=await request('parts',{id:t.id});completionReview(t,catalog,data.media);}catch(error){notice(error.message);}finally{button.disabled=false;}
    };
  }
}

function completionReview(ticket,catalog,media) {
  const form=editableLines('Complete repair · #'+ticket.ticket_number,catalog.items,catalog.parts,false,async(parts,values)=>{
    await request('completeRepair',{id:ticket.id,parts,notes:values.notes});
    return 'Repair completed. You can now receive payment.';
  },'<label>Work performed<textarea name="notes" required maxlength="2000" rows="3">'+e(ticket.completion_notes)+'</textarea></label><h3>After photos <small class="meta">Optional</small></h3><div id="completion-review-photos"></div><div id="completion-review-gallery">'+photoGallery(media,'completion')+'</div><h3>Parts used</h3>','Complete repair');
  mountPhotoControls(form.querySelector('#completion-review-photos'),{ticketId:ticket.id,stage:'completion',request,onError:notice,onUploaded:async()=>{
    const latest=await request('ticketDetail',{id:ticket.id});
    form.querySelector('#completion-review-gallery').innerHTML=photoGallery(latest.media,'completion');
  }});
}

function receivePaymentModal(data) {
  const key=crypto.randomUUID(),ticket=data.ticket;
  let signatureId=null,proofId=null,selectedProof=null,proofPreviewUrl=null;
  const clearPreview=()=>{if(proofPreviewUrl)URL.revokeObjectURL(proofPreviewUrl);proofPreviewUrl=null;};
  $('dialog').addEventListener('close',clearPreview,{once:true});
  const form=modal('Receive payment · #'+ticket.ticket_number,
    input('Amount received (₹)','amount','type="number" min="0.01" max="'+e(data.invoice ? data.remaining : 9999999)+'" step="0.01" required '+(data.invoice ? 'value="'+e(data.remaining)+'"' : ''))+
    select('Payment method','method',['Cash','UPI'])+
    '<section id="upi-proof" hidden><p class="field-caption">Payment photo or screenshot <span class="required-mark">*</span></p><div class="actions photo-actions"><button type="button" id="take-payment-photo" class="secondary icon-button" aria-label="Take payment photo" title="Take payment photo">'+cameraIcon+'</button>'+btn('Upload photo','upload-payment-photo',true)+'</div><input name="proof" type="file" accept="image/jpeg,image/png,image/webp" hidden><input name="proof_camera" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden><p id="proof-selection" class="meta"></p><div id="proof-preview"></div><p class="meta">Attach the payment confirmation. Confirm receipt in your payment account.</p></section>'+
    '<section id="cash-ack"><p id="acknowledgement" class="cash-acknowledgement"></p><label>Customer signature<canvas id="customer-signature" aria-label="Customer signature pad"></canvas></label>'+btn('Clear signature','clear-signature',true)+'<label class="check-row"><input type="checkbox" name="cannot_sign">Customer cannot sign</label><label id="signature-reason" hidden>Reason customer cannot sign<textarea name="signature_waiver" maxlength="500" disabled></textarea></label></section>'+
    '<label class="check-row"><input type="checkbox" name="confirmed_received" required>I confirm the money has been received.</label>',
    'Save payment',async values=>{
      const cash=values.method === 'Cash';
      const waiver=cash && form.elements.cannot_sign.checked ? values.signature_waiver.trim() : '';
      if(cash && !waiver && !signatureId){
        const blob=await pad.blob();
        if(!blob)throw new Error('Ask the customer to sign, or record why they cannot sign.');
        signatureId=await uploadTicketMedia(request,ticket.id,'signature',blob,'customer-signature.png');
      }
      if(!cash && !selectedProof && !proofId)throw new Error('Attach a payment photo or screenshot for UPI.');
      if(!cash && selectedProof && !proofId){
        const file=selectedProof;
        proofId=await uploadTicketMedia(request,ticket.id,'payment',await compressPhoto(file),file.name || 'upi-payment.jpg');
      }
      const receipt=await request('receivePayment',{id:key,ticket_id:ticket.id,amount:Number(values.amount),method:values.method,reference:'',
        proof_media_id:cash ? null : proofId,signature_media_id:cash && !waiver ? signatureId : null,signature_waiver:waiver,confirmed_received:true});
      return 'Receipt RCPT-'+receipt.receipt_number+' saved';
    });
  const canvas=form.querySelector('#customer-signature'),pad=signaturePad(canvas,()=>{signatureId=null;});
  const clear=()=>{signatureId=null;pad.clear();};
  form.querySelector('#clear-signature').onclick=clear;
  form.elements.amount.oninput=()=>{clear();form.elements.confirmed_received.checked=false;updateAck();};
  for(const field of [form.elements.proof,form.elements.proof_camera])field.onchange=()=>{
    if(!field.files[0])return;
    clearPreview();proofId=null;selectedProof=field.files[0];
    form.querySelector('#proof-selection').textContent=selectedProof.name;
    proofPreviewUrl=URL.createObjectURL(selectedProof);
    const preview=document.createElement('img');preview.src=proofPreviewUrl;preview.alt='Selected UPI payment proof';preview.className='payment-preview';
    form.querySelector('#proof-preview').replaceChildren(preview);
    form.elements.confirmed_received.checked=false;
  };
  form.querySelector('#take-payment-photo').onclick=()=>form.elements.proof_camera.click();
  form.querySelector('#upload-payment-photo').onclick=()=>form.elements.proof.click();
  function updateAck(){form.querySelector('#acknowledgement').textContent='I confirm that I paid '+money(form.elements.amount.value || 0)+' in cash to Jyoti Refrigeration for ticket #'+ticket.ticket_number+'.';}
  function updateMethod(){
    const cash=form.elements.method.value === 'Cash';
    form.querySelector('#cash-ack').hidden=!cash;
    form.querySelector('#upi-proof').hidden=cash;
    const waived=cash && form.elements.cannot_sign.checked;
    form.querySelector('#signature-reason').hidden=!waived;
    form.elements.signature_waiver.disabled=!waived;
    form.elements.signature_waiver.required=waived;
    canvas.hidden=waived;
    form.querySelector('#clear-signature').hidden=waived;
    form.elements.confirmed_received.checked=false;
    clear();updateAck();markRequiredFields(form);
  }
  form.elements.method.onchange=updateMethod;
  form.elements.cannot_sign.onchange=updateMethod;
  updateMethod();
}

function newTicket() {
  const key = crypto.randomUUID();
  const form = modal('New service ticket',
    '<div class="pair">'+input('Customer name','customer_name','required maxlength="100"')+
    input('Mobile number','mobile','required inputmode="numeric" type="tel" pattern="[6-9][0-9]{9}" maxlength="10"')+
    input('Service area','locality','required maxlength="100" placeholder="Type locality"')+
    input('Brand','brand','required maxlength="100" placeholder="Type brand"')+
    select('Appliance','appliance',[placeholder('Choose appliance'),...applianceOptions])+
    input('City','city','value="Ambikapur, CG" required')+
    select('Service type','service_type',['Bring to Shop','Home Visit','Home Pickup','Installation','Preventive Maintenance','Warranty Service'])+
    select('Complaint source','intake_source',['Walk-in','Phone'])+'</div>'+
    '<label>Service address<textarea name="service_address" required maxlength="500"></textarea></label>'+
    '<label>Issue<textarea name="issue" required maxlength="2000"></textarea></label>',
    'Register complaint',async data => {
      const result = await request('createTicket',{...data,key});
      return 'Ticket #'+result.ticket_number+' registered';
    });
  attachSuggestions(form,'locality',localityOptions);
  attachSuggestions(form,'brand',brandOptions);
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
    markRequiredFields(wrapper);
  }
  form.querySelector('#add-line').onclick = () => addLine();
  for (const line of existing) addLine(line);
  if (!existing.length) addLine();
  return form;
}

const payable = row => Math.max(0,Math.round((Number(row.total ?? row.amount)-(row.payments || []).reduce((sum,p)=>sum+Number(p.amount),0))*100)/100);
function paymentModal(row, type) {
  const key = crypto.randomUUID();
  const due = payable(row);
  modal('Record payment',input('Amount','amount','type="number" min="0.01" max="'+e(due)+'" step="0.01" value="'+e(due)+'" required')+
    select('Method','method',['Cash','UPI','Bank Transfer','Card','Other'])+input('Reference','reference','maxlength="100"'),'Save payment',async data => {
    await request('payment',{ id:key,[type]:row.id,...numberFields(data,'amount') });
    return 'Payment recorded';
  });
}

function itemForm(item = {}) {
  const textInput = (label,name,required = false,max = 100) => input(label,name,
    (required ? 'required ' : '')+'maxlength="'+max+'" value="'+e(item[name] ?? '')+'"');
  const moneyInput = (label,name,required = true,max = 9999999) => input(label,name,
    'type="number" min="0" max="'+max+'" step="0.01" '+(required ? 'required ' : '')+'value="'+e(item[name] ?? '')+'"');
  const units = uomOptions.includes(item.uom) || !item.uom ? uomOptions : [item.uom,...uomOptions];
  const form = modal(item.id ? 'Edit item' : 'New item',
    '<div class="pair">'+input('Item code','code','required maxlength="32" value="'+e(item.code ?? '')+'"'+(item.id ? ' readonly' : ''))+
    select('Unit of measure','uom',[placeholder('Choose unit'),...units],item.uom)+'</div>'+
    textInput('Description','description',true,180)+
    '<div class="pair">'+textInput('Brand','brand')+textInput('Model','model')+'</div>'+
    textInput('HSN/SAC','hsn_sac',false,12)+
    '<div class="pair">'+moneyInput('Purchase price','purchase_price')+moneyInput('Customer price','sale_price',false)+'</div>'+
    moneyInput('Tax rate %','tax_rate',true,100), 'Save item',data=>request('item',{
      ...numberFields(data,'purchase_price','tax_rate'),
      sale_price:data.sale_price.trim() === '' ? null : Number(data.sale_price),
    }));
  attachSuggestions(form,'brand',brandOptions);
}

function renderItems({items,total,limit,offset:currentOffset}) {
  $('page-actions').innerHTML = btn('New item','new-item');
  $('new-item').onclick = () => itemForm();
  $('content').innerHTML = '<form id="item-search" class="inline-form master-search">'+
    input('Search items','search','type="search" maxlength="100" placeholder="Code, description, brand or model" value="'+e(itemSearch)+'"')+
    submitButton('Search')+'</form><section class="panel">'+
    '<p class="meta">'+(total ? 'Showing '+(currentOffset+1)+'–'+(currentOffset+items.length)+' of '+total+' items' : 'No matching items')+'</p>'+
    '<div class="table-wrap"><table><thead><tr><th>Item code</th><th>Description</th><th>Brand</th><th>Model</th><th>Unit</th><th>Purchase price</th><th>Customer price</th><th></th></tr></thead><tbody>'+
    items.map(item=>'<tr><td>'+e(item.code)+'</td><td>'+e(item.description)+'</td><td>'+e(item.brand || '—')+'</td><td>'+e(item.model || '—')+'</td><td>'+e(item.uom)+'</td><td>'+money(item.purchase_price)+'</td><td>'+
      (item.sale_price == null ? '—' : money(item.sale_price))+'</td><td><button class="secondary" data-item="'+e(item.id)+'">Edit</button></td></tr>').join('')+
    '</tbody></table></div>'+(items.length ? '' : '<p class="muted">'+(itemSearch ? 'Try another item code, description, brand or model.' : 'Add the parts you buy and use in repairs.')+'</p>')+'</section>'+
    '<div class="pagination"><span class="meta">Page '+(Math.floor(currentOffset/limit)+1)+' of '+Math.max(1,Math.ceil(total/limit))+'</span><div class="actions">'+
    (currentOffset ? btn('Previous','items-prev',true) : '')+(currentOffset+limit<total ? btn('Next','items-next',true) : '')+'</div></div>';
  submit($('item-search'),async data => { itemSearch = data.search.trim(); itemOffset = 0; await load(); });
  if ($('items-prev')) $('items-prev').onclick = () => { itemOffset = Math.max(0,currentOffset-limit); load(); };
  if ($('items-next')) $('items-next').onclick = () => { itemOffset = currentOffset+limit; load(); };
  for (const button of $('content').querySelectorAll('[data-item]')) button.onclick = () => itemForm(items.find(item=>item.id === button.dataset.item));
}

function renderSuppliers({suppliers}) {
  $('page-actions').innerHTML = btn('New supplier','new-supplier');
  $('new-supplier').onclick = () => modal('New supplier',input('Business name','name','required maxlength="150"')+
    input('Contact','contact','maxlength="100"')+input('Address','address','maxlength="300"')+
    input('GSTIN','gstin','maxlength="15"'),'Save supplier',data=>request('supplier',data));
  $('content').innerHTML = '<section class="panel"><div class="table-wrap"><table><thead><tr><th>Business name</th><th>Contact</th><th>Address</th><th>GSTIN</th></tr></thead><tbody>'+
    suppliers.map(supplier=>'<tr><td><strong>'+e(supplier.name)+'</strong></td><td>'+e(supplier.contact || '—')+'</td><td>'+e(supplier.address || '—')+'</td><td>'+e(supplier.gstin || '—')+'</td></tr>').join('')+
    '</tbody></table></div>'+(suppliers.length ? '' : '<p class="muted">Add the suppliers you purchase parts from.</p>')+'</section>';
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
  markRequiredFields(form);
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
    (completed.length ? completed.map(t=>'<div class="card-actions"><strong>#'+t.ticket_number+' · '+e(t.customer_name)+'</strong>'+((t.payments || []).length ? '<span class="badge status-unbilled">Received '+money(t.payments.reduce((sum,p)=>sum+Number(p.amount),0))+'</span>' : '')+'<button data-draft="'+e(t.id)+'">Review invoice</button></div>').join('') :
      '<p class="muted">No completed repairs awaiting billing.</p>')+'</section>'+
    '<section class="panel"><h2>Issued invoices</h2>'+
    (invoices.length ? invoices.map(b=>{
      const due = payable(b);
      const received = (b.payments || []).reduce((sum,p)=>sum+Number(p.amount),0);
      const excess = Math.max(0,Math.round((received-Number(b.total))*100)/100);
      const state = !due ? 'Paid' : due === Number(b.total) ? 'Pending payment' : 'Part paid';
      return '<div class="card-actions"><strong>'+e(b.number)+' · '+e(b.customer_name)+'</strong><span class="badge">'+state+'</span> '+'<span>Total '+money(b.total)+' · Received '+money(received)+' · Remaining '+money(due)+'</span>'+
        (excess > 0 ? '<span class="excess-payment">Excess '+money(excess)+' · refund or credit required</span>' : '')+
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
  for (const button of $('content').querySelectorAll('[data-invoice-pay]')) button.onclick = async () => {
    button.disabled=true;
    try{const bill=invoices.find(b=>b.id===button.dataset.invoicePay);receivePaymentModal(await request('ticketDetail',{id:bill.ticket_id}));}
    catch(error){notice(error.message);}finally{button.disabled=false;}
  };
}

window.addEventListener('popstate',()=>{
  const number=new URL(location.href).searchParams.get('ticket') || '';
  detailTicketId=null;pendingTicketNumber=number;filter=number;ticketScope=number ? 'all' : 'open';page='tickets';
  if(session) load();
});

$('menu-toggle').onclick = () => {
  const open = document.body.classList.toggle('menu-open');
  $('menu-toggle').setAttribute('aria-expanded',String(open));
  $('sidebar-backdrop').hidden = !open;
};
$('close-sidebar').onclick = closeSidebar;
$('sidebar-backdrop').onclick = closeSidebar;
document.addEventListener('keydown',event => { if (event.key === 'Escape') closeSidebar(); });
markRequiredFields();

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
