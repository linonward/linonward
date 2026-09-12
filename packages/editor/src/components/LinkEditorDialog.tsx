import Modal from "./Modal";

export type LinkDraft = { from: number; to: number; text: string; href: string };

export default function LinkEditorDialog({
  draft,
  error,
  onChange,
  onClose,
  onSubmit,
  onRemove,
}: {
  draft: LinkDraft;
  error: string;
  onChange: (href: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  onRemove: () => void;
}) {
  return (
    <Modal
      title="编辑链接"
      description={draft.text ? `链接文本：${draft.text}` : "选择文本后即可添加链接。"}
      onClose={onClose}
      className="link-modal"
      footer={
        <>
          {draft.href && (
            <button type="button" className="link-remove" onClick={onRemove}>
              移除链接
            </button>
          )}
          <span />
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="link-confirm" form="link-editor-form">
            确定
          </button>
        </>
      }
    >
      <form
        id="link-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label>
          链接地址
          <input
            aria-label="链接地址"
            autoFocus
            placeholder="https://example.com"
            value={draft.href}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
        {error && <p className="link-modal-error">{error}</p>}
      </form>
    </Modal>
  );
}
