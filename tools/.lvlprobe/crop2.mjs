import { chromium } from 'playwright';
const a = Object.fromEntries(process.argv.slice(2).reduce((acc,c,i,arr)=>{if(c.startsWith('--'))acc.push([c.slice(2),arr[i+1]]);return acc;},[]));
const PORT = a.port ?? 5312;
const browser = await chromium.launch({ args: ['--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--use-gl=angle','--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errs=[]; page.on('pageerror',e=>errs.push(e.message)); page.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__READY__ === true, { timeout: 40000 }).catch(()=>errs.push('never ready'));
await new Promise(r=>setTimeout(r,2000));
if (a.pose) { await page.evaluate(p=>window.__POSE__?.(p), a.pose); await new Promise(r=>setTimeout(r,600)); }
if (a.js) { const r = await page.evaluate(a.js); console.log('JS', JSON.stringify(r)); }
await new Promise(r=>setTimeout(r,1600));
await page.evaluate(()=>{for(const id of ['enter','boot']){const el=document.getElementById(id); if(el)el.style.display='none';}});
await new Promise(r=>setTimeout(r,250));
const clip = a.clip ? (()=>{const [x,y,w,h]=a.clip.split(',').map(Number);return {x,y,width:w,height:h};})() : undefined;
await page.screenshot({ path: a.out, type:'png', clip });
if (errs.length) console.log('ERRORS:', errs.slice(0,8));
console.log('OK', a.out);
await browser.close();
