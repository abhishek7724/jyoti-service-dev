import { createHmac } from 'node:crypto';
import { sendAssignmentAlerts } from '../lib/push.js';
import { HttpError, clients, read, requireRole, staffSession } from '../lib/db.js';
import { forms, mobile, staffEmail, ticket, uuid, validatePushEndpoint } from '../lib/validation.js';

import {accessibleTicket, ticketEvidence, createMediaUpload, finalizeMedia} from '../lib/ticket-workflow.js';

const financeRoles = ['manager', 'billing'];
const publicActions = ['submit','track','login','refresh'];
const fields = 'id,ticket_number,customer_name,mobile,locality,city,service_address,appliance,brand,service_type,issue,latitude,longitude,maps_url,assigned_to,status,created_at,intake_source,parts_reviewed,assignment_version,assignment_responded_at,rejection_reason,activity_version';

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(422, result.error.issues[0]?.message || 'Check the form fields');
  return result.data;
}

async function rateLimit(db, req, action, limit, subject = '') {
  const secret = process.env.PUBLIC_RATE_LIMIT_SECRET;
  if (!secret || secret.length < 24) throw new HttpError(503, 'Public access is being configured');
  const ip = String(req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const key = createHmac('sha256', secret).update([action, subject || ip].join(':')).digest('hex');
  if (!(await read(db.rpc('consume_rate_limit', { p_bucket: key, p_limit: limit, p_window_seconds: 900 })))) {
    throw new HttpError(429, 'Too many requests. Please wait a few minutes and try again.');
  }
}

function optionalMaps(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 750) throw new HttpError(422, 'Enter a valid Google Maps share link');
  try {
    const url = new URL(value);
    const google = ['www.google.com','maps.google.com','google.com','www.google.co.in','maps.google.co.in','maps.app.goo.gl'];
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !(google.includes(url.hostname) || (url.hostname === 'goo.gl' && url.pathname.startsWith('/maps/')))) throw new Error();
    if (url.hostname.startsWith('www.') && !url.pathname.startsWith('/maps')) throw new Error();
    return url.href;
  } catch {
    throw new HttpError(422, 'Enter a valid Google Maps share link');
  }
}

function publicTicket(input) {
  const [latitude, longitude] = typeof input.pin === 'string' && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(input.pin)
    ? input.pin.split(',').map(Number) : [null, null];
  const service = input.service === 'Pickup and Return' ? 'Home Pickup' : input.service;
  return parse(ticket, {
    customer_name: input.name, mobile: input.mobile, locality: 'Ambikapur',
    service_address: (typeof input.address === 'string' && input.address.trim()) || (['Bring to Shop','Warranty Service'].includes(service) ? 'Jyoti Refrigeration' : ''),
    appliance: input.appliance, brand: input.brand, service_type: service,
    issue: input.issue, latitude, longitude, maps_url: optionalMaps(input.maps),
  });
}

function sessionView(session) {
  return { access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at };
}

async function publicAction(action, req, input) {
  const { db, userDb } = clients();
  if (action === 'login') {
    await rateLimit(db, req, action, 30);
    if (typeof input.username !== 'string' || !input.username.trim() || input.username.length > 150 ||
        typeof input.password !== 'string' || input.password.length > 100) throw new HttpError(422, 'Enter your staff username and password');
    const email = staffEmail(input.username);
    await rateLimit(db, req, 'login-account', 10, email);
    const { data, error } = await userDb.auth.signInWithPassword({ email, password: input.password });
    if (error || !data.session) throw new HttpError(401, 'Incorrect staff username or password');
    const staff = await read(db.from('staff').select('user_id').eq('user_id', data.user.id).eq('active', true).maybeSingle());
    if (!staff) throw new HttpError(403, 'This account has no active staff access');
    return sessionView(data.session);
  }
  if (action === 'refresh') {
    if (typeof input.refresh_token !== 'string' || input.refresh_token.length > 1024) throw new HttpError(401, 'Sign in again');
    const { data, error } = await userDb.auth.refreshSession({ refresh_token: input.refresh_token });
    if (error || !data.session) throw new HttpError(401, 'Sign in again');
    return sessionView(data.session);
  }
  await rateLimit(db, req, action, action === 'track' ? 25 : 8);
  if (action === 'track') {
    const phone = parse(mobile, input.mobile);
    const number = String(input.ticket);
    if (!/^[1-9][0-9]{4}$/.test(number)) throw new HttpError(422, 'Enter a five-digit ticket number');
    await rateLimit(db, req, 'track-ticket', 12, number);
    if (!input.access) return read(db.from('service_tickets').select('status').eq('ticket_number',Number(number)).eq('mobile',phone).maybeSingle());
    const access = parse(uuid,input.access);
    const customerTicket = await read(db.from('service_tickets').select('id,ticket_number,customer_name,appliance,brand,status,inspection_notes,completion_notes')
      .eq('ticket_number',Number(number)).eq('mobile',phone).eq('customer_view_key',access).maybeSingle());
    if (!customerTicket) return null;
    const {id,...details} = customerTicket;
    return {...details,...await ticketEvidence(db,id)};
  }
  if (input.website) throw new HttpError(422, 'Could not submit the complaint');
  const details = publicTicket(input);
  const key = parse(uuid, input.key);
  let result = await read(db.from('service_tickets').select('ticket_number,customer_view_key').eq('intake_key', key).eq('mobile', details.mobile).maybeSingle());
  if (!result) {
    try {
      result = await read(db.from('service_tickets').insert({ ...details, intake_key: key, intake_source: 'Website' }).select('ticket_number,customer_view_key').single());
    } catch (error) {
      if (error.status !== 409) throw error;
      result = await read(db.from('service_tickets').select('ticket_number,customer_view_key').eq('intake_key', key).eq('mobile', details.mobile).single());
    }
  }
  return {ticket:result.ticket_number,access:result.customer_view_key};
}


