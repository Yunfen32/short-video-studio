import React, { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Check,
  Clapperboard,
  ExternalLink,
  FileText,
  FolderKanban,
  Image as ImageIcon,
  Home,
  Link2,
  Music2,
  Pencil,
  Search,
  Sparkles,
  Tag,
  Trash2,
  Video,
} from 'lucide-react';
import { projectProgress } from './creative-library.mjs';

const TYPE_FILTERS = [
  { id: 'all', label: '全部', icon: Archive },
  { id: 'image', label: '图片', icon: ImageIcon },
  { id: 'video', label: '视频', icon: Video },
  { id: 'audio', label: '音频', icon: Music2 },
  { id: 'document', label: '文档', icon: FileText },
];

const CATEGORY_LABELS = {
  idea: '灵感',
  story: '故事',
  storyboard: '分镜脚本',
  character: '角色',
  scene: '场景',
  prompt: '提示词',
  reference: '参考图',
  shot: '镜头',
  material: '素材',
  final: '成片',
};

function typeLabel(type) {
  return { image: '图片', video: '视频', audio: '音频', document: '文档' }[type] || '资产';
}

function typeIcon(type, size = 18) {
  const Icon = { image: ImageIcon, video: Video, audio: Music2, document: FileText }[type] || Archive;
  return <Icon size={size} />;
}

function dateLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function assetDescription(asset) {
  if (asset.source?.model) return asset.source.model;
  if (asset.content) return asset.content.replace(/\s+/g, ' ').slice(0, 60);
  return '尚未写入内容';
}

