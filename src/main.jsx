import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Clapperboard,
  Download,
  Film,
  Gauge,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  Sparkles,
  Wand2,
} from 'lucide-react';
import './styles.css';

const aspectRatios = ['9:16', '16:9', '1:1'];
const durations = ['8 秒', '15 秒', '30 秒'];
const styles = ['写实广告', '电影感', '产品展示', '动画短片'];

function createStoryboard(prompt, ratio, duration, style) {
  const cleanPrompt = prompt.trim();
  const source = cleanPrompt || '一杯冰咖啡在城市天台上被阳光照亮，镜头缓慢推进';
  const fragments = source
    .replace(/[，。,.]/g, '|')
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);

  const beats = [
    fragments[0] || source,
    fragments[1] || '主体进入画面，环境细节逐渐清晰',
    fragments[2] || '镜头切到特写，突出质感、动作和情绪',
    fragments[3] || '收束到完整画面，保留品牌或主题记忆点',
  ];

  return beats.map((beat, index) => ({
    id: index + 1,
    time: `${String(index * 3).padStart(2, '0')}s`,
    shot: beat,
    camera: ['慢速推进', '横向跟拍', '微距特写', '定格收束'][index],
    meta: `${style} / ${ratio} / ${duration}`,
  }));
}

function App() {
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState('9:16');
  const [duration, setDuration] = useState('15 秒');
  const [style, setStyle] = useState('电影感');
  const [quality, setQuality] = useState(72);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);

  const storyboard = useMemo(
    () => createStoryboard(prompt, ratio, duration, style),
    [prompt, ratio, duration, style],
  );

  const canGenerate = prompt.trim().length > 0 && !isGenerating;

  function generateVideo() {
    if (!canGenerate) return;
    setIsGenerating(true);
    setProgress(0);

    const timer = window.setInterval(() => {
      setProgress((current) => {
        if (current >= 100) {
          window.clearInterval(timer);
          setIsGenerating(false);
          setIsPlaying(true);
          return 100;
        }
        return Math.min(current + 8, 100);
      });
    }, 180);
  }

  function reset() {
    setPrompt('');
    setProgress(0);
    setIsGenerating(false);
    setIsPlaying(true);
  }

  const status = isGenerating ? '生成中' : progress === 100 ? '已完成' : '待生成';

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Prompt Video Studio</p>
          <h1>输入提示词，生成短视频</h1>
        </div>
        <div className="status-strip" aria-label="任务状态">
          <span>{status}</span>
          <strong>{String(progress).padStart(3, '0')}%</strong>
        </div>
      </section>

      <section className="workspace">
        <aside className="control-panel">
          <div className="panel-heading">
            <Wand2 size={18} />
            <h2>提示词</h2>
          </div>

          <label className="field">
            <span>视频描述</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="例如：一款银色智能手表在雨夜街头旋转，屏幕亮起健康数据，最后出现产品正面特写"
            />
          </label>

          <div className="settings-grid">
            <label className="field">
              <span>比例</span>
              <select value={ratio} onChange={(event) => setRatio(event.target.value)}>
                {aspectRatios.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>时长</span>
              <select value={duration} onChange={(event) => setDuration(event.target.value)}>
                {durations.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="field">
            <span>风格</span>
            <select value={style} onChange={(event) => setStyle(event.target.value)}>
              {styles.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>

          <label className="range-field">
            <span>
              <Gauge size={16} />
              画面细节
            </span>
            <input
              type="range"
              min="20"
              max="100"
              value={quality}
              onChange={(event) => setQuality(Number(event.target.value))}
            />
            <strong>{quality}</strong>
          </label>

          <div className="action-row">
            <button className="primary-action" onClick={generateVideo} disabled={!canGenerate}>
              {isGenerating ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
              生成视频
            </button>
            <button className="icon-action" onClick={reset} aria-label="重置">
              <RefreshCw size={18} />
            </button>
          </div>
        </aside>

        <section className="preview-panel">
          <div className="preview-toolbar">
            <div className="panel-heading">
              <Film size={18} />
              <h2>预览</h2>
            </div>
            <div className="toolbar-actions">
              <button className="icon-action" onClick={() => setIsPlaying((value) => !value)} aria-label={isPlaying ? '暂停' : '播放'}>
                {isPlaying ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <button className="icon-action" aria-label="下载">
                <Download size={18} />
              </button>
            </div>
          </div>

          <div className={`video-frame ${isPlaying ? 'playing' : ''}`}>
            <div className="scan-layer" />
            <div className="frame-number">FRAME {String(Math.max(progress, 1)).padStart(3, '0')}</div>
            <div className="subject-block">
              <span>{style}</span>
              <strong>{prompt.trim() || '等待提示词'}</strong>
            </div>
            <div className="timeline">
              <span style={{ width: `${progress || 18}%` }} />
            </div>
          </div>
        </section>

        <section className="storyboard-panel">
          <div className="panel-heading">
            <Clapperboard size={18} />
            <h2>分镜</h2>
          </div>
          <div className="shot-list">
            {storyboard.map((shot) => (
              <article key={shot.id} className="shot-card">
                <div>
                  <span>{shot.time}</span>
                  <strong>镜头 {shot.id}</strong>
                </div>
                <p>{shot.shot}</p>
                <footer>
                  <span>{shot.camera}</span>
                  <span>{shot.meta}</span>
                </footer>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