function issuerDetails() {
  let issuer;
  try { issuer = JSON.parse(process.env.INVOICE_ISSUER_JSON || '{}'); } catch { issuer = {}; }
  for (const field of ['name','address','gstin','bank','account','ifsc']) {
    if (typeof issuer[field] !== 'string' || !issuer[field].trim()) throw new HttpError(503, 'The invoice issuer is being configured');
  }
  return issuer;
}

async function staffAction(action, req, input) {
  const context = await staffSession(req);
  const { db, userDb, staff } = context;
  if (action === 'logout') {
    const token = req.headers.authorization.replace(/^Bearer /i, '');
    await db.auth.admin.signOut(token, 'local');
    return { signedOut: true };
  }
  if (action === 'dashboard') {
    const limit = 75;
    const offset = Number.isInteger(input.offset) && input.offset >= 0 && input.offset <= 15000 ? input.offset : 0;
    let query = userDb.from('service_tickets').select(fields).order('created_at', { ascending: false }).order('id').range(offset, offset + limit - 1);
    if (input.status !== undefined) {
      if (!['New','Assigned','Accepted','Assignment Rejected','In Progress','Inspection Complete','Awaiting Parts','Repair Complete','Paid, not billed','Billed','Paid'].includes(input.status)) {
        throw new HttpError(422, 'Choose a valid ticket status');
      }
      query = query.eq('status',input.status);
    } else if (input.openOnly === true) {
      query = query.in('status',['New','Assigned','Accepted','Assignment Rejected','In Progress','Inspection Complete','Awaiting Parts']);
    }
    if (input.ticket !== undefined && input.ticket !== '') {
      if (!/^[1-9][0-9]{4}$/.test(String(input.ticket))) throw new HttpError(422, 'Enter a five-digit ticket number');
      query = query.eq('ticket_number', Number(input.ticket));
    }
    const [tickets, technicians] = await Promise.all([
      read(query),
      staff.role === 'manager' ? read(userDb.from('staff').select('user_id,name').eq('role','technician').eq('active',true).order('name')) : [],
    ]);
    const waiting=tickets.filter(ticket=>ticket.status === 'Awaiting Parts');
    if(waiting.length){
      const required=await read(db.from('ticket_required_parts').select('ticket_id,item_id,quantity,items(code,description,uom)').in('ticket_id',waiting.map(ticket=>ticket.id)));
      for(const ticket of waiting)ticket.ticket_required_parts=required.filter(part=>part.ticket_id===ticket.id);
    }
    return { staff, tickets, technicians, limit, pushKey: staff.role === 'technician' && process.env.WEB_PUSH_PRIVATE_KEY && process.env.WEB_PUSH_SUBJECT ? process.env.WEB_PUSH_PUBLIC_KEY || '' : '' };
  }
  if(action === 'technicians'){requireRole(staff,'manager');return read(userDb.from('staff').select('user_id,name').eq('role','technician').eq('active',true).order('name'));}
  if(action === 'liveConfig')return {url:process.env.SUPABASE_URL,key:process.env.SUPABASE_PUBLISHABLE_KEY};
  if(action === 'assignmentResponse'){
    requireRole(staff,'technician');
    const data=parse(forms.assignmentResponse,input);
    return read(db.rpc('respond_ticket_assignment',{p_ticket:data.id,p_user:staff.user_id,p_version:data.version,p_response:data.response,p_reason:data.reason}));
  }
  if (action === 'ticketDetail') {
    const id = parse(uuid,input.id);
    const ticket = await accessibleTicket(userDb,staff,id);
    return {staff,ticket,pushKey:staff.role === 'technician' ? process.env.WEB_PUSH_PUBLIC_KEY || '' : '',requiredParts:await read(db.from('ticket_required_parts').select('item_id,quantity,items(code,description,uom)').eq('ticket_id',id)),...await ticketEvidence(db,id)};
  }
  if(action === 'awaitingParts'){
    requireRole(staff,'technician');const data=parse(forms.parts,input);
    await read(db.rpc('set_ticket_awaiting_parts',{p_ticket:data.id,p_user:staff.user_id,p_parts:data.parts}));return {saved:true};
  }
  if (action === 'inspection') {
    requireRole(staff,'technician');
    const data = parse(forms.inspection,input);
    await read(db.rpc('advance_ticket_inspection',{p_ticket:data.id,p_user:staff.user_id,p_action:data.step,p_notes:data.notes}));
    return {saved:true};
  }
  if (action === 'completeRepair') {
    requireRole(staff,'technician');
    const data = parse(forms.completion,input);
    return read(db.rpc('complete_service_ticket',{p_ticket:data.id,p_user:staff.user_id,p_parts:data.parts,p_notes:data.notes,p_test:''}));
  }
  if (action === 'receivePayment') {
    const data = parse(forms.collection,input);
    return read(db.rpc('receive_ticket_payment',{p_id:data.id,p_ticket:data.ticket_id,p_user:staff.user_id,p_amount:data.amount,p_method:data.method,
      p_reference:data.reference,p_proof:data.proof_media_id,p_signature:data.signature_media_id,p_waiver:data.signature_waiver}));
  }
  if (action === 'mediaUpload') {
    const data = parse(forms.mediaUpload,input);
    await rateLimit(db,req,'media-upload',60,staff.user_id);
    return createMediaUpload(context,data);
  }
  if (action === 'mediaReady') return finalizeMedia(context,parse(forms.mediaReady,input));
  if(action === 'staff'){
    requireRole(staff,'manager');
    const limit=50,offset=input.offset ?? 0;
    if(!Number.isSafeInteger(offset) || offset<0 || offset>1000000)throw new HttpError(422,'Choose a valid staff page');
    if(input.search!==undefined && (typeof input.search!=='string' || input.search.length>100))throw new HttpError(422,'Search must contain at most 100 characters');
    let query=db.from('staff').select('user_id,name,username,mobile_number,role,active',{count:'exact'}).order('name').order('user_id').range(offset,offset+limit-1);
    const search=(input.search || '').trim();
    if(search){const pattern=JSON.stringify('%'+search.replace(/[\\%_]/g,character=>'\\'+character)+'%');query=query.or(['name','username','mobile_number'].map(column=>column+'.ilike.'+pattern).join(','));}
    const result=await query;return {staff:await read(result),total:result.count ?? 0,offset,limit};
  }
  if(action === 'updateStaff'){
    requireRole(staff,'manager');const data=parse(forms.staffProfile,input);
    await read(db.rpc('update_staff_profile',{p_actor:staff.user_id,p_user:data.user_id,p_name:data.name,p_mobile:data.mobile_number,p_role:data.role}));return {saved:true};
  }
  if (action === 'createStaff') {
    requireRole(staff, 'manager');
    const { username, password, name, role,mobile_number } = parse(forms.staff, input);
    const { data, error } = await db.auth.admin.createUser({ email: staffEmail(username), password, email_confirm: true });
    if (error || !data.user) throw new HttpError(error?.status === 422 ? 409 : 422, error?.status === 422 ? 'That username may already be in use' : 'Staff account could not be created');
    try {
      await read(db.from('staff').insert({ user_id: data.user.id, name, role,username,mobile_number }));
    } catch (failure) {
      const cleanup = await db.auth.admin.deleteUser(data.user.id);
      if (cleanup.error) console.error('Staff onboarding cleanup failed', data.user.id);
      throw failure;
    }
    return { username, name };
  }
  if (action === 'customerLookup') {
    requireRole(staff,'manager');
    const phone = parse(mobile,input.mobile);
    return read(db.from('service_tickets').select('customer_name,locality,city,service_address')
      .eq('mobile',phone).order('created_at',{ascending:false}).limit(1).maybeSingle());
  }
  if (action === 'createTicket') {
    requireRole(staff, 'manager');
    const key = parse(uuid,input.key);
    if (!['Walk-in','Phone'].includes(input.intake_source)) throw new HttpError(422, 'Choose phone or walk-in');
    // Shop staff book against the customer's address, not the shop device's location.
    const details = parse(ticket,{...input,latitude:null,longitude:null,maps_url:null});
    const existing = () => read(db.from('service_tickets').select('ticket_number').eq('intake_key',key).eq('created_by',staff.user_id).maybeSingle());
    const prior = await existing();
    if (prior) return prior;
    try {
      return await read(db.from('service_tickets').insert({ ...details, intake_key:key, created_by:staff.user_id, intake_source:input.intake_source }).select('ticket_number').single());
    } catch (e) {
      if (e.status !== 409) throw e;
      const saved = await existing();
      if (saved) return saved;
      throw e;
    }
  }
  if (action === 'assign') {
    requireRole(staff, 'manager');
    const { id, technician_id } = parse(forms.assign, input);
    const previous = await read(userDb.from('service_tickets').select('assigned_to,ticket_number,status').eq('id',id).single());
    if(previous.assigned_to === technician_id)return {status:previous.status,ticket_number:previous.ticket_number,notification:'Assignment unchanged'};
    const updated = await read(userDb.from('service_tickets').update({ assigned_to: technician_id }).eq('id',id).select('status,ticket_number').single());
    let notification = '';
    if (technician_id && previous.assigned_to !== technician_id) {
      try { notification = await sendAssignmentAlerts(db, technician_id, updated.ticket_number); }
      catch { notification = 'Ticket assigned. Push could not be delivered.'; }
    }
    return { ...updated, notification };
  }
  if (action === 'status') {
    requireRole(staff, 'manager','technician');
    const { id,status } = parse(forms.status,input);
    return read(userDb.from('service_tickets').update({ status }).eq('id',id).select('status').single());
  }
  if (action === 'subscribe') {
    requireRole(staff,'technician');
    const subscription = parse(forms.subscription,input);
    if (!validatePushEndpoint(subscription.endpoint)) throw new HttpError(422,'This browser notification service is unsupported');
    await read(db.from('push_subscriptions').upsert({ endpoint:subscription.endpoint,user_id:staff.user_id,subscription,last_registered_at:new Date().toISOString(),last_error_code:null }));
    return { subscribed:true };
  }
  if (action === 'parts' || action === 'saveParts') {
    requireRole(staff,'technician');
    const id = parse(uuid,input.id);
    await read(userDb.from('service_tickets').select('id').eq('id',id).single());
    if (action === 'saveParts') {
      const { parts } = parse(forms.parts,input);
      return read(db.rpc('save_ticket_parts',{ p_ticket:id,p_user:staff.user_id,p_parts:parts }));
    }
    const [items,parts,required] = await Promise.all([
      read(db.from('items').select('id,code,description,uom,active').order('code')),
      read(db.from('ticket_parts').select('item_id,quantity').eq('ticket_id',id)),
      read(db.from('ticket_required_parts').select('item_id,quantity').eq('ticket_id',id)),
    ]);
    return { items,parts,required };
  }
  requireRole(staff,...financeRoles);
  switch (action) {
    case 'catalog': return catalog(db);
    case 'items': return itemMaster(db,input);
    case 'suppliers': return {suppliers:await read(db.from('suppliers').select('*').order('name'))};
    case 'item': return read(db.from('items').upsert(parse(forms.item,input),{onConflict:'code'}).select('id').single());
    case 'supplier': return read(db.from('suppliers').insert(parse(forms.supplier,input)).select('id').single());
    case 'purchases': return purchases(db);
    case 'po': {
      const po = parse(forms.po,input);
      return read(db.rpc('create_purchase_order',{p_supplier:po.supplier_id,p_ticket:po.ticket_id,p_user:staff.user_id,p_lines:po.lines}));
    }
    case 'receipt': {
      const data = parse(forms.receipt,input);
      return read(db.rpc('record_receipt',{p_id:data.id,p_line:data.line_id,p_quantity:data.quantity}));
    }
    case 'supplierBill': return read(db.from('supplier_bills').insert(parse(forms.supplierBill,input)).select('id').single());
    case 'billing': return billing(db);
    case 'invoiceDraft': {
      const id = parse(uuid,input.id);
      const [booking,parts] = await Promise.all([
        read(db.from('service_tickets').select('customer_name,service_address,locality,city,ticket_number,status').eq('id',id).single()),
        read(db.from('ticket_parts').select('item_id,quantity,items(description,uom,hsn_sac,sale_price,tax_rate)').eq('ticket_id',id)),
      ]);
      if (!['Repair Complete','Paid, not billed'].includes(booking.status)) throw new HttpError(422,'Finish the repair before billing');
      return { booking,parts };
    }
    case 'invoice': {
      const data = parse(forms.invoice,input);
      const start = Number(process.env.INVOICE_START_NUMBER || 1);
      if (!Number.isSafeInteger(start) || start < 1) throw new HttpError(503,'The invoice sequence is being configured');
      return read(db.rpc('issue_discounted_service_invoice',{
        p_ticket:data.id,p_fee:data.fee,p_tax_rate:data.tax_rate,p_gstin:data.gstin,p_issuer:issuerDetails(),p_start:start,
        p_prices:data.prices,p_discount_type:data.discount_type,p_discount_value:data.discount_value,
      }));
    }
    case 'payment': {
      const p = parse(forms.payment,input);
      if(p.invoice_id)throw new HttpError(422,'Open Receive payment on the ticket to record a customer payment with its acknowledgement or UPI proof');
      return read(db.rpc('record_payment',{p_id:p.id,p_invoice:p.invoice_id,p_bill:p.supplier_bill_id,p_amount:p.amount,p_method:p.method,p_reference:p.reference}));
    }
    default: throw new HttpError(404,'Unknown action');
  }
}

