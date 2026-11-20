// All outbound calls are intercepted. No real customer, push or Meta message is sent.
// Run after npm run build:cloudflare.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import assert from 'node:assert/strict';
import {createECDH,randomBytes,createHmac} from 'node:crypto';
import {generateVAPIDKeys} from 'web-push';
import {TEMPLATE_NAME} from '../lib/whatsapp-invoice.js';

const id='aaaaaaaa-0000-4000-8000-000000000001';
const vapid=generateVAPIDKeys(),client=createECDH('prime256v1');
client.generateKeys();
const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/test-only',keys:{p256dh:client.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
const token='test-only-secret',bill={id,number:'5000/2026-27',issued_on:'2026-11-20',customer_name:'Runtime Test',service_address:'Test address',
  issuer:{name:'Test issuer',address:'Test address'},lines:[{description:'Service',quantity:1,uom:'Pcs.',unit_price:100,amount:100,cgst:0,sgst:0,tax_rate:0}],subtotal:100,cgst:0,sgst:0,total:100};
let pushSent=false,pdfStored=false,metaSent=false;
const options=convertV4MiniflareOptions({
  modules:true,scriptPath:'.wrangler/build/worker.js',compatibilityDate:'2026-11-20',compatibilityFlags:['nodejs_compat'],host:'127.0.0.1',port:0,inspectorPort:0,
  assets:{directory:'public',binding:'ASSETS',run_worker_first:['/api','/api/*'],routerConfig:{has_user_worker:true},assetConfig:{headers:{version:2,rules:{'/sw.js':{set:{'Cache-Control':'no-cache'}}}}}},
  bindings:{SUPABASE_URL:'https://db.example.invalid',SUPABASE_PUBLISHABLE_KEY:'test-only',SUPABASE_SERVICE_ROLE_KEY:'test-only',PUBLIC_RATE_LIMIT_SECRET:'test-only-not-a-production-secret',
    WEB_PUSH_PUBLIC_KEY:vapid.publicKey,WEB_PUSH_PRIVATE_KEY:vapid.privateKey,WEB_PUSH_SUBJECT:'mailto:runtime@example.invalid'},
  outboundService:async request=>{
    const u=new URL(request.url),path=u.pathname;
    if(u.hostname==='fcm.googleapis.com'){
      assert.match(request.headers.get('authorization'),/^vapid /);
      assert.equal(request.headers.get('content-encoding'),'aes128gcm');
      assert.ok((await request.arrayBuffer()).byteLength>100);pushSent=true;
      return new Response(null,{status:201});
    }
    if(path.endsWith('/consume_rate_limit'))return Response.json(true);
    if(path==='/auth/v1/user')return Response.json({id});
    if(path==='/rest/v1/staff')return Response.json([{user_id:id,name:'Runtime Manager',role:'manager'}]);
    if(path==='/rest/v1/push_subscriptions')return Response.json(request.method==='GET'?[{endpoint:subscription.endpoint,subscription}]:null);
    if(path==='/rest/v1/service_tickets'){
      if(u.searchParams.get('select')==='status')return Response.json([{status:'Assigned'}]);
      return Response.json(request.method==='PATCH'?{status:'Assigned',ticket_number:10001}:{assigned_to:null,status:'New',ticket_number:10001});
    }
    if(path.endsWith('/jyoti_whatsapp_config'))return Response.json({token,enabled:true,test_recipient:'919685858101'});
    if(path.endsWith('/message_templates'))return Response.json({data:[{name:TEMPLATE_NAME,status:'APPROVED'}]});
    if(path.endsWith('/jyoti_whatsapp_claim'))return Response.json(bill);
    if(path==='/storage/v1/bucket')return Response.json([{id:'invoice-pdfs'}]);
    if(path.includes('/storage/v1/object/invoice-pdfs/')){assert.equal(Buffer.from(await request.arrayBuffer()).subarray(0,5).toString(),'%PDF-');pdfStored=true;return Response.json({Key:'test.pdf'});}
    if(path.endsWith('/media')){assert.ok(pdfStored);return Response.json({id:'test-media'});}
    if(path.endsWith('/messages')){const body=await request.json();assert.equal(body.template.components[0].parameters[0].document.id,'test-media');metaSent=true;return Response.json({messages:[{id:'test-message'}]});}
    if(path.endsWith('/jyoti_whatsapp_finish'))return Response.json(null);
    throw new Error('Unexpected outbound request: '+u.hostname+path);
  },
});
const mf=new Miniflare(options);
const post=(path,body,headers={})=>mf.dispatchFetch('https://jyoti.invalid'+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
try{
  const health=await mf.dispatchFetch('https://jyoti.invalid/api/health');assert.equal(health.status,200,await health.text());
  const staffPage=await mf.dispatchFetch('https://jyoti.invalid/staff');assert.equal(staffPage.status,200,await staffPage.text());assert.match(staffPage.headers.get('content-type'),/text\/html/);
  const sw=await mf.dispatchFetch('https://jyoti.invalid/sw.js');assert.equal(sw.headers.get('cache-control'),'no-cache');
  console.log('PASS Cloudflare assets, clean staff URL, service worker caching and configured health');
  const track=await post('/api/service',{action:'track',input:{ticket:'10001',mobile:'9000000000'}});
  const payload=await track.json();assert.equal(track.status,200,JSON.stringify(payload));assert.equal(payload.result.status,'Assigned');
  console.log('PASS Supabase request compatibility and rate-limit crypto');
  assert.equal((await post('/api/service',{action:'dashboard',input:{}})).status,401);
  const assigned=await post('/api/service',{action:'assign',input:{id,technician_id:id}},{Authorization:'Bearer test-only'});
  const assignment=await assigned.json();assert.equal(assigned.status,200,JSON.stringify(assignment));assert.match(assignment.result.notification,/accepted/);assert.ok(pushSent);
  console.log('PASS staff authentication, assignment, VAPID encryption and HTTPS push transport');
  const body={action:'send',invoice_id:id,timestamp:String(Math.floor(Date.now()/1000))};
  const signature=createHmac('sha256',token).update('send:'+id+':'+body.timestamp).digest('hex');
  const whatsapp=await post('/api/whatsapp-invoice',body,{'x-jyoti-signature':signature});
  const message=await whatsapp.json();assert.equal(whatsapp.status,200,JSON.stringify(message));assert.ok(metaSent);
  console.log('PASS signed callback, PDF generation, private upload and WhatsApp document payload');
}finally{await mf.dispose();}
