import type { Toast } from '../hooks/useToasts';
import styles from './ToastLayer.module.css';

type ToastLayerProps = {
  toasts: Toast[];
  onPause: (toastID: number) => void;
  onResume: (toastID: number) => void;
  onDismiss: (toastID: number) => void;
};

export function ToastLayer({ toasts, onPause, onResume, onDismiss }: ToastLayerProps) {
  return (
    <aside className={styles.stack} aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <article
          className={`${styles.toast} ${styles[toast.kind]}`}
          key={toast.id}
          onMouseEnter={() => onPause(toast.id)}
          onMouseLeave={() => onResume(toast.id)}
        >
          <p>{toast.text}</p>
          <button
            aria-label="关闭提示"
            className={styles.close}
            onClick={() => onDismiss(toast.id)}
            type="button"
          >
            ×
          </button>
        </article>
      ))}
    </aside>
  );
}
