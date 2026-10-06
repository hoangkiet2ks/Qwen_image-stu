import './PromptInput.css';

export default function PromptInput({ prompt, onPromptChange }) {
  return (
    <div className="prompt-input">
      <label className="section-label" htmlFor="prompt">
        Chỉ dẫn chỉnh sửa
      </label>
      <textarea
        id="prompt"
        className="prompt-textarea"
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        placeholder="Mô tả thay đổi bạn muốn… ví dụ: thay áo dài bằng áo cổ điển, đổi nền thành hoàng hôn"
        rows={4}
        maxLength={1000}
      />
      <div className="char-count">{prompt.length} / 1000</div>
    </div>
  );
}
