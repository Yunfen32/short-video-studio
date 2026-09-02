import React, { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArrowRight,
  Bot,
  Check,
  Clapperboard,
  FileText,
  FolderKanban,
  Home,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  RefreshCw,
  Sparkles,
  Video,
  Wand2,
} from 'lucide-react';
import { projectProgress } from './creative-library.mjs';

const SOURCES = [
  { id: 'inspiration', label: '灵感' },
  { id: 'script', label: '剧本' },
];

const STYLES = ['2D 动漫', '电影感', '写实质感', '产品展示'];
const RATIOS = ['9:16', '16:9', '1:1', '4:3', '3:4'];
const PROJECT_DURATION_MIN = 1;
const PROJECT_DURATION_MAX = 300;

const PROMPT_EXAMPLES = [
  {
    label: '竖屏短片',
    prompt: '制作一段 15 秒竖屏咖啡新品短片，暖色晨光，镜头从杯沿推进。',
    target: 'video',
    style: '产品展示',
    ratio: '9:16',
    duration: 15,
  },
  {
    label: '商品短片',
    prompt: '制作一段黑色背景的高对比商品广告短片，镜头环绕产品并突出材质细节。',
    target: 'video',
    style: '产品展示',
    ratio: '9:16',
    duration: 10,
  },
  {
    label: '连续短片',
    prompt: '根据这段剧情建立 30 秒短片项目，并拆分为连续镜头。',
    target: 'video',
    source: 'script',
    style: '电影感',
    ratio: '16:9',
    duration: 30,
  },
];

const CREATION_ENTRANCES = [
  { id: 'agent', title: '让 Agent 规划', description: '从灵感或剧本建立项目，审核后执行真实生成。', icon: Bot },
  { id: 'video', title: '精细生成视频', description: '选择工作流、兼容模型与参考素材。', icon: Video },
  { id: 'image', title: '生成或编辑图片', description: '使用文生图或参考图编辑完成画面创作。', icon: ImagePlus },
  { id: 'assets', title: '管理创作资产', description: '查看项目、版本、提示词与素材关系。', icon: Archive },
];

const WORKFLOWS = [
  { title: '视频创作', items: ['文字创作', '图片驱动', '参考一致性', '视频再创作'], icon: Clapperboard },
  { title: '图片创作', items: ['文生图', '参考图编辑'], icon: ImageIcon },
  { title: '创作 Agent', items: ['视频项目规划', '中间图像资产', '视频镜头执行', '资产回写'], icon: Wand2 },
  { title: '创作资产', items: ['项目归档', '版本管理', '来源参数', '创作关系'], icon: FolderKanban },
];

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未记录';
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function projectStatusLabel(status) {
  return { planned: '待执行', in_progress: '进行中', complete: '已完成' }[status] || '待执行';
}

function assetTypeLabel(type) {
  return { image: '图片', video: '视频', audio: '音频', document: '文档' }[type] || '资产';
}

function pathStartLabel(source) {
  const input = source === 'script' ? '剧本' : '创作描述';
  return `${input} -> 视频项目计划`;
}

