import './PromptIntentPlan.css';

const workflowName = {
  edit: 'Chỉnh sửa ảnh',
  inpaint: 'Tô vùng cần sửa',
  reconstruct: 'Tái tạo vùng lớn',
  scene: 'Hòa ảnh ghép vào nền'
};

export default function PromptIntentPlan({ plan, targetScope, isApplied, loading, onScopeChange, onResolve, onApply }) {
  return (
    <section className="intent-plan" aria-live="polite">
      <div className="intent-plan-head">
        <div>
          <span className="section-label">App hiểu yêu cầu</span>
          <p>Kiểm tra prompt, workflow và tham số trước khi tạo ảnh.</p>
        </div>
        <button type="button" className="secondary-btn intent-resolve" onClick={onResolve} disabled={loading}>
          {loading ? 'Đang phân tích…' : plan ? 'Phân tích lại' : 'Phân tích yêu cầu'}
        </button>
      </div>

      <div className="intent-scope" role="group" aria-label="Số vật thể cần sửa">
        <span>Số vật thể cần sửa</span>
        <div className="intent-scope-options">
          <button
            type="button"
            className={targetScope === 'single' ? 'active' : ''}
            onClick={() => onScopeChange('single')}
          >
            1 vật thể
          </button>
          <button
            type="button"
            className={targetScope === 'multiple' ? 'active' : ''}
            onClick={() => onScopeChange('multiple')}
          >
            Nhiều vật thể
          </button>
        </div>
        <small>
          {targetScope === 'multiple'
            ? 'Tô riêng từng vật thể; app sẽ yêu cầu AI xử lý từng vùng tô rời nhau.'
            : 'Chỉ tô vùng của một vật thể; các vật thể còn lại được ưu tiên giữ nguyên.'}
        </small>
      </div>

      {plan && (
        <div className="intent-plan-result">
          <div className="intent-tags">
            <strong>{plan.label}</strong>
            <span>{workflowName[plan.recommendedFeature] || 'Chỉnh sửa ảnh'}</span>
            <span>{plan.targetScopeLabel}</span>
            {plan.matchedKeywords?.length > 0 && <small>Từ khóa: {plan.matchedKeywords.join(', ')}</small>}
          </div>
          <p className="intent-plan-summary">
            Đề xuất: denoise <b>{Math.round(plan.parameters.denoise * 100)}</b>, {plan.parameters.steps} bước,
            {` mở rộng mask ${plan.parameters.growMask}px`}
            {plan.parameters.skinToneMatch ? ', khớp màu da bật.' : '.'}
          </p>
          <details className="intent-expanded-prompt">
            <summary>Xem prompt Qwen sau khi mở rộng</summary>
            <pre>{plan.expandedPrompt}</pre>
            <p><b>Negative:</b> {plan.negativePrompt}</p>
          </details>
          <button type="button" className="primary-btn intent-apply" onClick={onApply}>
            {isApplied ? 'Đã áp dụng · áp dụng lại' : 'Áp dụng gợi ý'}
          </button>
        </div>
      )}
    </section>
  );
}
