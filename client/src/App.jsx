import { useState, useEffect, useRef, useCallback } from 'react';
import ImageUpload from './components/ImageUpload';
import PromptInput from './components/PromptInput';
import DenoiseSlider from './components/DenoiseSlider';
import SavedPromptsManager from './components/SavedPromptsManager';
import ResultViewer from './components/ResultViewer';
import ModelSelector from './components/ModelSelector';
import MaskEditor from './components/MaskEditor';
import InpaintPanel from './components/InpaintPanel';
import ImageChat from './components/ImageChat';
import ImageLibrary from './components/ImageLibrary';
import ServerConnection from './components/ServerConnection';
import PromptIntentPlan from './components/PromptIntentPlan';
import CompositionStudio from './components/CompositionStudio';
import { API_BASE, checkServerStatus, queueEditJob, queueInpaintJob, getGenerationJob, fetchOutputImage, resolvePromptIntent, shutdownServer } from './api';
import './App.css';

const JOB_STORAGE_KEY = 'qwen-image-editor:generation-jobs:v1';
const ACTIVE_JOB_STATUSES = ['submitting', 'queued', 'processing'];
const POLLABLE_JOB_STATUSES = [...ACTIVE_JOB_STATUSES, 'waiting_connection'];
const JOB_LOOKUP_GRACE_MS = 30 * 1000;
const JOB_RECOVERY_TIMEOUT_MS = 10 * 60 * 1000;

function readStoredJobs() {
  try {
    const jobs = JSON.parse(localStorage.getItem(JOB_STORAGE_KEY) || '[]');
    return Array.isArray(jobs) ? jobs : [];
  } catch {
    return [];
  }
}

function writeStoredJobs(jobs) {
  try { localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(jobs)); } catch {}
}

