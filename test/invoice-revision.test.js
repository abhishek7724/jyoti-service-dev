import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {forms} from '../lib/validation.js';
import handler from '../api/service.js';
const id='aaaaaaaa-0000-4000-8000-000000000001',other='aaaaaaaa-0000-4000-8000-000000000002',original=globalThis.fetch;
Object.assign(process.env,{SUPABASE_URL:'https://db.example.invalid',SUPABASE_PUBLISHABLE_KEY:'test-only',SUPABASE_SERVICE_ROLE_KEY:'test-only'});
afterEach(()=>{globalThis.fetch=original;});
const input={invoice_id:other,revision:1,customer_name:'Customer',service_address:'Ambikapur',prices:[{line_index:0,unit_price:1200,tax_rate:18}],discount_type:'fixed',discount_value:250};
async function call(role,body=input){globalThis.fetch=async(url,init)=>{
 const path=new URL(url).pathname;if(path==='/auth/v1/user')return Response.json({id});if(path==='/rest/v1/staff')return Response.json([{user_id:id,name:'Staff',role}]);
 assert.equal(path,'/rest/v1/rpc/revise_unpaid_invoice');const rpc=JSON.parse(init.body);assert.equal(rpc.p_user,id);assert.equal(rpc.p_revision,1);assert.equal(rpc.p_prices[0].unit_price,1200);return Response.json({id:other,revision:2,total:1166});
};const res={setHeader(){},status(code){this.code=code;return this;},json(value){this.body=value;}};await handler({method:'POST',headers:{authorization:'Bearer test-token'},body:{action:'reviseInvoice',input:body}},res);return res;}
test('invoice correction validates values and role permissions',async()=>{
 assert.equal(forms.invoiceRevision.safeParse(input).success,true);
 assert.equal(forms.invoiceRevision.safeParse({...input,prices:[{line_index:0,unit_price:-1,tax_rate:18}]}).success,false);
 assert.equal(forms.invoiceRevision.safeParse({...input,revision:0}).success,false);
 assert.equal((await call('technician')).code,403);
 assert.equal((await call('billing')).code,200);
 assert.equal((await call('manager')).code,200);
});
