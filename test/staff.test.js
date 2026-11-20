import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/service.js';
import {forms} from '../lib/validation.js';
const id='aaaaaaaa-0000-4000-8000-000000000001',other='aaaaaaaa-0000-4000-8000-000000000002',original=globalThis.fetch;
Object.assign(process.env,{SUPABASE_URL:'https://db.example.invalid',SUPABASE_PUBLISHABLE_KEY:'test-only',SUPABASE_SERVICE_ROLE_KEY:'test-only',STAFF_PIN_SECRET:'test-only-pin-secret-at-least-32-characters'});
afterEach(()=>{globalThis.fetch=original;});
async function call(action,input){const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;}};await handler({method:'POST',headers:{authorization:'Bearer test-token'},body:{action,input}},res);return res;}
test('staff creation accepts all three roles and validates India mobile',()=>{
 const input={name:'Fixture',username:'new.user',pin:'1234',mobile_number:'9000000000'};
 for(const role of ['manager','technician','billing'])assert.equal(forms.staff.safeParse({...input,role}).success,true);
 assert.equal(forms.staff.safeParse({...input,role:'manager',mobile_number:'12345'}).success,false);
});
test('billing and technician users cannot list or manage staff',async()=>{
 for(const role of ['technician','billing']){
 globalThis.fetch=async url=>new URL(url).pathname==='/auth/v1/user'?Response.json({id}):Response.json([{user_id:id,name:'Staff',role}]);
 assert.equal((await call('staff',{})).code,403);assert.equal((await call('createStaff',{})).code,403);assert.equal((await call('updateStaff',{})).code,403);
 }
});
test('staff list is paginated and searches names, usernames and mobile numbers without credentials',async()=>{
 globalThis.fetch=async(url,init)=>{
  const u=new URL(url);if(u.pathname==='/auth/v1/user')return Response.json({id});
  if(u.pathname==='/rest/v1/staff' && u.searchParams.get('select')==='user_id,name,role')return Response.json([{user_id:id,name:'Manager',role:'manager'}]);
  assert.equal(u.searchParams.get('limit'),'50');assert.equal(u.searchParams.get('offset'),'0');
  assert.ok(!u.searchParams.get('select').includes('password'));for(const column of ['name','username','mobile_number'])assert.ok(u.searchParams.get('or').includes(column));
  return Response.json([{user_id:other,name:'Tech',username:'tech',mobile_number:'9000000000',role:'technician',active:true}],{headers:{'content-range':'0-0/1'}});
 };
 const result=await call('staff',{search:'Tech'});assert.equal(result.code,200);assert.equal(result.body.result.total,1);
});
test('manager account creation saves mobile, role and username with the new auth identity',async()=>{
 let saved;
 globalThis.fetch=async(url,init)=>{
 const path=new URL(url).pathname;
 if(path==='/auth/v1/user')return Response.json({id});
 if(path==='/auth/v1/admin/users')return Response.json({id:other,email:'newmanager@staff.jyoti.invalid'});
 if(init.method==='POST'){saved=JSON.parse(init.body);return Response.json(null);}
 return Response.json([{user_id:id,name:'Manager',role:'manager'}]);
 };
 const result=await call('createStaff',{name:'New Manager',username:'newmanager',pin:'1234',role:'manager',mobile_number:'9000000000'});
 assert.equal(result.code,200);assert.equal(saved.user_id,other);assert.equal(saved.role,'manager');assert.equal(saved.username,'newmanager');assert.equal(saved.mobile_number,'9000000000');
});
