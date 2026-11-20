import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/service.js';
import { amountWords } from '../public/documents.js';
import { forms, validatePushEndpoint } from '../lib/validation.js';

const key = 'aaaaaaaa-0000-4000-8000-000000000001';
const realFetch = globalThis.fetch;
Object.assign(process.env,{
  SUPABASE_URL:'https://db.example.invalid',SUPABASE_PUBLISHABLE_KEY:'test-only',
  SUPABASE_SERVICE_ROLE_KEY:'test-only',PUBLIC_RATE_LIMIT_SECRET:'test-key-not-a-real-production-secret',
});
afterEach(() => { globalThis.fetch = realFetch; });

async function request(action,input,headers={}) {
  const req = { method:'POST',headers,body:{action,input},socket:{remoteAddress:'127.0.0.1'} };
  const res = {
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; },
  };
  await handler(req,res);
  return {status:res.statusCode,body:res.body};
}

test('public complaint has no login and creates only one booking on retry',async () => {
  let record;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/consume_rate_limit')) return Response.json(true);
    assert.equal(path,'/rest/v1/service_tickets');
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.equal(body.intake_source,'Website');
      assert.equal(body.service_address,'Test Address');
      assert.equal(body.intake_key,key);
      assert.equal(body.maps_url,'https://maps.app.goo.gl/example');
      assert.equal(record,undefined);
      record = {ticket_number:10001,customer_view_key:key};
    }
    return Response.json(init.method === 'POST' ? record : record ? [record] : []);
  };
  const input = { name:'Test Customer',mobile:'9000000000',appliance:'Refrigerator',brand:'Other',
    service:'Home Visit',issue:'Not cooling',address:'Test Address',maps:'https://maps.app.goo.gl/example',key };
  for (const _ of [1,2]) {
    assert.deepEqual(await request('submit',input),{status:200,body:{ok:true,result:{ticket:10001,access:key}}});
  }
});

test('tracking only returns status after matching ticket and phone',async () => {
  globalThis.fetch = async (url) => {
    const target = new URL(url);
    if (target.pathname.endsWith('/consume_rate_limit')) return Response.json(true);
    assert.equal(target.searchParams.get('select'),'status');
    assert.equal(target.searchParams.get('ticket_number'),'eq.10001');
    assert.equal(target.searchParams.get('mobile'),'eq.9000000000');
    return Response.json([{status:'Assigned'}]);
  };
  assert.deepEqual(await request('track',{ticket:'10001',mobile:'9000000000'}),
    {status:200,body:{ok:true,result:{status:'Assigned'}}});
});

test('staff actions require authentication and public intake validates India mobile format',async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url),/consume_rate_limit$/);
    return Response.json(true);
  };
  assert.equal((await request('assign',{id:key,technician_id:key})).status,401);
  assert.equal((await request('track',{ticket:'10001',mobile:'1234567890'})).status,422);
});

test('payment precision, invoice words and push destination validation',() => {
  assert.equal(forms.payment.safeParse({id:key,invoice_id:key,amount:500.01,method:'UPI'}).success,true);
  assert.equal(forms.payment.safeParse({id:key,invoice_id:key,amount:500.011,method:'UPI'}).success,false);
  assert.equal(amountWords(2575),'Rupees Two Thousand Five Hundred Seventy Five Only');
  assert.equal(amountWords(110010.25),'Rupees One Lakh Ten Thousand Ten and Twenty Five Paise Only');
  assert.equal(validatePushEndpoint('https://fcm.googleapis.com/fcm/send/example'),true);
  assert.equal(validatePushEndpoint('https://fcm.googleapis.com.example.invalid/'),false);
  assert.equal(validatePushEndpoint('https://fcm.googleapis.com:444/fcm/send/example'),false);
});

test('ticket dashboard filters Billed and Paid and keeps settled tickets out of Open tickets',async () => {
  const queries = [];
  globalThis.fetch = async (url) => {
    const target = new URL(url);
    if (target.pathname === '/auth/v1/user') return Response.json({id:key});
    if (target.pathname === '/rest/v1/staff') {
      return Response.json(target.searchParams.get('select').includes('role')
        ? [{user_id:key,name:'Test Manager',role:'manager'}] : []);
    }
    assert.equal(target.pathname,'/rest/v1/service_tickets');
    queries.push(target.searchParams);
    return Response.json([]);
  };
  for (const status of ['Inspection Complete','Paid, not billed','Billed','Paid']) {
    const result = await request('dashboard',{status},{authorization:'Bearer test-token'});
    assert.equal(result.status,200);
    assert.equal(queries.at(-1).get('status'),'eq.'+status);
  }
  assert.equal((await request('dashboard',{openOnly:true},{authorization:'Bearer test-token'})).status,200);
  assert.equal(queries.at(-1).get('status'),'in.(New,Assigned,Accepted,Assignment Rejected,In Progress,Inspection Complete,Awaiting Parts)');
});

test('item master pages are limited to 50 and search includes code, description, brand and model',async () => {
  globalThis.fetch = async (url,init) => {
    const target = new URL(url);
    if (target.pathname === '/auth/v1/user') return Response.json({id:key});
    if (target.pathname === '/rest/v1/staff') return Response.json([{user_id:key,name:'Test Manager',role:'manager'}]);
    assert.equal(target.pathname,'/rest/v1/items');
    assert.equal(target.searchParams.get('offset'),'50');
    assert.equal(target.searchParams.get('limit'),'50');
    assert.equal(target.searchParams.get('order'),'code.asc');
    assert.match(new Headers(init.headers).get('prefer'),/count=exact/);
    for (const column of ['code','description','brand','model']) {
      assert.ok(target.searchParams.get('or').includes(column+'.ilike."%LG%"'));
    }
    return Response.json([{id:key,code:'PART-051'}],{headers:{'content-range':'50-50/101'}});
  };
  const result = await request('items',{search:'LG',offset:50},{authorization:'Bearer test-token'});
  assert.equal(result.status,200);
  assert.equal(result.body.result.total,101);
  assert.equal(result.body.result.limit,50);
  assert.equal(result.body.result.offset,50);
  assert.equal(result.body.result.items[0].code,'PART-051');
});

