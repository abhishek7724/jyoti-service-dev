import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {billingQuery} from '../lib/billing.js';
import {billingMarkup} from '../public/billing-table.js';
import handler from '../api/service.js';
const id='aaaaaaaa-0000-4000-8000-000000000001',realFetch=globalThis.fetch;
Object.assign(process.env,{SUPABASE_URL:'https://db.example.invalid',SUPABASE_PUBLISHABLE_KEY:'test-only',SUPABASE_SERVICE_ROLE_KEY:'test-only'});
afterEach(()=>{globalThis.fetch=realFetch;});
test('billing validates page sizes, search and real calendar ranges before querying',()=>{
 assert.equal(billingQuery({search:' Ravi ',limit:10,offset:10,status:'part_paid'}).p_search,'Ravi');
 for(const input of [{limit:1000},{offset:-1},{status:'open'},{tab:'staff'},{search:'x'.repeat(101)},{from:'2026-02-30'},{from:'2026-11-02',to:'2026-11-01'}])assert.throws(()=>billingQuery(input),e=>e.status===422);
});
test('billing pagination is sent to the database and technicians cannot access it',async()=>{
 for(const role of ['manager','billing','technician']){
  let rpcCalled=false;
  globalThis.fetch=async(url,init)=>{
   const path=new URL(url).pathname;if(path==='/auth/v1/user')return Response.json({id});
   if(path==='/rest/v1/staff')return Response.json([{user_id:id,name:'Staff',role}]);
   assert.equal(path,'/rest/v1/rpc/billing_workspace');rpcCalled=true;const input=JSON.parse(init.body);assert.equal(input.p_offset,50);assert.equal(input.p_limit,25);assert.equal(input.p_status,'pending');return Response.json({total:100,invoices:[],completed:[]});
  };
  const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;}};
  await handler({method:'POST',headers:{authorization:'Bearer test-only'},body:{action:'billing',input:{offset:50,limit:25,status:'pending'}}},res);
  assert.equal(res.code,role==='technician'?403:200);assert.equal(rpcCalled,role!=='technician');
 }
});
test('invoice table preserves edit/payment rules, aligned actions and escaped customer data',()=>{
 const bill={id,number:'5000/2026-27',customer_name:'<script>alert(1)</script>',total:2000,received:500,due:1500,excess:0,payment_status:'part_paid',service_tickets:{ticket_number:10001,mobile:'9000000000'}};
 const state={tab:'invoices',status:'all',search:'',from:'',to:''};
 const data={invoices:[bill],completed:[],total:1,offset:0,limit:25};
 let html=billingMarkup(data,state);assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(!html.match(/<button[^>]+data-invoice-edit[^>]+>/)[0].includes(' disabled')); assert.match(html,/data-invoice-pay/);assert.match(html,/Showing 1–1 of 1/);assert.match(html,/id="billing-next" disabled/);
 html=billingMarkup({...data,invoices:[{...bill,received:2500,due:0,excess:500,payment_status:'paid'}]},state);
 assert.match(html,/data-invoice-edit="[^"]+"[^>]* disabled/);assert.match(html,/data-invoice-pay="[^"]+"[^>]* disabled/);assert.match(html,/500\.00 excess/);
 assert.match(billingMarkup({...data,invoices:[],total:0},{...state,search:'missing'}),/No results match your filters/);
});
