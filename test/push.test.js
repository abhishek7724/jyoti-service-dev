import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sendAssignmentAlerts} from '../lib/push.js';
const endpoint='https://fcm.googleapis.com/fcm/send/test-only';
const env={WEB_PUSH_PUBLIC_KEY:'public',WEB_PUSH_PRIVATE_KEY:'private-test',WEB_PUSH_SUBJECT:'mailto:test@example.invalid'};
function dbFixture(){const changes=[];return{changes,from(){const query={select(){return this;},eq(){return this;},update(value){changes.push(value);this.write=true;return this;},delete(){changes.push('deleted');this.write=true;return this;},then(resolve){resolve({data:this.write?null:[{endpoint,subscription:{endpoint}}],error:null});}};return query;}};}
test('assignment push uses high urgency and 24h expiry, retries transient failures, and records acceptance',async()=>{
 const db=dbFixture();let attempts=0;
 const result=await sendAssignmentAlerts(db,'technician',10008,{env,send:async(subscription,payload,options)=>{
  assert.equal(options.urgency,'high');assert.equal(options.TTL,86400);assert.equal(JSON.parse(payload).ticketNumber,10008);
  if(++attempts===1)throw{statusCode:503};
 }});
 assert.equal(attempts,2);assert.match(result,/accepted/);assert.equal(db.changes[0].last_error_code,null);assert.ok(db.changes[0].last_accepted_at);
});
test('expired subscriptions are removed instead of repeatedly reported as enabled',async()=>{
 const db=dbFixture();await sendAssignmentAlerts(db,'technician',10008,{env,send:async()=>{throw{statusCode:410};}});assert.deepEqual(db.changes,['deleted']);
});