test('item customer price is optional and brand and model remain optional',() => {
  const item = {code:'P-01',description:'Repair part',uom:'Piece',purchase_price:100,tax_rate:18};
  assert.equal(forms.item.parse(item).sale_price,null);
  assert.equal(forms.item.parse({...item,sale_price:null}).sale_price,null);
  assert.equal(forms.item.parse({...item,sale_price:0}).sale_price,0);
  assert.equal(forms.item.safeParse({...item,sale_price:-1}).success,false);
  assert.equal(forms.item.parse({...item,brand:'LG',model:'ABC-01'}).model,'ABC-01');
});

test('manager home-visit booking uses the customer address without shop-device coordinates',async () => {
  let saved;
  globalThis.fetch = async (url,init) => {
    const target = new URL(url);
    if (target.pathname === '/auth/v1/user') return Response.json({id:key});
    if (target.pathname === '/rest/v1/staff') return Response.json([{user_id:key,name:'Test Manager',role:'manager'}]);
    assert.equal(target.pathname,'/rest/v1/service_tickets');
    if (init.method !== 'POST') return Response.json([]);
    saved = JSON.parse(init.body);
    return Response.json({ticket_number:10008});
  };
  const booking = {key,customer_name:'Test customer',mobile:'9000000000',locality:'Godhanpur',
    service_address:'Near ATM',appliance:'Air Conditioner',brand:'LG',service_type:'Home Visit',
    intake_source:'Phone',issue:'Not cooling'};
  assert.equal((await request('createTicket',booking,{authorization:'Bearer test-token'})).status,200);
  assert.equal(saved.service_address,'Near ATM');
  assert.equal(saved.locality,'Godhanpur');
  assert.equal(saved.latitude,null);
  assert.equal(saved.longitude,null);
  assert.equal(saved.maps_url,null);
  // Cached clients cannot accidentally save the manager's shop location either.
  assert.equal((await request('createTicket',{...booking,latitude:23.1,longitude:83.2,maps_url:'https://maps.google.com/?q=shop'},
    {authorization:'Bearer test-token'})).status,200);
  assert.equal(saved.latitude,null);
  assert.equal(saved.maps_url,null);
});

test('awaiting ticket dashboard includes its existing PO so creation can be disabled',async()=>{
  globalThis.fetch=async url=>{
    const u=new URL(url);
    if(u.pathname==='/auth/v1/user')return Response.json({id:key});
    if(u.pathname==='/rest/v1/staff')return Response.json(u.searchParams.get('select').includes('role') ? [{user_id:key,name:'Manager',role:'manager'}] : []);
    if(u.pathname==='/rest/v1/service_tickets')return Response.json([{id:key,ticket_number:10008,status:'Awaiting Parts'}]);
    if(u.pathname==='/rest/v1/ticket_required_parts')return Response.json([]);
    assert.equal(u.pathname,'/rest/v1/purchase_orders');
    assert.equal(u.searchParams.get('ticket_id'),'in.('+key+')');
    return Response.json([{ticket_id:key,po_number:10001}]);
  };
  const result=await request('dashboard',{}, {authorization:'Bearer test-token'});
  assert.equal(result.status,200);assert.equal(result.body.result.tickets[0].purchase_order.po_number,10001);
});

test('manager technician filter intersects ticket and status filters and supports unassigned',async()=>{
  const technician='aaaaaaaa-0000-4000-8000-000000000002';let query;
  globalThis.fetch=async url=>{
    const u=new URL(url);
    if(u.pathname==='/auth/v1/user')return Response.json({id:key});
    if(u.pathname==='/rest/v1/staff')return Response.json(u.searchParams.get('select').includes('role')?[{user_id:key,name:'Manager',role:'manager'}]:[]);
    assert.equal(u.pathname,'/rest/v1/service_tickets');query=u.searchParams;return Response.json([]);
  };
  let result=await request('dashboard',{technician,ticket:'10001',status:'In Progress',offset:75},{authorization:'Bearer test-token'});
  assert.equal(result.status,200);assert.equal(query.get('assigned_to'),'eq.'+technician);assert.equal(query.get('ticket_number'),'eq.10001');assert.equal(query.get('status'),'eq.In Progress');assert.equal(query.get('offset'),'75');
  result=await request('dashboard',{technician:'unassigned',openOnly:true},{authorization:'Bearer test-token'});
  assert.equal(result.status,200);assert.equal(query.get('assigned_to'),'is.null');assert.match(query.get('status'),/^in\./);
  result=await request('dashboard',{technician:'',status:'Paid'},{authorization:'Bearer test-token'});
  assert.equal(result.status,200);assert.equal(query.has('assigned_to'),false);assert.equal(query.get('status'),'eq.Paid');
  assert.equal((await request('dashboard',{technician:'invalid'},{authorization:'Bearer test-token'})).status,422);
});

test('technician accounts cannot use the manager assignment filter',async()=>{
  globalThis.fetch=async url=>new URL(url).pathname==='/auth/v1/user'?Response.json({id:key}):Response.json([{user_id:key,name:'Technician',role:'technician'}]);
  assert.equal((await request('dashboard',{technician:key},{authorization:'Bearer test-token'})).status,403);
});
