import React, { useEffect, useState } from "react";

// ── Global imperative confirm dialog ─────────────────────────────────────────
// Usage:  if (!(await confirmDialog({ message: "Delete this?" })) ) return;
// Mount <ConfirmDialogHost /> once near the app root.

export type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as a destructive (red) action. Default: true. */
  danger?: boolean;
};

type PendingRequest = ConfirmOptions & { resolve: (ok: boolean) => void };

let emit: ((req: PendingRequest | null) => void) | null = null;

/**
 * Show a confirmation dialog and resolve to `true` if the user confirms,
 * `false` if they cancel (or if no host is mounted).
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!emit) {
      // Fallback to the native dialog if the host isn't mounted.
      resolve(window.confirm(options.message));
      return;
    }
    emit({ ...options, resolve });
  });
}

export function ConfirmDialogHost() {
  const [req, setReq] = useState<PendingRequest | null>(null);

  useEffect(() => {
    emit = setReq;
    return () => {
      emit = null;
    };
  }, []);

  useEffect(() => {
    if (!req) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
      if (e.key === "Enter") close(true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  const close = (ok: boolean) => {
    if (req) req.resolve(ok);
    setReq(null);
  };

  if (!req) return null;

  const danger = req.danger !== false;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onClick={() => close(false)}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl px-6 py-5 flex flex-col gap-4 min-w-[280px] max-w-[420px]"
        onClick={(e) => e.stopPropagation()}
      >
        {req.title && <h3 className="text-sm font-semibold text-white">{req.title}</h3>}
        <p className="text-sm text-zinc-300 whitespace-pre-line">{req.message}</p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={() => close(false)}
            className="px-3 py-1.5 text-xs rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer transition-colors"
          >
            {req.cancelLabel ?? "Cancel"}
          </button>
          <button
            autoFocus
            onClick={() => close(true)}
            className={
              "px-3 py-1.5 text-xs rounded-md text-white cursor-pointer transition-colors " +
              (danger
                ? "bg-red-700 hover:bg-red-600"
                : "bg-indigo-600 hover:bg-indigo-500")
            }
          >
            {req.confirmLabel ?? "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