export default function AssetsStudio({
  library,
  onOpenHome,
  onOpenVideo,
  onOpenImage,
  onOpenAgent,
  onUpdateAsset,
  onDeleteAsset,
  onSetRelations,
  onAssignProject,
  onSetCurrentVersion,
}) {
  const [projectId, setProjectId] = useState('all');
  const [type, setType] = useState('all');
  const [query, setQuery] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftTags, setDraftTags] = useState('');

  const assets = library?.assets || [];
  const projects = library?.projects || [];
  const filteredAssets = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return assets.filter((asset) => {
      if (projectId !== 'all' && asset.projectId !== projectId) return false;
      if (type !== 'all' && asset.type !== type) return false;
      if (!normalizedQuery) return true;
      return [asset.title, asset.content, asset.tags.join(' '), asset.source?.prompt, asset.source?.model]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [assets, projectId, query, type]);
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId) || filteredAssets[0] || null;
  const selectedProject = projects.find((project) => project.id === projectId) || null;
  const relatedAssets = selectedAsset
    ? selectedAsset.relatedAssetIds.map((id) => assets.find((asset) => asset.id === id)).filter(Boolean)
    : [];
  const projectAssets = useMemo(
    () => selectedProject ? assets.filter((asset) => asset.projectId === selectedProject.id) : [],
    [assets, selectedProject],
  );
  const projectDocuments = useMemo(
    () => projectAssets.filter((asset) => asset.type === 'document' && asset.category !== 'shot'),
    [projectAssets],
  );
  const projectShots = useMemo(
    () => selectedProject ? selectedProject.shotIds.map((id) => assets.find((asset) => asset.id === id)).filter(Boolean) : [],
    [assets, selectedProject],
  );
  const versionPeers = useMemo(
    () => selectedAsset
      ? assets.filter((asset) => (asset.versionGroupId || `asset:${asset.id}`) === (selectedAsset.versionGroupId || `asset:${selectedAsset.id}`)).sort((a, b) => a.version - b.version)
      : [],
    [assets, selectedAsset],
  );

  useEffect(() => {
    if (!selectedAsset) {
      setSelectedAssetId('');
      setDraftTitle('');
      setDraftContent('');
      setDraftTags('');
      return;
    }
    setSelectedAssetId(selectedAsset.id);
    setDraftTitle(selectedAsset.title);
    setDraftContent(selectedAsset.content || '');
    setDraftTags(selectedAsset.tags.join(', '));
  }, [selectedAsset?.id]);

  function saveAsset() {
    if (!selectedAsset) return;
    onUpdateAsset(selectedAsset.id, {
      title: draftTitle,
      content: draftContent,
      tags: draftTags.split(',').map((tag) => tag.trim()).filter(Boolean),
    });
  }

  function toggleRelation(assetId) {
    if (!selectedAsset) return;
    const next = selectedAsset.relatedAssetIds.includes(assetId)
      ? selectedAsset.relatedAssetIds.filter((id) => id !== assetId)
      : [...selectedAsset.relatedAssetIds, assetId];
    onSetRelations(selectedAsset.id, next);
  }

  return (
    <main className="app-shell assets-app-shell">
      <header className="topbar">
        <div className="brand-block"><p>SHORT VIDEO STUDIO</p><h1>创作资产</h1></div>
        <div className="topbar-controls">
          <div className="studio-switch" role="tablist" aria-label="创作类型">
            <button type="button" onClick={onOpenHome} role="tab" aria-selected="false"><Home size={16} /><span>首页</span></button>
            <button type="button" onClick={onOpenAgent} role="tab" aria-selected="false"><Sparkles size={16} /><span>Agent</span></button>
            <button type="button" onClick={onOpenVideo} role="tab" aria-selected="false"><Video size={16} /><span>视频</span></button>
            <button type="button" onClick={onOpenImage} role="tab" aria-selected="false"><ImageIcon size={16} /><span>图片</span></button>
            <button type="button" className="active" role="tab" aria-selected="true"><Archive size={16} /><span>资产</span></button>
          </div>
          <div className="service-metrics" aria-label="资产库状态">
            <div><span>项目</span><strong>{projects.length}</strong></div>
            <div><span>资产</span><strong>{assets.length}</strong></div>
            <div className="status-strip"><span>本机归档</span><strong>LOCAL</strong></div>
          </div>
        </div>
      </header>

      <section className="asset-workspace">
        <aside className="asset-sidebar" aria-label="项目与分类">
          <div className="asset-sidebar-heading"><FolderKanban size={17} /><div><span>项目归档</span><strong>{projects.length} 个项目</strong></div></div>
          <div className="project-list">
            <button type="button" className={projectId === 'all' ? 'active' : ''} onClick={() => setProjectId('all')}><span>全部资产</span><strong>{assets.length}</strong></button>
            {projects.map((project) => {
              const progress = projectProgress(project, assets);
              return <button type="button" key={project.id} className={projectId === project.id ? 'active' : ''} onClick={() => setProjectId(project.id)}><span>{project.title}</span><small>{progress.total ? `${progress.complete}/${progress.total} 镜头` : `${project.assetIds.length} 项资产`}</small></button>;
            })}
          </div>
          <div className="asset-type-list" role="tablist" aria-label="资产类型">
            {TYPE_FILTERS.map((item) => {
              const Icon = item.icon;
              const count = item.id === 'all' ? assets.length : assets.filter((asset) => asset.type === item.id).length;
              return <button type="button" key={item.id} className={type === item.id ? 'active' : ''} onClick={() => setType(item.id)} role="tab" aria-selected={type === item.id}><Icon size={15} /><span>{item.label}</span><strong>{count}</strong></button>;
            })}
          </div>
          <p className="asset-local-note">资产和项目保存于当前浏览器。本地归档不会上传提示词或媒体内容。</p>
        </aside>

        <section className="asset-catalog" aria-label="资产目录">
          <div className="asset-catalog-toolbar">
            <div><span>{selectedProject ? '当前项目' : '资产目录'}</span><h2>{selectedProject?.title || '全部创作资产'}</h2></div>
            <label className="asset-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、标签、模型或提示词" /></label>
          </div>
          {selectedProject && <>
            <div className="project-trace"><span>创作简述</span><strong>{selectedProject.brief}</strong><small>{selectedProject.style || '未设置风格'} · {selectedProject.ratio || '未设置比例'} · {selectedProject.duration} 秒</small></div>
            <section className="project-lineage" aria-label="项目资产关系">
              <div className="project-lineage-heading"><span>项目关系</span><strong>从创作资料到最终素材</strong></div>
              <div className="project-lineage-docs">
                {projectDocuments.filter((asset) => ['story', 'character', 'scene', 'storyboard'].includes(asset.category)).map((asset) => (
                  <button type="button" key={asset.id} className={selectedAsset?.id === asset.id ? 'active' : ''} onClick={() => setSelectedAssetId(asset.id)}>
                    <span>{CATEGORY_LABELS[asset.category]}</span><strong>{asset.title}</strong>
                  </button>
                ))}
              </div>
              <div className="project-lineage-shots">
                {projectShots.map((shot, index) => {
                  const outputs = projectAssets.filter((asset) => asset.type !== 'document' && asset.relatedAssetIds.includes(shot.id));
                  return <div className="project-lineage-shot" key={shot.id}>
                    <button type="button" className={selectedAsset?.id === shot.id ? 'active' : ''} onClick={() => setSelectedAssetId(shot.id)}><span>SHOT {String(index + 1).padStart(2, '0')}</span><strong>{shot.title}</strong></button>
                    <div>{outputs.length ? outputs.map((asset) => <button type="button" key={asset.id} className={selectedAsset?.id === asset.id ? 'active' : ''} onClick={() => setSelectedAssetId(asset.id)}><span>{typeLabel(asset.type)} · V{asset.version}</span><strong>{asset.title}</strong></button>) : <span className="project-lineage-pending">待生成素材</span>}</div>
                  </div>;
                })}
              </div>
            </section>
          </>}
          <div className="asset-grid" role="list">
            {filteredAssets.map((asset) => <button type="button" role="listitem" key={asset.id} className={'asset-card ' + (selectedAsset?.id === asset.id ? 'active' : '')} onClick={() => setSelectedAssetId(asset.id)}>
              <div className="asset-card-preview">
                {asset.type === 'image' && asset.previewUrl ? <img src={asset.previewUrl} alt="" /> : asset.type === 'video' && asset.previewUrl ? <video src={asset.previewUrl} muted preload="metadata" /> : <span>{typeIcon(asset.type, 25)}</span>}
                <em>{typeLabel(asset.type)}</em>
              </div>
              <div className="asset-card-copy"><span>{CATEGORY_LABELS[asset.category] || '素材'} · V{asset.version}{asset.isCurrent ? ' · 当前' : ''}</span><strong>{asset.title}</strong><small>{assetDescription(asset)}</small></div>
              <div className="asset-card-meta"><span>{dateLabel(asset.updatedAt)}</span><strong>{asset.relatedAssetIds.length ? <><Link2 size={12} /> {asset.relatedAssetIds.length}</> : '--'}</strong></div>
            </button>)}
            {!filteredAssets.length && <div className="asset-empty-state"><Archive size={36} /><strong>{assets.length ? '没有匹配的资产' : '还没有沉淀的创作资产'}</strong><span>{assets.length ? '调整搜索条件或切换分类。' : '图片、视频与 Agent 的生成结果可以保存到这里。'}</span></div>}
          </div>
        </section>

        <aside className="asset-inspector" aria-label="资产详情">
          {selectedAsset ? <>
            <div className="asset-inspector-heading"><div>{typeIcon(selectedAsset.type, 18)}<span>资产详情</span></div><button type="button" className="icon-action" onClick={() => onDeleteAsset(selectedAsset.id)} aria-label="删除资产" title="删除资产"><Trash2 size={16} /></button></div>
            {selectedAsset.previewUrl && <div className="asset-detail-preview">{selectedAsset.type === 'image' ? <img src={selectedAsset.previewUrl} alt={selectedAsset.title} /> : selectedAsset.type === 'video' ? <video src={selectedAsset.previewUrl} controls playsInline /> : <a href={selectedAsset.previewUrl} target="_blank" rel="noreferrer">打开原始媒体</a>}</div>}
            <div className="asset-form">
              <label className="field"><span>标题</span><input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} maxLength={120} /></label>
              <label className="field"><span>归属项目</span><select value={selectedAsset.projectId || ''} onChange={(event) => onAssignProject(selectedAsset.id, event.target.value || null)}><option value="">未归档</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.title}</option>)}</select></label>
              <label className="field"><span><Tag size={14} />标签</span><input value={draftTags} onChange={(event) => setDraftTags(event.target.value)} placeholder="用逗号分隔标签" /></label>
              {selectedAsset.type === 'document' && <label className="field asset-content-field"><span>内容</span><textarea value={draftContent} onChange={(event) => setDraftContent(event.target.value)} maxLength={12000} placeholder="记录故事、设定、分镜或提示词" /></label>}
              <button type="button" className="secondary-action asset-save" onClick={saveAsset}><Pencil size={14} />保存修改</button>
            </div>
            {versionPeers.length > 1 && <section className="asset-versions" aria-label="生成版本">
              <div className="asset-detail-label"><Check size={15} /><span>生成版本</span></div>
              <div className="asset-version-list">{versionPeers.map((asset) => <button type="button" key={asset.id} className={asset.id === selectedAsset.id ? 'active' : ''} onClick={() => setSelectedAssetId(asset.id)}><span>V{asset.version}</span><strong>{asset.isCurrent ? '当前版本' : dateLabel(asset.createdAt)}</strong></button>)}</div>
              {!selectedAsset.isCurrent && <button type="button" className="secondary-action asset-restore" onClick={() => onSetCurrentVersion(selectedAsset.id)}><Check size={14} />恢复为当前版本</button>}
            </section>}
            <section className="asset-provenance"><div className="asset-detail-label"><Clapperboard size={15} /><span>生成来源</span></div>{selectedAsset.source ? <dl><div><dt>服务商</dt><dd>{selectedAsset.source.provider || '--'}</dd></div><div><dt>模型</dt><dd>{selectedAsset.source.model || '--'}</dd></div><div><dt>方式</dt><dd>{selectedAsset.source.workflow || '--'}</dd></div><div><dt>参数</dt><dd>{Object.entries(selectedAsset.source.parameters || {}).map(([key, value]) => `${key}: ${value}`).join(' · ') || '--'}</dd></div>{selectedAsset.source.prompt && <div className="wide"><dt>提示词</dt><dd>{selectedAsset.source.prompt}</dd></div>}</dl> : <p>该资产由项目文档或用户输入创建。</p>}</section>
            <section className="asset-relations"><div className="asset-detail-label"><Link2 size={15} /><span>创作关系</span></div><p>{relatedAssets.length ? `关联 ${relatedAssets.length} 项资产` : '尚未关联其他资产'}</p><div className="relation-list">{assets.filter((asset) => asset.id !== selectedAsset.id).map((asset) => <label key={asset.id}><input type="checkbox" checked={selectedAsset.relatedAssetIds.includes(asset.id)} onChange={() => toggleRelation(asset.id)} /><span>{typeIcon(asset.type, 13)}{asset.title}</span></label>)}</div></section>
            {selectedAsset.previewUrl && <a className="secondary-action asset-open" href={selectedAsset.previewUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开媒体</a>}
          </> : <div className="asset-inspector-empty"><Archive size={34} /><strong>选择一项资产</strong><span>这里会显示它的版本、提示词、模型参数和创作关系。</span></div>}
        </aside>
      </section>
    </main>
  );
}

