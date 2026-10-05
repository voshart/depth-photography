'use strict';
import { createAcceleratedProcessor } from './processor-wasm.js?v=20261005-wasm3';

const processor=await createAcceleratedProcessor();
self.onmessage=event=>{
  const {id,type,payload}=event.data;
  try{
    const result=processor.process(type,payload);
    const transfer=[];
    if(result.buffer)transfer.push(result.buffer);
    if(result.values)transfer.push(result.values);
    self.postMessage({id,result},transfer);
  }catch(error){
    self.postMessage({id,error:error?.message||String(error)});
  }
};
