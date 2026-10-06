import { useRef, useEffect, useState, useCallback } from 'react';
import './MaskEditor.css';

/**
 * Mobile-first mask editor.
 *
 * Props:
 *   image         : File  - ảnh gốc cần edit
 *   mask          : File | null - mask PNG (đen = giữ, trắng = vẽ) đã tạo trước
 *   onMaskChange  : (File|null) => void
 *   brushSize     : number
 *   onBrushSize   : (n) => void
 */
export default function MaskEditor({ image, mask, onMaskChange, brushSize, onBrushSize }) {
  const baseCanvasRef = useRef(null);
  const maskCanvasRef = useRef(null);
  const containerRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [tool, setTool] = useState('brush'); // 'brush' | 'eraser'
  const [showMask, setShowMask] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedMode, setExpandedMode] = useState('navigate'); // navigate | paint
  const [zoom, setZoom] = useState(1);
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });
  const lastPosRef = useRef(null);
  const historyRef = useRef([]);
  const pinchRef = useRef(null);

  // Load base image onto the base canvas
  useEffect(() => {
    if (!image) return;
    const url = URL.createObjectURL(image);
    const img = new Image();
    img.onload = () => {
      setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      const base = baseCanvasRef.current;
      if (!base) return;
      base.width = img.naturalWidth;
      base.height = img.naturalHeight;
      const ctx = base.getContext('2d');
      ctx.clearRect(0, 0, base.width, base.height);
      ctx.drawImage(img, 0, 0);

      const m = maskCanvasRef.current;
      if (m) {
        m.width = img.naturalWidth;
        m.height = img.naturalHeight;
        const mctx = m.getContext('2d');
        mctx.clearRect(0, 0, m.width, m.height);
      }
      historyRef.current = [];
      URL.revokeObjectURL(url);
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [image]);

  // Load mask file if provided
  useEffect(() => {
    if (!mask) return;
    const url = URL.createObjectURL(mask);
    const img = new Image();
    img.onload = () => {
      const m = maskCanvasRef.current;
      if (!m) return;
      m.width = img.naturalWidth;
      m.height = img.naturalHeight;
      const ctx = m.getContext('2d');
      ctx.clearRect(0, 0, m.width, m.height);
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, m.width, m.height);
      for (let i = 0; i < data.data.length; i += 4) {
        if (data.data[i + 3] > 0) {
          data.data[i] = 255;
          data.data[i + 1] = 72;
          data.data[i + 2] = 102;
          data.data[i + 3] = Math.round(data.data[i + 3] * 0.55);
        }
      }
      ctx.putImageData(data, 0, 0);
      URL.revokeObjectURL(url);
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [mask]);

  const getCanvasCoords = useCallback((e) => {
    const canvas = maskCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const point = e.touches ? e.touches[0] : e;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (point.clientX - rect.left) * scaleX,
      y: (point.clientY - rect.top) * scaleY
    };
  }, []);

  const drawStroke = useCallback((from, to) => {
    const ctx = maskCanvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = brushSize * (maskCanvasRef.current.width / 1024) * 2;
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    // The editor is red for clarity; exportMask converts it to a pure white
    // mask so ComfyUI receives white = edit and transparent/black = preserve.
    ctx.strokeStyle = 'rgba(255, 72, 102, 0.55)';
    ctx.fillStyle = 'rgba(255, 72, 102, 0.55)';

    ctx.beginPath();
    if (from) ctx.moveTo(from.x, from.y);
    else ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    // Dot at the very start so single taps leave a mark
    if (!from) {
      ctx.beginPath();
      ctx.arc(to.x, to.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }, [brushSize, tool]);

  const rememberMask = useCallback(() => {
    const canvas = maskCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    historyRef.current = [...historyRef.current.slice(-9), ctx.getImageData(0, 0, canvas.width, canvas.height)];
  }, []);

  const handleStart = (e) => {
    if (!image) return;
    if (e.touches?.length === 2) {
      e.preventDefault();
      const [first, second] = e.touches;
      pinchRef.current = {
        distance: Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
        zoom
      };
      setIsDrawing(false);
      return;
    }
    // In the expanded phone view, one finger belongs to navigation by
    // default. This lets the browser scroll the enlarged canvas naturally;
    // painting only starts after the user explicitly selects Brush or Eraser.
    if (isExpanded && expandedMode === 'navigate') return;
    e.preventDefault();
    rememberMask();
    setIsDrawing(true);
    const pos = getCanvasCoords(e);
    lastPosRef.current = null;
    drawStroke(null, pos);
  };

  const handleMove = (e) => {
    if (pinchRef.current && e.touches?.length === 2) {
      e.preventDefault();
      const [first, second] = e.touches;
      const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
      setZoom(Math.min(4, Math.max(1, pinchRef.current.zoom * (distance / pinchRef.current.distance))));
      return;
    }
    if (isExpanded && expandedMode === 'navigate') return;
    if (!isDrawing) return;
    e.preventDefault();
    const pos = getCanvasCoords(e);
    drawStroke(lastPosRef.current, pos);
    lastPosRef.current = pos;
  };

  const handleEnd = (e) => {
    if (pinchRef.current && (!e?.touches || e.touches.length < 2)) {
      pinchRef.current = null;
      return;
    }
    if (!isDrawing) return;
    setIsDrawing(false);
    lastPosRef.current = null;
    exportMask();
  };

  const exportMask = useCallback(() => {
    const m = maskCanvasRef.current;
    if (!m) return;
    const source = m.getContext('2d').getImageData(0, 0, m.width, m.height);
    const output = document.createElement('canvas');
    output.width = m.width;
    output.height = m.height;
    const outputCtx = output.getContext('2d');
    const normalized = outputCtx.createImageData(m.width, m.height);
    for (let i = 0; i < source.data.length; i += 4) {
      if (source.data[i + 3] > 8) {
        normalized.data[i] = 255;
        normalized.data[i + 1] = 255;
        normalized.data[i + 2] = 255;
        normalized.data[i + 3] = 255;
      }
    }
    outputCtx.putImageData(normalized, 0, 0);
    output.toBlob((blob) => {
      if (blob) {
        const file = new File([blob], `mask_${Date.now()}.png`, { type: 'image/png' });
        onMaskChange(file);
      }
    }, 'image/png');
  }, [onMaskChange]);

  const clearMask = () => {
    const ctx = maskCanvasRef.current?.getContext('2d');
    if (!ctx) return;
    rememberMask();
    ctx.clearRect(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height);
    onMaskChange(null);
  };

  const fillAll = () => {
    const ctx = maskCanvasRef.current?.getContext('2d');
    const m = maskCanvasRef.current;
    if (!ctx || !m) return;
    rememberMask();
    ctx.fillStyle = 'rgba(255, 72, 102, 0.55)';
    ctx.fillRect(0, 0, m.width, m.height);
    exportMask();
  };

  const undoMask = () => {
    const previous = historyRef.current.pop();
    const canvas = maskCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!previous || !ctx) return;
    ctx.putImageData(previous, 0, 0);
    exportMask();
  };

  if (!image) {
    return (
      <div className="mask-editor empty">
        <p>Chọn ảnh trước để bắt đầu tô vùng cần chỉnh sửa.</p>
      </div>
    );
  }

  return (
    <div className="mask-editor" ref={containerRef}>
      <div className="mask-toolbar">
        <button
          type="button"
          className={`tool-btn ${tool === 'brush' ? 'active' : ''}`}
          onClick={() => { setTool('brush'); setExpandedMode('paint'); }}
          aria-label="Cọ vẽ"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 0 1 4.03 4.03l-8.06 8.06M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
          </svg>
          <span className="tool-label">Cọ</span>
        </button>
        <button
          type="button"
          className={`tool-btn ${tool === 'eraser' ? 'active' : ''}`}
          onClick={() => { setTool('eraser'); setExpandedMode('paint'); }}
          aria-label="Tẩy"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 20H7L3 16c-1.1-1.1-1.1-2.9 0-4L13 2l8 8-9 9" />
            <line x1="18" y1="13" x2="9" y2="4" />
          </svg>
          <span className="tool-label">Tẩy</span>
        </button>
        <button type="button" className="tool-btn" onClick={fillAll} aria-label="Tô toàn bộ">
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1">
            <rect x="4" y="4" width="16" height="16" rx="2" />
          </svg>
          <span className="tool-label">Toàn bộ</span>
        </button>
        <button type="button" className="tool-btn" onClick={undoMask} disabled={!historyRef.current.length} aria-label="Hoàn tác">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10a6 6 0 0 1 0 12h-1" />
          </svg>
          <span className="tool-label">Hoàn tác</span>
        </button>
        <button type="button" className="tool-btn" onClick={clearMask} aria-label="Xóa mask">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
          </svg>
          <span className="tool-label">Xóa</span>
        </button>
        <button
          type="button"
          className={`tool-btn ${showMask ? 'active' : ''}`}
          onClick={() => setShowMask((v) => !v)}
          aria-label={showMask ? 'Ẩn mask' : 'Hiện mask'}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span className="tool-label">{showMask ? 'Ẩn màu' : 'Hiện màu'}</span>
        </button>
      </div>

      <div
        className={`mask-canvas-wrap ${isExpanded ? 'is-expanded' : ''} ${isExpanded && expandedMode === 'navigate' ? 'is-navigating' : ''}`}
        style={!isExpanded && naturalSize.w && naturalSize.h ? { aspectRatio: `${naturalSize.w} / ${naturalSize.h}` } : undefined}
        onTouchStart={handleStart}
        onTouchMove={handleMove}
        onTouchEnd={handleEnd}
        onTouchCancel={handleEnd}
      >
        {isExpanded && (
          <div className="mask-zoom-controls">
            <button type="button" className={expandedMode === 'navigate' ? 'active' : ''} onClick={() => setExpandedMode('navigate')}>Di chuyển</button>
            <button type="button" className={expandedMode === 'paint' && tool === 'brush' ? 'active' : ''} onClick={() => { setTool('brush'); setExpandedMode('paint'); }}>Cọ</button>
            <button type="button" className={expandedMode === 'paint' && tool === 'eraser' ? 'active' : ''} onClick={() => { setTool('eraser'); setExpandedMode('paint'); }}>Tẩy</button>
            <button type="button" onClick={() => setZoom(value => Math.max(1, value - 0.5))}>−</button>
            <strong>{zoom === 1 ? 'Vừa màn' : `${Math.round(zoom * 100)}%`}</strong>
            <button type="button" onClick={() => setZoom(value => Math.min(4, value + 0.5))}>+</button>
            <button type="button" className="mask-zoom-close" onClick={() => { setIsExpanded(false); setExpandedMode('navigate'); setZoom(1); }}>Xong</button>
          </div>
        )}
        <div
          className="mask-canvas-stage"
          style={{
            aspectRatio: naturalSize.w && naturalSize.h ? `${naturalSize.w} / ${naturalSize.h}` : '1 / 1',
            width: isExpanded ? `${zoom * 100}%` : undefined
          }}
        >
          <canvas ref={baseCanvasRef} className="base-canvas" />
          <canvas
            ref={maskCanvasRef}
            className={`mask-canvas ${showMask ? 'visible' : ''}`}
            onMouseDown={handleStart}
            onMouseMove={handleMove}
            onMouseUp={handleEnd}
            onMouseLeave={handleEnd}
            style={isExpanded && expandedMode === 'navigate' ? { pointerEvents: 'none' } : undefined}
          />
        </div>
        {!isExpanded && <button type="button" className="mask-expand-trigger" onClick={() => { setExpandedMode('navigate'); setIsExpanded(true); }}>Phóng to để tô chi tiết</button>}
      </div>

      <div className="brush-control">
        <label>
          <span>Cọ: <strong>{brushSize}px</strong></span>
          <input
            type="range"
            min="1"
            max="60"
            value={brushSize}
            onChange={(e) => onBrushSize(parseInt(e.target.value, 10))}
          />
        </label>
      </div>
    </div>
  );
}
