import { useCallback, useEffect, useRef, useState } from 'react';
import './CompositionStudio.css';
import { layerMetrics } from './studioGeometry.mjs';

const DEFAULT_PROMPT = 'Hoà các đối tượng đã đặt vào nền để chúng hiện diện thật trong cùng môi trường, không giống ảnh cắt dán. Giữ nguyên vị trí, kích thước và góc xoay đã chọn. Khớp ánh sáng, màu, bóng tiếp xúc, viền và texture với nền; cho phép chỉnh nhẹ mép và điểm tiếp xúc để hợp vật lý với bề mặt.';
const FIXES = [
  ['edge', 'Viền & tóc'],
  ['lighting', 'Ánh sáng & màu'],
  ['shadow', 'Bóng tiếp xúc'],
  ['texture', 'Texture']
];

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

function toFile(canvas, name) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(new File([blob], name, { type: 'image/png' })) : reject(new Error('Không thể tạo ảnh ghép.')), 'image/png');
  });
}

function silhouetteFrom(image, color) {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

async function cropTransparentLayer(file) {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(sourceUrl);
    const source = document.createElement('canvas');
    source.width = image.naturalWidth;
    source.height = image.naturalHeight;
    const sourceCtx = source.getContext('2d', { willReadFrequently: true });
    sourceCtx.drawImage(image, 0, 0);
    const data = sourceCtx.getImageData(0, 0, source.width, source.height).data;
    let left = source.width;
    let top = source.height;
    let right = -1;
    let bottom = -1;
    let transparentPixels = 0;
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const alpha = data[(y * source.width + x) * 4 + 3];
        if (alpha < 250) transparentPixels += 1;
        if (alpha > 8) {
          left = Math.min(left, x); top = Math.min(top, y);
          right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
      }
    }
    if (right < 0) throw new Error(`Ảnh “${file.name}” không có phần hiển thị.`);
    if (transparentPixels === 0) throw new Error(`Ảnh “${file.name}” chưa có nền trong suốt. Hãy dùng PNG đã xóa nền.`);
    const padding = Math.max(2, Math.round(Math.min(source.width, source.height) * 0.01));
    left = Math.max(0, left - padding); top = Math.max(0, top - padding);
    right = Math.min(source.width - 1, right + padding); bottom = Math.min(source.height - 1, bottom + padding);
    const cropped = document.createElement('canvas');
    cropped.width = right - left + 1;
    cropped.height = bottom - top + 1;
    cropped.getContext('2d').drawImage(source, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
    const croppedFile = await toFile(cropped, `${file.name.replace(/\.[^.]+$/, '')}-trim.png`);
    return { file: croppedFile, url: URL.createObjectURL(croppedFile) };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

export default function CompositionStudio({ onApply, isLoading, serverOnline, resultSlot }) {
  const previewRef = useRef(null);
  const backgroundInputRef = useRef(null);
  const overlayInputRef = useRef(null);
  const cacheRef = useRef(new Map());
  const urlsRef = useRef(new Set());
  const dragRef = useRef(null);
  const [background, setBackground] = useState(null);
  const [layers, setLayers] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [sceneFixes, setSceneFixes] = useState(['edge', 'lighting', 'shadow', 'texture']);
  const [localError, setLocalError] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  const [strength, setStrength] = useState(0.55);

  const getCachedImage = useCallback(async (url) => {
    if (!cacheRef.current.has(url)) cacheRef.current.set(url, loadImage(url));
    return cacheRef.current.get(url);
  }, []);

  const outputSize = useCallback(() => {
    if (!background) return { width: 1, height: 1 };
    const longest = Math.max(background.width, background.height);
    const ratio = Math.min(1, 2048 / longest);
    return { width: Math.max(1, Math.round(background.width * ratio)), height: Math.max(1, Math.round(background.height * ratio)) };
  }, [background]);

  const getLayerMetrics = useCallback((layer, image, width, height) => {
    return layerMetrics(layer, image, width, height);
  }, []);

  const drawLayer = useCallback((ctx, image, layer, width, height) => {
    const metrics = getLayerMetrics(layer, image, width, height);
    ctx.save();
    ctx.translate(metrics.x, metrics.y);
    ctx.rotate(metrics.rotation);
    ctx.drawImage(image, -metrics.width / 2, -metrics.height / 2, metrics.width, metrics.height);
    ctx.restore();
    return metrics;
  }, [getLayerMetrics]);

  const renderCanvases = useCallback(async ({ includeSelection = false } = {}) => {
    if (!background) throw new Error('Hãy chọn ảnh nền trước.');
    const { width, height } = outputSize();
    const composite = document.createElement('canvas');
    const mask = document.createElement('canvas');
    composite.width = mask.width = width;
    composite.height = mask.height = height;
    const ctx = composite.getContext('2d');
    const maskCtx = mask.getContext('2d');
    const backgroundImage = await getCachedImage(background.url);
    ctx.drawImage(backgroundImage, 0, 0, width, height);
    maskCtx.clearRect(0, 0, width, height);

    for (const layer of layers) {
      const layerImage = await getCachedImage(layer.url);
      const metrics = getLayerMetrics(layer, layerImage, width, height);
      const alphaCanvas = silhouetteFrom(layerImage, '#ffffff');
      // Send original layer pixels to Qwen. Nearby material colors do not
      // determine the scene illuminant, and a flattened silhouette is not a contact shadow.
      const metricsForDraw = drawLayer(ctx, layerImage, layer, width, height);
      maskCtx.save();
      maskCtx.translate(metricsForDraw.x, metricsForDraw.y);
      maskCtx.rotate(metricsForDraw.rotation);
      maskCtx.drawImage(alphaCanvas, -metricsForDraw.width / 2, -metricsForDraw.height / 2, metricsForDraw.width, metricsForDraw.height);
      maskCtx.restore();

      if (includeSelection && layer.id === selectedId) {
        ctx.save();
        ctx.translate(metrics.x, metrics.y);
        ctx.rotate(metrics.rotation);
        ctx.strokeStyle = '#9b7cff';
        ctx.lineWidth = Math.max(2, width / 600);
        ctx.setLineDash([8, 6]);
        ctx.strokeRect(-metrics.width / 2, -metrics.height / 2, metrics.width, metrics.height);
        ctx.setLineDash([]);
        ctx.fillStyle = '#9b7cff';
        ctx.beginPath();
        ctx.arc(0, -metrics.height / 2, Math.max(5, width / 150), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    return { composite, mask, width, height };
  }, [background, drawLayer, getCachedImage, getLayerMetrics, layers, outputSize, selectedId]);

  useEffect(() => {
    let cancelled = false;
    if (!background || !previewRef.current) return undefined;
    renderCanvases({ includeSelection: true }).then(({ composite }) => {
      if (cancelled || !previewRef.current) return;
      previewRef.current.width = composite.width;
      previewRef.current.height = composite.height;
      previewRef.current.getContext('2d').drawImage(composite, 0, 0);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [background, layers, selectedId, renderCanvases]);

  useEffect(() => () => {
    urlsRef.current.forEach(url => URL.revokeObjectURL(url));
    urlsRef.current.clear();
  }, []);

  const chooseBackground = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    urlsRef.current.add(url);
    try {
      const image = await loadImage(url);
      urlsRef.current.forEach(item => { if (item !== url) URL.revokeObjectURL(item); });
      urlsRef.current = new Set([url]);
      cacheRef.current.clear();
      setBackground({ file, url, width: image.naturalWidth, height: image.naturalHeight });
      setLayers([]);
      setSelectedId(null);
      setLocalError('');
    } catch {
      URL.revokeObjectURL(url);
      urlsRef.current.delete(url);
      setLocalError('Không đọc được ảnh nền.');
    } finally {
      event.target.value = '';
    }
  };

  const addLayers = async (event) => {
    const files = [...(event.target.files || [])];
    if (!files.length) return;
    const next = [];
    const failures = [];
    for (const [index, file] of files.entries()) {
      try {
        const prepared = await cropTransparentLayer(file);
        urlsRef.current.add(prepared.url);
        next.push({
          id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${index}`,
          file: prepared.file,
          url: prepared.url,
          name: file.name,
          x: 0.5 + ((index % 3) - 1) * 0.08,
          y: 0.5 + (Math.floor(index / 3) % 2) * 0.08,
          scale: 0.38,
          rotation: 0
        });
      } catch (error) { failures.push(error.message || `Không đọc được “${file.name}”.`); }
    }
    setLayers(current => [...current, ...next]);
    if (next[0]) setSelectedId(next[next.length - 1].id);
    setLocalError(failures[0] || (next.length ? '' : 'Không đọc được ảnh PNG đã chọn.'));
    event.target.value = '';
  };

  const updateSelected = (patch) => setLayers(current => current.map(layer => layer.id === selectedId ? { ...layer, ...patch } : layer));
  const selectedLayer = layers.find(layer => layer.id === selectedId);

  const removeSelected = () => {
    if (!selectedId) return;
    setLayers(current => {
      const target = current.find(layer => layer.id === selectedId);
      if (target) {
        URL.revokeObjectURL(target.url);
        urlsRef.current.delete(target.url);
      }
      return current.filter(layer => layer.id !== selectedId);
    });
    setSelectedId(null);
  };

  const moveLayer = (direction) => {
    setLayers(current => {
      const index = current.findIndex(layer => layer.id === selectedId);
      const nextIndex = Math.max(0, Math.min(current.length - 1, index + direction));
      if (index < 0 || index === nextIndex) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const pointerToCanvas = (event) => {
    const canvas = previewRef.current;
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * (canvas.width / rect.width), y: (event.clientY - rect.top) * (canvas.height / rect.height) };
  };

  const findLayerAt = async (point) => {
    if (!background) return null;
    const { width, height } = outputSize();
    for (const layer of [...layers].reverse()) {
      const image = await getCachedImage(layer.url);
      const metrics = getLayerMetrics(layer, image, width, height);
      if (point.x >= metrics.x - metrics.width / 2 && point.x <= metrics.x + metrics.width / 2 && point.y >= metrics.y - metrics.height / 2 && point.y <= metrics.y + metrics.height / 2) return layer;
    }
    return null;
  };

  const handlePointerDown = async (event) => {
    if (!background) return;
    const point = pointerToCanvas(event);
    const hit = await findLayerAt(point);
    if (!hit) { setSelectedId(null); return; }
    setSelectedId(hit.id);
    dragRef.current = { pointerId: event.pointerId, id: hit.id, point };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !previewRef.current) return;
    const point = pointerToCanvas(event);
    const { width, height } = outputSize();
    const deltaX = (point.x - drag.point.x) / width;
    const deltaY = (point.y - drag.point.y) / height;
    setLayers(current => current.map(layer => layer.id === drag.id ? {
      ...layer,
      x: Math.max(-0.25, Math.min(1.25, layer.x + deltaX)),
      y: Math.max(-0.25, Math.min(1.25, layer.y + deltaY))
    } : layer));
    drag.point = point;
  };

  const handlePointerEnd = (event) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const applyStudio = async () => {
    if (!background) return setLocalError('Chọn một ảnh nền gốc trước.');
    if (!layers.length) return setLocalError('Nhấn + để thêm ít nhất một ảnh PNG đã xóa nền.');
    if (serverOnline === false) return setLocalError('Chưa kết nối được máy AI.');
    setLocalError('');
    setIsApplying(true);
    try {
      const { composite, mask } = await renderCanvases();
      const stamp = Date.now();
      await onApply({
        image: await toFile(composite, `studio-composite-${stamp}.png`),
        mask: await toFile(mask, `studio-mask-${stamp}.png`),
        prompt: prompt.trim() || DEFAULT_PROMPT,
        sceneFixes,
        strength
      });
    } catch (error) {
      setLocalError(error.message || 'Không thể áp dụng bố cục.');
    } finally {
      setIsApplying(false);
    }
  };

  const toggleFix = (fix) => setSceneFixes(current => current.includes(fix) ? current.filter(item => item !== fix) : [...current, fix]);

  return (
    <div className="composition-studio">
      <div className="studio-header">
        <span className="inpaint-badge">Studio ghép ảnh</span>
        <p>Đặt ảnh nền gốc, thêm PNG nền trong suốt, rồi sắp xếp trước khi AI hòa cảnh. Studio tự cắt phần trong suốt thừa để mask ôm sát đối tượng.</p>
      </div>

      {!background ? (
        <button type="button" className="studio-empty" onClick={() => backgroundInputRef.current?.click()}>
          <strong>Chọn ảnh nền gốc</strong><small>Ảnh này là môi trường cuối cùng của bạn.</small>
        </button>
      ) : (
        <>
          <div className="studio-actions">
            <button type="button" className="secondary-btn" onClick={() => backgroundInputRef.current?.click()}>Đổi ảnh nền</button>
            <button type="button" className="primary-btn" onClick={() => overlayInputRef.current?.click()}>＋ Thêm ảnh đã xóa nền</button>
          </div>
          <div className="studio-canvas-wrap">
            <canvas
              ref={previewRef}
              className="studio-canvas"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
            />
            {!layers.length && <p className="studio-canvas-empty">Nhấn “Thêm ảnh đã xóa nền” để bắt đầu.</p>}
          </div>
          <p className="studio-drag-hint">Chạm và kéo ảnh đang chọn để đổi vị trí. Viền tím là lớp đang chỉnh.</p>

          {layers.length > 0 && (
            <section className="studio-layers">
              <div className="studio-section-head"><strong>Các ảnh đã thêm</strong><small>{layers.length} lớp</small></div>
              <div className="studio-layer-list">
                {layers.map((layer, index) => (
                  <button key={layer.id} type="button" className={layer.id === selectedId ? 'active' : ''} onClick={() => setSelectedId(layer.id)}>
                    <img src={layer.url} alt="" />
                    <span><strong>Ảnh {index + 1}</strong><small>{layer.name}</small></span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {selectedLayer && (
            <section className="studio-transform">
              <div className="studio-section-head"><strong>Chỉnh ảnh đang chọn</strong><button type="button" onClick={removeSelected}>Xóa ảnh</button></div>
              <label><span>Kích thước <b>{Math.round(selectedLayer.scale * 100)}%</b></span><input type="range" min="8" max="150" value={Math.round(selectedLayer.scale * 100)} onChange={event => updateSelected({ scale: Number(event.target.value) / 100 })} /></label>
              <label><span>Xoay <b>{selectedLayer.rotation}°</b></span><input type="range" min="-180" max="180" value={selectedLayer.rotation} onChange={event => updateSelected({ rotation: Number(event.target.value) })} /></label>
              <div className="studio-transform-actions">
                <button type="button" onClick={() => moveLayer(-1)}>Đưa xuống</button>
                <button type="button" onClick={() => moveLayer(1)}>Đưa lên</button>
                <button type="button" onClick={() => updateSelected({ x: 0.5, y: 0.5, scale: 0.38, rotation: 0 })}>Đặt lại</button>
              </div>
            </section>
          )}

          <section className="studio-fixes">
            <div className="studio-section-head"><strong>AI sẽ hòa những gì?</strong><small>Chọn lỗi cần AI ưu tiên</small></div>
            <div>{FIXES.map(([fix, label]) => <button key={fix} type="button" aria-pressed={sceneFixes.includes(fix)} className={sceneFixes.includes(fix) ? 'active' : ''} onClick={() => toggleFix(fix)}>{sceneFixes.includes(fix) ? '✓ ' : ''}{label}</button>)}</div>
          </section>
          <label className="studio-prompt">
            <span>Cường độ AI: {Math.round(strength * 100)}%</span>
            <input aria-label="Cường độ hòa cảnh" type="range" min="40" max="75" value={Math.round(strength * 100)} onChange={event => setStrength(Number(event.target.value) / 100)} />
            <small>Tăng cường độ cho phép đổi ánh sáng và chi tiết nhiều hơn, nhưng cũng dễ đổi khuôn mặt hoặc trang phục. Ảnh xem trước là bố cục gốc; kết quả AI xuất hiện sau Apply.</small>
          </label>
          <label className="studio-prompt"><span>Ý đồ chỉnh sửa</span><textarea value={prompt} maxLength="1000" onChange={event => setPrompt(event.target.value)} /></label>
        </>
      )}

      <input ref={backgroundInputRef} className="studio-file-input" type="file" accept="image/*" onChange={chooseBackground} />
      <input ref={overlayInputRef} className="studio-file-input" type="file" accept="image/png,image/webp" multiple onChange={addLayers} />
      {localError && <p className="studio-error">{localError}</p>}
      {background && <button type="button" className="submit-btn studio-apply" onClick={applyStudio} disabled={isLoading || isApplying || !layers.length}>
        {isLoading || isApplying ? 'Đang hòa ảnh…' : 'Áp dụng bố cục & hòa bằng AI'}
      </button>}
      {resultSlot}
    </div>
  );
}
