import { X } from "lucide-react";
import { animate, AnimatePresence, motion, useDragControls, useMotionValue, type PanInfo } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";

/** Where a flick would come to rest: Apple's deceleration projection (UIScrollView rate). */
export function project(velocity: number, decelerationRate = 0.998) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/**
 * Side sheet that slides in from the right and leaves the same way. It follows the pointer
 * 1:1 when dragged; on release the projected resting point, not the release point, decides
 * between closing and springing back, and the spring starts at the finger's velocity.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const x = useMotionValue(0);
  const panel = useRef<HTMLElement>(null);
  const controls = useDragControls();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const previous = document.activeElement as HTMLElement | null;
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus());
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      previous?.focus?.();
    };
  }, [open, onClose]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const width = panel.current?.offsetWidth ?? 480;
    if (x.get() + project(info.velocity.x) > width / 2) onClose();
    else animate(x, 0, { type: "spring", bounce: 0.15, duration: 0.4, velocity: info.velocity.x });
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.div
            className="absolute inset-0 bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />
          <motion.aside
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="absolute inset-y-0 right-0 flex w-full max-w-[480px] touch-pan-y flex-col border-l border-border bg-bg shadow-[var(--shadow)]"
            style={{ x }}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", bounce: 0, duration: 0.4 }}
            drag="x"
            dragDirectionLock
            dragListener={false}
            dragControls={controls}
            onPointerDown={(e) => {
              // Fields keep their own pointer behaviour (text selection); the rest of the sheet drags.
              if (!(e.target as HTMLElement).closest("input, select, textarea, button, a")) controls.start(e);
            }}
            dragConstraints={{ left: 0 }}
            // Rubber-band past the open position instead of a hard stop.
            dragElastic={{ left: 0.06, right: 0 }}
            dragMomentum={false}
            onDragEnd={onDragEnd}
          >
            <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
              <div>
                <h2 className="text-lg font-semibold title">{title}</h2>
                {description && <p className="mt-1 text-sm text-muted">{description}</p>}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="pressable -mr-2 rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-5">{children}</div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}
