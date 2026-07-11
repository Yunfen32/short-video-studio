import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Download,
  Film,
  ImagePlus,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import './styles.css';

const aspectRatios = ['9:16', '16:9', '1:1', '4:3', '3:4'];
const durations = [5, 8, 15];
const styles = ['写实广告', '电影感', '产品展示', '动画短片'];
const models = [
  { id: 'happyhorse-1.1-t2v', label: 'HappyHorse 1.1 文生视频', needsReferenceImages: false },
  { id: 'happyhorse-1.1-r2v', label: 'HappyHorse 1.1 参考图生视频', needsReferenceImages: true },
  { id: 'wan2.7-r2v-2026-06-12', label: '万相 2.7 人物 / 背景 / 音色参考', needsReferenceImages: true, supportsAudioReference: true },
  { id: 'agnes-video-v2.0', label: 'Agnes Video V2.0 图生视频', needsReferenceImages: true },
];
const POLL_INTERVAL = 15000;

function createStoryboard(prompt, ratio, duration, style) {
  const source = prompt.trim() || '等待提示词';
  const fragments = source.replace(/[，。,.]/g, '|').split('|').map((item) => item.trim()).filter(Boolean);
  const beats = [
    fragments[0] || source,
    fragments[1] || '主体进入画面，环境细节逐渐清晰',
    fragments[2] || '镜头切到特写，突出质感、动作和情绪',
    fragments[3] || '收束到完整画面，保留主题记忆点',
  ];

  return beats.map((beat, index) => ({
    id: index + 1,
    time: `${String(Math.round(index * duration / 4)).padStart(2, '0')}s`,
    shot: beat,
    camera: ['慢速推进', '横向跟拍', '微距特写', '定格收束'][index],
    meta: `${style} / ${ratio} / ${duration} 秒`,
  }));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('参考图读取失败'));
    reader.readAsDataURL(file);
  });
}

async function apiRequest(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试');
  return data;
}

function progressFor(status) {
  if (status === 'PENDING') return 12;
  if (status === 'RUNNING') return 58;
  if (status === 'SUCCEEDED') return 100;
  return 0;
}

