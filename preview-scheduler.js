/* One render in flight; show completed frames while moving toward the latest state. */
export function createPreviewScheduler({frame, sync, ready, epoch, render, paint, error}) {
  let dirty=false,scheduled=false,running=false;
  function schedule(){if(!scheduled){scheduled=true;frame(flush);}}
  async function flush(){
    scheduled=false;
    sync();
    if(running||!dirty||!ready())return;
    dirty=false;running=true;
    const stamp=epoch();
    try{
      const result=await render();
      // Parameter changes queue the next frame; image/encoding/alignment changes
      // invalidate this result so an old input can never overwrite a new image.
      if(ready()&&stamp===epoch())paint(result);
    }catch(e){if(stamp===epoch())error(e);}
    finally{running=false;if(dirty&&ready())schedule();}
  }
  return {request(){dirty=true;schedule();}};
}
