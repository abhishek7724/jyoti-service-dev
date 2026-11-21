import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/service.js';
const id='aaaaaaaa-0000-4000-8000-000000000001',original=globalThis.fetch;
Object.assign(process.env,{SUPABASE_URL:'https://db.example.invalid',SUPABASE_PUBLISHABLE_KEY:'test',SUPABASE_SERVICE_ROLE_KEY:'test'});
afterEach(()=>{globalThis.fetch=original;});
const details={id,version:0,customer_name:'Corrected customer',mobile:'9000000000',locality:'Godhanpur',city:'Ambikapur, CG',service_address:'Corrected address',appliance:'Refrigerator',brand:'LG',service_type:'Home Visit',issue:'Not cooling'};
async function call(input){const res={setHeader(){},status(n){this.code=n;return this;},json(b){this.body=b;}};await handler({method:'POST',headers:{authorization:'Bearer fixture'},body:{action:'editTicket',input}},res);return res;}
test('ticket edits authorize the manager and send only editable fields to an atomic versioned RPC',async()=>{
 let role='technician',calls=0;
 globalThis.fetch=async(url,init)=>{const u=new URL(url);
 if(u.pathname==='/auth/v1/user')return Response.json({id});
 if(u.pathname==='/rest/v1/staff')return Response.json([{user_id:id,role}]);
 assert.equal(u.pathname,'/rest/v1/rpc/edit_new_service_ticket');calls++;const p=JSON.parse(init.body);assert.equal(p.p_actor,id);assert.equal(p.p_ticket,id);assert.equal(p.p_version,0);assert.equal(p.p_details.service_address,'Corrected address');for(const field of ['status','assigned_to','ticket_number','created_at','latitude','maps_url'])assert.ok(!(field in p.p_details));return Response.json({saved:true});
 };
 assert.equal((await call(details)).code,403);role='billing';assert.equal((await call(details)).code,403);assert.equal(calls,0);
 role='manager';assert.equal((await call({...details,status:'New',assigned_to:id,latitude:20,maps_url:'bad'})).code,200);assert.equal(calls,1);
 assert.equal((await call({...details,mobile:'123'})).code,422);assert.equal((await call({...details,version:-1})).code,422);assert.equal(calls,1);
});
test('assignment and stale form database errors are shown without bypassing the RPC',async()=>{
 globalThis.fetch=async(url)=>{const p=new URL(url).pathname;if(p==='/auth/v1/user')return Response.json({id});if(p==='/rest/v1/staff')return Response.json([{user_id:id,role:'manager'}]);return Response.json({code:'P0001',message:'This ticket has been assigned. Editing is locked'},{status:400});};
 const r=await call(details);assert.equal(r.code,422);assert.match(r.body.error,/Editing is locked/);
});
