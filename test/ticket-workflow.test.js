import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {forms} from '../lib/validation.js';
import {imageMime,canUpload,ticketEvidence,createMediaUpload,finalizeMedia} from '../lib/ticket-workflow.js';
import {statusBadge,receiptHistory,financialSummary} from '../public/ticket-display.js';
import handler from '../api/service.js';
const id='aaaaaaaa-0000-4000-8000-000000000001',other='aaaaaaaa-0000-4000-8000-000000000002';
const originalFetch=globalThis.fetch;
Object.assign(process.env,{SUPABASE_URL:'https://db.example.invalid',SUPABASE_PUBLISHABLE_KEY:'test-only',SUPABASE_SERVICE_ROLE_KEY:'test-only',PUBLIC_RATE_LIMIT_SECRET:'test-only-not-a-production-key-with-32-characters'});
afterEach(()=>{globalThis.fetch=originalFetch;});
const call=async(action,input,authorized=false)=>{
 const req={method:'POST',headers:authorized ? {authorization:'Bearer test-token'} : {},body:{action,input},socket:{remoteAddress:'127.0.0.1'}};
 const res={setHeader(){},status(code){this.code=code;return this;},json(value){this.body=value;}};
 await handler(req,res);return res;
};
test('completion requires parts and work performed without a test result; UPI requires proof',()=>{
 const completion={id,parts:[{item_id:other,quantity:1}],notes:'Fixed'};
 assert.equal(forms.completion.safeParse(completion).success,true);
 for(const invalid of [{parts:[]},{notes:''}])assert.equal(forms.completion.safeParse({...completion,...invalid}).success,false);
 const payment={id,ticket_id:other,amount:2500,method:'Cash',confirmed_received:true};
 assert.equal(forms.collection.safeParse(payment).success,true);
 assert.equal(forms.collection.safeParse({...payment,method:'UPI'}).success,false);
 assert.equal(forms.collection.safeParse({...payment,method:'UPI',proof_media_id:id}).success,true);
 assert.equal(forms.inspection.safeParse({id,step:'complete',notes:''}).success,true);
 for(const invalid of [{amount:0},{amount:2500.001},{confirmed_received:false},{method:'Credit'}])assert.equal(forms.collection.safeParse({...payment,...invalid}).success,false);
});
test('image uploads are restricted to real supported formats and assigned staff',()=>{
 assert.equal(imageMime(Uint8Array.from([255,216,255,0])),'image/jpeg');
 assert.equal(imageMime(Uint8Array.from([137,80,78,71,13,10,26,10])),'image/png');
 assert.equal(imageMime(Buffer.from('RIFF0000WEBP')),'image/webp');
 assert.equal(imageMime(Buffer.from('<svg onload=evil>')),null);
 assert.throws(()=>canUpload({role:'technician',user_id:other},{assigned_to:id,status:'Repair Complete'},'inspection'),/assigned technician/);
 assert.throws(()=>canUpload({role:'technician',user_id:id},{assigned_to:id,status:'Assigned'},'payment'),/Complete the repair/);
 assert.throws(()=>canUpload({role:'billing',user_id:id},{status:'Repair Complete'},'inspection'),/assigned technician/);
 canUpload({role:'technician',user_id:id},{assigned_to:id,status:'Repair Complete'},'signature');
});
test('private evidence hides unlinked proofs and calculates remaining/excess correctly',async()=>{
 const rows={payments:[{amount:'2500.00',staff:{name:'Technician'}}],ticket_media:[{id:'before',object_path:'before.jpg',stage:'inspection',staff:{name:'Tech'}},{id:'hidden',stage:'signature',object_path:'secret.png',payment_id:null}],ticket_parts:[],invoices:{number:'5000/2026-27',total:'3000'}};
 const query=table=>{const chain={};for(const method of ['select','eq','order','maybeSingle'])chain[method]=()=>chain;chain.then=resolve=>resolve({data:rows[table],error:null});return chain;};
 const db={from:query,storage:{from:()=>({createSignedUrls:async paths=>{assert.deepEqual(paths,['before.jpg']);return {data:paths.map(()=>({signedUrl:'https://signed.invalid/photo'}))};}})}};
 const result=await ticketEvidence(db,id);
 assert.equal(result.collected,2500);assert.equal(result.remaining,500);assert.equal(result.excess,0);assert.equal(result.media.length,1);
 rows.invoices.total='2000';const excess=await ticketEvidence(db,id);assert.equal(excess.remaining,0);assert.equal(excess.excess,500);
});
test('receipt display escapes customer evidence and uses an orange unbilled badge',()=>{
 const html=receiptHistory([{receipt_number:1001,amount:2500,method:'Cash',paid_at:'2026-11-19T12:00:00Z',acknowledgement:'<script>bad</script>',signature_waiver:'',collected_by_name:'<img>',signature_media_id:id}],[]);
 assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'));assert.ok(!html.includes('<script>'));
 assert.match(statusBadge('Paid, not billed'),/status-unbilled/);
 assert.match(financialSummary({invoice:{number:'5000',total:3000},collected:2500,remaining:500,excess:0}),/Remaining amount/);
});
test('wrong private customer key cannot read evidence and phone is matched',async()=>{
 globalThis.fetch=async url=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/consume_rate_limit'))return Response.json(true);
  assert.equal(u.pathname,'/rest/v1/service_tickets');
  assert.equal(u.searchParams.get('customer_view_key'),'eq.'+other);
  assert.equal(u.searchParams.get('mobile'),'eq.9000000000');
  return Response.json([]);
 };
 assert.deepEqual((await call('track',{ticket:'10001',mobile:'9000000000',access:other})).body,{ok:true,result:null});
});
test('technician detail authorizes the ticket before service-role evidence queries',async()=>{
 globalThis.fetch=async url=>{
  const u=new URL(url);
  if(u.pathname==='/auth/v1/user')return Response.json({id});
  if(u.pathname==='/rest/v1/staff')return Response.json([{user_id:id,name:'Tech',role:'technician'}]);
  assert.equal(u.pathname,'/rest/v1/service_tickets');
  return Response.json({code:'PGRST116',message:'No rows'},{status:406});
 };
 assert.equal((await call('ticketDetail',{id:other},true)).code,404);
});
test('repair/payment endpoints carry the authenticated technician to atomic RPCs',async()=>{
 let last;
 globalThis.fetch=async(url,init)=>{
  const u=new URL(url);
  if(u.pathname==='/auth/v1/user')return Response.json({id});
  if(u.pathname==='/rest/v1/staff')return Response.json([{user_id:id,name:'Tech',role:'technician'}]);
  last=JSON.parse(init.body);return Response.json({receipt_number:1001,status:'Repair Complete'});
 };
 assert.equal((await call('completeRepair',{id:other,parts:[{item_id:id,quantity:1}],notes:'Fixed'},true)).code,200);
 assert.equal(last.p_user,id);assert.equal(last.p_ticket,other);
 assert.equal((await call('receivePayment',{id,ticket_id:other,amount:2500,method:'Cash',signature_waiver:'Unable to sign',confirmed_received:true},true)).code,200);
 assert.equal(last.p_user,id);assert.equal(last.p_amount,2500);
});
test('upload finalization verifies the uploaded bytes before making media visible',async()=>{
 let updated=false;
 const row={id:other,ticket_id:id,uploaded_by:id,stage:'inspection',object_path:'ticket/photo.jpg',mime_type:'image/jpeg',file_size:4,ready:false};
 const query=data=>{const c={};for(const method of ['select','eq','single'])c[method]=()=>c;c.then=resolve=>resolve({data,error:null});return c;};
 const db={from:()=>({...query(row),update:values=>{updated=values.ready;return query(null);}}),storage:{from:()=>({download:async()=>({data:new Blob([Uint8Array.from([255,216,255,0])])})})}};
 const context={db,userDb:{from:()=>query({assigned_to:id,status:'In Progress'})},staff:{user_id:id,role:'technician'}};
 assert.deepEqual(await finalizeMedia(context,{id,media_id:other}),{id:other});assert.equal(updated,true);
 updated=false;row.mime_type='image/png';
 await assert.rejects(()=>finalizeMedia(context,{id,media_id:other}),/Choose a JPEG/);assert.equal(updated,false);
});
test('private customer receipt view only signs visible media after link and phone match',async()=>{
 const paths=[];
 globalThis.fetch=async(url,init)=>{
  const u=new URL(url);paths.push(u.pathname);
  if(u.pathname.endsWith('/consume_rate_limit'))return Response.json(true);
  if(u.pathname==='/rest/v1/service_tickets')return Response.json([{id,ticket_number:10001,status:'Paid, not billed',customer_name:'Fixture'}]);
  if(u.pathname==='/rest/v1/payments')return Response.json([{amount:2500,receipt_number:1001,staff:{name:'Tech'}}]);
  if(u.pathname==='/rest/v1/ticket_media')return Response.json([]);
  if(u.pathname==='/rest/v1/ticket_parts')return Response.json([]);
  if(u.pathname==='/rest/v1/invoices')return Response.json([]);
  throw Error('Unexpected '+u.pathname);
 };
 const result=await call('track',{ticket:'10001',mobile:'9000000000',access:other});
 assert.equal(result.code,200);assert.equal(result.body.result.collected,2500);assert.equal(result.body.result.customer_view_key,undefined);assert.equal(result.body.result.id,undefined);
});