function App() {
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState('9:16');
  const [duration, setDuration] = useState(5);
  const [style, setStyle] = useState('电影感');
  const [model, setModel] = useState('happyhorse-1.1-t2v');
  const [resolution, setResolution] = useState('720P');
  const [watermark, setWatermark] = useState(false);
  const [images, setImages] = useState([]);
  const [audioUrl, setAudioUrl] = useState('');
  const [taskStatus, setTaskStatus] = useState('IDLE');
  const [videoUrl, setVideoUrl] = useState('');
  const [error, setError] = useState('');
  const [mention, setMention] = useState(null);
  const videoRef = useRef(null);
  const promptRef = useRef(null);
  const activeTaskRef = useRef(0);

  const isGenerating = taskStatus === 'PENDING' || taskStatus === 'RUNNING';
  const progress = progressFor(taskStatus);
  const canGenerate = prompt.trim().length > 0 && !isGenerating;
  const selectedModel = models.find((item) => item.id === model) || models[0];
  const referenceLimit = selectedModel.id === 'wan2.7-r2v-2026-06-12' || selectedModel.id === 'agnes-video-v2.0' ? 5 : 9;
  const mentionOptions = mention
    ? images.map((reference, index) => ({ reference, index })).filter(({ reference, index }) => (
      `参考图${index + 1}${reference.role}`.toLowerCase().includes(mention.query.toLowerCase())
    ))
    : [];

  function handlePromptChange(event) {
    const { value, selectionStart } = event.target;
    const cursor = selectionStart ?? value.length;
    const trigger = value.slice(0, cursor).match(/@([^\s@]*)$/);
    setPrompt(value);
    setMention(selectedModel.needsReferenceImages && images.length > 0 && trigger
      ? { start: cursor - trigger[0].length, end: cursor, query: trigger[1] }
      : null);
  }

  function insertReferenceMention(index) {
    if (!mention) return;
    const token = `@参考图${index + 1}`;
    const nextPrompt = `${prompt.slice(0, mention.start)}${token}${prompt.slice(mention.end)}`;
    const nextCursor = mention.start + token.length;
    setPrompt(nextPrompt);
    setMention(null);
    window.requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  async function addImages(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;

    const available = referenceLimit - images.length;
    const selected = files.slice(0, available);
    const invalid = selected.find((file) => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024);
    if (invalid) {
      setError('参考图需为 JPG、PNG 或 WEBP，单张不超过 20MB');
      return;
    }

    try {
      const encoded = await Promise.all(selected.map(fileToDataUrl));
      setImages((current) => [...current, ...encoded.map((source) => ({ source, role: '人物' }))]);
      setError(files.length > available ? `最多保留前 ${referenceLimit} 张参考图` : '');
    } catch (readError) {
      setError(readError.message);
    }
  }

  async function pollTask(taskId, taskToken, provider, videoId) {
    const query = new URLSearchParams({ provider: provider || 'dashscope' });
    if (videoId) query.set('video_id', videoId);
    const data = await apiRequest(`/api/videos/${encodeURIComponent(taskId)}?${query}`);
    if (activeTaskRef.current !== taskToken) return;
    setTaskStatus(data.status);

    if (data.status === 'SUCCEEDED' && data.videoUrl) {
      setVideoUrl(data.videoUrl);
      return;
    }
    if (data.terminal) throw new Error(data.error || '视频任务未能完成');

    window.setTimeout(() => {
      pollTask(taskId, taskToken, provider, videoId).catch((pollError) => {
        if (activeTaskRef.current !== taskToken) return;
        setTaskStatus('FAILED');
        setError(pollError.message);
      });
    }, POLL_INTERVAL);
  }

  async function generateVideo() {
    if (!canGenerate) return;
    if (selectedModel.needsReferenceImages && images.length === 0) {
      setError('当前模型需要至少上传 1 张参考图');
      return;
    }
    setError('');
    setVideoUrl('');
    setTaskStatus('PENDING');
    const taskToken = activeTaskRef.current + 1;
    activeTaskRef.current = taskToken;

    try {
      const data = await apiRequest('/api/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: `${prompt.trim()}。视觉风格：${style}。`,
          images: selectedModel.needsReferenceImages ? images : [],
          audioUrl: selectedModel.supportsAudioReference ? audioUrl.trim() : '',
          ratio,
          duration,
          resolution,
          watermark,
        }),
      });
      if (activeTaskRef.current !== taskToken) return;
      setTaskStatus(data.status);
      await pollTask(data.taskId, taskToken, data.provider, data.videoId);
    } catch (requestError) {
      if (activeTaskRef.current !== taskToken) return;
      setTaskStatus('FAILED');
      setError(requestError.message);
    }
  }

  function reset() {
    activeTaskRef.current += 1;
    setPrompt('');
    setMention(null);
    setImages([]);
    setAudioUrl('');
    setVideoUrl('');
    setError('');
    setTaskStatus('IDLE');
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  }

  const statusLabels = {
    IDLE: '待生成',
    PENDING: '排队中',
    RUNNING: '生成中',
    SUCCEEDED: '已完成',
    FAILED: '生成失败',
  };

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">{selectedModel.id === 'agnes-video-v2.0' ? 'AGNES AI / VIDEO V2.0' : 'HAPPYHORSE 1.1'}</p>
          <h1>参考图驱动的视频生成台</h1>
        </div>
        <div className={`status-strip ${taskStatus === 'FAILED' ? 'error' : ''}`} aria-live="polite">
          <span>{statusLabels[taskStatus] || taskStatus}</span>
          <strong>{String(progress).padStart(3, '0')}%</strong>
        </div>
      </section>

      <section className="workspace">
        <aside className="control-panel">
          <div className="panel-heading"><Wand2 size={18} /><h2>生成指令</h2></div>

          <label className="field">
            <span>生成模型</span>
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              {models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>

          <label className="field">
            <span>视频描述</span>
            <textarea
              ref={promptRef}
              value={prompt}
              maxLength={2500}
              onChange={handlePromptChange}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setMention(null);
              }}
              placeholder={selectedModel.needsReferenceImages
                ? '例如：@参考图1 中的银色手表在雨夜街头旋转，镜头推进至屏幕特写'
                : '例如：一款银色智能手表在雨夜街头旋转，镜头推进至屏幕特写'}
            />
          </label>

          {mention && mentionOptions.length > 0 && (
            <div className="reference-mention-menu" role="listbox" aria-label="选择参考图">
              <div className="reference-mention-track">
                {mentionOptions.map(({ reference, index }) => (
                  <button
                    type="button"
                    className="reference-mention-option"
                    key={`${reference.source.slice(-20)}-mention-${index}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertReferenceMention(index)}
                    role="option"
                    aria-label={`插入参考图 ${index + 1}`}
                  >
                    <img src={reference.source} alt="" />
                    <span>@参考图 {index + 1}</span>
                    <small>{reference.role}</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          {selectedModel.needsReferenceImages && (
            <div className="reference-field">
              <div className="field-label"><span>参考图（至少 1 张）</span><strong>{images.length}/{referenceLimit}</strong></div>
              <div className="reference-grid">
                {images.map((reference, index) => (
                  <div className="reference-item" key={`${reference.source.slice(-20)}-${index}`}>
                    <img src={reference.source} alt={`参考图 ${index + 1}`} />
                    <span>@参考图 {index + 1} · {reference.role}</span>
                    <select
                      value={reference.role}
                      onChange={(event) => setImages((current) => current.map((item, itemIndex) => (
                        itemIndex === index ? { ...item, role: event.target.value } : item
                      )))}
                      aria-label={`参考图 ${index + 1} 的用途`}
                    >
                      <option>人物</option>
                      <option>背景</option>
                    </select>
                    <button type="button" onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`删除参考图 ${index + 1}`}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                {images.length < referenceLimit && (
                  <label className="upload-tile" aria-label="添加参考图">
                    <ImagePlus size={22} />
                    <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={addImages} />
                  </label>
                )}
              </div>
              {selectedModel.supportsAudioReference && (
                <label className="field audio-reference-field">
                  <span>音频参考 URL</span>
                  <input
                    type="url"
                    value={audioUrl}
                    onChange={(event) => setAudioUrl(event.target.value)}
                    placeholder="https://example.com/voice.mp3"
                  />
                </label>
              )}
            </div>
          )}

          <div className="settings-grid">
            <label className="field">
              <span>比例</span>
              <select value={ratio} onChange={(event) => setRatio(event.target.value)}>
                {aspectRatios.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label className="field">
              <span>时长</span>
              <select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
                {durations.map((item) => <option key={item} value={item}>{item} 秒</option>)}
              </select>
            </label>
            <label className="field">
              <span>清晰度</span>
              <select value={resolution} onChange={(event) => setResolution(event.target.value)}>
                <option>720P</option><option>1080P</option>
              </select>
            </label>
            <label className="field">
              <span>风格</span>
              <select value={style} onChange={(event) => setStyle(event.target.value)}>
                {styles.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
          </div>

          <label className="toggle-field">
            <input type="checkbox" checked={watermark} onChange={(event) => setWatermark(event.target.checked)} />
            <span>添加 Happy Horse 水印</span>
          </label>

          {error && <p className="error-message" role="alert">{error}</p>}

          <div className="action-row">
            <button className="primary-action" onClick={generateVideo} disabled={!canGenerate}>
              {isGenerating ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
              {isGenerating ? '正在生成' : '生成视频'}
            </button>
            <button className="icon-action" onClick={reset} aria-label="重置"><RefreshCw size={18} /></button>
          </div>
        </aside>

        <section className="preview-panel">
          <div className="preview-toolbar">
            <div className="panel-heading"><Film size={18} /><h2>生成结果</h2></div>
            <div className="toolbar-actions">
              <button className="icon-action" onClick={togglePlayback} disabled={!videoUrl} aria-label="播放或暂停"><Play size={18} /></button>
              <a className={`icon-action ${!videoUrl ? 'disabled' : ''}`} href={videoUrl || undefined} target="_blank" rel="noreferrer" aria-label="下载视频"><Download size={18} /></a>
            </div>
          </div>

          <div className={`video-frame ${videoUrl ? 'has-video' : ''}`}>
            {videoUrl ? (
              <video ref={videoRef} src={videoUrl} controls autoPlay loop playsInline />
            ) : (
              <>
                <div className="scan-layer" />
                <div className="frame-number">TASK {taskStatus}</div>
                <div className="subject-block">
                  <span>{style} / {resolution}</span>
                  <strong>{isGenerating ? `${selectedModel.label} 正在合成画面与声音` : (prompt.trim() || '等待生成任务')}</strong>
                </div>
                <div className="timeline"><span style={{ width: `${progress || 4}%` }} /></div>
              </>
            )}
          </div>
        </section>

      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