async function itemMaster(db,input) {
  const limit = 50;
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new HttpError(422,'Choose a valid item page');
  if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 100)) throw new HttpError(422,'Search must contain at most 100 characters');
  const search = (input.search || '').trim();
  let query = db.from('items').select('*',{count:'exact'}).order('code').range(offset,offset+limit-1);
  if (search) {
    const pattern = JSON.stringify('%'+search.replace(/[\\%_]/g,character=>'\\'+character)+'%');
    query = query.or(['code','description','brand','model'].map(column=>column+'.ilike.'+pattern).join(','));
  }
  const result = await query;
  return {items:await read(result),total:result.count ?? 0,offset,limit};
}

async function catalog(db) {
  const [items,suppliers] = await Promise.all([
    read(db.from('items').select('*').order('code')),
    read(db.from('suppliers').select('*').order('name')),
  ]);
  return { items,suppliers };
}

async function purchases(db) {
  const [orders, masters] = await Promise.all([
    read(db.from('purchase_orders').select('id,po_number,created_at,suppliers(id,name,contact),service_tickets(ticket_number),purchase_lines(*),supplier_bills(*,payments(amount,method,reference,paid_at))').order('created_at',{ascending:false})),
    catalog(db),
  ]);
  return { orders,...masters };
}

async function billing(db) {
  const [completed,invoices] = await Promise.all([
    read(db.from('service_tickets').select('id,ticket_number,customer_name,created_at,payments!payments_ticket_id_fkey(amount),invoices!left(id)').in('status',['Repair Complete','Paid, not billed']).is('invoices',null).order('created_at',{ascending:false})),
    read(db.from('invoices').select('*,service_tickets(ticket_number,mobile),payments(amount,method,reference,paid_at)').order('issued_on',{ascending:false}).order('id')),
  ]);
  return { completed,invoices };
}

