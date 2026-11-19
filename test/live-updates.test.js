import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLiveUpdates} from '../public/live-updates.js';
function fixture(){
 let clock=0,changed,status,blocked=false,active=true,reloads=0,token='staff-token',disconnected=false;
 class RealtimeClient{
  constructor(url,options){assert.equal(url,'https://project.invalid/realtime/v1');assert.equal(options.params.apikey,'publishable-only');}
  async setAuth(value){assert.equal(value,token);}
  channel(){return {on(type,filter,handler){assert.equal(type,'postgres_changes');assert.equal(filter.table,'service_tickets');changed=handler;return this;},subscribe(handler){status=handler;return this;}};}
  disconnect(){disconnected=true;}
 }
 const updates=createLiveUpdates({request:async()=>({url:'https://project.invalid',key:'publishable-only'}),reload:async()=>{reloads++;return true;},isBlocked:()=>blocked,isActive:()=>active,getToken:()=>token,loadClient:async()=>({RealtimeClient}),now:()=>clock,timers:{setInterval:()=>1,clearInterval(){}}});
 return{updates,time:value=>{clock=value;},block:value=>{blocked=value;},active:value=>{active=value;},change:()=>changed(),status:value=>status(value),reloads:()=>reloads,disconnected:()=>disconnected};
}
test('database changes refresh live views but preserve unsaved forms',async()=>{
 const f=fixture();await f.updates.start();f.status('SUBSCRIBED');f.time(300);await f.updates.tick();assert.equal(f.reloads(),1);
 f.block(true);f.change();f.time(2000);await f.updates.tick();assert.equal(f.reloads(),1);
 f.block(false);await f.updates.tick();assert.equal(f.reloads(),2);
 f.active(false);f.change();f.time(4000);await f.updates.tick();assert.equal(f.reloads(),2);
 f.active(true);await f.updates.tick();assert.equal(f.reloads(),3);
 f.updates.stop();assert.equal(f.disconnected(),true);f.time(10000);await f.updates.tick();assert.equal(f.reloads(),3);
});
test('live connection has a five-second disconnected fallback and thirty-second safety refresh',async()=>{
 const f=fixture();await f.updates.start();f.time(4999);await f.updates.tick();assert.equal(f.reloads(),0);
 f.time(5000);await f.updates.tick();assert.equal(f.reloads(),1);
 f.status('SUBSCRIBED');f.time(5300);await f.updates.tick();assert.equal(f.reloads(),2);
 f.time(30000);await f.updates.tick();assert.equal(f.reloads(),2);
 f.time(35300);await f.updates.tick();assert.equal(f.reloads(),3);
 f.updates.stop();
});