function makeJobId() {
  return globalThis.crypto?.randomUUID?.()
    || `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function App() {
  const [image, setImage] = useState(null);
  const [mask, setMask] = useState(null);
  const [brushSize, setBrushSize] = useState(20);
  const [growMask, setGrowMask] = useState(6);
  const [skinToneMatch, setSkinToneMatch] = useState(true);
  const [poseReference, setPoseReference] = useState(null);
  const [sceneFixes, setSceneFixes] = useState(['edge', 'lighting', 'shadow', 'texture']);
  const [inpaintSteps, setInpaintSteps] = useState(8);
  const [reconstructionSteps, setReconstructionSteps] = useState(6);
  const [activeFeature, setActiveFeature] = useState('edit');
  const [prompt, setPrompt] = useState('');
  const [denoise, setDenoise] = useState(0.85);
  const [preserveFace, setPreserveFace] = useState(true);
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const [isFeatureMenuOpen, setIsFeatureMenuOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [intentPlan, setIntentPlan] = useState(null);
  const [appliedIntentPlan, setAppliedIntentPlan] = useState(null);
  const [isResolvingIntent, setIsResolvingIntent] = useState(false);
  const [targetScope, setTargetScope] = useState('single');
  useEffect(() => {
    if (!isFeatureMenuOpen) return;
    const closeOutside = event => {
      if (!event.target.closest('.feature-menu-wrap')) setIsFeatureMenuOpen(false);
    };
    const closeEscape = event => { if (event.key === 'Escape') setIsFeatureMenuOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, [isFeatureMenuOpen]);
  const [selectedModel, setSelectedModel] = useState({ unet: '', clip: '', vae: '' });
  const [serverOnline, setServerOnline] = useState(null);
  const [generationJobs, setGenerationJobs] = useState(readStoredJobs);

  const prevImageRef = useRef(null);
  const generationJobsRef = useRef(generationJobs);
  const renderedJobRef = useRef('');

  useEffect(() => {
    generationJobsRef.current = generationJobs;
    writeStoredJobs(generationJobs);
    // A job waiting for the PC/server to reconnect must not lock the create
    // button forever. It remains pollable in the background and can recover.
    setIsLoading(generationJobs.some(job => ACTIVE_JOB_STATUSES.includes(job.status)));
  }, [generationJobs]);

  const refreshServerStatus = useCallback(async () => {
    setServerOnline(await checkServerStatus());
  }, []);

  useEffect(() => {
    refreshServerStatus();
    const interval = window.setInterval(refreshServerStatus, 15000);
    return () => window.clearInterval(interval);
  }, [refreshServerStatus]);

  // Clear results only when a NEW image file replaces the old one,
  // NOT when the user presses X (which sets image to null).
  useEffect(() => {
    if (image !== null && prevImageRef.current !== image) {
      setResults([]);
      setError(null);
      setMeta(null);
      setMask(null);
    }
    prevImageRef.current = image;
  }, [image]);

  const replaceGenerationJob = useCallback((id, patch) => {
    setGenerationJobs(previous => previous.map(job => (
      job.id === id ? { ...job, ...patch, updatedAt: Date.now() } : job
    )));
  }, []);

  const loadCompletedJobImages = useCallback(async (job) => {
    const filenames = (job.images || []).map(image => image.filename).filter(Boolean);
    if (!filenames.length) return;
    const signature = `${job.id}:${filenames.join('|')}`;
    if (renderedJobRef.current === signature) return;

    try {
      const loaded = await Promise.all(filenames.map(async filename => ({
        url: URL.createObjectURL(await fetchOutputImage(filename)),
        filename,
        kind: 'result'
      })));
      renderedJobRef.current = signature;
      setResults(loaded);
      setMeta(job.meta || null);
      setError(null);
    } catch {
      // Keep the completed record. Network access can be unavailable while the
      // WebView wakes up; visibility/focus will retry without losing the job.
    }
  }, []);

  const pollGenerationQueue = useCallback(async () => {
    const pending = generationJobsRef.current.filter(job => POLLABLE_JOB_STATUSES.includes(job.status));
    for (const localJob of pending) {
      try {
        const remoteJob = await getGenerationJob(localJob.id, localJob.promptId);
        const updatedJob = {
          ...localJob,
          ...remoteJob,
          images: remoteJob.images || [],
          meta: { ...(localJob.meta || {}), ...(remoteJob.meta || {}) },
          updatedAt: Date.now()
        };
        setGenerationJobs(previous => previous.map(job => job.id === localJob.id ? updatedJob : job));
        if (updatedJob.status === 'completed') await loadCompletedJobImages(updatedJob);
        if (updatedJob.status === 'failed') setError(updatedJob.error || 'Tạo ảnh không thành công.');
      } catch (err) {
        // 404 can occur briefly if the request was backgrounded while the
        // server was still accepting the upload. After the grace period, keep
        // polling without leaving the main action button spinning forever.
        const jobAge = Date.now() - (localJob.createdAt || localJob.updatedAt || Date.now());
        if (jobAge >= JOB_RECOVERY_TIMEOUT_MS) {
          replaceGenerationJob(localJob.id, {
            status: 'failed',
            error: 'Tác vụ cũ không còn phản hồi. Bạn có thể tạo ảnh lại.'
          });
          setError('Tác vụ cũ không còn phản hồi. Bạn có thể tạo ảnh lại.');
          continue;
        }

        const connectionFailed = !err.status || err.status !== 404;
        if (connectionFailed) setServerOnline(false);
        if (connectionFailed || jobAge >= JOB_LOOKUP_GRACE_MS) {
          if (localJob.status !== 'waiting_connection') {
            replaceGenerationJob(localJob.id, {
              status: 'waiting_connection',
              error: connectionFailed
                ? 'Mất kết nối máy AI. Tác vụ sẽ được kiểm tra lại khi kết nối trở lại.'
                : 'Không tìm thấy tác vụ trên server. App vẫn đang kiểm tra lại.'
            });
          }
          if (connectionFailed) {
            setError(`Mất kết nối máy AI tại ${API_BASE}. Nút tạo ảnh đã được mở lại.`);
          }
        }
      }
    }
    const latestCompleted = [...generationJobsRef.current]
      .filter(job => job.status === 'completed')
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (latestCompleted) await loadCompletedJobImages(latestCompleted);
  }, [loadCompletedJobImages, replaceGenerationJob]);

  useEffect(() => {
    const restore = () => {
      const latest = [...generationJobsRef.current]
        .filter(job => job.status === 'completed')
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      if (latest) void loadCompletedJobImages(latest);
      void pollGenerationQueue();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') restore();
    };
    restore();
    const interval = window.setInterval(pollGenerationQueue, 4000);
    window.addEventListener('focus', restore);
    window.addEventListener('pageshow', restore);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', restore);
      window.removeEventListener('pageshow', restore);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loadCompletedJobImages, pollGenerationQueue]);

  const handleClearImage = () => {
    setImage(null);
    setError(null);
    setMeta(null);
  };

  const handleShutdown = async () => {
    if (!window.confirm('Tắt ComfyUI và proxy server?')) return;
    setIsShuttingDown(true);
    try {
      await shutdownServer();
      // Show success then close
      setTimeout(() => {
        try { window.close(); } catch {}
      }, 1000);
    } catch {
      setIsShuttingDown(false);
      setError('Không thể tắt server.');
    }
  };

  const handleDelete = (filename) => {
    setResults(prev => prev.filter(r => r.filename !== filename));
    setGenerationJobs(previous => previous.map(job => ({
      ...job,
      images: (job.images || []).filter(image => image.filename !== filename)
    })));
  };

  const handleLoadPrompt = ({ prompt: loadedPrompt, denoise: loadedDenoise }) => {
    setPrompt(loadedPrompt);
    setIntentPlan(null);
    setAppliedIntentPlan(null);
    if (loadedDenoise != null) setDenoise(loadedDenoise);
  };

  const selectFeature = (feature) => {
    setActiveFeature(feature);
    if (feature === 'pose' && !prompt.trim()) setPrompt('Đổi tư thế nhân vật theo ảnh tham chiếu, giữ khuôn mặt, trang phục và bối cảnh gốc.');
    setIsFeatureMenuOpen(false);
  };

  const isMaskFeature = activeFeature === 'inpaint' || activeFeature === 'reconstruct' || activeFeature === 'scene' || activeFeature === 'pose';
  const isReconstruction = activeFeature === 'reconstruct';
  const isSceneIntegration = activeFeature === 'scene';
  const isPose = activeFeature === 'pose';

  const handlePromptChange = (value) => {
    setPrompt(value);
    setIntentPlan(null);
    setAppliedIntentPlan(null);
  };

  const handleResolveIntent = async () => {
    if (!prompt.trim()) {
      setError('Nhập mô tả chỉnh sửa trước khi phân tích.');
      return;
    }
    setIsResolvingIntent(true);
    try {
      const plan = await resolvePromptIntent(prompt, activeFeature, targetScope);
      setIntentPlan(plan);
      setAppliedIntentPlan(null);
      setError(null);
    } catch (err) {
      setError(err.message || 'Không thể phân tích yêu cầu chỉnh sửa.');
    } finally {
      setIsResolvingIntent(false);
    }
  };

  const handleApplyIntent = () => {
    if (!intentPlan) return;
    const { parameters, recommendedFeature } = intentPlan;
    setDenoise(parameters.denoise);
    setGrowMask(parameters.growMask);
    setSkinToneMatch(Boolean(parameters.skinToneMatch));
    if (recommendedFeature === 'reconstruct') setReconstructionSteps(parameters.steps);
    else if (recommendedFeature === 'inpaint') setInpaintSteps(parameters.steps);
    if (recommendedFeature && recommendedFeature !== activeFeature) setActiveFeature(recommendedFeature);
    setAppliedIntentPlan(intentPlan);
  };

  const handleTargetScopeChange = (scope) => {
    setTargetScope(scope);
    setIntentPlan(null);
    setAppliedIntentPlan(null);
  };

  const intentSlot = (
    <PromptIntentPlan
      plan={intentPlan}
      targetScope={targetScope}
      isApplied={appliedIntentPlan === intentPlan}
      loading={isResolvingIntent}
      onScopeChange={handleTargetScopeChange}
      onResolve={handleResolveIntent}
      onApply={handleApplyIntent}
    />
  );

  const submitGeneration = async ({ inputImage, inputMask, inputPrompt, feature = activeFeature, sceneIntegration = [], denoiseOverride, stepsOverride, growMaskOverride, skinToneMatchOverride, negativePromptOverride }) => {
    const usesMask = feature === 'inpaint' || feature === 'reconstruct' || feature === 'scene' || feature === 'studio' || feature === 'pose';
    const usesReconstruction = feature === 'reconstruct';
    const usesSceneIntegration = feature === 'scene' || feature === 'studio';
    if (serverOnline === false) {
      setError(`Không kết nối được máy AI tại ${API_BASE}. Kiểm tra máy chủ và kết nối riêng.`);
      return;
    }
    if (!inputImage) {
      setError(usesMask ? 'Vui lòng chọn ảnh cần chỉnh sửa.' : 'Vui lòng chọn một ảnh đầu vào.');
      return;
    }
    if (usesMask && !inputMask) {
      setError('Vui lòng tô vùng cần chỉnh sửa trên ảnh.');
      return;
    }
    if (feature === 'pose' && !poseReference?.file) {
      setError('Chọn một tư thế tham chiếu trước khi tạo ảnh.');
      return;
    }
    if (!inputPrompt.trim()) { setError('Vui lòng nhập chỉ dẫn chỉnh sửa.'); return; }

    const job = {
      id: makeJobId(),
      feature,
      status: 'submitting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      images: [],
      meta: { denoise: denoiseOverride ?? denoise, seed: null, steps: null, cfg: null }
    };

    // Persist before upload: if Android backgrounds the app while the server
    // accepts the request, the app can resume polling this same job id.
    setGenerationJobs(previous => {
      const next = [...previous.filter(item => item.status !== 'submitting'), job];
      writeStoredJobs(next);
      return next;
    });
    setError(null);
    setResults([]);
    setMeta(null);

    try {
      const useAppliedPlan = feature !== 'studio' && feature !== 'pose' && inputPrompt === prompt && Boolean(appliedIntentPlan);
      const finalPrompt = useAppliedPlan ? appliedIntentPlan.expandedPrompt : inputPrompt.trim();
      const negativePrompt = negativePromptOverride ?? (useAppliedPlan ? appliedIntentPlan.negativePrompt : '');
      const requestDenoise = denoiseOverride ?? denoise;
      const requestSteps = stepsOverride ?? (usesReconstruction ? reconstructionSteps : inpaintSteps);
      const requestGrowMask = growMaskOverride ?? growMask;
      const requestSkinToneMatch = skinToneMatchOverride ?? skinToneMatch;
      const remoteJob = usesMask
        ? await queueInpaintJob({ image: inputImage, mask: inputMask, poseReference: feature === 'pose' ? poseReference.file : null, poseLabel: feature === 'pose' ? poseReference.label : '', prompt: finalPrompt, negativePrompt, denoise: requestDenoise, steps: requestSteps, growMask: requestGrowMask, skinToneMatch: requestSkinToneMatch, sceneIntegration: usesSceneIntegration ? sceneIntegration : [], jobId: job.id, ...selectedModel })
        : await queueEditJob({ image: inputImage, prompt: finalPrompt, negativePrompt, denoise: requestDenoise, preserveFace, jobId: job.id, ...selectedModel });
      const updatedJob = {
        ...job,
        ...remoteJob,
        images: remoteJob.images || [],
        meta: { ...job.meta, ...(remoteJob.meta || {}) },
        updatedAt: Date.now()
      };
      setGenerationJobs(previous => previous.map(item => item.id === job.id ? updatedJob : item));
      setServerOnline(true);
      if (updatedJob.status === 'completed') await loadCompletedJobImages(updatedJob);
    } catch (err) {
      const connectionFailed = !err.status;
      replaceGenerationJob(job.id, {
        status: connectionFailed ? 'waiting_connection' : 'failed',
        error: connectionFailed
          ? 'Máy AI chưa phản hồi. App sẽ tự kiểm tra lại tác vụ này.'
          : (err.message || 'Không thể gửi yêu cầu tạo ảnh.')
      });
      setServerOnline(false);
      setError(connectionFailed
        ? `Máy AI chưa phản hồi tại ${API_BASE}. Nút tạo ảnh đã được mở lại.`
        : (err.message || `Kết nối thất bại. Kiểm tra proxy tại ${API_BASE} đang chạy.`));
    }
  };

  const handleSubmit = () => submitGeneration({
    inputImage: image,
    inputMask: mask,
    inputPrompt: prompt,
    feature: activeFeature,
    sceneIntegration: sceneFixes
  });

  const handleStudioApply = ({ image: composedImage, mask: composedMask, prompt: studioPrompt, sceneFixes: selectedFixes, strength = 0.55 }) => {
    setImage(composedImage);
    setMask(composedMask);
    setPrompt(studioPrompt);
    setActiveFeature('studio');
    return submitGeneration({
      inputImage: composedImage,
      inputMask: composedMask,
      inputPrompt: studioPrompt,
      feature: 'studio',
      sceneIntegration: selectedFixes,
      denoiseOverride: strength,
      stepsOverride: 6,
      growMaskOverride: 5,
      skinToneMatchOverride: false,
      negativePromptOverride: 'pasted cutout, unchanged foreground lighting, hard edge, halo, bright fringe, floating object, flat black shadow, visible text, watermark'
    });
  };

  const enrichedResults = results.map((r, i) => ({
    ...r,
    seed:    (i === 0 && meta?.seed)    ? meta.seed    : null,
    denoise: (i === 0 && meta?.denoise) ? meta.denoise : null,
    steps:   (i === 0 && meta?.steps)   ? meta.steps   : null,
    cfg:     (i === 0 && meta?.cfg)     ? meta.cfg     : null,
  }));

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-inner">
          <div className="brand">
            <svg className="brand-icon" viewBox="0 0 32 32" fill="none">
              <rect x="2" y="2" width="28" height="28" rx="6" stroke="currentColor" strokeWidth="2" />
              <circle cx="11" cy="11" r="3" stroke="currentColor" strokeWidth="1.8" />
              <path d="M2 22l9-9 6 6 7-7 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
            <div className="brand-text">
              <span className="brand-name">Qwen Image Editor</span>
              <span className="brand-sub">Không gian chỉnh ảnh</span>
            </div>
          </div>
          <div className="header-actions">
            <button type="button" className="gallery-header-btn" onClick={() => { setLibraryOpen(true); setIsFeatureMenuOpen(false); }}>Kho ảnh</button>
            <div className="feature-menu-wrap">
              <button
                className="feature-menu-btn"
                onClick={() => setIsFeatureMenuOpen(open => !open)}
                aria-label="Mở danh sách chức năng"
                aria-expanded={isFeatureMenuOpen}
                aria-controls="feature-menu"
                type="button"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="4" y1="6" x2="20" y2="6" />
                  <line x1="4" y1="12" x2="20" y2="12" />
                  <line x1="4" y1="18" x2="20" y2="18" />
                </svg>
              </button>
              {isFeatureMenuOpen && (
                <div className="feature-menu" id="feature-menu">
                  <button className={`feature-menu-item ${activeFeature === 'edit' ? 'active' : ''}`} onClick={() => selectFeature('edit')} type="button">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <path d="m21 15-5-5L5 21" />
                    </svg>
                    <span><strong>Chỉnh sửa ảnh</strong><small>Img2img</small></span>
                    {activeFeature === 'edit' && <span className="feature-current">Đang dùng</span>}
                  </button>
                  <button className={`feature-menu-item ${activeFeature === 'inpaint' ? 'active' : ''}`} onClick={() => selectFeature('inpaint')} type="button">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 19l7-7 3 3-7 7-3-3z" />
                      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
                      <path d="M2 2l7.586 7.586" />
                      <circle cx="11" cy="11" r="2" />
                    </svg>
                    <span><strong>Tô vùng cần sửa</strong><small>Inpaint</small></span>
                    {activeFeature === 'inpaint' && <span className="feature-current">Đang dùng</span>}
                  </button>
                  <button className={`feature-menu-item ${activeFeature === 'reconstruct' ? 'active' : ''}`} onClick={() => selectFeature('reconstruct')} type="button">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M4 8V5a1 1 0 0 1 1-1h3" />
                      <path d="M20 8V5a1 1 0 0 0-1-1h-3" />
                      <path d="M4 16v3a1 1 0 0 0 1 1h3" />
                      <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
                      <path d="M8 12h8M12 8v8" />
                    </svg>
                    <span><strong>Tái tạo vùng lớn</strong><small>Vùng trang phục, vật thể lớn</small></span>
                    {activeFeature === 'reconstruct' && <span className="feature-current">Đang dùng</span>}
                  </button>
                  <button className={`feature-menu-item ${isPose ? 'active' : ''}`} onClick={() => selectFeature('pose')} type="button">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="4" r="2" /><path d="M12 6v7m0 0-5 7m5-7 6 7m-6-10-5-3m5 3 5-3" /></svg>
                    <span><strong>Đổi tư thế theo ref</strong><small>Chọn tư thế REF-02 và tô vùng cơ thể</small></span>
                    {isPose && <span className="feature-current">Đang dùng</span>}
                  </button>
                  <button className={`feature-menu-item ${activeFeature === 'scene' ? 'active' : ''}`} onClick={() => selectFeature('scene')} type="button">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="8" cy="9" r="3" />
                      <path d="M3 20c1-4 3-6 5-6s4 2 5 6" />
                      <path d="M14 18c2.5-1 4.5-3.3 5-6.5" />
                      <path d="m17 8 2-2 2 2" />
                    </svg>
                    <span><strong>Hòa ảnh ghép vào nền</strong><small>Viền, sáng, bóng, texture</small></span>
                    {activeFeature === 'scene' && <span className="feature-current">Đang dùng</span>}
                  </button>
                  <button className={`feature-menu-item ${activeFeature === 'studio' ? 'active' : ''}`} onClick={() => selectFeature('studio')} type="button">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="4" width="18" height="16" rx="2" />
                      <path d="M7 15l3-3 2 2 3-4 3 5" />
                      <path d="M12 7v4M10 9h4" />
                    </svg>
                    <span><strong>Studio ghép ảnh</strong><small>Thêm PNG, sắp xếp rồi hòa nền</small></span>
                    {activeFeature === 'studio' && <span className="feature-current">Đang dùng</span>}
                  </button>
                  <button type="button" className={`feature-menu-item ${activeFeature === 'chat' ? 'active' : ''}`} onClick={() => selectFeature('chat')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16v12H9l-5 4z" /></svg>
                    <span><strong>Chat chỉnh ảnh</strong><small>Lịch sử và kho ảnh</small></span>
                    {activeFeature === 'chat' && <span className="feature-current">Đang dùng</span>}
                  </button>
                  <button className="feature-menu-item" type="button" onClick={() => { setConnectionOpen(true); setIsFeatureMenuOpen(false); }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h.01M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M9 7h6" /></svg>
                    <span><strong>Kết nối máy AI</strong><small>URL Tailscale riêng tư</small></span>
                  </button>
                  <div className="feature-menu-item disabled" aria-disabled="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="5" y="5" width="14" height="14" rx="2" />
                      <path d="M9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M17 9h4M3 15h4M17 15h4" />
                    </svg>
                    <span><strong>Mở rộng ảnh</strong><small>Outpainting</small></span>
                    <span className="feature-soon">Sắp có</span>
                  </div>
                </div>
              )}
            </div>
            <button
              className="shutdown-btn"
              onClick={handleShutdown}
              disabled={isShuttingDown}
              type="button"
            >
              {isShuttingDown ? 'Đang tắt…' : 'Tắt server'}
            </button>
          </div>
        </div>
      </header>

      {libraryOpen && <ImageLibrary onClose={() => setLibraryOpen(false)} onDeleted={handleDelete} />}
      {connectionOpen && <ServerConnection onClose={() => setConnectionOpen(false)} />}
      <main className="app-main">
        {activeFeature === 'chat' ? <ImageChat /> : <aside className="control-panel">
          {activeFeature === 'studio' ? (
            <CompositionStudio
              onApply={handleStudioApply}
              isLoading={isLoading}
              serverOnline={serverOnline}
              resultSlot={(isLoading || error || enrichedResults.length > 0) ? (
                <section className="result-panel inpaint-result" aria-label="Kết quả hòa ảnh ghép">
                  <div className="stage-label">Kết quả hòa ảnh ghép</div>
                  <ResultViewer results={enrichedResults} isLoading={isLoading} error={error} apiBase={API_BASE} onDelete={handleDelete} comparison={false} />
                </section>
              ) : null}
            />
          ) : isMaskFeature ? (
            <InpaintPanel
              mode={isPose ? 'pose' : isSceneIntegration ? 'scene' : isReconstruction ? 'reconstruct' : 'inpaint'}
              image={image}
              mask={mask}
              brushSize={brushSize}
              growMask={growMask}
              steps={isReconstruction ? reconstructionSteps : inpaintSteps}
              skinToneMatch={skinToneMatch}
              poseReference={poseReference}
              onPoseReferenceChange={setPoseReference}
              selectedModel={selectedModel}
              onImageChange={setImage}
              onImageClear={handleClearImage}
              onMaskChange={setMask}
              onBrushSizeChange={setBrushSize}
              onGrowMaskChange={setGrowMask}
              onSkinToneMatchChange={setSkinToneMatch}
              sceneFixes={sceneFixes}
              onSceneFixesChange={setSceneFixes}
              onStepsChange={isReconstruction ? setReconstructionSteps : setInpaintSteps}
              onModelChange={setSelectedModel}
              prompt={prompt}
              onPromptChange={handlePromptChange}
              denoise={denoise}
              onDenoiseChange={setDenoise}
              onLoadPrompt={handleLoadPrompt}
              intentSlot={intentSlot}
              resultSlot={(isLoading || error || enrichedResults.length > 0) ? (
                <section className="result-panel inpaint-result" aria-label="Kết quả chỉnh sửa vùng tô">
                  <div className="stage-label">Kết quả chỉnh sửa</div>
                  <ResultViewer
                    results={enrichedResults}
                    isLoading={isLoading}
                    error={error}
                    apiBase={API_BASE}
                    onDelete={handleDelete}
                    comparison={false}
                  />
                </section>
              ) : null}
            />
          ) : (
            <>
              <div className="workflow-heading">
                <span>Chỉnh sửa ảnh</span>
                <small>Chọn ảnh, mô tả thay đổi, rồi tạo kết quả.</small>
              </div>
              <div className="visual-stage" aria-label="Ảnh đầu vào và ảnh tạo ra">
                <div className="source-stage">
                  <ImageUpload image={image} onImageChange={setImage} onClear={handleClearImage} />
                </div>
                <section className="result-panel embedded-result" aria-label="Ảnh tạo ra">
                  <div className="stage-label">Ảnh tạo ra</div>
                  <ResultViewer
                    results={enrichedResults}
                    isLoading={isLoading}
                    error={error}
                    apiBase={API_BASE}
                    onDelete={handleDelete}
                    comparison={false}
                  />
                </section>
              </div>
              <PromptInput prompt={prompt} onPromptChange={handlePromptChange} />
              {intentSlot}
              <DenoiseSlider denoise={denoise} onDenoiseChange={setDenoise} />
              <label className="face-preserve-control">
                <input
                  type="checkbox"
                  checked={preserveFace}
                  onChange={(event) => setPreserveFace(event.target.checked)}
                />
                <span className="face-preserve-switch" aria-hidden="true" />
                <span>
                  <strong>Giữ khuôn mặt gần đúng</strong>
                  <small>Ưu tiên giữ nhận diện khuôn mặt từ ảnh gốc</small>
                </span>
              </label>
              <details className="advanced-options">
                <summary>Tùy chọn mô hình</summary>
                <ModelSelector value={selectedModel} onChange={setSelectedModel} />
              </details>
              <SavedPromptsManager currentPrompt={prompt} currentDenoise={denoise} onLoad={handleLoadPrompt} />
            </>
          )}
          {activeFeature !== 'studio' && <div className="mobile-action-dock">
            <button
              className={`submit-btn ${isLoading ? 'loading' : ''}`}
              onClick={handleSubmit}
              disabled={isLoading || serverOnline === false || !image || !prompt.trim() || (isMaskFeature && !mask) || (isPose && !poseReference)}
              type="button"
            >
              {isLoading ? (
                <>
                  <span className="btn-spinner" />
                  Đang xử lý…
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none" />
                  </svg>
                  {isMaskFeature ? (isPose ? 'Đổi tư thế' : isSceneIntegration ? 'Hòa ảnh ghép' : isReconstruction ? 'Tái tạo vùng đã tô' : 'Tô vùng & tạo ảnh') : 'Tạo ảnh'}
                </>
              )}
            </button>
            <button className="server-status" onClick={refreshServerStatus} type="button" aria-label="Kiểm tra kết nối máy AI">
              <span className={`server-status-dot ${serverOnline === true ? 'online' : serverOnline === false ? 'offline' : 'checking'}`} />
              {serverOnline === true ? 'Máy AI đã sẵn sàng' : serverOnline === false ? `Không kết nối ${API_BASE}` : 'Đang kiểm tra máy AI…'}
            </button>
          </div>}
        </aside>}

      </main>
    </div>
  );
}
