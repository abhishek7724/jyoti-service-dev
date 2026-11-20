import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker, {handleApi} from '../cloudflare/worker.js';

test('Cloudflare API rejects oversized streamed bodies before invoking the handler',async()=>{
  let called=false;
  const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(32769));controller.close();}});
  const response=await handleApi(new Request('https://example.invalid/api/service',{method:'POST',body:stream,duplex:'half'}),()=>{called=true;});
  assert.equal(response.status,413);assert.equal(called,false);
  assert.equal(response.headers.get('cache-control'),'no-store');
});

test('rate limiting uses Cloudflare client IP rather than a spoofed Vercel header',async()=>{
  const response=await handleApi(new Request('https://example.invalid/api/service',{method:'POST',headers:{'cf-connecting-ip':'192.0.2.1','x-vercel-forwarded-for':'203.0.113.5'},body:'{}'}),(req,res)=>{
    assert.equal(req.headers['x-vercel-forwarded-for'],'192.0.2.1');
    assert.equal(req.body,'{}');res.status(200).json({ok:true});
  });
  assert.equal(response.status,200);assert.equal(response.headers.get('x-frame-options'),'DENY');
});

test('Cloudflare health fails closed until configured and unknown APIs never fall back to HTML',async()=>{
  assert.equal((await worker.fetch(new Request('https://example.invalid/api/health'),{})).status,503);
  const response=await worker.fetch(new Request('https://example.invalid/api/not-real'),{ASSETS:{fetch(){throw new Error('API must not serve HTML');}}});
  assert.equal(response.status,404);assert.match(response.headers.get('content-type'),/application\/json/);
});

test('actual Cloudflare routes preserve authentication, malformed body errors, and callback signature checks',async()=>{
  const request=(path,body)=>new Request('https://example.invalid'+path,{method:'POST',body});
  assert.equal((await worker.fetch(request('/api/service','bad'),{})).status,400);
  assert.equal((await worker.fetch(request('/api/service',JSON.stringify({action:'dashboard',input:{}})),{})).status,401);
  assert.equal((await worker.fetch(request('/api/whatsapp-invoice','{}'),{})).status,401);
  assert.equal((await worker.fetch(new Request('https://example.invalid/api/service',{method:'OPTIONS'}),{})).status,204);
});
