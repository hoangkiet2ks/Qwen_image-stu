import ImageUpload from './ImageUpload';
import PromptInput from './PromptInput';
import DenoiseSlider from './DenoiseSlider';
import MaskEditor from './MaskEditor';
import SavedPromptsManager from './SavedPromptsManager';
import ModelSelector from './ModelSelector';
import PoseReferencePicker from './PoseReferencePicker';

/**
 * Combined panel for the Inpaint workflow.
 *  1. Choose image
 *  2. Paint mask on the image
 *  3. Describe what to change
 *  4. Adjust denoise
 */
export default function InpaintPanel({
  mode = 'inpaint',
  image,
  mask,
  brushSize,
  growMask,
  steps,
  skinToneMatch,
  poseReference,
  onPoseReferenceChange,
  selectedModel,
  onImageChange,
  onImageClear,
  onMaskChange,
  onBrushSizeChange,
  onGrowMaskChange,
  onSkinToneMatchChange,
  sceneFixes = [],
  onSceneFixesChange,
  onStepsChange,
  onModelChange,
  prompt,
  onPromptChange,
  denoise,
  onDenoiseChange,
  onLoadPrompt,
  intentSlot,
  resultSlot
}) {
  const isReconstruction = mode === 'reconstruct';
  const isSceneIntegration = mode === 'scene';
  const isPose = mode === 'pose';
  const title = isPose ? 'Đổi tư thế theo ảnh ref' : isSceneIntegration ? 'Hòa ảnh ghép vào nền' : isReconstruction ? 'Tái tạo vùng lớn' : 'Tô vùng cần sửa';
  const description = isSceneIntegration
    ? 'Làm cho nhân vật và môi trường cùng một cảnh: khớp viền, ánh sáng, bóng và texture.'
    : isPose
    ? 'Chọn một tư thế REF-02 và tô vùng cơ thể cần dựng lại trên ảnh gốc.'
    : isReconstruction
    ? 'Tô vùng trang phục hoặc vật thể lớn cần tái tạo. Vùng ngoài nét tô được ưu tiên giữ nguyên.'
    : 'Chỉ vùng tô màu sẽ được AI thay đổi. Phần còn lại được giữ nguyên.';
  const stepOptions = isReconstruction
    ? [[4, 'Ít'], [6, 'Trung bình'], [8, 'Nhiều']]
    : [[4, 'Ít'], [6, 'Trung bình'], [8, 'Nhiều']];
  const sceneFixOptions = [
    ['edge', 'Viền & tóc', 'Mép nhân vật hòa tự nhiên với nền'],
    ['lighting', 'Ánh sáng & màu', 'Khớp tông và hướng sáng của cảnh'],
    ['shadow', 'Bóng tiếp xúc', 'Không bị cảm giác lơ lửng'],
    ['texture', 'Độ nét & texture', 'Khớp hạt ảnh và chi tiết bề mặt']
  ];

  const toggleSceneFix = (value) => {
    if (!onSceneFixesChange) return;
    onSceneFixesChange(sceneFixes.includes(value)
      ? sceneFixes.filter(item => item !== value)
      : [...sceneFixes, value]);
  };

  return (
    <div className="inpaint-panel">
      <div className={`inpaint-header ${isReconstruction ? 'reconstruction-header' : ''}`}>
        <div>
          <span className="inpaint-badge">{title}</span>
          <p>{description}</p>
        </div>
        <span className="inpaint-shield" aria-hidden="true">✦</span>
      </div>

      <ol className="inpaint-steps" aria-label="Các bước tạo ảnh">
        <li className={image ? 'done' : 'active'}><span>1</span> Chọn ảnh</li>
        {isPose && <li className={poseReference ? 'done' : image ? 'active' : ''}><span>2</span> Chọn tư thế</li>}
        <li className={mask ? 'done' : image ? 'active' : ''}><span>{isPose ? 3 : 2}</span> Tô vùng</li>
        <li className={mask && prompt.trim() && (!isPose || poseReference) ? 'done' : mask ? 'active' : ''}><span>{isPose ? 4 : 3}</span> Tạo ảnh</li>
      </ol>

      {isPose && <PoseReferencePicker reference={poseReference} onChange={onPoseReferenceChange} />}

      {!image ? (
        <ImageUpload
          image={image}
          onImageChange={onImageChange}
          onClear={() => {
            onImageClear();
          }}
          label="Ảnh cần chỉnh sửa"
        />
      ) : (
        <>
          <div className="inpaint-image-bar">
            <span className="section-label">Vùng cần chỉnh sửa</span>
          <div className="inpaint-image-bar-row">
            <img
              src={URL.createObjectURL(image)}
              alt="source"
              className="inpaint-image-thumb"
            />
            <button
              type="button"
              className="secondary-btn"
              onClick={() => {
                onImageClear();
              }}
            >
              Đổi ảnh
            </button>
          </div>
          </div>

          <MaskEditor
            image={image}
            mask={mask}
            onMaskChange={onMaskChange}
            brushSize={brushSize}
            onBrushSize={onBrushSizeChange}
          />

          {isReconstruction && (
            <div className="reconstruction-guide" role="note">
              <span aria-hidden="true">i</span>
              <p><strong>Mẹo để giữ dáng tự nhiên:</strong> tô trùm toàn bộ chi tiết cần thay, nhưng tránh lấn sang mặt, bàn tay hoặc mép cơ thể nếu các vùng đó không cần đổi. Dùng “Phóng to để tô chi tiết” để xử lý phần giáp ranh.</p>
            </div>
          )}

          {isPose && <div className="reconstruction-guide" role="note">
            <span aria-hidden="true">i</span>
            <p>Tô toàn bộ thân và các chi cần đổi tư thế, kể cả vị trí mới dự kiến. Nếu muốn giữ nguyên khuôn mặt, để mặt ngoài vùng tô. Đổi vị trí đầu có thể cần tô cả đầu và chỉnh lại mặt ở lượt sau.</p>
          </div>}

          {isSceneIntegration && (
            <section className="scene-integration-guide" aria-label="Thiết lập hòa ảnh ghép">
              <div>
                <strong>AI cần xử lý gì?</strong>
                <small>Chọn các lỗi bạn đang thấy trong ảnh ghép.</small>
              </div>
              <div className="scene-fix-grid">
                {sceneFixOptions.map(([value, label, help]) => (
                  <button
                    key={value}
                    type="button"
                    className={sceneFixes.includes(value) ? 'active' : ''}
                    onClick={() => toggleSceneFix(value)}
                    aria-pressed={sceneFixes.includes(value)}
                  >
                    <strong>{label}</strong>
                    <small>{help}</small>
                  </button>
                ))}
              </div>
              <p><b>Cách tô:</b> tô một dải hẹp ôm theo viền nhân vật và vùng chạm nền. Chỉ tô toàn thân khi cần AI chỉnh cả tư thế hoặc cấu trúc.</p>
            </section>
          )}

          <div className={`inpaint-mask-status ${mask ? 'ready' : ''}`}>
            <span>{mask ? '✓' : '!'}</span>
            <p>{mask
              ? (isSceneIntegration ? 'Đã chọn vùng cần hòa vào nền. Chọn lỗi cần sửa và mô tả ngắn bên dưới.' : 'Đã chọn vùng sửa. Mô tả điều bạn muốn thay đổi bên dưới.')
              : (isSceneIntegration ? 'Dùng cọ tô dải viền và vùng tiếp xúc giữa nhân vật với nền.' : 'Dùng cọ để tô đúng vùng bạn muốn AI thay đổi.')}
            </p>
          </div>

          <label className="mask-growth-control">
            <span>
              <strong>Mở rộng mép vùng tô</strong>
              <small>{growMask}px · giúp mép ghép tự nhiên hơn</small>
            </span>
            <input
              type="range"
              min="0"
              max="32"
              value={growMask}
              onChange={(event) => onGrowMaskChange(parseInt(event.target.value, 10))}
            />
          </label>

          <label className="skin-tone-match-control">
            <span>
              <strong>Khớp màu da với mặt gốc</strong>
              <small>Chỉ cân tông da vùng AI tạo để gần với mặt được giữ lại.</small>
            </span>
            <input
              type="checkbox"
              checked={skinToneMatch}
              onChange={(event) => onSkinToneMatchChange(event.target.checked)}
            />
          </label>

          {resultSlot}
        </>
      )}

      {image && (
        <>
          <PromptInput prompt={prompt} onPromptChange={onPromptChange} />
          {intentSlot}
          <DenoiseSlider denoise={denoise} onDenoiseChange={onDenoiseChange} />
          <section className="inpaint-quality" aria-label="Chất lượng inpaint">
            <div><strong>Chất lượng tạo ảnh</strong><small>Ảnh chi tiết hơn sẽ mất thời gian lâu hơn</small></div>
            <div className="step-choice" role="group" aria-label="Số bước tạo ảnh">
              {stepOptions.map(([value, label]) => (
                <button key={value} type="button" className={steps === value ? 'active' : ''} onClick={() => onStepsChange(value)}>
                  <strong>{label}</strong><small>{value} bước</small>
                </button>
              ))}
            </div>
          </section>
          <details className="advanced-options inpaint-model-options">
            <summary>Tùy chọn mô hình</summary>
            <ModelSelector value={selectedModel} onChange={onModelChange} />
          </details>
          {denoise > 0.88 && (
            <p className="inpaint-denoise-warning">
              Cường độ trên 0.88 dễ làm AI vẽ lại chi tiết mạnh hơn cần thiết. Với vùng lớn, 0.72–0.82 thường giữ hình dáng tốt hơn.
            </p>
          )}
          <SavedPromptsManager
            currentPrompt={prompt}
            currentDenoise={denoise}
            onLoad={onLoadPrompt}
          />
        </>
      )}
    </div>
  );
}
