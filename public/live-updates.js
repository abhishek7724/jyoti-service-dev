// Database events give immediate updates; foreground polling recovers from reconnects and missed events.
export function createLiveUpdates({request,reload,isBlocked,isActive,getToken,loadClient=()=>import('./vendor/realtime-2.119.0.js'),now=()=>Date.now(),timers=globalThis}){
 let running=false,starting=false,client=null,channel=null,timer=null,connected=false,pending=false,busy=false,lastCheck=0,notBefore=0,generation=0;
 async function tick(){
  if(!running || busy || !isActive() || isBlocked())return;
  const time=now();
  if(time < notBefore || (!pending && time-lastCheck < (connected ? 30000 : 5000)))return;
  busy=true;pending=false;lastCheck=time;
  try{const refreshed=await reload();if(refreshed === false)pending=true;}
  catch{pending=true;notBefore=now()+5000;}
  finally{busy=false;}
 }
 async function start(){
  if(running || starting)return;
  running=true;starting=true;lastCheck=now();const current=++generation;
  timer=timers.setInterval(tick,1000);
  try{
   const [config,module]=await Promise.all([request('liveConfig'),loadClient()]);
   if(!running || current!==generation)return;
   if(!config.url || !config.key)throw new Error('Realtime is not configured');
   const socket=new module.RealtimeClient(config.url.replace(/\/$/,'')+'/realtime/v1',{params:{apikey:config.key},accessToken:async()=>getToken()});
   client=socket;
   await socket.setAuth(getToken());
   if(!running || current!==generation){socket.disconnect();return;}
   channel=socket.channel('jyoti-ticket-updates').on('postgres_changes',{event:'*',schema:'public',table:'service_tickets'},()=>{pending=true;notBefore=now()+250;}).subscribe(status=>{
    if(!running || current!==generation)return;
    connected=status==='SUBSCRIBED';
    if(connected){pending=true;notBefore=now()+250;}
   });
  }catch{if(current===generation)connected=false;}
  finally{if(current===generation)starting=false;}
 }
 function stop(){
  running=false;starting=false;connected=false;pending=false;generation++;
  if(timer!==null)timers.clearInterval(timer);timer=null;
  client?.disconnect();client=null;channel=null;
 }
 function refresh(){pending=true;notBefore=0;return tick();}
 function setToken(token){if(token)client?.setAuth(token).catch(()=>{});else stop();}
 return{start,stop,refresh,setToken,tick};
}
