const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
pres.author='Victor Ogbonna'; pres.company='Ogbontor Engineering Enterprise';
pres.title='Joint-Agent IDE — Seed Deck';

const BG='0B0D12', RAISED='14171F', LINE='1F242E',
      TEXT='EDEAE6', MUTED='8B93A3', FAINT='5A6272', BRAND='F97316', TINT='1C1710';
const SANS='Calibri', MONO='Courier New';
const M=0.6, W=13.333, CW=W-M*2;
const P='/home/victorogbonna313/joint-agent-project/';
const IMG={ logo:P+'public/logo.png', off:P+'deck-assets/build/board-off.jpg',
            on:P+'deck-assets/build/board-on.jpg', me:P+'deck-assets/build/founder.jpg',
            ide:P+'deck-assets/build/ide-screenshot.jpg' };

function slide(d){ const s=pres.addSlide(); s.background={color:BG};
  if(d) s.addText(d,{x:M,y:0.34,w:6,h:0.3,fontSize:10,bold:true,color:BRAND,fontFace:MONO,
    charSpacing:2,isTextBox:true,margin:0}); return s; }
// Title boxes are 1.35" — the geometry pass showed 1.0" was short for wrapped headings.
const title=(s,t,y=0.95,w=CW,size=34)=>s.addText(t,{x:M,y,w,h:1.35,fontSize:size,bold:true,
  color:TEXT,fontFace:SANS,isTextBox:true,margin:0,valign:'top'});
function card(s,{x,y,w,h,fill=RAISED,border=LINE,dash=null}){
  const line={color:border,width:1}; if(dash) line.dashType=dash;
  s.addShape(pres.ShapeType.rect,{x,y,w,h,fill:{color:fill},line}); }
function body(s,t,{x,y,w,h=0.9,size=12,color=MUTED,bold=false,font=SANS,align='left',lh=null}){
  const o={x,y,w,h,fontSize:size,color,bold,fontFace:font,align,isTextBox:true,margin:0,valign:'top'};
  if(lh) o.lineSpacingMultiple=lh; s.addText(t,o); }