export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  const bridge = req.headers.origin === process.env.PUBLIC_PORTAL_ORIGIN && Boolean(process.env.PUBLIC_PORTAL_ORIGIN);
  try {
    if (req.method !== 'POST' && req.method !== 'OPTIONS') throw new HttpError(405,'Use POST');
    if (req.method === 'OPTIONS') {
      if (bridge) {
        res.setHeader('Access-Control-Allow-Origin',req.headers.origin);
        res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers','Content-Type');
        res.setHeader('Vary','Origin');
      }
      return res.status(204).end();
    }
    let body;
    try {
      if (Number(req.headers['content-length']) > 32768 || (typeof req.body === 'string' && req.body.length > 32768)) throw new Error();
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || typeof body.action !== 'string' || JSON.stringify(body).length > 32768 || !body.input ||
          typeof body.input !== 'object' || Array.isArray(body.input)) throw new Error();
    } catch { throw new HttpError(400,'Invalid request'); }
    const { action,input } = body;
    if (bridge && ['submit','track'].includes(action)) {
      res.setHeader('Access-Control-Allow-Origin',req.headers.origin);
      res.setHeader('Vary','Origin');
    }
    const result = publicActions.includes(action) ? await publicAction(action,req,input) : await staffAction(action,req,input);
    return res.status(200).json({ok:true,result});
  } catch (error) {
    if (!(error instanceof HttpError)) console.error('Service operation failed', error.name);
    return res.status(error.status || 500).json({ok:false,error:error.status ? error.message : 'Could not complete the request'});
  }
}
