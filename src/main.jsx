import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  Check,
  Download,
  Film,
  Gauge,
  ImagePlus,
  Layers3,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  Video,
  Wand2,
} from 'lucide-react';
import { VIDEO_MODEL_CATEGORIES, VIDEO_MODELS } from '../shared/video-models.mjs';
import './styles.css';

const ASPECT_RATIOS = ['9:16', '16:9', '1:1', '4:3', '3:4'];
const STYLES = ['写实广告', '电影感', '产品展示', '动画短片'];
const POLL_INTERVAL = 15000;

async function apiRequest(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || '请求失败，请稍后重试');
    Object.assign(error, data);
    throw error;
  }
  return data;
}

async function uploadReferenceImage(file) {
  const response = await fetch('/api/reference-images', {
    method: 'POST',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.url) throw new Error(data.error || '参考图上传失败');
  return data.url;
}

function progressFor(status) {
  if (status === 'PENDING') return 12;
  if (status === 'RUNNING') return 58;
  if (status === 'SUCCEEDED') return 100;
  return 0;
}

function assetRole(model, reference, index) {
  if (model.protocol === 'i2v27' || model.protocol === 'kf2vLegacy') return index === 0 ? '首帧' : '尾帧';
  if (model.protocol === 'i2vLegacy') return '首帧';
  if (model.protocol === 'animateMove' || model.protocol === 'animateMix') return '人物';
  return reference.role;
}

function App() {
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState('9:16');
  const [duration, setDuration] = useState(5);
  const [style, setStyle] = useState('电影感');
  const [modelId, setModelId] = useState('wan2.7-t2v');
  const [category, setCategory] = useState('text');
  const [resolution, setResolution] = useState('720P');
  const [watermark, setWatermark] = useState(false);
  const [promptExtend, setPromptExtend] = useState(true);
  const [negativePrompt, setNegativePrompt] = useState('');
  const [seed, setSeed] = useState('');
  const [images, setImages] = useState([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [audioUrl, setAudioUrl] = useState('');
  const [videoInputUrl, setVideoInputUrl] = useState('');
  const [animationMode, setAnimationMode] = useState('wan-std');
  const [taskStatus, setTaskStatus] = useState('IDLE');
  const [videoUrl, setVideoUrl] = useState('');
  const [error, setError] = useState('');
  const [mention, setMention] = useState(null);
  const [unavailableModels, setUnavailableModels] = useState([]);
  const [availabilityLoading, setAvailabilityLoading] = useState(true);
  const videoRef = useRef(null);
  const promptRef = useRef(null);
  const activeTaskRef = useRef(0);

  const unavailableIds = new Set(unavailableModels.map((item) => item.modelId));
  const availableModels = VIDEO_MODELS.filter((item) => !unavailableIds.has(item.id));
  const categoryModels = availableModels.filter((item) => item.category === category);
  const selectedModel = availableModels.find((item) => item.id === modelId) || categoryModels[0] || availableModels[0] || VIDEO_MODELS[0];
  const isGenerating = taskStatus === 'PENDING' || taskStatus === 'RUNNING';
  const progress = progressFor(taskStatus);
  const imageLimit = selectedModel.imageMax || 0;
  const activeImages = images.slice(0, imageLimit);
  const needsImage = (selectedModel.imageMin || 0) > 0;
  const canUseImages = imageLimit > 0;
  const canUseAudio = selectedModel.supportsAudio || selectedModel.supportsVoiceReference;
  const canUseVideo = selectedModel.acceptsVideo || selectedModel.requiresVideo;
  const availableRatios = selectedModel.protocol === 't2vLegacy' && resolution === '480P'
    ? ASPECT_RATIOS.slice(0, 3)
    : ASPECT_RATIOS;
  const hasRequiredPrompt = selectedModel.promptOptional || prompt.trim().length > 0;
  const hasRequiredImages = selectedModel.protocol === 'i2v27' && videoInputUrl
    ? activeImages.length <= 1
      : (selectedModel.protocol === 'r2v' || selectedModel.protocol === 'r2vLegacy') && videoInputUrl
      ? activeImages.length <= imageLimit
      : activeImages.length >= (selectedModel.imageMin || 0) && activeImages.length <= imageLimit;
  const hasRequiredVideo = !selectedModel.requiresVideo || Boolean(videoInputUrl.trim());
  const canGenerate = hasRequiredPrompt && hasRequiredImages && hasRequiredVideo && !isGenerating && uploadingCount === 0;
  const mentionOptions = mention
    ? activeImages.map((reference, index) => ({ reference, index })).filter(({ reference, index }) => (
      `参考图${index + 1}${assetRole(selectedModel, reference, index)}`.toLowerCase().includes(mention.query.toLowerCase())
    ))
    : [];

  async function refreshAvailability() {
    try {
      const data = await apiRequest('/api/models');
      setUnavailableModels(Array.isArray(data.unavailable) ? data.unavailable : []);
    } catch {
      // The model catalog remains usable if the availability service is temporarily unreachable.
    } finally {
      setAvailabilityLoading(false);
    }
  }

  useEffect(() => {
    refreshAvailability();
    const timer = window.setInterval(refreshAvailability, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!unavailableIds.has(modelId)) return;
    const fallback = availableModels.find((item) => item.category === category) || availableModels[0];
    if (fallback) setModelId(fallback.id);
  }, [unavailableModels, modelId, category]);

  useEffect(() => {
    if (!selectedModel.durations.includes(duration)) setDuration(selectedModel.durations[0]);
    if (!selectedModel.resolutions.includes(resolution)) setResolution(selectedModel.resolutions[0]);
    setMention(null);
  }, [selectedModel.id]);

  useEffect(() => {
    if (!availableRatios.includes(ratio)) setRatio(availableRatios[0]);
  }, [selectedModel.id, resolution]);

  function selectCategory(nextCategory) {
    setCategory(nextCategory);
    const firstModel = availableModels.find((item) => item.category === nextCategory);
    if (firstModel) setModelId(firstModel.id);
  }

  function selectModel(nextModel) {
    setModelId(nextModel.id);
    setCategory(nextModel.category);
    setError('');
  }

  function handlePromptChange(event) {
    const { value, selectionStart } = event.target;
    const cursor = selectionStart ?? value.length;
    const trigger = value.slice(0, cursor).match(/@([^\s@]*)$/);
    setPrompt(value);
    setMention(canUseImages && activeImages.length > 0 && trigger
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

    const available = imageLimit - activeImages.length;
    const selected = files.slice(0, Math.max(available, 0));
    const invalid = selected.find((file) => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024);
    if (invalid) {
      setError('参考图需为 JPG、PNG 或 WEBP，单张不超过 4MB');
      return;
    }

    try {
      setUploadingCount(selected.length);
      const uploaded = await Promise.all(selected.map(uploadReferenceImage));
      setImages((current) => [...current, ...uploaded.map((source) => ({ source, role: '人物' }))]);
      setError(files.length > available ? `当前模型最多保留 ${imageLimit} 张参考图` : '');
    } catch (readError) {
      setError(readError.message);
    } finally {
      setUploadingCount(0);
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
    if (!canGenerate) {
      if (!hasRequiredPrompt) setError('请输入视频描述');
      else if (!hasRequiredImages) setError(`当前模型需要 ${selectedModel.imageMin || 0}-${imageLimit} 张参考图`);
      else if (!hasRequiredVideo) setError('请输入可访问的视频 URL');
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
          model: selectedModel.id,
          prompt: prompt.trim() ? `${prompt.trim()}。视觉风格：${style}。` : '',
          images: canUseImages ? images.slice(0, imageLimit) : [],
          audioUrl: canUseAudio ? audioUrl.trim() : '',
          videoUrl: canUseVideo ? videoInputUrl.trim() : '',
          ratio,
          duration,
          resolution,
          watermark,
          promptExtend,
          negativePrompt: negativePrompt.trim(),
          seed: seed === '' ? null : Number(seed),
          animationMode,
        }),
      });
      if (activeTaskRef.current !== taskToken) return;
      setTaskStatus(data.status);
      await pollTask(data.taskId, taskToken, data.provider, data.videoId);
    } catch (requestError) {
      if (activeTaskRef.current !== taskToken) return;
      setTaskStatus('FAILED');
      setError(requestError.message);
      if (requestError.modelUnavailable && requestError.modelId) {
        setUnavailableModels((current) => [
          ...current.filter((item) => item.modelId !== requestError.modelId),
          { modelId: requestError.modelId, until: requestError.unavailableUntil, reason: requestError.message },
        ]);
      }
    }
  }

  function reset() {
    activeTaskRef.current += 1;
    setPrompt('');
    setMention(null);
    setImages([]);
    setAudioUrl('');
    setVideoInputUrl('');
    setNegativePrompt('');
    setSeed('');
    setPromptExtend(true);
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
      <header className="topbar">
        <div className="brand-block">
          <p className="eyebrow">VIDEO MODEL CONSOLE</p>
          <h1>视频生成工作台</h1>
        </div>
        <div className="service-metrics" aria-label="模型服务状态">
          <div><span>可用模型</span><strong>{availableModels.length}</strong></div>
          <div><span>额度下架</span><strong>{unavailableModels.length}</strong></div>
          <div className={`status-strip ${taskStatus === 'FAILED' ? 'error' : ''}`}>
            <span>{statusLabels[taskStatus] || taskStatus}</span>
            <strong>{String(progress).padStart(3, '0')}%</strong>
          </div>
        </div>
      </header>

      <section className="workspace">
        <aside className="control-panel">
          <div className="panel-heading"><Wand2 size={18} /><h2>生成配置</h2></div>

          <section className="model-console" aria-label="视频模型">
            <div className="category-tabs" role="tablist" aria-label="模型类型">
              {VIDEO_MODEL_CATEGORIES.map((item) => {
                const count = availableModels.filter((model) => model.category === item.id).length;
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={category === item.id ? 'active' : ''}
                    onClick={() => selectCategory(item.id)}
                    role="tab"
                    aria-selected={category === item.id}
                    disabled={count === 0}
                  >
                    <span>{item.label}</span><strong>{count}</strong>
                  </button>
                );
              })}
            </div>

            <div className="model-track" role="listbox" aria-label="可用模型列表">
              {categoryModels.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={`model-option ${selectedModel.id === item.id ? 'active' : ''}`}
                  onClick={() => selectModel(item)}
                  role="option"
                  aria-selected={selectedModel.id === item.id}
                >
                  <span>{item.family}</span>
                  <strong>{item.label.replace(`${item.family} `, '')}</strong>
                  {item.featured && <em>推荐</em>}
                </button>
              ))}
            </div>

            <div className="model-readout">
              <div><Gauge size={15} /><span>{selectedModel.id}</span></div>
              <p>{selectedModel.summary}</p>
              <div className="capability-row">
                {selectedModel.resolutions.map((item) => <span key={item}>{item}</span>)}
                {canUseAudio && <span>音频</span>}
                {canUseVideo && <span>视频输入</span>}
                {canUseImages && <span>{selectedModel.imageMin || 0}-{imageLimit} 图</span>}
              </div>
            </div>
          </section>

          <label className="field prompt-field">
            <span>视频描述</span>
            <textarea
              ref={promptRef}
              value={prompt}
              maxLength={5000}
              onChange={handlePromptChange}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setMention(null);
              }}
              placeholder={selectedModel.promptOptional ? '可选：补充动作、镜头或编辑要求' : '描述主体、动作、场景、镜头和声音'}
            />
            <small>{prompt.length}/5000</small>
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
                    <small>{assetRole(selectedModel, reference, index)}</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          {canUseImages && (
            <section className="asset-field">
              <div className="field-label">
                <span>参考图</span>
                <strong>{activeImages.length}/{imageLimit}</strong>
              </div>
              <div className="reference-grid">
                {activeImages.map((reference, index) => (
                  <div className="reference-item" key={`${reference.source.slice(-20)}-${index}`}>
                    <img src={reference.source} alt={`参考图 ${index + 1}`} />
                    <span>@参考图 {index + 1}</span>
                    {(selectedModel.protocol === 'r2v' || selectedModel.protocol === 'r2vLegacy' || selectedModel.protocol === 'videoEdit' || selectedModel.protocol === 'agnes') ? (
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
                    ) : <em>{assetRole(selectedModel, reference, index)}</em>}
                    <button type="button" onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`删除参考图 ${index + 1}`}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                {activeImages.length < imageLimit && (
                  <label className="upload-tile" aria-label="添加参考图">
                    {uploadingCount > 0 ? <Loader2 className="spin" size={22} /> : <ImagePlus size={22} />}
                    <span>{uploadingCount > 0 ? `上传 ${uploadingCount}` : '添加'}</span>
                    <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={addImages} disabled={uploadingCount > 0} />
                  </label>
                )}
              </div>
              {needsImage && activeImages.length < (selectedModel.imageMin || 0) && (
                <p className="field-note">需要 {selectedModel.imageMin} 张图片</p>
              )}
            </section>
          )}

          {canUseVideo && (
            <label className="field">
              <span>{selectedModel.requiresVideo ? '输入视频 URL' : '参考 / 续写视频 URL（可选）'}</span>
              <div className="input-with-icon"><Video size={16} /><input type="url" value={videoInputUrl} onChange={(event) => setVideoInputUrl(event.target.value)} placeholder="https://example.com/source.mp4" /></div>
            </label>
          )}

          {canUseAudio && (
            <label className="field">
              <span>{selectedModel.supportsVoiceReference ? '音色参考 URL（可选）' : '音频 URL（可选）'}</span>
              <div className="input-with-icon"><Layers3 size={16} /><input type="url" value={audioUrl} onChange={(event) => setAudioUrl(event.target.value)} placeholder="https://example.com/audio.mp3" /></div>
            </label>
          )}

          {(selectedModel.protocol === 'animateMove' || selectedModel.protocol === 'animateMix') && (
            <label className="field">
              <span>生成模式</span>
              <select value={animationMode} onChange={(event) => setAnimationMode(event.target.value)}>
                <option value="wan-std">标准模式</option>
                <option value="wan-pro">专业模式</option>
              </select>
            </label>
          )}

          <div className="settings-grid">
            {selectedModel.ratios && (
              <label className="field">
                <span>比例</span>
                <select value={ratio} onChange={(event) => setRatio(event.target.value)}>
                  {availableRatios.map((item) => <option key={item}>{item}</option>)}
                </select>
              </label>
            )}
            <label className="field">
              <span>时长</span>
              <select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
                {selectedModel.durations.map((item) => <option key={item} value={item}>{item} 秒</option>)}
              </select>
            </label>
            <label className="field">
              <span>清晰度</span>
              <select value={resolution} onChange={(event) => setResolution(event.target.value)}>
                {selectedModel.resolutions.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label className="field">
              <span>风格</span>
              <select value={style} onChange={(event) => setStyle(event.target.value)}>
                {STYLES.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
          </div>

          <label className="toggle-field">
            <input type="checkbox" checked={watermark} onChange={(event) => setWatermark(event.target.checked)} />
            <span>添加 AI 生成水印</span>
          </label>

          <details className="advanced-settings">
            <summary>高级设置</summary>
            <label className="field">
              <span>负面提示词</span>
              <textarea value={negativePrompt} maxLength={500} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="不希望出现的内容" />
            </label>
            <label className="field">
              <span>随机种子（可选）</span>
              <input type="number" min="0" max="2147483647" step="1" value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="0 - 2147483647" />
            </label>
            <label className="toggle-field">
              <input type="checkbox" checked={promptExtend} onChange={(event) => setPromptExtend(event.target.checked)} />
              <span>启用提示词扩写</span>
            </label>
          </details>

          {error && <p className="error-message" role="alert"><AlertTriangle size={15} />{error}</p>}

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
            <div className="preview-model-state">
              {availabilityLoading ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
              <span>{selectedModel.label}</span>
            </div>
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
                <div className="frame-crosshair" aria-hidden="true" />
                <div className="subject-block">
                  <span>{selectedModel.family} / {resolution} / {duration}s</span>
                  <strong>{isGenerating ? `${selectedModel.label} 正在生成` : (prompt.trim() || selectedModel.summary)}</strong>
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