test('inspection media is unavailable before inspection and completion media before inspection completes',()=>{
 const staff={role:'technician',user_id:id};
 assert.throws(()=>canUpload(staff,{assigned_to:id,status:'Assigned'},'inspection'),/Start the inspection/);
 assert.throws(()=>canUpload(staff,{assigned_to:id,status:'In Progress'},'completion'),/Complete the inspection/);
 canUpload(staff,{assigned_to:id,status:'In Progress'},'inspection');
 canUpload(staff,{assigned_to:id,status:'Inspection Complete'},'completion');
});
test('inspection steps pass the authenticated identity and legacy invoice payment cannot bypass proof',async()=>{
 let rpc;
 globalThis.fetch=async(url,init)=>{
  const u=new URL(url);
  if(u.pathname==='/auth/v1/user')return Response.json({id});
  if(u.pathname==='/rest/v1/staff')return Response.json([{user_id:id,name:'Manager',role:'manager'}]);
  throw Error('Unexpected database operation '+u.pathname);
 };
 assert.equal((await call('payment',{id,invoice_id:other,amount:100,method:'UPI'},true)).code,422);
 globalThis.fetch=async(url,init)=>{
  const u=new URL(url);
  if(u.pathname==='/auth/v1/user')return Response.json({id});
  if(u.pathname==='/rest/v1/staff')return Response.json([{user_id:id,name:'Tech',role:'technician'}]);
  assert.equal(u.pathname,'/rest/v1/rpc/advance_ticket_inspection');rpc=JSON.parse(init.body);return Response.json(null);
 };
 assert.equal((await call('inspection',{id:other,step:'complete',notes:'Checked cooling'},true)).code,200);
 assert.equal(rpc.p_action,'complete');assert.equal(rpc.p_user,id);
});

