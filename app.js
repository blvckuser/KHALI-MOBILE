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
      // Description may span several lines. Read only the description column,
      // from the product row to the quantity/commessa rows, excluding headings.
      const descriptionWords=words.filter(w=>w.x>=118&&w.x<320&&w.y>=code.y-4&&w.y<Math.min(code.y+31,nextY-5));
      const lines=[];
      for(const word of descriptionWords.sort((a,b)=>a.y-b.y||a.x-b.x)){
        let line=lines.find(line=>Math.abs(line.y-word.y)<4);
        if(!line){line={y:word.y,words:[]};lines.push(line);}
        line.words.push(word);
      }
      const name=lines.sort((a,b)=>a.y-b.y).map(line=>line.words.sort((a,b)=>a.x-b.x).map(w=>w.str).join(' ')).join(' ').replace(/\s+/g,' ').trim();
      if(!name)throw new Error(`Descrizione mancante per ${code.str}`);
      found.push({code:code.str,name,qty,comm,pageNum:p,top:code.y, nextY});
    }
  }
  if(!found.length)throw new Error('Nessun articolo riconosciuto. Controlla il modello dell’ordine PDF.');
  return found;
}
async function generatePdf(){
  for(const row of articles){
    row.name=String(row.name??'').trim();row.code=String(row.code??'').trim();row.comm=String(row.comm??'').trim();
    const qty=Number(row.qty);
    if(!row.name||!row.code||!row.comm||!Number.isInteger(qty)||qty<1){status(`Controlla descrizione, codice, commessa e quantità per ${row.code||'un articolo'}.`,true);return;}
    row.qty=qty;
  }
  $('generate').disabled=true;status('Generazione delle etichette…');
  try {
    const output=await PDFDocument.create();
    const font=await output.embedFont(StandardFonts.HelveticaBold);
    const W=62*MM,H=29*MM;
    // Wrap text by actual embedded-font width, avoiding truncation.
    function wrapName(name,maxWidth,maxLines=2){
      const words=name.split(/\s+/), lines=[];
      let size=7.6;
      for(;size>=5.2;size-=0.2){
        lines.length=0;let current='';
        for(const word of words){
          const candidate=current?current+' '+word:word;
          if(font.widthOfTextAtSize(candidate,size)<=maxWidth){current=candidate;}
          else{if(current)lines.push(current);current=word;}
        }
        if(current)lines.push(current);
        if(lines.length<=maxLines&&lines.every(t=>font.widthOfTextAtSize(t,size)<=maxWidth))return {lines:[...lines],size};
      }
      throw new Error(`Descrizione troppo lunga: ${name}`);
    }
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
      // Compact layout: product name at top, article/quantity and commessa on ONE row.
      const nameLayout=wrapName(row.name,57*MM,2);
      const nameLineStep=2.8*MM;
      nameLayout.lines.forEach((line,i)=>page.drawText(line,{
        x:2.5*MM,y:H-(5.4*MM+i*nameLineStep),font,size:nameLayout.size,color:rgb(0,0,0)
      }));
      const detailTop=5.4+(nameLayout.lines.length-1)*2.8+3.6;
      const leftText=`${row.code} x ${row.qty} PZ`;
      const rightText=`Com ${row.comm}`;
      const leftX=2.5*MM, rightEdge=59.5*MM;
      let leftSize=8.2, rightSize=7.8;
      // Keep a visible gap between the two fields even for longer product codes.
      while(leftSize>6.0 && font.widthOfTextAtSize(leftText,leftSize)+font.widthOfTextAtSize(rightText,rightSize)>55*MM){leftSize-=0.2;}
      if(font.widthOfTextAtSize(leftText,leftSize)+font.widthOfTextAtSize(rightText,rightSize)>55*MM)throw new Error(`Riga articolo troppo lunga: ${row.code}`);
      page.drawText(leftText,{x:leftX,y:H-detailTop*MM,font,size:leftSize,color:rgb(0,0,0)});
      page.drawText(rightText,{x:rightEdge-font.widthOfTextAtSize(rightText,rightSize),y:H-detailTop*MM,font,size:rightSize,color:rgb(0,0,0)});
      // Fixed barcode dimensions for EVERY label; never stretch to fill available space.
      // Keep generous white space on the right and below for thermal printers.
      const barcodeWidth=42;   // mm
      const barcodeHeight=11;  // mm
      const barcodeX=3;       // mm from left
      const barcodeBottom=4;  // mm from bottom
      const barcodeTop=29-barcodeBottom-barcodeHeight;
      if(barcodeTop<detailTop+1.2)throw new Error(`Spazio insufficiente per codice a barre: ${row.code}`);
      page.drawImage(img,{x:barcodeX*MM,y:barcodeBottom*MM,width:barcodeWidth*MM,height:barcodeHeight*MM});
    }
    const bytes=await output.save();const blob=new Blob([bytes],{type:'application/pdf'});
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='Etichette_62x29_V7.pdf';document.body.appendChild(a);a.click();a.remove();
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
    const renderArticles=()=>{
      $('articles').innerHTML=articles.map((row,i)=>`<div class="article-card" data-card="${i}"><div class="article-head"><div class="article-title">Articolo ${i+1}</div><button type="button" class="edit-button" data-edit="${i}" aria-expanded="false">✎ Modifica</button></div><div class="article-preview"><strong>${escapeHtml(row.name)}</strong><br>${escapeHtml(row.code)} · ${escapeHtml(row.qty)} PZ · Commessa ${escapeHtml(row.comm)}</div><div class="edit-panel hidden" id="edit-panel-${i}"><div class="edit-grid"><label class="wide">Descrizione prodotto<input data-index="${i}" data-field="name" value="${escapeHtml(row.name)}" autocomplete="off"></label><label>Codice articolo<input data-index="${i}" data-field="code" value="${escapeHtml(row.code)}" autocomplete="off"></label><label>Quantità (PZ)<input data-index="${i}" data-field="qty" type="number" min="1" step="1" value="${escapeHtml(row.qty)}" inputmode="numeric"></label><label class="wide">Commessa interna<input data-index="${i}" data-field="comm" value="${escapeHtml(row.comm)}" autocomplete="off"></label></div><button type="button" class="save-edit" data-save="${i}">Salva modifiche</button></div></div>`).join('');
      $('articles').querySelectorAll('button[data-edit]').forEach(button=>button.addEventListener('click',()=>{
        const i=Number(button.dataset.edit), panel=$(`edit-panel-${i}`), opening=panel.classList.contains('hidden');
        panel.classList.toggle('hidden',!opening);button.textContent=opening?'Chiudi':'✎ Modifica';button.setAttribute('aria-expanded',String(opening));
      }));
      $('articles').querySelectorAll('button[data-save]').forEach(button=>button.addEventListener('click',()=>{
        const i=Number(button.dataset.save), card=$(`articles`).querySelector(`[data-card="${i}"]`);
        card.querySelectorAll('input[data-index]').forEach(input=>{const field=input.dataset.field;articles[i][field]=input.value;});
        renderArticles();status(`Modifiche salvate per Articolo ${i+1}.`);
      }));
    };
    renderArticles();
    $('results').classList.remove('hidden');$('generate').disabled=false;status(`${articles.length} articoli trovati in ${sourcePdf.numPages} pagine. Puoi correggere i campi prima della generazione.`);
  }catch(e){console.error(e);status(`Errore: ${e.message}`,true);}
});
$('generate').addEventListener('click',generatePdf);
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
