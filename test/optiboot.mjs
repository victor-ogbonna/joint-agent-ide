/**
 * The optiboot (STK500v1) model from avrFlash.sim.mjs, reused so the WebUSB
 * suite can drive an Uno-class board as well as a Mega.
 */
const STK_OK=0x10, STK_INSYNC=0x14, CRC_EOP=0x20;
const GET_SYNC=0x30, ENTER_PROG=0x50, LEAVE_PROG=0x51, LOAD_ADDR=0x55, PROG_PAGE=0x64;
const FLASH=32*1024;

class Optiboot {
  constructor(chunkBytes=64){ this.flash=new Uint8Array(FLASH).fill(0xff); this.addr=0;
    this.rx=[]; this.out=[]; this.log=[]; this.chunkBytes=chunkBytes; this.running=false; }
  reset(){ this.running=true; this.rx.length=0; }
  feed(b){ if(!this.running) return; for(const x of b) this.rx.push(x); this.parse(); }
  parse(){
    for(;;){
      if(!this.rx.length) return;
      const c=this.rx[0];
      let need, handler;
      if(c===GET_SYNC||c===ENTER_PROG||c===LEAVE_PROG){ need=2; }
      else if(c===LOAD_ADDR){ need=4; }
      else if(c===PROG_PAGE){
        if(this.rx.length<4) return;
        const len=(this.rx[1]<<8)|this.rx[2];
        need=4+len+1;
      } else { this.rx.shift(); continue; }
      if(this.rx.length<need) return;
      const msg=this.rx.splice(0,need);
      if(msg[need-1]!==CRC_EOP){ this.log.push("BAD CRC_EOP"); this.badEop=true; continue; }
      this.handle(c,msg);
    }
  }
  ok(body=[]){ this.out.push(STK_INSYNC,...body,STK_OK); }
  handle(c,msg){
    if(c===GET_SYNC){ this.log.push("SYNC"); this.ok(); }
    else if(c===ENTER_PROG){ this.log.push("ENTER"); this.ok(); }
    else if(c===LEAVE_PROG){ this.log.push("LEAVE"); this.ok(); }
    else if(c===LOAD_ADDR){ this.addr=((msg[2]<<8)|msg[1])<<1; this.log.push(`ADDR 0x${this.addr.toString(16)}`); this.ok(); }
    else if(c===PROG_PAGE){
      const len=(msg[1]<<8)|msg[2];
      if(msg[3]!==0x46){ this.log.push("not flash"); }
      for(let i=0;i<len;i++) this.flash[this.addr+i]=msg[4+i];
      this.log.push(`PAGE ${len}B @0x${this.addr.toString(16)}`);
      this.ok();
    }
  }
  drain(){ return this.out.length? new Uint8Array(this.out.splice(0,this.chunkBytes)) : null; }
}

export default class OptibootSim extends Optiboot {
  constructor(chunkBytes = 64) { super(chunkBytes); }
}