test('assignment response requires an explicit decision/version and passes the signed-in technician',async()=>{
 assert.equal(forms.assignmentResponse.safeParse({id,version:1,response:'accept'}).success,true);
 assert.equal(forms.assignmentResponse.safeParse({id,response:'accept'}).success,false);
 let args;
 globalThis.fetch=async(url,init)=>{
  const path=new URL(url).pathname;
  if(path==='/auth/v1/user')return Response.json({id});
  if(path==='/rest/v1/staff')return Response.json([{user_id:id,name:'Tech',role:'technician'}]);
  assert.equal(path,'/rest/v1/rpc/respond_ticket_assignment');args=JSON.parse(init.body);return Response.json({status:'Assignment Rejected'});
 };
 assert.equal((await call('assignmentResponse',{id:other,version:2,response:'reject',reason:'Unavailable'},true)).code,200);
 assert.equal(args.p_user,id);assert.equal(args.p_version,2);assert.equal(args.p_reason,'Unavailable');
});
test('live configuration exposes the publishable key, never the server key',async()=>{
 globalThis.fetch=async url=>new URL(url).pathname==='/auth/v1/user'?Response.json({id}):Response.json([{user_id:id,name:'Manager',role:'manager'}]);
 const result=await call('liveConfig',{},true);
 assert.deepEqual(result.body.result,{url:process.env.SUPABASE_URL,key:process.env.SUPABASE_PUBLISHABLE_KEY});
 assert.equal(result.body.result.secret,undefined);
});

test('awaiting parts records item and quantity under the signed-in technician',async()=>{
 let rpc;
 globalThis.fetch=async(url,init)=>{
  const path=new URL(url).pathname;
  if(path==='/auth/v1/user')return Response.json({id});
  if(path==='/rest/v1/staff')return Response.json([{user_id:id,name:'Tech',role:'technician'}]);
  assert.equal(path,'/rest/v1/rpc/set_ticket_awaiting_parts');rpc=JSON.parse(init.body);return Response.json(null);
 };
 assert.equal((await call('awaitingParts',{id:other,parts:[]},true)).code,422);
 assert.equal((await call('awaitingParts',{id:other,parts:[{item_id:id,quantity:2}]},true)).code,200);
 assert.equal(rpc.p_user,id);assert.equal(rpc.p_parts[0].quantity,2);
});
