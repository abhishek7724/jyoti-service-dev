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
      record = {ticket_number:10001};
    }
    return Response.json(init.method === 'POST' ? record : record ? [record] : []);
  };
  const input = { name:'Test Customer',mobile:'9000000000',appliance:'Refrigerator',brand:'Other',
    service:'Home Visit',issue:'Not cooling',address:'Test Address',maps:'https://maps.app.goo.gl/example',key };
  for (const _ of [1,2]) {
    assert.deepEqual(await request('submit',input),{status:200,body:{ok:true,result:{ticket:10001}}});
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
  for (const status of ['Billed','Paid']) {
    const result = await request('dashboard',{status},{authorization:'Bearer test-token'});
    assert.equal(result.status,200);
    assert.equal(queries.at(-1).get('status'),'eq.'+status);
  }
  assert.equal((await request('dashboard',{openOnly:true},{authorization:'Bearer test-token'})).status,200);
  assert.equal(queries.at(-1).get('status'),'in.(New,Assigned,In Progress,Awaiting Parts)');
});
