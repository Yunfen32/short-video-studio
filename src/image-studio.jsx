import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Download,
  ExternalLink,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  Video,
} from 'lucide-react';
import {
  getImageWorkflow,
  IMAGE_MODELS,
  IMAGE_WORKFLOWS,
  supportsImageWorkflow,
} from '../shared/image-models.mjs';

const POLL_INTERVAL = Number(import.meta.env.VITE_POLL_INTERVAL) || 5000;

function authorizedHeaders(headers = {}) {
  return headers;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: authorizedHeaders(options.headers) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || '请求失败，请稍后重试');
    Object.assign(error, data);
    throw error;
  }
  return data;
}

async function uploadImage(file) {
  const response = await fetch('/api/reference-images', {
    method: 'POST',
    headers: authorizedHeaders({ 'Content-Type': file.type }),
    body: file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.url) throw new Error(data.error || '图片上传失败');
  return data.url;
}

function statusLabel(status) {
  return { IDLE: '待生成', PENDING: '排队中', RUNNING: '生成中', SUCCEEDED: '已完成', FAILED: '生成失败' }[status] || status;
}

export default function ImageStudio({ onOpenVideo }) {
  const [workflowId, setWorkflowId] = useState('text-to-image');
  const [modelId, setModelId] = useState('wan2.7-image-pro');
  const [prompt, setPrompt] = useState('');
  const [quality, setQuality] = useState('2K');
  const [count, setCount] = useState(1);
  const [watermark, setWatermark] = useState(false);
  const [images, setImages] = useState([]);
  const [uploading, setUploading] = useState(0);
  const [task, setTask] = useState({ status: 'IDLE', taskId: '', imageUrls: [], size: '', error: '', modelLabel: '' });
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState([]);
  const pollToken = useRef(0);
  const timerRef = useRef(0);
  const uploadToken = useRef(0);

  const unavailableIds = useMemo(() => new Set(unavailable.map((item) => item.modelId)), [unavailable]);
  const availableModels = useMemo(() => IMAGE_MODELS.filter((model) => !unavailableIds.has(model.id)), [unavailableIds]);
  const workflow = getImageWorkflow(workflowId);
  const compatibleModels = availableModels.filter((model) => supportsImageWorkflow(model, workflowId));
  const selectedModel = compatibleModels.find((model) => model.id === modelId) || compatibleModels.find((model) => model.featured) || compatibleModels[0] || null;
  const canGenerate = Boolean(
    selectedModel
    && prompt.trim()
    && !uploading
    && !(workflowId === 'image-edit' && !images.length)
    && !['PENDING', 'RUNNING'].includes(task.status),
  );

  useEffect(() => {
    requestJson('/api/models').then((data) => {
      setUnavailable(data.unavailable || []);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!compatibleModels.length || compatibleModels.some((model) => model.id === modelId)) return;
    setModelId(compatibleModels[0].id);
  }, [modelId, compatibleModels]);

  useEffect(() => {
    if (!selectedModel || selectedModel.qualities.includes(quality)) return;
    setQuality(selectedModel.qualities[0]);
  }, [quality, selectedModel]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  function selectWorkflow(nextWorkflow) {
    if (nextWorkflow === workflowId) return;
    setWorkflowId(nextWorkflow);
    setError('');
    setTask((current) => ({ ...current, error: '' }));
  }

  async function addImages(files) {
    if (!files.length) return;
    const remaining = Math.max(0, 9 - images.length);
    const selected = files.slice(0, remaining);
    if (!selected.length) {
      setError('最多可添加 9 张参考图');
      return;
    }
    setUploading(selected.length);
    setError('');
    const token = uploadToken.current + 1;
    uploadToken.current = token;
    try {
      const uploads = await Promise.all(selected.map(async (file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        source: await uploadImage(file),
      })));
      if (uploadToken.current !== token) return;
      setImages((current) => [...current, ...uploads].slice(0, 9));
      if (files.length > selected.length) setError('最多可添加 9 张参考图');
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      if (uploadToken.current === token) setUploading(0);
    }
  }

  async function pollImage(taskId, token) {
    if (pollToken.current !== token) return;
    try {
      const data = await requestJson('/api/images/' + encodeURIComponent(taskId));
      if (pollToken.current !== token) return;
      const status = data.status || 'RUNNING';
      if (status === 'SUCCEEDED' && data.imageUrls?.length) {
        setTask((current) => ({ ...current, status, imageUrls: data.imageUrls, size: data.size || '', error: '' }));
        return;
      }
      if (data.terminal || status === 'FAILED') {
        setTask((current) => ({ ...current, status: 'FAILED', error: data.error || '图片任务未能完成' }));
        return;
      }
      setTask((current) => ({ ...current, status, size: data.size || current.size }));
      timerRef.current = window.setTimeout(() => pollImage(taskId, token), POLL_INTERVAL);
    } catch (pollError) {
      if (pollToken.current === token) setTask((current) => ({ ...current, status: 'FAILED', error: pollError.message }));
    }
  }

  async function generateImage() {
    if (!canGenerate || !selectedModel) return;
    const token = pollToken.current + 1;
    pollToken.current = token;
    window.clearTimeout(timerRef.current);
    setError('');
    setTask({ status: 'PENDING', taskId: '', imageUrls: [], size: quality, error: '', modelLabel: selectedModel.label });
    try {
      const data = await requestJson('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflow: workflowId,
          model: selectedModel.id,
          prompt: prompt.trim(),
          images: workflowId === 'image-edit' ? images.map((image) => image.source) : [],
          quality,
          count,
          watermark,
        }),
      });
      if (pollToken.current !== token) return;
      setTask((current) => ({ ...current, taskId: data.taskId, status: data.status || 'PENDING' }));
      pollImage(data.taskId, token);
    } catch (requestError) {
      if (pollToken.current !== token) return;
      setTask((current) => ({ ...current, status: 'FAILED', error: requestError.message }));
      if (requestError.unavailable) setUnavailable((current) => [...current, ...requestError.unavailable]);
    }
  }

  function resetImage() {
    pollToken.current += 1;
    uploadToken.current += 1;
    window.clearTimeout(timerRef.current);
    setPrompt('');
    setImages([]);
    setError('');
    setUploading(0);
    setTask({ status: 'IDLE', taskId: '', imageUrls: [], size: '', error: '', modelLabel: '' });
  }

  async function downloadImage(url, index) {
    try {
      const response = await fetch('/api/image-download?url=' + encodeURIComponent(url), {
        headers: authorizedHeaders({}),
      });
      if (!response.ok) throw new Error('图片下载失败');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `generated-image-${index + 1}.png`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    } catch (downloadError) {
      setError(downloadError.message);
    }
  }

  const requirement = !prompt.trim()
    ? '请填写图片描述'
    : uploading
      ? '参考图正在上传'
      : workflowId === 'image-edit' && !images.length
        ? '请上传至少 1 张参考图'
        : '输入完整，可以生成';
  const taskError = error || task.error;

  return (
    <main className="app-shell image-app-shell">
      <header className="topbar">
        <div className="brand-block">
          <p>阿里云百炼 · 万相 2.7</p>
          <h1>图片生成工作台</h1>
        </div>
        <div className="topbar-controls">
          <div className="studio-switch" role="tablist" aria-label="创作类型">
            <button type="button" onClick={onOpenVideo} role="tab" aria-selected="false"><Video size={16} /><span>视频</span></button>
            <button type="button" className="active" role="tab" aria-selected="true"><ImageIcon size={16} /><span>图片</span></button>
          </div>
          <div className="service-metrics" aria-label="图片服务状态">
            <div><span>可用模型</span><strong>{availableModels.length}</strong></div>
            <div><span>参考图</span><strong>{images.length}/9</strong></div>
            <div className={'status-strip ' + (task.status === 'FAILED' ? 'error' : '')}><span>{statusLabel(task.status)}</span><strong>{task.imageUrls.length}</strong></div>
          </div>
        </div>
      </header>

      <section className="workspace">
        <section className="control-panel">
          <section className="task-console" aria-labelledby="image-task-title">
            <div className="section-heading"><div><h2 id="image-task-title">选择生成方式</h2><p>图片生成与参考图编辑</p></div></div>
            <div className="task-tabs image-task-tabs" role="tablist">
              {IMAGE_WORKFLOWS.map((item) => (
                <button type="button" key={item.id} className={workflowId === item.id ? 'active' : ''} onClick={() => selectWorkflow(item.id)} role="tab" aria-selected={workflowId === item.id}>
                  <strong>{item.label}</strong><span>{item.summary}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="model-console" aria-labelledby="image-model-title">
            <div className="section-heading"><div><h2 id="image-model-title">选择模型</h2><p>{workflow?.label}</p></div></div>
            <div className="image-model-list" role="listbox" aria-label="图片模型">
              {compatibleModels.map((model) => (
                <button type="button" key={model.id} className={selectedModel?.id === model.id ? 'active' : ''} onClick={() => setModelId(model.id)} role="option" aria-selected={selectedModel?.id === model.id}>
                  <span><strong>{model.label}</strong><small>{model.summary}</small></span>
                  <em>{model.variantLabel}</em>
                </button>
              ))}
            </div>
          </section>

          <section className="input-console" aria-labelledby="image-input-title">
            <div className="section-heading"><div><h2 id="image-input-title">描述与参考</h2><p>{workflow?.summary}</p></div></div>
            {workflowId === 'image-edit' && (
              <div className="reference-grid image-reference-grid">
                {images.map((image, index) => (
                  <article className="reference-item" key={image.id}>
                    <img src={image.source} alt={'参考图 ' + (index + 1)} />
                    <div><span>参考图 {index + 1}</span><small>{image.name}</small><button type="button" onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))} aria-label={'删除参考图 ' + (index + 1)}><Trash2 size={15} /></button></div>
                  </article>
                ))}
                {images.length < 9 && (
                  <label className="upload-tile">
                    <ImagePlus size={21} /><span>{uploading ? '上传中' : '添加参考图'}</span>
                    <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => addImages(Array.from(event.target.files || []))} />
                  </label>
                )}
              </div>
            )}
            <label className="prompt-field"><span>图片描述</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); generateImage(); } }} placeholder={workflowId === 'image-edit' ? '描述如何改造、组合或延展参考图' : '描述主体、场景、构图、光线和风格'} maxLength={5000} /></label>
          </section>

          <section className="settings-console" aria-label="图片生成设置">
            <div className="settings-grid">
              <label className="field"><span>清晰度</span><select value={quality} onChange={(event) => setQuality(event.target.value)}>{(selectedModel?.qualities || []).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
              <label className="field"><span>生成数量</span><select value={count} onChange={(event) => setCount(Number(event.target.value))}>{Array.from({ length: selectedModel?.maxOutputs || 1 }, (_, index) => index + 1).map((item) => <option key={item} value={item}>{item} 张</option>)}</select></label>
              <label className="toggle-field"><input type="checkbox" checked={watermark} onChange={(event) => setWatermark(event.target.checked)} /><span>添加 AI 生成水印</span></label>
            </div>
          </section>

          {taskError && <p className="error-message"><AlertTriangle size={16} />{taskError}</p>}
          <section className="action-row">
            <div className="primary-action-wrap"><button type="button" className="primary-action" onClick={generateImage} disabled={!canGenerate}><Sparkles size={17} />{['PENDING', 'RUNNING'].includes(task.status) ? '正在生成' : '生成图片'}</button><p className={'action-note ' + (canGenerate ? 'ready' : 'warning')}>{requirement}</p></div>
            <button type="button" className="icon-action" onClick={resetImage} aria-label="重置图片创作"><RefreshCw size={18} /></button>
          </section>
        </section>

        <section className="preview-panel image-preview-panel" aria-label="图片生成结果">
          <div className="preview-toolbar"><div className="panel-heading"><ImageIcon size={18} /><div><h2>生成结果</h2><span>{task.modelLabel || selectedModel?.label || '暂无可用模型'}</span></div></div><div className="preview-model-state"><Loader2 className={['PENDING', 'RUNNING'].includes(task.status) ? 'spin' : ''} size={15} /><span>{statusLabel(task.status)}</span></div></div>
          <div className={'image-result-stage ' + (task.imageUrls.length ? 'has-images' : '')}>
            {task.imageUrls.length ? task.imageUrls.map((url, index) => (
              <figure className="generated-image" key={url}><img src={url} alt={'生成图片 ' + (index + 1)} /><figcaption><span>图片 {index + 1}</span><div><a className="icon-action" href={url} target="_blank" rel="noreferrer" aria-label={'打开生成图片 ' + (index + 1)}><ExternalLink size={16} /></a><button type="button" className="icon-action" onClick={() => downloadImage(url, index)} aria-label={'下载生成图片 ' + (index + 1)}><Download size={16} /></button></div></figcaption></figure>
            )) : <div className="image-empty-state"><ImagePlus size={36} /><strong>{['PENDING', 'RUNNING'].includes(task.status) ? '图片正在生成' : (prompt.trim() || '生成的图片会显示在这里')}</strong><span>{task.taskId ? 'TASK ' + task.taskId : '万相 2.7 Image'}</span></div>}
          </div>
          <div className="result-readout"><div><span>生成方式</span><strong>{workflow?.label || '--'}</strong></div><div><span>清晰度</span><strong>{task.size || quality}</strong></div><div><span>任务编号</span><strong>{task.taskId || '--'}</strong></div><div><span>结果状态</span><strong>{statusLabel(task.status)}</strong></div></div>
        </section>
      </section>
    </main>
  );
}
