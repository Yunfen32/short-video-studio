import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
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
import { isFreeImageModel } from '../shared/free-models.mjs';

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

function taskStatusTone(status) {
  if (status === 'SUCCEEDED') return 'status-success';
  if (status === 'FAILED') return 'status-error';
  if (status === 'PENDING' || status === 'RUNNING') return 'status-active';
  return '';
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
  const [task, setTask] = useState({ status: 'IDLE', taskId: '', provider: '', imageUrls: [], size: '', error: '', modelLabel: '' });
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState([]);
  const [freeOnly, setFreeOnly] = useState(false);
  const pollToken = useRef(0);
  const timerRef = useRef(0);
  const uploadToken = useRef(0);

  const unavailableIds = useMemo(() => new Set(unavailable.map((item) => item.modelId)), [unavailable]);
  const availableModels = useMemo(
    () => IMAGE_MODELS.filter((model) => (!freeOnly || isFreeImageModel(model)) && !unavailableIds.has(model.id)),
    [freeOnly, unavailableIds],
  );
  const availableWorkflows = useMemo(
    () => IMAGE_WORKFLOWS.filter((item) => availableModels.some((model) => supportsImageWorkflow(model, item.id))),
    [availableModels],
  );
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
    if (!availableWorkflows.some((item) => item.id === workflowId) && availableWorkflows[0]) {
      setWorkflowId(availableWorkflows[0].id);
    }
  }, [availableWorkflows, workflowId]);

  useEffect(() => {
    requestJson('/api/models').then((data) => {
      setUnavailable(data.unavailable || []);
      setFreeOnly(data.freeOnly === true);
    }).catch(() => setError('模型状态暂时无法读取，请稍后重试'));
  }, []);

  useEffect(() => {
    if (!compatibleModels.length || compatibleModels.some((model) => model.id === modelId)) return;
    setModelId(compatibleModels[0].id);
  }, [modelId, compatibleModels]);

  useEffect(() => {
    if (!selectedModel || selectedModel.qualities.includes(quality)) return;
    setQuality(selectedModel.qualities[0]);
  }, [quality, selectedModel]);

  useEffect(() => {
    if (selectedModel && count > selectedModel.maxOutputs) setCount(selectedModel.maxOutputs);
  }, [count, selectedModel]);

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

  async function pollImage(taskId, token, provider = '') {
    if (pollToken.current !== token) return;
    try {
      const providerQuery = provider ? '?provider=' + encodeURIComponent(provider) : '';
      const data = await requestJson('/api/images/' + encodeURIComponent(taskId) + providerQuery);
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
      timerRef.current = window.setTimeout(() => pollImage(taskId, token, provider), POLL_INTERVAL);
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
    setTask({ status: 'PENDING', taskId: '', provider: '', imageUrls: [], size: quality, error: '', modelLabel: selectedModel.label });
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
      setTask((current) => ({
        ...current,
        taskId: data.taskId || '',
        provider: data.provider || '',
        status: data.status || 'PENDING',
        imageUrls: data.imageUrls || current.imageUrls,
      }));
      if (data.status === 'SUCCEEDED' && data.imageUrls?.length) return;
      if (!data.taskId) throw new Error('图片服务没有返回任务或图片地址');
      pollImage(data.taskId, token, data.provider);
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
    setTask({ status: 'IDLE', taskId: '', provider: '', imageUrls: [], size: '', error: '', modelLabel: '' });
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
          <p>免费图片模型</p>
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
            <div className="section-heading"><span>01</span><div><h2 id="image-task-title">选择生成方式</h2><p>图片生成与参考图编辑</p></div></div>
            <div className="task-tabs image-task-tabs" role="tablist">
              {availableWorkflows.map((item) => (
                <button type="button" key={item.id} className={workflowId === item.id ? 'active' : ''} onClick={() => selectWorkflow(item.id)} role="tab" aria-selected={workflowId === item.id}>
                  <strong>{item.label}</strong><span>{item.summary}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="model-console" aria-labelledby="image-model-title">
            <div className="section-heading"><span>02</span><div><h2 id="image-model-title">选择模型</h2><p>{workflow?.label}</p></div></div>
            <div className="image-model-list" role="listbox" aria-label="图片模型">
              {compatibleModels.map((model) => (
                <button type="button" key={model.id} className={selectedModel?.id === model.id ? 'active' : ''} onClick={() => setModelId(model.id)} role="option" aria-selected={selectedModel?.id === model.id}>
                  <span><strong>{model.label}</strong><small>{model.summary}</small></span>
                  <em>{model.providerLabel} · 免费 · {model.variantLabel}</em>
                </button>
              ))}
              {!compatibleModels.length && <p className="empty-model-state">当前没有可用的免费图片模型，请稍后刷新模型状态。</p>}
            </div>
          </section>

          <section className="input-console" aria-labelledby="image-input-title">
            <div className="section-heading"><span>03</span><div><h2 id="image-input-title">描述与参考</h2><p>{workflow?.summary}</p></div></div>
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
            <label className="field prompt-field image-prompt-field"><span>图片描述</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); generateImage(); } }} placeholder={workflowId === 'image-edit' ? '描述如何改造、组合或延展参考图' : '描述主体、场景、构图、光线和风格'} maxLength={5000} /><small>{prompt.length}/5000</small></label>
          </section>

          <section className="settings-console" aria-label="图片生成设置">
            <div className="section-heading"><span>04</span><div><h2>输出设置</h2><p>{selectedModel?.variantLabel || '当前免费模型'}</p></div></div>
            <div className="settings-grid">
              <label className="field"><span>清晰度</span><select value={quality} onChange={(event) => setQuality(event.target.value)}>{(selectedModel?.qualities || []).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
              <label className="field"><span>生成数量</span><select value={count} onChange={(event) => setCount(Number(event.target.value))}>{Array.from({ length: selectedModel?.maxOutputs || 1 }, (_, index) => index + 1).map((item) => <option key={item} value={item}>{item} 张</option>)}</select></label>
              <label className="toggle-field"><input type="checkbox" checked={watermark} onChange={(event) => setWatermark(event.target.checked)} /><span>添加 AI 生成水印</span></label>
            </div>
          </section>

          {taskError && <p className="error-message" role="alert"><AlertTriangle size={16} />{taskError}</p>}
          <section className="action-row">
            <div className="primary-action-wrap"><button type="button" className="primary-action" onClick={generateImage} disabled={!canGenerate} title={requirement || '提交图片生成任务'} aria-describedby="image-generation-requirement"><Sparkles size={17} />{['PENDING', 'RUNNING'].includes(task.status) ? '正在生成' : '生成图片'}</button><p id="image-generation-requirement" className={'action-note ' + (canGenerate ? 'ready' : 'warning')} aria-live="polite">{requirement}</p></div>
            <button type="button" className="icon-action" onClick={resetImage} aria-label="重置图片创作" title="重置当前任务"><RefreshCw size={18} /></button>
          </section>
        </section>

        <section className="preview-panel image-preview-panel" aria-label="图片生成结果">
          <div className="preview-toolbar"><div className="panel-heading"><ImageIcon size={18} /><div><h2>生成结果</h2><span>{task.modelLabel || selectedModel?.label || '暂无可用模型'}</span></div></div><div className={'preview-model-state ' + taskStatusTone(task.status)} aria-live="polite">{['PENDING', 'RUNNING'].includes(task.status) ? <Loader2 className="spin" size={15} /> : task.status === 'FAILED' ? <AlertTriangle size={15} /> : <Check size={15} />}<span>{statusLabel(task.status)}</span></div></div>
          <div className={'image-result-stage ' + (task.imageUrls.length ? 'has-images' : '')}>
            {task.imageUrls.length ? task.imageUrls.map((url, index) => (
              <figure className="generated-image" key={url}><img src={url} alt={'生成图片 ' + (index + 1)} /><figcaption><span>图片 {index + 1}</span><div><a className="icon-action" href={url} target="_blank" rel="noreferrer" aria-label={'打开生成图片 ' + (index + 1)} title="在新窗口打开图片"><ExternalLink size={16} /></a><button type="button" className="icon-action" onClick={() => downloadImage(url, index)} aria-label={'下载生成图片 ' + (index + 1)} title="下载图片"><Download size={16} /></button></div></figcaption></figure>
            )) : <div className="image-empty-state"><ImagePlus size={36} /><span className="result-eyebrow">{['PENDING', 'RUNNING'].includes(task.status) ? '任务进行中' : task.status === 'FAILED' ? '生成未完成' : '等待输入'}</span><strong>{['PENDING', 'RUNNING'].includes(task.status) ? '图片正在生成' : (prompt.trim() || '生成的图片会显示在这里')}</strong><span>{task.taskId ? 'TASK ' + task.taskId : (selectedModel?.label || '免费图片模型')}</span></div>}
          </div>
          <div className="result-readout"><div><span>生成方式</span><strong>{workflow?.label || '--'}</strong></div><div><span>清晰度</span><strong>{task.size || quality}</strong></div><div><span>任务编号</span><strong>{task.taskId || '--'}</strong></div><div><span>结果状态</span><strong>{statusLabel(task.status)}</strong></div></div>
        </section>
      </section>
    </main>
  );
}
