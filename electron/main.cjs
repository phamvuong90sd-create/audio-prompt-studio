const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const installerFfmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const isDev = !app.isPackaged;
const BASE = path.join(os.homedir(), '.audio-prompt-studio');
const OUT = path.join(BASE, 'output');
const CFG = path.join(BASE, 'config.json');
function ensure(){ fs.mkdirSync(OUT, { recursive: true }); }
function createWindow(){
  const w = new BrowserWindow({ width: 1220, height: 820, backgroundColor: '#08111f', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }});
  if (isDev) w.loadURL('http://127.0.0.1:5173'); else w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}
app.whenReady().then(()=>{ ensure(); createWindow(); });
app.on('window-all-closed',()=>{ if(process.platform !== 'darwin') app.quit(); });

ipcMain.handle('dialog:openFile', async (_e, opts={}) => {
  const r = await dialog.showOpenDialog({ properties: opts.properties || ['openFile'], filters: opts.filters || [] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('config:load', async()=>{ try { return { ok:true, ...JSON.parse(fs.readFileSync(CFG,'utf8')) }; } catch { return { ok:true }; } });
ipcMain.handle('config:save', async(_e,p)=>{ ensure(); fs.writeFileSync(CFG, JSON.stringify(p||{}, null, 2)); return { ok:true }; });
function ffmpegBin(){
  const platformDir = process.platform === 'win32' ? 'win32-x64' : process.platform === 'darwin' ? 'darwin-x64' : 'linux-x64';
  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    installerFfmpegPath,
    installerFfmpegPath.replace('app.asar', 'app.asar.unpacked'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', platformDir, exeName),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', 'ffmpeg', exeName),
  ];
  for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch {} }
  return installerFfmpegPath;
}
function runFfmpeg(args){ return spawnSync(ffmpegBin(), args, { encoding:'utf8', windowsHide:true }); }
function mime(f){ const e=String(f).toLowerCase().split('.').pop(); if(e==='wav')return 'audio/wav'; if(e==='m4a')return 'audio/mp4'; return 'audio/mpeg'; }
function parseKeys(input){ return String(input||'').split(/[\n,;]+/).map(x=>x.trim()).filter(Boolean); }
async function gemini(apiKeys, parts, system, json=false, startIndex=0){
  const keys=parseKeys(apiKeys); if(!keys.length) throw new Error('missing_api_key');
  const models=['gemini-2.5-flash','gemini-2.0-flash']; let last='';
  for(let k=0;k<keys.length;k++){ const apiKey=keys[(startIndex+k)%keys.length];
  for(const m of models){
    try{
      const body={ contents:[{role:'user',parts}], systemInstruction:{parts:[{text:system}]}, generationConfig:{temperature:.55} };
      if(json) body.generationConfig.responseMimeType='application/json';
      const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      const o=await r.json().catch(()=>({}));
      if(!r.ok){ const msg=o.error?.message || `http_${r.status}`; if(msg.includes('Quota exceeded') || msg.includes('quota')){ last='quota_exceeded: API key/model quota exceeded. Add another Gemini API key or wait for quota reset.'; continue; } last=msg; continue; }
      return (o.candidates?.[0]?.content?.parts || []).map(p=>p.text||'').join('\n').trim();
    }catch(e){ last=String(e); }
  }}
  throw new Error(last || 'gemini_failed');
}
function splitAudio(file, seconds){
  ensure();
  const dir = path.join(OUT, 'chunks_' + Date.now());
  fs.mkdirSync(dir, { recursive:true });
  const ext = String(file).toLowerCase().endsWith('.wav') ? 'wav' : String(file).toLowerCase().endsWith('.m4a') ? 'm4a' : 'mp3';
  let pattern = path.join(dir, `chunk_%03d.${ext}`);
  let r = runFfmpeg(['-y','-i',file,'-f','segment','-segment_time',String(seconds||30),'-reset_timestamps','1','-c','copy',pattern]);
  let files = fs.readdirSync(dir).filter(x => x.startsWith('chunk_')).map(x => path.join(dir, x));
  if (r.status !== 0 || !files.length) {
    pattern = path.join(dir, 'chunk_%03d.mp3');
    r = runFfmpeg(['-y','-i',file,'-f','segment','-segment_time',String(seconds||30),'-reset_timestamps','1','-vn','-ar','44100','-ac','2','-b:a','128k',pattern]);
    files = fs.readdirSync(dir).filter(x => x.startsWith('chunk_') && x.endsWith('.mp3')).map(x => path.join(dir, x));
  }
  if (r.status !== 0 || !files.length) {
    const log = path.join(OUT, 'ffmpeg-split-error-' + Date.now() + '.log');
    fs.writeFileSync(log, `ffmpeg=${ffmpegBin()}\nstatus=${r.status}\nstdout=${r.stdout||''}\nstderr=${r.stderr||''}`, 'utf8');
    throw new Error('ffmpeg_split_failed: ' + log);
  }
  return files.sort();
}
ipcMain.handle('audio:process', async(_e,p={})=>{
  try{
    ensure(); if(!parseKeys(p.apiKeys||p.apiKey).length) return {ok:false,error:'missing_api_key'}; if(!p.audioFile) return {ok:false,error:'missing_audio'};
    let chunks=[];
    let splitWarning='';
    try {
      chunks=splitAudio(p.audioFile, Number(p.chunkSeconds||30));
    } catch (splitErr) {
      splitWarning=String(splitErr.message||splitErr);
      chunks=[p.audioFile];
    }
    const transcripts=[];
    for(let i=0;i<chunks.length;i++){
      const data=fs.readFileSync(chunks[i]).toString('base64');
      const t=await gemini(p.apiKeys||p.apiKey, [{inlineData:{mimeType:mime(chunks[i]),data}}, {text:`Transcribe this Vietnamese audio chunk ${i+1}/${chunks.length}. Return clean text only.`}], 'Bạn là hệ thống nhận dạng giọng nói tiếng Việt. Chỉ trả văn bản đã nghe được, không giải thích.', false, i);
      transcripts.push(t);
    }
    const raw=transcripts.join('\n');
    const desiredCount=Math.max(1, Number(p.targetPromptCount||chunks.length)||chunks.length);
    const sys=`You are a professional video prompt engineer. Your output MUST be a JSON array containing EXACTLY ${desiredCount} scene strings. ALL output text, including titles, descriptions, labels, camera notes, dialog notes, and subtitle notes, MUST be in ENGLISH only. Create exactly ${desiredCount} prompts/scenes. Do not create fewer or more. Each scene must strictly follow this format: Scene 01 – Title | Character1: full description | Character2: full description | Style: ... | Character voices: ... | Camera: ... | Setting: ... | Mood: ... | Audio cues: ... | Dialog: ... | Subtitles: ... . Preserve the SAME SYSTEM, storyline, structure, characters, scene order, events, meaning, and emotional intent from the original text. Do not invent a different story. Do not change the topic, character roles, sequence of events, or core message. If the original text is Vietnamese, translate the meaning faithfully into natural English prompts. Respect the user Style JSON. Dialog enabled: ${p.dialog?'yes':'no'}. Subtitles enabled: ${p.subtitles?'yes':'no'}. Apply extra prompt requirements if provided, but never override the original content. Compare the transcript with the original text if provided, fix the transcript to match the original content, then generate final English prompts that stay faithful to the original text.`;
    const prompt=`STYLE JSON:\n${p.styleJson||''}\n\nORIGINAL TEXT:\n${p.originalText||''}\n\nEXTRA PROMPT REQUIREMENTS:\n${p.extraRequirement||''}\n\nAUDIO TRANSCRIPT:\n${raw}\n\nGenerate final prompts in ENGLISH only, but preserve the same system, storyline, scene order, meaning, characters, and emotional intent as the original text. Do not rewrite into a different concept.`;
    const out=await gemini(p.apiKeys||p.apiKey, [{text:prompt}], sys, true, chunks.length);
    let arr; try { arr=JSON.parse(out.replace(/^```json\s*|```$/g,'')); } catch { arr=[out]; }
    if(!Array.isArray(arr)) arr=[String(arr)];
    if(arr.length>desiredCount) arr=arr.slice(0,desiredCount);
    while(arr.length<desiredCount){ arr.push(`Scene ${String(arr.length+1).padStart(2,'0')} – Continuation | Character1: based on the original text | Character2: based on the original text | Style: follow the provided style JSON | Character voices: match the original audio | Camera: cinematic continuation | Setting: continue from the original story | Mood: consistent with the original text | Audio cues: continue the narration | Dialog: ${p.dialog?'include if present in original':'none'} | Subtitles: ${p.subtitles?'English subtitles matching the narration':'none'}`); }
    const resultFile=path.join(OUT,'audio-prompts-'+Date.now()+'.json'); fs.writeFileSync(resultFile, JSON.stringify(arr,null,2), 'utf8');
    const transcriptFile=path.join(OUT,'transcript-'+Date.now()+'.txt'); fs.writeFileSync(transcriptFile, raw, 'utf8');
    return {ok:true,count:Array.isArray(arr)?arr.length:1,prompts:arr,resultFile,transcriptFile,splitWarning};
  }catch(e){ return {ok:false,error:String(e.message||e)}; }
});
