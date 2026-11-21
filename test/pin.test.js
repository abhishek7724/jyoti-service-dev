import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {pinPassword} from '../lib/staff-pin.js';
import {forms} from '../lib/validation.js';
import handler from '../api/service.js';
Object.assign(process.env,{SUPABASE_URL:'https://db.example.invalid',SUPABASE_PUBLISHABLE_KEY:'test-only',SUPABASE_SERVICE_ROLE_KEY:'test-only',STAFF_PIN_SECRET:'test-only-pin-secret-at-least-32-characters',PUBLIC_RATE_LIMIT_SECRET:'test-only-public-secret-at-least-24-characters'});
const original=globalThis.fetch;
afterEach(()=>{globalThis.fetch=original;});
async function login(input){const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;}};await handler({method:'POST',headers:{},body:{action:'login',input}},res);return res;}
test('PINs preserve leading zeros and derive a strong identity-specific credential',()=>{
 const a=pinPassword('A@EXAMPLE.COM','0123');assert.equal(a,pinPassword('a@example.com','0123'));assert.notEqual(a,pinPassword('b@example.com','0123'));assert.notEqual(a,pinPassword('a@example.com','1230'));assert.equal(a.length,68);
 for(const pin of ['123','12345','abcd',1234,' 1234'])assert.throws(()=>pinPassword('a@example.com',pin));
 const base={name:'Tech',username:'tech',mobile_number:'9000000000',role:'technician'};
 assert.equal(forms.staff.safeParse({...base,pin:'0123'}).success,true);assert.equal(forms.staff.safeParse({...base,password:'old-password'}).success,false);
});
test('login uses protected PIN credential and five-attempt account limit',async()=>{
 let tokenRequested=false;
 globalThis.fetch=async(url,init)=>{const u=new URL(url);
 if(u.pathname.endsWith('/consume_rate_limit')){const b=JSON.parse(init.body);assert.ok([5,30].includes(b.p_limit));return Response.json(true);}
 if(u.pathname.endsWith('/staff_login_identity'))return Response.json({user_id:'aaaaaaaa-0000-4000-8000-000000000001',email:'tech@staff.jyoti.invalid'});
 if(u.pathname==='/auth/v1/token'){tokenRequested=true;assert.equal(JSON.parse(init.body).password,pinPassword('tech@staff.jyoti.invalid','0123'));return Response.json({access_token:'fixture',refresh_token:'fixture-refresh',expires_in:3600,token_type:'bearer',user:{id:'aaaaaaaa-0000-4000-8000-000000000001'}});}
 return Response.json({user_id:'aaaaaaaa-0000-4000-8000-000000000001'});
 };
 const r=await login({username:'Tech',pin:'0123'});assert.equal(r.code,200);assert.equal(tokenRequested,true);
});
test('legacy password and incorrect PIN cannot sign in; exhausted account limit blocks auth',async()=>{
 globalThis.fetch=async()=>Response.json(true);
 assert.equal((await login({username:'tech',password:'old-password'})).code,422);
 globalThis.fetch=async(url)=>{const p=new URL(url).pathname;if(p.endsWith('/consume_rate_limit'))return Response.json(true);if(p.endsWith('/staff_login_identity'))return Response.json({user_id:'aaaaaaaa-0000-4000-8000-000000000001',email:'tech@staff.jyoti.invalid'});return Response.json({message:'Invalid login credentials'},{status:400});};
 assert.equal((await login({username:'tech',pin:'9999'})).code,401);
 let auth=false;
 globalThis.fetch=async(url,init)=>{if(new URL(url).pathname.endsWith('/consume_rate_limit'))return Response.json(JSON.parse(init.body).p_limit!==5);auth=true;return Response.json({});};
 assert.equal((await login({username:'tech',pin:'1234'})).code,429);assert.equal(auth,false);
});
test('only managers can reset a PIN and only for a staff identity',async()=>{
 const manager='aaaaaaaa-0000-4000-8000-000000000001',target='aaaaaaaa-0000-4000-8000-000000000002';
 const call=async()=>{const res={setHeader(){},status(n){this.code=n;return this;},json(b){this.body=b;}};await handler({method:'POST',headers:{authorization:'Bearer fixture'},body:{action:'resetStaffPin',input:{user_id:target,pin:'0456'}}},res);return res;};
 let role='technician',exists=true,updated=false;
 globalThis.fetch=async(url,init)=>{const u=new URL(url);
 if(u.pathname==='/auth/v1/user')return Response.json({id:manager});
 if(u.pathname.endsWith('/consume_rate_limit'))return Response.json(true);
 if(u.pathname==='/rest/v1/staff')return Response.json(u.searchParams.get('select')==='user_id,name,role'?[{user_id:manager,role}]:exists?{user_id:target}:null);
 if(u.pathname==='/auth/v1/admin/users/'+target){if(init.method==='PUT'){assert.equal(JSON.parse(init.body).password,pinPassword('target@staff.jyoti.invalid','0456'));updated=true;}return Response.json({id:target,email:'target@staff.jyoti.invalid'});}
 throw new Error('Unexpected request');};
 assert.equal((await call()).code,403);assert.equal(updated,false);
 role='billing';assert.equal((await call()).code,403);
 role='manager';exists=false;assert.equal((await call()).code,404);assert.equal(updated,false);
 exists=true;assert.equal((await call()).code,200);assert.equal(updated,true);
});
test('renamed username keeps its stable auth email and PIN; old and deleted usernames cannot sign in',async()=>{
 const id='aaaaaaaa-0000-4000-8000-000000000001';let tokenCalls=0;
 globalThis.fetch=async(url,init)=>{const p=new URL(url).pathname;
 if(p.endsWith('/consume_rate_limit'))return Response.json(true);
 if(p.endsWith('/staff_login_identity'))return Response.json(JSON.parse(init.body).p_username==='abhishek'?{user_id:id,email:'original@example.com'}:null);
 if(p==='/auth/v1/token'){tokenCalls++;const body=JSON.parse(init.body);assert.equal(body.email,'original@example.com');assert.equal(body.password,pinPassword('original@example.com','0456'));return Response.json({access_token:'fixture',refresh_token:'fixture-refresh',expires_in:3600,token_type:'bearer',user:{id}});}
 return Response.json({user_id:id});
 };
 assert.equal((await login({username:' Abhishek ',pin:'0456'})).code,200);
 for(const username of ['original@example.com','edwin','sik'])assert.equal((await login({username,pin:'0456'})).code,401);
 assert.equal(tokenCalls,1);
});
