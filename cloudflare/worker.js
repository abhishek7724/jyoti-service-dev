import service from '../api/service.js';
import whatsappInvoice from '../api/whatsapp-invoice.js';

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
};

function jsonError(status, message) {
  return Response.json({ok:false,error:message}, {
    status, headers:{...securityHeaders,'Cache-Control':'no-store'},
  });
}

// Bound the stream, including requests without Content-Length, before buffering it.
async function bodyText(request, maximum) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maximum) throw new RangeError('Request too large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new RangeError('Request too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset);offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function handleApi(request, handler) {
  let body = '';
  if (!['GET','HEAD','OPTIONS'].includes(request.method)) {
    try { body = await bodyText(request,32768); }
    catch (error) { return jsonError(error instanceof RangeError ? 413 : 400,'Invalid request'); }
  }
  const headers = Object.fromEntries(request.headers);
  // Cloudflare sets CF-Connecting-IP. Never trust a client-supplied Vercel header.
  headers['x-vercel-forwarded-for'] = request.headers.get('cf-connecting-ip') || 'unknown';
  const req = {method:request.method,headers,body};
  const responseHeaders = new Headers({...securityHeaders,'Cache-Control':'no-store'});
  let status = 200;
  let response;
  const res = {
    setHeader(name,value) { responseHeaders.set(name,String(value));return this; },
    status(value) { status = value;return this; },
    json(value) {
      responseHeaders.set('Content-Type','application/json; charset=utf-8');
      response = new Response(JSON.stringify(value),{status,headers:responseHeaders});
      return response;
    },
    end() { response = new Response(null,{status,headers:responseHeaders});return response; },
  };
  try {
    await handler(req,res);
    return response || jsonError(500,'Could not complete the request');
  } catch {
    return jsonError(500,'Could not complete the request');
  }
}

export default {
  async fetch(request,env) {
    const path = new URL(request.url).pathname.replace(/\/$/,'');
    if (path === '/api/service') return handleApi(request,service);
    if (path === '/api/whatsapp-invoice') return handleApi(request,whatsappInvoice);
    if (path === '/api/health') {
      const configured = ['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','SUPABASE_SERVICE_ROLE_KEY','PUBLIC_RATE_LIMIT_SECRET']
        .every(name=>Boolean(env[name]));
      return Response.json({ok:configured,platform:'cloudflare'}, {
        status:configured ? 200 : 503,headers:{...securityHeaders,'Cache-Control':'no-store'},
      });
    }
    if (path === '/api' || path.startsWith('/api/')) return jsonError(404,'Not found');
    return env.ASSETS.fetch(request);
  },
};
