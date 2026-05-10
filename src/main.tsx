import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Copy, Download, Upload } from 'lucide-react';
import './style.css';

declare global { interface Window { studioAPI: any } }

const api = () => window.studioAPI || {
  openFile: async () => [],
  process: async () => ({ ok:false, error:'api_not_ready' }),
  info: async () => ({ ok:false, error:'api_not_ready' }),
  saveConfig: async () => ({}),
  loadConfig: async () => ({}),
  saveText: async () => ({ ok:false, error:'api_not_ready' }),
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function onlyDigits(value: string) {
  return value.replace(new RegExp('[^0-9]', 'g'), '');
}

function App() {
  const [apiKey, setApiKey] = useState('');
  const [styleJson, setStyleJson] = useState('');
  const [audioFile, setAudioFile] = useState('');
  const [transcriptionMode, setTranscriptionMode] = useState('localWhisper');
  const [chunkSeconds, setChunkSeconds] = useState('8');
  const [targetPromptCount, setTargetPromptCount] = useState('');
  const [originalText, setOriginalText] = useState('');
  const [extraRequirement, setExtraRequirement] = useState('');
  const [dialog, setDialog] = useState(false);
  const [subtitles, setSubtitles] = useState(false);
  const [status, setStatus] = useState('Sẵn sàng');
  const [result, setResult] = useState<any[]>([]);
  const [autoInfo, setAutoInfo] = useState<any>(null);

  useEffect(() => {
    api().loadConfig().then((c: any) => {
      setApiKey(c.apiKeys || c.apiKey || '');
      setStyleJson(c.styleJson || '');
      setTranscriptionMode(c.transcriptionMode || 'localWhisper');
    });
  }, []);

  async function refreshInfo(file = audioFile, seconds = chunkSeconds) {
    if (!file) return;
    const info = await api().info({ file, chunkSeconds: seconds });
    if (info?.ok) { setAutoInfo(info); if (info.promptCount) setTargetPromptCount(String(info.promptCount)); }
  }

  async function pickAudio() {
    const r = await api().openFile({
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a'] }],
    });
    if (r?.[0]) {
      setAudioFile(r[0]);
      await refreshInfo(r[0], chunkSeconds);
    }
  }


  async function save() {
    await api().saveConfig({ apiKeys: apiKey, styleJson, transcriptionMode });
    setStatus('Đã lưu cấu hình');
  }


  function promptText() {
    if (!Array.isArray(result) || !result.length) return '';
    return result.map((x: any, i: number) => typeof x === 'string' ? x : (x?.prompt || x?.text || JSON.stringify(x))).join('\n\n');
  }

  async function copyPrompts() {
    const text = promptText();
    if (!text) { setStatus('Chưa có prompt để copy'); return; }
    await navigator.clipboard.writeText(text);
    setStatus(`Đã copy ${result.length} prompt`);
  }

  async function downloadTxt() {
    const text = promptText();
    if (!text) { setStatus('Chưa có prompt để tải'); return; }
    const r = await api().saveText({ defaultPath: `audio-prompts-${Date.now()}.txt`, text });
    setStatus(r?.ok ? `Đã lưu TXT: ${r.filePath}` : 'Đã huỷ lưu TXT');
  }

  async function run() {
    setStatus('Đang phân tích thời lượng, cắt audio, nhận dạng văn bản và tạo prompt...');
    let promptCount = targetPromptCount;
    if (!promptCount && audioFile) {
      const info = await api().info({ file: audioFile, chunkSeconds });
      if (info?.ok) {
        setAutoInfo(info);
        if (info.promptCount) { promptCount = String(info.promptCount); setTargetPromptCount(promptCount); }
      }
    }
    const r = await api().process({
      apiKeys: apiKey,
      styleJson,
      audioFile,
      transcriptionMode,
      chunkSeconds,
      targetPromptCount,
      originalText,
      extraRequirement,
      dialog,
      subtitles,
    });
    if (r?.prompts) setResult(r.prompts);
    if (r?.ok) {
      setStatus(`Hoàn tất: ${r.count} scene • ${r.resultFile}`);
      setAutoInfo({ durationSeconds: r.durationSeconds, cutSeconds: r.cutSeconds, promptCount: r.autoPromptCount });
    } else {
      setStatus(`Lỗi: ${r?.error}`);
    }
  }

  return (
    <div className="app compact">
      <aside>
        <h1>Audio Prompt Studio</h1>
        <p>Audio + văn bản gốc → prompt tiếng Anh</p>
        <button onClick={run}>Tạo prompt</button>
        <button className="soft" onClick={save}>Lưu</button>
      </aside>
      <main>
        <section className="card top-card">
          <div className="section-head"><h2>Nội dung đầu vào</h2><button className="soft smallbtn" onClick={pickAudio}><Upload size={14}/> Chọn audio</button></div>
          <div className="input-pair">
            <div className="audio-box">
              <h3>Audio</h3>
              <p className="hint pathline">{audioFile || 'Chưa chọn audio mp3/wav/m4a'}</p>
              <p className="hint">Thời lượng: {autoInfo?.durationSeconds ? Math.round(autoInfo.durationSeconds) + 's' : 'chưa phân tích'} • Số prompt: {autoInfo?.promptCount || 'chưa có'}</p>
              <div className="mini-grid">
                <Field label="Cắt mỗi giây">
                  <input value={chunkSeconds} onChange={async e => { const v = onlyDigits(e.target.value); setChunkSeconds(v); await refreshInfo(audioFile, v); }} />
                </Field>
                <Field label="Số prompt tự động">
                  <input readOnly value={targetPromptCount || (autoInfo?.promptCount ? String(autoInfo.promptCount) : '')} placeholder="Tự tính" />
                </Field>
                <Field label="Dịch audio">
                  <select value={transcriptionMode} onChange={e => setTranscriptionMode(e.target.value)}>
                    <option value="localWhisper">Local Whisper nhanh</option>
                    <option value="gemini">Gemini Audio</option>
                  </select>
                </Field>
              </div>
            </div>
            <div className="text-box">
              <h3>Văn bản gốc</h3>
              <textarea value={originalText} onChange={e => setOriginalText(e.target.value)} placeholder="Dán văn bản gốc để AI đối chiếu với transcript audio và giữ đúng nội dung" />
            </div>
          </div>
        </section>

        <section className="card settings-card">
          <h2>Thiết lập</h2>
          <div className="grid compact-grid">
            <Field label="Gemini API keys">
              <textarea className="smallarea" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Mỗi dòng một API key" />
            </Field>
            <Field label="Lời thoại">
              <select value={dialog ? 'yes' : 'no'} onChange={e => setDialog(e.target.value === 'yes')}>
                <option value="no">Không</option><option value="yes">Có</option>
              </select>
            </Field>
            <Field label="Phụ đề">
              <select value={subtitles ? 'yes' : 'no'} onChange={e => setSubtitles(e.target.value === 'yes')}>
                <option value="no">Không</option><option value="yes">Có</option>
              </select>
            </Field>
          </div>
        </section>

        <section className="card"><h2>Phong cách JSON</h2><textarea className="mediumarea" value={styleJson} onChange={e => setStyleJson(e.target.value)} placeholder="Dán style_analysis JSON ở đây" /></section>
        <section className="card"><div className="section-head"><h2>Kết quả</h2><div className="result-actions"><button className="soft smallbtn" onClick={copyPrompts}><Copy size={14}/> Copy prompt</button><button className="soft smallbtn" onClick={downloadTxt}><Download size={14}/> Tải TXT</button></div></div><p>{status}</p><pre>{promptText() || JSON.stringify(result, null, 2)}</pre></section>
        <section className="card extra-card"><h2>Yêu cầu thêm vào prompt</h2><textarea className="mediumarea" value={extraRequirement} onChange={e => setExtraRequirement(e.target.value)} placeholder="Ví dụ: prompt ngắn gọn, phong cách điện ảnh, giữ nhân vật đồng nhất, không có chữ trên màn hình..." /></section>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App/>);
