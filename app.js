import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs';
import { PDFDocument, StandardFonts, rgb } from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs';
const $ = (id) => document.getElementById(id);
const MM = 72/25.4;
let articles = [];
let sourcePdf = null;
const status = (message, error=false) => { $('status').textContent = message; $('status').className = error ? 'error' : 'small'; };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function readOrder(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  sourcePdf = await pdfjsLib.getDocument({data}).promise;
  const found=[];
  for(let p=1;p<=sourcePdf.numPages;p++) {
    const page=await sourcePdf.getPage(p);
    const viewport=page.getViewport({scale:1});
    const content=await page.getTextContent();
    const words=[];
    for(const item of content.items){
      if(!item.str?.trim())continue;
      // PDF.js text transform y is bottom-up. Split item words while preserving rough x positions.
      const y=viewport.height-item.transform[5];
      const x=item.transform[4];
      const segments=item.str.trim().split(/\s+/);
      const unit=(item.width||segments.join(' ').length*5)/(item.str.length||1);
      let cursor=0;
      for(const word of segments){
        const at=item.str.indexOf(word,cursor); cursor=Math.max(0,at)+word.length;
        words.push({str:word,x:x+Math.max(0,at)*unit,y});
      }
    }
    const codes=words.filter(w=>/^MU[A-Z0-9]{7,}$/.test(w.str)&&w.x<110&&w.y>200).sort((a,b)=>a.y-b.y);
    for(let i=0;i<codes.length;i++){
      const code=codes[i];
      const nextY=codes[i+1]?.y??viewport.height;
      const block=words.filter(w=>w.y>=code.y-3&&w.y<Math.min(nextY,code.y+74)&&w.x>300);
      const near=(key)=>{const a=block.find(w=>w.str.startsWith(key));return a?block.filter(w=>Math.abs(w.y-a.y)<4).sort((a,b)=>a.x-b.x).map(w=>w.str):[]};
      const qline=near('Quantità');const cline=near('Commessa');
      const qtext=qline.find(t=>/^\d+[,.]\d+$/.test(t));
      const comm=cline.filter(t=>/^\d+$/.test(t)).at(-1);
      if(!qtext||!comm)continue;
      const qty=Number(qtext.replace(',','.'));
      if(!Number.isInteger(qty)||qty<1)throw new Error(`Quantità non valida per ${code.str}`);
      found.push({code:code.str,qty,comm,pageNum:p,top:code.y, nextY});
    }
  }
  if(!found.length)throw new Error('Nessun articolo riconosciuto. Controlla il modello dell’ordine PDF.');
  return found;
}
async function generatePdf(){
  $('generate').disabled=true;status('Generazione delle etichette…');
  try {
    const output=await PDFDocument.create();
    const font=await output.embedFont(StandardFonts.HelveticaBold);
    const W=62*MM,H=25*MM;
    const cache=new Map();
    for(const row of articles){
      let pageCanvas=cache.get(row.pageNum);
      if(!pageCanvas){
        const sourcePage=await sourcePdf.getPage(row.pageNum);
        const viewport=sourcePage.getViewport({scale:4});
        const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
        await sourcePage.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport}).promise;
        pageCanvas=canvas;cache.set(row.pageNum,canvas);
      }
      // Same source clip as validated Windows implementation: x=38..265, y=code top+26..+51.
      const top=row.top-9; // PDF.js gives baseline, PyMuPDF words use upper edge (~9 pt earlier).
      const y1=top+26, y2=Math.min(top+51,row.nextY-4);
      if(y2-y1<12)throw new Error(`Codice a barre non individuato: ${row.code}`);
      const cut=document.createElement('canvas');cut.width=Math.round(227*4);cut.height=Math.round((y2-y1)*4);
      const ctx=cut.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,cut.width,cut.height);
      ctx.drawImage(pageCanvas,38*4,y1*4,227*4,(y2-y1)*4,0,0,cut.width,cut.height);
      const img=await output.embedPng(await (await fetch(cut.toDataURL('image/png'))).arrayBuffer());
      const page=output.addPage([W,H]);
      page.drawRectangle({x:.7*MM,y:.7*MM,width:60.6*MM,height:23.6*MM,borderColor:rgb(.1,.1,.1),borderWidth:.45});
      page.drawText(`${row.code} x ${row.qty} PZ`,{x:2.5*MM,y:H-5.5*MM,font,size:10,color:rgb(0,0,0)});
      page.drawText(`Com ${row.comm}`,{x:2.5*MM,y:H-10*MM,font,size:9,color:rgb(0,0,0)});
      page.drawImage(img,{x:2.5*MM,y:2*MM,width:55*MM,height:11.5*MM});
    }
    const bytes=await output.save();const blob=new Blob([bytes],{type:'application/pdf'});
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='Etichette_62x25.pdf';document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
    status(`Completato — ${articles.length} etichette generate.`);
  } catch(e){console.error(e);status(`Errore: ${e.message}`,true);} finally {$('generate').disabled=false;}
}
$('pdfFile').addEventListener('change',async(e)=>{
  articles=[];$('results').classList.add('hidden');$('generate').disabled=true;
  const file=e.target.files[0];if(!file)return;
  status('Analisi dell’ordine in corso…');
  try{
    articles=await readOrder(file);
    $('articles').innerHTML=articles.map(row=>`<div class="row"><div><strong>${escapeHtml(row.code)}</strong><div class="small">Quantità: ${row.qty} PZ · Commessa: ${escapeHtml(row.comm)}</div></div><span class="ok">✓</span></div>`).join('');
    $('results').classList.remove('hidden');$('generate').disabled=false;status(`${articles.length} articoli trovati in ${sourcePdf.numPages} pagine.`);
  }catch(e){console.error(e);status(`Errore: ${e.message}`,true);}
});
$('generate').addEventListener('click',generatePdf);
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
