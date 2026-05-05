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
  const models=['gemini-2.5-flash','gemini-2.0-flash','gemini-1.5-flash']; let last='';
  for(let k=0;k<keys.length;k++){ const apiKey=keys[(startIndex+k)%keys.length];
  for(const m of models){
    try{
      const body={ contents:[{role:'user',parts}], systemInstruction:{parts:[{text:system}]}, generationConfig:{temperature:.55} };
      if(json) body.generationConfig.responseMimeType='application/json';
      const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      const o=await r.json().catch(()=>({}));
      if(!r.ok){ last=o.error?.message || `http_${r.status}`; continue; }
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
    const chunks=splitAudio(p.audioFile, Number(p.chunkSeconds||30));
    const transcripts=[];
    for(let i=0;i<chunks.length;i++){
      const data=fs.readFileSync(chunks[i]).toString('base64');
      const t=await gemini(p.apiKeys||p.apiKey, [{inlineData:{mimeType:mime(chunks[i]),data}}, {text:`Transcribe this Vietnamese audio chunk ${i+1}/${chunks.length}. Return clean text only.`}], 'Bạn là hệ thống nhận dạng giọng nói tiếng Việt. Chỉ trả văn bản đã nghe được, không giải thích.', false, i);
      transcripts.push(t);
    }
    const raw=transcripts.join('\n');
    const sys=`Bạn là chuyên gia chuyển audio/kịch bản thành prompt tạo video. Đầu ra phải là JSON array các scene string. Mỗi scene đúng format: Scene 01 – Title | Character1: full description | Character2: full description | Style: ... | Character voices: ... | Camera: ... | Setting: ... | Mood: ... | Audio cues: ... | Dialog: ... | Subtitles: ... . Style JSON người dùng cung cấp phải được tôn trọng. Lời thoại: ${p.dialog?'có':'không'}. Phụ đề: ${p.subtitles?'có':'không'}. Yêu cầu thêm của người dùng phải được áp dụng vào mọi prompt nếu có. So sánh transcript với văn bản gốc nếu có, chỉnh transcript cho khớp nội dung gốc, rồi tạo prompt đúng nội dung văn bản gốc.`;
    const prompt=`STYLE JSON:\n${p.styleJson||''}\n\nVĂN BẢN GỐC:\n${p.originalText||''}\n\nYÊU CẦU THÊM VÀO PROMPT:\n${p.extraRequirement||''}\n\nTRANSCRIPT TỪ AUDIO:\n${raw}\n\nHãy tạo prompt cuối cùng đúng theo nội dung gốc.`;
    const out=await gemini(p.apiKeys||p.apiKey, [{text:prompt}], sys, true, chunks.length);
    let arr; try { arr=JSON.parse(out.replace(/^```json\s*|```$/g,'')); } catch { arr=[out]; }
    const resultFile=path.join(OUT,'audio-prompts-'+Date.now()+'.json'); fs.writeFileSync(resultFile, JSON.stringify(arr,null,2), 'utf8');
    const transcriptFile=path.join(OUT,'transcript-'+Date.now()+'.txt'); fs.writeFileSync(transcriptFile, raw, 'utf8');
    return {ok:true,count:Array.isArray(arr)?arr.length:1,prompts:arr,resultFile,transcriptFile};
  }catch(e){ return {ok:false,error:String(e.message||e)}; }
});