/* 1 TITLE */{
  const s=slide('01 / TITLE');
  s.addImage({path:IMG.logo,x:M,y:1.0,w:1.05,h:1.05});
  s.addText('Joint-Agent\nIDE',{x:M,y:2.3,w:6.4,h:2.0,fontSize:52,bold:true,color:TEXT,
    fontFace:SANS,isTextBox:true,margin:0,lineSpacingMultiple:0.92});
  body(s,'The idea should be the hardest part.',{x:M,y:4.4,w:6.4,h:0.4,size:17,color:TEXT,bold:true});
  body(s,'The autonomous AI agent that writes, compiles and flashes embedded firmware — from a browser tab.',
    {x:M,y:4.9,w:6.2,h:0.85,size:13,lh:1.3});
  body(s,'SEED  ·  $300,000  ·  LIVE IN PRODUCTION',{x:M,y:6.35,w:6.4,h:0.3,size:10,color:FAINT,font:MONO});
  s.addImage({path:IMG.off,x:7.4,y:1.6,w:5.33,h:3.55});
}
/* 2 PROBLEM */{
  const s=slide('02 / PROBLEM');
  title(s,'Nobody quits because the idea was too hard.',0.95,9.2);
  body(s,'Amara has a working idea for an irrigation controller. She loses the weekend to toolchains, drivers and a compiler error written for someone who already knows what it means.',
    {x:M,y:2.4,w:8.4,h:0.9,size:13,lh:1.35});
  const bars=[['Install toolchain',2.402,0],['Match versions',2.402,0],['Find the port',1.681,0],
              ['Decode errors',2.402,0],['Build the actual thing',3.123,1]];
  let x=M;
  bars.forEach(([t,w,hot])=>{
    card(s,{x,y:3.5,w,h:0.62,fill:hot?BG:RAISED,border:hot?BRAND:LINE,dash:hot?'dash':null});
    s.addText(t,{x:x+0.12,y:3.5,w:w-0.24,h:0.62,fontSize:10,color:hot?BRAND:MUTED,fontFace:MONO,
      isTextBox:true,margin:0,valign:'middle'});
    x+=w+0.03;
  });
  body(s,'HER WEEKEND',{x:M,y:4.25,w:4,h:0.25,size:9,color:FAINT,font:MONO});
  body(s,'And Amara is the lucky case — she owns a laptop. Plenty of students and first-time builders don’t. They own a phone. Today that rules them out of hardware entirely, before ability is ever tested.',
    {x:M,y:4.8,w:8.6,h:0.9,size:12,lh:1.35});
  body(s,'That gap is where talent leaks out.',{x:M,y:6.3,w:8,h:0.45,size:16,color:TEXT,bold:true});
  s.addNotes('"Everyone who\'s touched embedded knows this weekend. Two days lost to toolchains and drivers before a line of real code — and for a lot of talented people that\'s where the project dies. But notice Amara is the lucky one: she has a laptop. A huge share of the people who\'d be best at this own a phone and nothing else, so they never start. The barrier isn\'t ability. It\'s setup — and hardware." (~30s)');
}
/* 3 SOLUTION */{
  const s=slide('03 / SOLUTION');
  title(s,'Describe it. It compiles. It flashes.',1.0,6.4,32);
  body(s,'Plain English in. Working firmware running on your physical board — in a browser tab, with nothing installed.',
    {x:M,y:2.8,w:5.9,h:1.0,size:13,lh:1.35});
  body(s,'BEFORE',{x:7.2,y:1.1,w:5,h:0.25,size:9,color:FAINT,font:MONO});
  let cx=7.2, cy=1.45;
  ['IDE','drivers','SDK','board manager','build system','serial config'].forEach(c=>{
    const w=0.35+c.length*0.093;
    if(cx+w>12.85){cx=7.2;cy+=0.46;}
    card(s,{x:cx,y:cy,w,h:0.38,fill:BG,border:LINE});
    s.addText(c,{x:cx,y:cy,w,h:0.38,fontSize:9,color:FAINT,fontFace:MONO,align:'center',
      isTextBox:true,margin:0,valign:'middle'});
    cx+=w+0.06;
  });
  body(s,'WITH JOINT-AGENT IDE',{x:7.2,y:3.3,w:5,h:0.25,size:9,color:BRAND,font:MONO});
  card(s,{x:7.2,y:3.7,w:5.53,h:0.75,fill:TINT,border:BRAND});
  s.addText('"Blink the built-in LED twice a second"',{x:7.4,y:3.7,w:5.1,h:0.75,fontSize:11,
    color:TEXT,fontFace:MONO,isTextBox:true,margin:0,valign:'middle'});
  body(s,'▸  running on the board',{x:7.25,y:4.65,w:5,h:0.35,size:13,color:BRAND,bold:true});
  s.addNotes('"One sentence in. A minute later, working firmware on physical hardware, nothing installed. The objection: \'isn\'t this ChatGPT for Arduino?\' No — those hand you code and wish you luck. We run the whole loop, and the compiler proves it worked." (~22s)');
}
/* 4 HOW IT WORKS */{
  const s=slide('04 / HOW IT WORKS');
  title(s,'A real toolchain, not a chat box.');
  const steps=[['01 · DESCRIBE','Plain English','It asks which board and what behaviour.'],
               ['02 · GENERATE','Board-specific C++','Correct libraries pulled in automatically.'],
               ['03 · COMPILE','Joint-Agent Engine','A genuine PlatformIO toolchain in the cloud.'],
               ['04 · FLASH','Straight to metal','Over Web Serial, with a live serial monitor.']];
  const cw=(CW-0.3*3)/4;
  steps.forEach(([k,h,p],i)=>{
    const x=M+i*(cw+0.3);
    card(s,{x,y:2.45,w:cw,h:1.85});
    s.addShape(pres.ShapeType.rect,{x,y:2.45,w:cw,h:0.035,fill:{color:BRAND},line:{color:BRAND,width:0}});
    body(s,k,{x:x+0.22,y:2.7,w:cw-0.44,h:0.25,size:9,color:BRAND,font:MONO});
    body(s,h,{x:x+0.22,y:3.03,w:cw-0.44,h:0.3,size:13,color:TEXT,bold:true});
    body(s,p,{x:x+0.22,y:3.42,w:cw-0.44,h:0.75,size:10.5,lh:1.25});
  });
  s.addShape(pres.ShapeType.rect,{x:M,y:4.85,w:0.03,h:1.0,fill:{color:BRAND},line:{color:BRAND,width:0}});
  body(s,'The compiler is the evaluator.\nThe model cannot bluff.',
    {x:M+0.15,y:4.85,w:5.4,h:1.0,size:20,color:TEXT,bold:true,lh:1.15});
  body(s,'Self-healing loop',{x:7.0,y:4.9,w:5.7,h:0.3,size:13,color:TEXT,bold:true});
  body(s,'Build fails → the agent reads its own compiler error and fixes it. Correctness is verifiable, not an opinion.',
    {x:7.0,y:5.25,w:5.7,h:0.8,size:11.5,lh:1.3});
  s.addNotes('"Four steps, one tab. Step three is what matters: a real PlatformIO toolchain in the cloud across 466 boards. That\'s the hard infrastructure — and it means the agent grades itself. When the build breaks it reads its own error and fixes it. Objection: \'can an LLM really debug firmware reliably?\' It doesn\'t have to be perfect. It has to iterate against a compiler that tells the truth." (~28s)');
}
/* 5 TRACTION */{
  const s=slide('05 / TRACTION');
  title(s,'Shipped, not slideware.');
  s.addImage({path:IMG.ide,x:M,y:2.35,w:6.6,h:3.62});
  const stats=[['Live','In production, not a prototype'],['466','Supported boards'],
               ['50','Discovery interviews'],['50','On the waitlist'],
               ['Live','Payments — real, not mocked'],['Solo','Built end to end']];
  const sw=(5.53-0.12)/2, sh=(3.62-0.24)/3;
  stats.forEach(([n,k],i)=>{
    const x=7.4+(i%2)*(sw+0.12), y=2.35+Math.floor(i/2)*(sh+0.12);
    card(s,{x,y,w:sw,h:sh,fill:BG,border:LINE});
    body(s,n,{x:x+0.2,y:y+0.2,w:sw-0.4,h:0.42,size:20,color:BRAND,bold:true,font:MONO});
    body(s,k,{x:x+0.2,y:y+0.66,w:sw-0.4,h:0.45,size:10,lh:1.2});
  });
  body(s,'The next dollar goes into scale — not into finding out whether this can be built.',
    {x:M,y:6.25,w:11,h:0.45,size:15,color:TEXT,bold:true});
  s.addNotes('"This isn\'t a mockup. Auth, payments, the compiler, hardware flashing — all working, all built solo. That\'s the live serial monitor on the right of the screenshot: real hardware, reporting back. Fifty people I interviewed to shape it; a separate fifty already on the waitlist. Objection: \'fifty is small.\' It is, deliberately. I\'m raising to convert a waitlist and scale infrastructure, not to discover whether the thing works. That\'s answered." (~28s)');
}
/* 6 MARKET */{
  const s=slide('06 / MARKET');
  title(s,'47.2M developers. The hardware ones have the worst tools.',0.95,7.0,29);
  card(s,{x:M,y:2.75,w:7.0,h:1.72,fill:TINT,border:BRAND});
  body(s,'The phone is the unlock          [ V2 · ROADMAP ]',{x:M+0.22,y:2.95,w:6.6,h:0.3,size:13,color:BRAND,bold:true});
  body(s,'Every embedded tool ever built assumes a laptop. Students, hobbyists and first-time builders are far likelier to own a phone than a dev-capable laptop. Flashing over OTG from Android reaches a population no desktop tool can address — that’s not a feature, it’s a second market.',
    {x:M+0.22,y:3.32,w:6.6,h:1.05,size:11,lh:1.3});
  body(s,'Universal problem',{x:M,y:4.7,w:7,h:0.28,size:12.5,color:TEXT,bold:true});
  body(s,'Setup friction blocks a maker in Berlin exactly as it blocks one in Enugu.',{x:M,y:5.02,w:7,h:0.3,size:11});
  body(s,'Free distribution',{x:M,y:5.5,w:7,h:0.28,size:12.5,color:TEXT,bold:true});
  body(s,'Founder runs the largest student hardware community in South-East Nigeria. A beachhead, not a boundary.',
    {x:M,y:5.82,w:7,h:0.55,size:11,lh:1.25});
  [['','47.2M','developers worldwide — SlashData, 2025'],
   ['×','~6M','in embedded / IoT (internal estimate)'],
   ['×','$84','per Pro subscriber, per year']].forEach(([op,v,l],i)=>{
    const y=2.75+i*0.63;
    card(s,{x:8.0,y,w:4.73,h:0.55});
    body(s,op,{x:8.15,y:y+0.14,w:0.3,h:0.3,size:13,color:BRAND,font:MONO});
    body(s,v,{x:8.5,y:y+0.13,w:1.3,h:0.3,size:13,color:TEXT,bold:true,font:MONO});
    body(s,l,{x:9.75,y:y+0.15,w:2.85,h:0.35,size:9,align:'right',lh:1.1});
  });
  card(s,{x:8.0,y:4.64,w:4.73,h:0.62,fill:TINT,border:BRAND});
  body(s,'=',{x:8.15,y:4.8,w:0.3,h:0.3,size:14,color:BRAND,font:MONO});
  body(s,'~$500M',{x:8.5,y:4.76,w:2,h:0.4,size:18,color:BRAND,bold:true,font:MONO});
  body(s,'TAM',{x:10.5,y:4.84,w:2.1,h:0.3,size:11,align:'right'});
  body(s,'This counts people already counted as developers. It excludes everyone shut out for owning a phone and not a laptop — the segment mobile flashing opens.',
    {x:8.0,y:5.5,w:4.73,h:0.9,size:10,lh:1.3});
  s.addNotes('"The 47.2 million is sourced. The 6 million embedded slice is my estimate and I label it as one. Times eighty-four a year, roughly a five-hundred-million TAM. But that figure only counts people already classified as developers — every one of whom owns a laptop. Mobile flashing is the interesting number, because a phone is the one computer almost every student already has. Objection: \'not venture-scale.\' At seven dollars alone, no. Team seats, institutions, and a device class nobody else can serve change that." (~28s)');
}
/* 7 BUSINESS MODEL */{
  const s=slide('07 / BUSINESS MODEL');
  title(s,'90% gross margin, live today.');
  card(s,{x:M,y:2.45,w:6.0,h:1.9});
  body(s,'FREE',{x:M+0.3,y:2.7,w:5.4,h:0.25,size:10,color:MUTED,font:MONO});
  body(s,'$0',{x:M+0.3,y:3.0,w:5.4,h:0.55,size:30,color:TEXT,bold:true});
  body(s,'50,000 tokens — roughly 15 complete projects. Enough to feel the value.',{x:M+0.3,y:3.65,w:5.4,h:0.55,size:11,lh:1.25});
  card(s,{x:6.93,y:2.45,w:6.0,h:1.9,border:BRAND});
  body(s,'PRO',{x:7.23,y:2.7,w:5.4,h:0.25,size:10,color:BRAND,font:MONO});
  body(s,'$7 /mo',{x:7.23,y:3.0,w:5.4,h:0.55,size:30,color:TEXT,bold:true});
  body(s,'400,000 tokens — 100+ projects.',{x:7.23,y:3.65,w:5.4,h:0.4,size:11});
  // Margin bar: revenue block + cost block, sized to stay inside the right margin.
  const barW=CW, revW=barW*0.82;
  s.addShape(pres.ShapeType.rect,{x:M,y:4.7,w:revW,h:0.6,fill:{color:BRAND},line:{color:BRAND,width:0}});
  s.addText('REVENUE  $7.00',{x:M+0.25,y:4.7,w:5,h:0.6,fontSize:11,bold:true,color:BG,fontFace:MONO,
    isTextBox:true,margin:0,valign:'middle'});
  card(s,{x:M+revW,y:4.7,w:barW-revW,h:0.6});
  s.addText('COST $0.25–0.56',{x:M+revW+0.12,y:4.7,w:barW-revW-0.24,h:0.6,fontSize:8.5,color:MUTED,
    fontFace:MONO,isTextBox:true,margin:0,valign:'middle'});
  body(s,'$7 is the wedge, not the ceiling',{x:M,y:5.7,w:9,h:0.3,size:13,color:TEXT,bold:true});
  body(s,'Team seats, institutional and education licensing, and mobile all raise revenue per account on the same product.',
    {x:M,y:6.05,w:9.5,h:0.5,size:11.5,lh:1.25});
  s.addNotes('"Freemium. Free tier is about fifteen projects — enough to prove it. Pro is seven dollars, inference costs well under a dollar per active subscriber, so margin sits around ninety percent and improves with scale. The objection is always price — and the answer is the price per seat isn\'t fixed. Institutions, teams and mobile all move revenue per account up on the same product." (~24s)');
}
/* 8 COMPETITION */{
  const s=slide('08 / COMPETITION');
  title(s,'Everyone else stops at the code.');
  const Y='✓', N='✕';
  const rows=[['','Writes code','Compiles for real','Flashes hardware','Zero install']
    .map(h=>({text:h,options:{bold:true,color:MUTED,fontSize:9.5,fontFace:MONO,fill:{color:BG}}}))];
  [['Arduino IDE / PlatformIO',N,Y,Y,N],['Wokwi & simulators',N,N,N,Y],
   ['Copilot / Cursor / ChatGPT',Y,N,N,Y],['Joint-Agent IDE',Y,Y,Y,Y]]
  .forEach((r,ri)=>{ const ours=ri===3;
    rows.push(r.map((c,ci)=>({text:c,options:{bold:ci===0||ours,fontSize:ci===0?11:14,
      color:ci===0?(ours?BRAND:TEXT):(c===Y?BRAND:FAINT),align:ci===0?'left':'center',
      fill:{color:ours?TINT:BG}}})));
  });
  s.addTable(rows,{x:M,y:2.4,w:CW,colW:[4.0,2.03,2.03,2.03,2.04],rowH:0.52,
    border:{type:'solid',color:LINE,pt:1},valign:'middle',margin:6});
  [['Verifiable.','The compiler grades the model.'],
   ['Real infrastructure.','Cloud compilation across 466 boards.'],
   ['Browser to metal.','No install, unlike every incumbent.'],
   ['The full loop.','Others hand you code. We hand you a running board.']]
  .forEach(([b,t],i)=>{
    s.addText([{text:b+'  ',options:{bold:true,color:TEXT}},{text:t,options:{color:MUTED}}],
      {x:M+(i%2)*6.3,y:5.45+Math.floor(i/2)*0.62,w:6.0,h:0.5,fontSize:11.5,fontFace:SANS,
       isTextBox:true,margin:0,valign:'top'});
  });
  s.addNotes('"Only our row is yes across the board. Simulators never touch real hardware. General assistants write code with nothing verifying it. Classic IDEs still need the install we removed. Objection: \'couldn\'t OpenAI or Arduino just add this?\' They\'d have to build the same cloud compiler and the same flashing layer. That\'s the moat, and we\'re already through it." (~28s)');
}
/* 9 ROADMAP */{
  const s=slide('09 / ROADMAP');
  title(s,'From one board to the whole workflow.');
  card(s,{x:M,y:2.35,w:CW,h:2.45,border:BRAND});
  body(s,'NEAR — THE UNLOCK',{x:M+0.3,y:2.57,w:6,h:0.25,size:9.5,color:BRAND,font:MONO});
  body(s,'Bridge Agent. A lightweight local companion connecting any microcontroller to the browser on Linux, Windows, macOS, iOS and Android — removing the Web Serial limit entirely.',
    {x:M+0.3,y:2.9,w:11.5,h:0.6,size:12,color:TEXT,lh:1.25});
  card(s,{x:M+0.3,y:3.62,w:11.5,h:0.98,fill:TINT,border:BRAND});
  body(s,'Build hardware with no computer at all',{x:M+0.5,y:3.78,w:11.1,h:0.28,size:12.5,color:BRAND,bold:true});
  body(s,'An OTG cable turns any Android phone into the entire workbench — write, compile and flash. For a student who has a phone and no laptop, this is the difference between building and not building.',
    {x:M+0.5,y:4.11,w:11.1,h:0.45,size:10.5,lh:1.25});
  card(s,{x:M,y:4.95,w:CW,h:0.72});
  body(s,'MID',{x:M+0.3,y:5.1,w:1.2,h:0.25,size:9.5,color:MUTED,font:MONO});
  body(s,'Agentic circuit simulation and design · AI-powered CAD for embedded · custom component building · auto-generated IoT sketches.',
    {x:M+1.6,y:5.12,w:10.2,h:0.45,size:11,lh:1.2});
  card(s,{x:M,y:5.8,w:CW,h:0.72});
  body(s,'LATER',{x:M+0.3,y:5.95,w:1.2,h:0.25,size:9.5,color:MUTED,font:MONO});
  body(s,'Generated companion apps · OTA firmware updates · collaboration spaces · dashboards · no-code automations · AI/ML and LLM plugins · blockchain accountability plugin.',
    {x:M+1.6,y:5.95,w:10.2,h:0.5,size:11,lh:1.2});
  body(s,'Every rival tool needs a laptop. We need a phone and a cable.',
    {x:M,y:6.7,w:10,h:0.45,size:15,color:TEXT,bold:true});
  s.addNotes('"The Bridge Agent is the single most important thing on this slide. Today flashing needs a desktop browser with Web Serial. A small local helper removes that — and then you flash a board from an Android phone over OTG, using a cable that costs about a dollar. Think about what that means: a student with no laptop can build real hardware. Every competitor requires a computer they don\'t have. We require the phone already in their pocket. Everything after this is expansion — this is what turns a tool into a platform." (~28s)');
}
/* 10 MILESTONES */{
  const s=slide('10 / MILESTONES');
  title(s,'What the next 18 months buy.');
  const tl=[['NOW','Live in production. 466 boards. 50 interviews. 50 on the waitlist. Payments working.',1],
            ['MONTHS 1–6','Bridge Agent on desktop and mobile — including OTG flashing from Android phones. Board coverage expanded. First paying cohort converted.',0],
            ['MONTHS 7–12','Circuit simulation and CAD in beta. Team and education licensing. Distribution beyond the founding community.',0],
            ['MONTHS 13–18','Collaboration, OTA, plugin ecosystem. Series A readiness on recurring revenue and retention.',0]];
  const cw=(CW-0.3*3)/4;
  tl.forEach(([k,t,now],i)=>{
    const x=M+i*(cw+0.3);
    card(s,{x,y:2.55,w:cw,h:2.6,fill:now?TINT:BG,border:now?BRAND:LINE});
    body(s,k,{x:x+0.22,y:2.8,w:cw-0.44,h:0.25,size:9.5,color:BRAND,font:MONO});
    body(s,t,{x:x+0.22,y:3.2,w:cw-0.44,h:1.8,size:11,lh:1.3});
  });
  s.addNotes('"\'Now\' is already done — that\'s the point of anchoring it on the timeline. First six months: the Bridge Agent and converting the waitlist into revenue. By month twelve, licensing launched and distribution past my own community. By eighteen, Series-A-ready on retention numbers, not promises." (~22s)');
}
/* 11 TEAM */{
  const s=slide('11 / TEAM');
  title(s,'Built by someone who lived the problem.');
  s.addImage({path:IMG.me,x:M,y:2.5,w:3.3,h:3.3});   // square source, square box — no crop
  const creds=[['Founder — Joint-Agent IDE','Full-stack embedded engineer. 4+ years embedded, 3+ years software including web and blockchain. Built the product end to end, solo.'],
    ['Founder — Ogbontor Engineering Enterprise','The largest student hardware community in South-East Nigeria. Trains robotics, embedded, IoT, PCB and CAD. Builds products for market and incubates student hardware ideas.'],
    ['Founder — CNG Protect','Edge-AI IoT safety device predicting explosions in retrofitted CNG vehicles and warning drivers.   ✓ BACKED BY SEDC · $5,000']];
  creds.forEach(([h,p],i)=>{
    const y=2.5+i*1.18;
    s.addShape(pres.ShapeType.rect,{x:4.35,y,w:0.03,h:1.02,fill:{color:BRAND},line:{color:BRAND,width:0}});
    body(s,h,{x:4.6,y,w:8.15,h:0.28,size:12.5,color:TEXT,bold:true});
    body(s,p,{x:4.6,y:y+0.33,w:8.15,h:0.72,size:10.5,lh:1.25});
  });
  body(s,'He teaches the users, ships hardware products, and has already been funded once for embedded AI.',
    {x:M,y:6.25,w:11,h:0.45,size:14,color:TEXT,bold:true});
  s.addNotes('"I\'m not an outsider guessing at this market. I run the community that trains these builders, I\'ve shipped hardware products, and CNG Protect was already backed for embedded AI. Objection: \'solo founder, big roadmap.\' True — part of what the raise is for. But the riskiest thing, proving the product works, is done, and I did it alone." (~24s)');
}
/* 12 ASK */{
  const s=slide('12 / THE ASK');
  title(s,'$300,000 to make the idea the hardest part.',0.95,6.6,30);
  [['CLOUD INFRASTRUCTURE','Scale compilation and flashing capacity.'],
   ['MARKETING & GROWTH','Convert the waitlist, reach embedded developers globally.'],
   ['V2 DEVELOPMENT','Bridge Agent and phone-based flashing, circuit simulation and CAD, the plugin ecosystem.']]
  .forEach(([k,t],i)=>{
    const y=2.55+i*0.95;
    card(s,{x:M,y,w:6.2,h:0.82});
    body(s,k,{x:M+0.25,y:y+0.13,w:5.7,h:0.25,size:9.5,color:BRAND,font:MONO});
    body(s,t,{x:M+0.25,y:y+0.42,w:5.7,h:0.4,size:10.5,lh:1.2});
  });
  s.addImage({path:IMG.on,x:7.2,y:2.55,w:5.53,h:2.2});
  s.addShape(pres.ShapeType.rect,{x:7.2,y:4.95,w:0.03,h:0.85,fill:{color:BRAND},line:{color:BRAND,width:0}});
  body(s,'Amara describes the irrigation controller and watches it run on the board. Her weekend goes into the idea.',
    {x:7.45,y:4.95,w:5.28,h:0.85,size:12,color:TEXT,lh:1.3});
  body(s,'The idea should be the hardest part.',{x:M,y:5.6,w:6.6,h:0.9,size:28,color:BRAND,bold:true,lh:1.1});
  body(s,'JOINT-AGENT IDE  ·  OGBONTOR ENGINEERING ENTERPRISE',{x:M,y:6.65,w:8,h:0.3,size:9,color:MUTED,font:MONO});
  s.addNotes('"Three hundred thousand: infrastructure, growth, and V2 — mainly the Bridge Agent, which is what puts this on a phone. The product is live, the margin works, the waitlist is waiting. Every hardware project that dies during setup is our market — and every builder who never got one because they don\'t own a laptop. It\'s running right now; happy to open it and build something live in the room." (~24s)');
}
/* APPENDIX */
function appendix(d,h,items,stats){
  const s=pres.addSlide(); s.background={color:'080A0E'};
  s.addText(d,{x:M,y:0.34,w:6,h:0.3,fontSize:10,bold:true,color:MUTED,fontFace:MONO,
    charSpacing:2,isTextBox:true,margin:0});
  card(s,{x:M,y:0.75,w:1.5,h:0.32,fill:'080A0E',border:BRAND});
  s.addText('ONLY IF ASKED',{x:M,y:0.75,w:1.5,h:0.32,fontSize:8,color:BRAND,fontFace:MONO,
    align:'center',isTextBox:true,margin:0,valign:'middle'});
  title(s,h,1.3,CW,30);
  let y=2.6;
  if(stats){
    const sw=(CW-0.24)/3;
    stats.forEach(([n,k],i)=>{
      const x=M+i*(sw+0.12);
      card(s,{x,y:2.45,w:sw,h:1.1,fill:BG,border:LINE});
      body(s,n,{x:x+0.25,y:2.65,w:sw-0.5,h:0.4,size:20,color:BRAND,bold:true,font:MONO});
      body(s,k,{x:x+0.25,y:3.1,w:sw-0.5,h:0.35,size:10.5});
    });
    y=3.95;
  }
  items.forEach(([b,t])=>{
    body(s,b,{x:M,y,w:CW,h:0.28,size:12.5,color:TEXT,bold:true});
    body(s,t,{x:M,y:y+0.32,w:11.4,h:0.6,size:11,lh:1.3});
    y+=1.05;
  });
}
appendix('A1 / APPENDIX','Technical architecture',[
  ['Request','Browser sends plain English; the agent returns board-specific C++ plus a structured schematic.'],
  ['Joint-Agent Engine','Containerised PlatformIO toolchain with espressif32 and atmelavr baked in — 466 boards from the real catalog.'],
  ['Self-healing','On failure, compiler stderr feeds back to the agent, which patches and resubmits.'],
  ['Flash','Binary streams to the browser and onto the board over Web Serial, with a live monitor reading back.']]);
appendix('A2 / APPENDIX','Unit economics',[
  ['Only output is metered','Prompts, system instruction and history aren’t charged to the user’s allowance.'],
  ['Caching drives cost down','Automatic prefix caching discounts the repeated system instruction, so cost trends to the low end as usage grows.'],
  ['Path beyond $7','Per-seat team billing, institutional and education site licences, and a mobile tier once the Bridge Agent ships.']],
  [['50,000','Free cap — ~15 projects'],['400,000','Pro cap — 100+ projects'],['$0.25–0.56','Inference / subscriber / month']]);
appendix('A3 / APPENDIX','Why incumbents can’t just add this.',[
  ['Simulators','Model hardware in software. Closing the loop to a physical board means a flashing layer and a real toolchain — a different product, not a feature toggle.'],
  ['General coding assistants','Have no evaluator. Nothing compiles it, nothing flashes it, nothing tells them when they’re wrong. Adding that is adding Joint-Agent Engine.'],
  ['Classic IDEs','Already compile and flash — locally. Moving that to zero-install in the browser means rebuilding the toolchain as cloud infrastructure across hundreds of boards.']]);

pres.writeFile({fileName:'Joint-Agent-IDE-Seed-Deck.pptx'}).then(f=>console.log('WROTE',f));
