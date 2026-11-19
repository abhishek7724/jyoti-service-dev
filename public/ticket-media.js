export async function compressPhoto(file) {
  const image = new Image();
  const url = URL.createObjectURL(file);
  try {
    const loaded = new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('This image could not be opened. Choose a JPEG, PNG or WebP photo.'));});
    image.src = url;
    await loaded;
    const scale = Math.min(1,1600/Math.max(image.naturalWidth,image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1,Math.round(image.naturalWidth*scale));
    canvas.height = Math.max(1,Math.round(image.naturalHeight*scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';context.fillRect(0,0,canvas.width,canvas.height);
    context.drawImage(image,0,0,canvas.width,canvas.height);
    return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob ? resolve(blob) : reject(new Error('Could not prepare the photo')),'image/jpeg',0.82));
  } finally { URL.revokeObjectURL(url); }
}

export async function uploadTicketMedia(request,ticketId,stage,blob,fileName) {
  const mediaId = crypto.randomUUID();
  const upload = await request('mediaUpload',{id:ticketId,media_id:mediaId,stage,mime_type:blob.type,file_name:fileName.slice(0,150),file_size:blob.size});
  if (!upload.ready) {
    const response = await fetch(upload.signedUrl,{method:'PUT',headers:{'Content-Type':blob.type,'x-upsert':'false'},body:blob});
    if (!response.ok && response.status !== 409) throw new Error('Photo upload failed. Check your connection and try again.');
  }
  await request('mediaReady',{id:ticketId,media_id:mediaId});
  return mediaId;
}

export function mountPhotoControls(container,{ticketId,stage,request,onUploaded,onError}) {
  container.innerHTML = '<div class="actions"><button type="button" class="secondary" data-camera>Take photo</button><button type="button" class="secondary" data-gallery>Choose photos</button></div><p class="meta" role="status"></p>';
  const status = container.querySelector('[role="status"]');
  for (const [selector,camera] of [['[data-camera]',true],['[data-gallery]',false]]) {
    const input = document.createElement('input');
    input.type='file';input.accept='image/jpeg,image/png,image/webp';input.hidden=true;
    if(camera) input.setAttribute('capture','environment'); else input.multiple=true;
    container.append(input);
    container.querySelector(selector).onclick=()=>input.click();
    input.onchange=async()=>{
      let uploaded=0;
      const buttons=[...container.querySelectorAll('button'),...container.closest('form')?.querySelectorAll('button:not([type="button"])') || []];
      buttons.forEach(button=>{button.disabled=true;});
      try {
        for(const file of input.files) {
          status.textContent='Uploading photo '+(uploaded+1)+' of '+input.files.length+'…';
          const blob=await compressPhoto(file);
          await uploadTicketMedia(request,ticketId,stage,blob,file.name || stage+'.jpg');
          uploaded++;
        }
      } catch(error) {status.textContent=error.message;onError(error.message);}
      finally {
        buttons.forEach(button=>{button.disabled=false;});input.value='';
        if(uploaded) {try {await onUploaded();}catch(error){status.textContent=error.message;onError(error.message);}}
      }
    };
  }
}

export function signaturePad(canvas,onChange = () => {}) {
  canvas.width=900;canvas.height=280;
  const context=canvas.getContext('2d');
  let drawing=false,drawn=false;
  const point=event=>{
    const rect=canvas.getBoundingClientRect();
    return [(event.clientX-rect.left)*canvas.width/rect.width,(event.clientY-rect.top)*canvas.height/rect.height];
  };
  const clear=()=>{context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);drawn=false;};
  clear();context.strokeStyle='#142a4a';context.lineWidth=3;context.lineCap='round';
  canvas.onpointerdown=event=>{
    event.preventDefault();onChange();canvas.setPointerCapture?.(event.pointerId);drawing=true;
    context.beginPath();context.moveTo(...point(event));
  };
  canvas.onpointermove=event=>{
    if(!drawing)return;event.preventDefault();context.lineTo(...point(event));context.stroke();drawn=true;
  };
  canvas.onpointerup=canvas.onpointercancel=()=>{drawing=false;};
  return {clear,blob:()=>drawn ? new Promise(resolve=>canvas.toBlob(resolve,'image/png')) : Promise.resolve(null)};
}