export default function HomeStudio({
  projects = [],
  assets = [],
  onOpenAgent,
  onOpenVideo,
  onOpenImage,
  onOpenAssets,
}) {
  const [source, setSource] = useState('inspiration');
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState('2D 动漫');
  const [ratio, setRatio] = useState('9:16');
  const [duration, setDuration] = useState(5);
  const [availability, setAvailability] = useState({ loading: true, video: 0, image: 0, unavailable: 0, error: '' });

  const recentProjects = useMemo(
    () => [...projects].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 4),
    [projects],
  );
  const recentAssets = useMemo(
    () => [...assets].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 6),
    [assets],
  );
  const canStart = Boolean(prompt.trim());
  const routeSteps = [pathStartLabel(source), '审核计划', '中间资产与视频任务', '视频成片归档'];

  async function refreshAvailability() {
    setAvailability((current) => ({ ...current, loading: true, error: '' }));
    try {
      const response = await fetch('/api/models');
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '模型状态暂时无法读取');
      setAvailability({
        loading: false,
        video: Array.isArray(data.videoModels) ? data.videoModels.length : 0,
        image: Array.isArray(data.imageModels) ? data.imageModels.length : 0,
        unavailable: Array.isArray(data.unavailable) ? data.unavailable.length : 0,
        error: '',
      });
    } catch (error) {
      setAvailability((current) => ({ ...current, loading: false, error: error.message || '模型状态暂时无法读取' }));
    }
  }

  useEffect(() => {
    refreshAvailability();
  }, []);

  function startAgent(overrides = {}) {
    const nextPrompt = (overrides.prompt ?? prompt).trim();
    if (!nextPrompt) return;
    onOpenAgent({
      prompt: nextPrompt,
      source: overrides.source || source,
      target: 'video',
      style: overrides.style || style,
      ratio: overrides.ratio || ratio,
      duration: overrides.duration || duration,
      detail: '已从创作首页带入描述与视觉设定，等待审核生成计划。',
    });
  }

  function applyExample(example) {
    setPrompt(example.prompt);
    setSource(example.source || 'inspiration');
    setStyle(example.style);
    if (example.ratio) setRatio(example.ratio);
    if (example.duration) setDuration(example.duration);
  }

  return (
    <main className="app-shell home-app-shell">
      <header className="topbar home-topbar">
        <div className="brand-block"><p>SHORT VIDEO STUDIO</p><h1>创作首页</h1></div>
        <div className="topbar-controls">
          <nav className="studio-switch home-switch" aria-label="创作类型">
            <button type="button" className="active" aria-current="page"><Home size={16} /><span>首页</span></button>
            <button type="button" onClick={() => onOpenAgent()}><Bot size={16} /><span>Agent</span></button>
            <button type="button" onClick={onOpenVideo}><Video size={16} /><span>视频</span></button>
            <button type="button" onClick={onOpenImage}><ImageIcon size={16} /><span>图片</span></button>
            <button type="button" onClick={onOpenAssets}><Archive size={16} /><span>资产</span></button>
          </nav>
          <button type="button" className="topbar-icon-action" onClick={refreshAvailability} disabled={availability.loading} aria-label="刷新模型状态" title="刷新模型状态"><RefreshCw className={availability.loading ? 'spin' : ''} size={16} /></button>
          <div className="service-metrics home-service-metrics" aria-label="当前状态">
            <div><span>可用模型</span><strong>{availability.loading ? '--' : availability.video + availability.image}</strong></div>
            <div><span>额度暂停</span><strong>{availability.loading ? '--' : availability.unavailable}</strong></div>
            <div className="status-strip"><span>本地项目</span><strong>{projects.length}</strong></div>
          </div>
        </div>
      </header>

      <section className="home-command-area" aria-labelledby="home-title">
        <div className="home-intro">
          <p>AI 媒体创作工作台</p>
          <h2 id="home-title">今天，想创作什么？</h2>
          <span>输入一个想法，Agent 会规划视频项目；需要更多控制时，再进入专业工作台。</span>
        </div>

        <section className="creation-command" aria-label="创建创作计划">
          <div className="command-toolbar">
            <div className="compact-tabs" role="tablist" aria-label="创作来源">
              {SOURCES.map((item) => <button type="button" key={item.id} className={source === item.id ? 'active' : ''} onClick={() => setSource(item.id)} role="tab" aria-selected={source === item.id}>{item.id === 'script' ? <FileText size={14} /> : <Sparkles size={14} />}{item.label}</button>)}
            </div>
          </div>
          <label className="home-prompt-field">
            <span>{source === 'script' ? '剧本或分镜' : '描述你想创作的内容'}</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={source === 'script' ? '粘贴剧情、镜头或分镜；Agent 会从当前镜头开始制定计划。' : '例如：制作一段 15 秒竖屏短片，描述主体、场景、动作与镜头。'} maxLength={5000} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); startAgent(); } }} />
            <small>{prompt.length}/5000</small>
          </label>
          <div className="command-settings">
            <label><span>视觉风格</span><select value={style} onChange={(event) => setStyle(event.target.value)}>{STYLES.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
            <label><span>视频比例</span><select value={ratio} onChange={(event) => setRatio(event.target.value)}>{RATIOS.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
            <label><span>项目时长</span><input type="number" min={PROJECT_DURATION_MIN} max={PROJECT_DURATION_MAX} step="1" value={duration} onChange={(event) => setDuration(event.target.value === '' ? '' : Math.min(PROJECT_DURATION_MAX, Math.max(PROJECT_DURATION_MIN, Number(event.target.value))))} onBlur={() => setDuration((current) => Number.isFinite(Number(current)) ? Math.min(PROJECT_DURATION_MAX, Math.max(PROJECT_DURATION_MIN, Math.round(Number(current)))) : 5)} inputMode="numeric" aria-label={`项目时长，${PROJECT_DURATION_MIN} 到 ${PROJECT_DURATION_MAX} 秒`} title={`输入 ${PROJECT_DURATION_MIN}-${PROJECT_DURATION_MAX} 秒；超过单段上限会自动拆分并拼接。`} /></label>
            <div className="command-actions"><button type="button" className="primary-action" onClick={() => startAgent()} disabled={!canStart}><Wand2 size={17} />制定创作计划</button><div><button type="button" className="text-action" onClick={onOpenVideo}>视频工作台</button><button type="button" className="text-action" onClick={onOpenImage}>图片工作台</button></div></div>
          </div>
          <p className={'command-note ' + (canStart ? 'ready' : '')}>{canStart ? '将进入视频 Agent 审核计划；中间图片资产只用于生成视频，确认后才会提交真实任务。' : '请先描述想创作的视频内容。'}</p>
        </section>

        <div className="inspiration-list" aria-label="创作示例"><span>示例</span>{PROMPT_EXAMPLES.map((example) => <button type="button" key={example.label} onClick={() => applyExample(example)}>{example.label}<ArrowRight size={13} /></button>)}</div>

        <ol className="creation-route" aria-label="创作路径预览">
          {routeSteps.map((step, index) => <li key={step} className={index === 0 ? 'active' : ''}><span>{index === 0 ? <Sparkles size={14} /> : index === routeSteps.length - 1 ? <Archive size={14} /> : String(index + 1).padStart(2, '0')}</span><strong>{step}</strong>{index < routeSteps.length - 1 && <ArrowRight size={15} />}</li>)}
        </ol>
        {availability.error && <p className="home-model-error">{availability.error}</p>}
      </section>

      <section className="home-section creation-entrances" aria-labelledby="entrances-title">
        <div className="home-section-heading"><div><span>创作入口</span><h2 id="entrances-title">选择你的工作方式</h2></div></div>
        <div className="creation-entrance-grid">
          {CREATION_ENTRANCES.map((entry) => {
            const Icon = entry.icon;
            const action = entry.id === 'agent' ? () => onOpenAgent() : entry.id === 'video' ? onOpenVideo : entry.id === 'image' ? onOpenImage : onOpenAssets;
            return <button type="button" className={'creation-entrance ' + entry.id} key={entry.id} onClick={action}><span className="creation-entrance-visual"><Icon size={25} /></span><span><strong>{entry.title}</strong><small>{entry.description}</small></span><ArrowRight size={17} /></button>;
          })}
        </div>
      </section>

      <section className="home-section home-two-column" aria-label="继续创作与最近资产">
        <section className="home-panel active-projects" aria-labelledby="projects-title">
          <div className="home-section-heading"><div><span>继续创作</span><h2 id="projects-title">你的项目</h2></div><button type="button" className="text-action" onClick={() => onOpenAgent()}>打开 Agent</button></div>
          {recentProjects.length ? <div className="project-resume-list">{recentProjects.map((project) => {
            const progress = projectProgress(project, assets);
            return <article className="project-resume-item" key={project.id}>
              <div><span>{projectStatusLabel(project.status)} · {formatDate(project.updatedAt)}</span><strong>{project.title}</strong><small>{project.style || '未设置风格'} · {project.ratio || '未设置比例'} · {project.duration} 秒</small></div>
              <div className="project-resume-progress"><span>{progress.complete}/{progress.total || project.shotIds.length} 镜头</span><i><b style={{ width: `${progress.total ? Math.round((progress.complete / progress.total) * 100) : 0}%` }} /></i></div>
              <div className="project-resume-actions"><button type="button" className="secondary-action" onClick={() => onOpenAgent({ prompt: project.brief, source: 'script', target: 'video', style: project.style || '2D 动漫', ratio: project.ratio || '9:16', duration: project.duration, projectId: project.id, detail: '已从创作首页恢复视频项目，可继续审核当前镜头。' })}>继续项目</button><button type="button" className="text-action" onClick={onOpenAssets}>查看资产</button></div>
            </article>;
          })}</div> : <div className="home-empty-state"><FolderKanban size={28} /><strong>还没有创作项目</strong><span>从一句想法开始，Agent 会为你建立创作资料与镜头。</span><button type="button" className="secondary-action" onClick={() => document.querySelector('.home-prompt-field textarea')?.focus()}>从一句想法开始</button></div>}
        </section>

        <section className="home-panel recent-assets" aria-labelledby="assets-title">
          <div className="home-section-heading"><div><span>最近资产</span><h2 id="assets-title">已沉淀的内容</h2></div><button type="button" className="text-action" onClick={onOpenAssets}>打开资产库</button></div>
          {recentAssets.length ? <div className="home-asset-grid">{recentAssets.map((asset) => <article className={'home-asset-card ' + asset.type} key={asset.id}>
            <div className="home-asset-preview">{asset.type === 'image' && asset.previewUrl ? <img src={asset.previewUrl} alt={asset.title} /> : asset.type === 'video' && asset.previewUrl ? <video src={asset.previewUrl} muted preload="metadata" /> : asset.type === 'document' ? <FileText size={28} /> : <Archive size={28} />}</div>
            <div><span>{assetTypeLabel(asset.type)} · V{asset.version}</span><strong>{asset.title}</strong><small>{formatDate(asset.updatedAt)}</small></div>
          </article>)}</div> : <div className="home-empty-state"><Archive size={28} /><strong>还没有可展示的资产</strong><span>图片、视频与 Agent 的真实结果会自动沉淀到资产库。</span><button type="button" className="secondary-action" onClick={onOpenAssets}>打开资产库</button></div>}
        </section>
      </section>

      <section className="home-section workflow-overview" aria-labelledby="workflow-title">
        <div className="home-section-heading"><div><span>专业工作流</span><h2 id="workflow-title">一个工作台，保留需要的控制权</h2></div></div>
        <div className="workflow-overview-grid">{WORKFLOWS.map((workflow) => { const Icon = workflow.icon; return <article key={workflow.title}><Icon size={19} /><strong>{workflow.title}</strong><ul>{workflow.items.map((item) => <li key={item}><Check size={13} />{item}</li>)}</ul></article>; })}</div>
      </section>
    </main>
  );
}
