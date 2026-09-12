import { Pencil, Trash2 } from "lucide-react";

export default function ImageEditToolbar({
  anchor,
  onEdit,
  onDelete,
}: {
  anchor: { left: number; top: number; placeBelow: boolean };
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="image-edit-toolbar"
      role="toolbar"
      aria-label="图片编辑工具"
      style={{
        left: anchor.left,
        top: anchor.top,
        transform: anchor.placeBelow ? "translateX(-50%)" : "translate(-50%, -100%)",
      }}
    >
      <button
        type="button"
        className="image-edit-tool"
        title="编辑图片"
        aria-label="编辑图片"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onEdit}
      >
        <Pencil size={18} />
      </button>
      <button
        type="button"
        className="image-edit-tool image-delete-tool"
        title="删除图片"
        aria-label="删除图片"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onDelete}
      >
        <Trash2 size={18} />
      </button>
    </div>
  );
}
