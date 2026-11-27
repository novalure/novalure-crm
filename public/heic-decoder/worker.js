importScripts('/heic-decoder/primary.js');
self.onmessage = async ({data}) => {
  try {
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > 10 * 1024 * 1024) {
      postMessage({ok: false, code: 'INVALID_INPUT'}); return;
    }
    if (typeof OffscreenCanvas !== 'function' || typeof ImageData !== 'function') {
      postMessage({ok: false, code: 'BROWSER_UNSUPPORTED'}); return;
    }
    let decoder;
    try {
      decoder = await createPrimaryDecoder({locateFile: p => '/heic-decoder/' + p, print:()=>{}, printErr:()=>{}});
    } catch {
      postMessage({ok: false, code: 'BROWSER_UNSUPPORTED'}); return;
    }
    self.postMessage({ type: 'READY' });
    decoder.FS.writeFile('/input.heic', new Uint8Array(data));
    let code; try { code = decoder.callMain(['/input.heic', '/output.rgba']); } catch(e) { code = e.status ?? -1; }
    if (code !== 0) { postMessage({ok: false, code: 'CONVERSION_FAILED'}); return; }
    const raw=decoder.FS.readFile('/output.rgba');
    if (raw.byteLength < 8) throw Error('bad output');
    const d = new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
    const width=d.getUint32(0,true), height=d.getUint32(4,true);
    if (!width || !height || width>16384 || height>16384 || width*height>40000000 || raw.byteLength!==8+width*height*4) throw Error('bad output');
    const canvas=new OffscreenCanvas(width,height), ctx=canvas.getContext('2d');
    if(!ctx) throw Error('no context');
    const rgba=new Uint8ClampedArray(raw.buffer,raw.byteOffset+8,raw.byteLength-8);
    // Composite alpha over white in the existing RGBA buffer before JPEG encoding.
    for (let i=0;i<rgba.length;i+=4) {
      const a=rgba[i+3]; if (a===255) continue;
      rgba[i] = Math.round((rgba[i]*a + 255*(255-a))/255);
      rgba[i+1] = Math.round((rgba[i+1]*a + 255*(255-a))/255);
      rgba[i+2] = Math.round((rgba[i+2]*a + 255*(255-a))/255);
      rgba[i+3] = 255;
    }
    ctx.putImageData(new ImageData(rgba,width,height),0,0);
    const jpeg=await canvas.convertToBlob({type:'image/jpeg',quality:0.9});
    if(jpeg.type!=='image/jpeg'||jpeg.size===0||jpeg.size>10*1024*1024) throw Error('bad JPEG');
    postMessage({ok:true,blob:jpeg,width,height});
  } catch { postMessage({ok:false,code:'CONVERSION_FAILED'}); }
};
