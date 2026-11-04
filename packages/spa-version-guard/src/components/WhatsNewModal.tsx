import React, { useState, useEffect, useCallback } from 'react';
import type { WhatsNewModalProps, VersionChangeItem } from '../types';

export const DEFAULT_WHATS_NEW_STORAGE_KEY = 'kt_seen_app_version';

/**
 * Built-in fallback icon render helper for changelog items
 */
function renderItemIcon(icon?: string) {
  if (!icon) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
    );
  }

  // If icon is an svg string
  if (icon.trim().startsWith('<svg')) {
    return <span dangerouslySetInnerHTML={{ __html: icon }} />;
  }

  // Material symbols / lucide icon name
  return <span className="material-symbols-outlined text-[22px]">{icon}</span>;
}

/**
 * WhatsNewModal component:
 * Modal displaying release notes and changelog when user opens app after a new deployment.
 * Persists seen version in localStorage to prevent repeated popups.
 */
export function WhatsNewModal({
  release,
  forceOpen = false,
  isOpen: controlledIsOpen,
  storageKey = DEFAULT_WHATS_NEW_STORAGE_KEY,
  onClose,
  onAction,
  actionLabel = 'BẮT ĐẦU TRẢI NGHIỆM',
  className = '',
}: WhatsNewModalProps) {
  const [internalIsOpen, setInternalIsOpen] = useState(forceOpen);

  const isControlled = controlledIsOpen !== undefined;
  const isVisible = isControlled ? controlledIsOpen : internalIsOpen;

  useEffect(() => {
    if (forceOpen) {
      setInternalIsOpen(true);
      return;
    }

    if (!release?.version) return;

    if (typeof window !== 'undefined') {
      try {
        const seenVersion = localStorage.getItem(storageKey);
        if (seenVersion !== release.version) {
          // Slight delay to allow first frame paint
          const timer = setTimeout(() => setInternalIsOpen(true), 600);
          return () => clearTimeout(timer);
        }
      } catch {
        // Storage access fallback
      }
    }
  }, [forceOpen, release?.version, storageKey]);

  const markVersionAsSeen = useCallback(() => {
    if (typeof window !== 'undefined' && release?.version) {
      try {
        localStorage.setItem(storageKey, release.version);
      } catch {
        // Storage quota / sandbox ignore
      }
    }
  }, [release?.version, storageKey]);

  const handleDismiss = useCallback(() => {
    markVersionAsSeen();
    setInternalIsOpen(false);
    onClose?.();
  }, [markVersionAsSeen, onClose]);

  const handleAction = useCallback(() => {
    markVersionAsSeen();
    setInternalIsOpen(false);
    if (onAction) {
      onAction();
    } else {
      onClose?.();
    }
  }, [markVersionAsSeen, onAction, onClose]);

  // Close on Escape key
  useEffect(() => {
    if (!isVisible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleDismiss();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isVisible, handleDismiss]);

  if (!isVisible || !release) return null;

  return (
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
      onClick={handleDismiss}
      role="dialog"
      aria-modal="true"
      aria-labelledby="whats-new-title"
    >
      <div
        className={`relative w-full max-w-[420px] max-h-[88vh] overflow-hidden rounded-3xl bg-[#0D121F] border border-sky-500/30 shadow-[0_0_50px_rgba(56,189,248,0.25)] flex flex-col text-white ${className}`}
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '420px',
          maxHeight: '88vh',
          overflow: 'hidden',
          borderRadius: '24px',
          backgroundColor: '#0D121F',
          border: '1px solid rgba(56, 189, 248, 0.3)',
          boxShadow: '0 0 50px rgba(56, 189, 248, 0.25)',
          display: 'flex',
          flexDirection: 'column',
          color: '#FFFFFF',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Glow ambient background effect */}
        <div
          style={{
            position: 'absolute',
            top: '-96px',
            right: '-96px',
            width: '192px',
            height: '192px',
            backgroundColor: 'rgba(56, 189, 248, 0.2)',
            borderRadius: '9999px',
            filter: 'blur(48px)',
            pointerEvents: 'none',
          }}
        />
        <div
          style={{
            position: 'absolute',
            bottom: '-96px',
            left: '-96px',
            width: '192px',
            height: '192px',
            backgroundColor: 'rgba(6, 182, 212, 0.15)',
            borderRadius: '9999px',
            filter: 'blur(48px)',
            pointerEvents: 'none',
          }}
        />

        {/* Modal Header */}
        <div
          className="relative pt-6 px-6 pb-4 border-b border-white/10 flex items-start justify-between"
          style={{
            position: 'relative',
            paddingTop: '24px',
            paddingLeft: '24px',
            paddingRight: '24px',
            paddingBottom: '16px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
          }}
        >
          <div className="flex flex-col gap-1.5" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div className="flex items-center gap-2" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span
                className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold tracking-wider uppercase bg-sky-500/15 text-sky-400 border border-sky-500/30"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '2px 10px',
                  borderRadius: '9999px',
                  fontSize: '11px',
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                  backgroundColor: 'rgba(56, 189, 248, 0.15)',
                  color: '#38BDF8',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                }}
              >
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '9999px',
                    backgroundColor: '#38BDF8',
                  }}
                />
                PHIÊN BẢN {release.version}
              </span>
              <span
                className="text-[11px] text-slate-400 font-mono"
                style={{ fontSize: '11px', color: '#94A3B8', fontFamily: 'monospace' }}
              >
                {release.releaseDate}
              </span>
            </div>
            <h2
              id="whats-new-title"
              className="text-xl font-bold text-white tracking-tight"
              style={{
                fontSize: '20px',
                fontWeight: 700,
                color: '#FFFFFF',
                letterSpacing: '-0.025em',
                margin: 0,
              }}
            >
              {release.title}
            </h2>
            {release.subtitle && (
              <p
                className="text-xs text-slate-400"
                style={{ fontSize: '12px', color: '#94A3B8', margin: 0, lineHeight: 1.4 }}
              >
                {release.subtitle}
              </p>
            )}
          </div>

          <button
            onClick={handleDismiss}
            aria-label="Đóng"
            className="w-8 h-8 rounded-full flex items-center justify-center bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '9999px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(255, 255, 255, 0.05)',
              border: 'none',
              color: '#94A3B8',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable Changelog Items */}
        <div
          className="flex-1 overflow-y-auto px-6 py-4 space-y-3.5"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          {release.changes.map((item: VersionChangeItem, idx: number) => (
            <div
              key={idx}
              className="p-3.5 rounded-2xl bg-white/[0.03] hover:bg-white/[0.05] border border-white/[0.08] transition-all flex items-start gap-3.5"
              style={{
                padding: '14px',
                borderRadius: '16px',
                backgroundColor: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '14px',
              }}
            >
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center bg-sky-500/10 border border-sky-500/20 text-sky-400 shrink-0 mt-0.5"
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: 'rgba(56, 189, 248, 0.1)',
                  border: '1px solid rgba(56, 189, 248, 0.2)',
                  color: '#38BDF8',
                  flexShrink: 0,
                  marginTop: '2px',
                }}
              >
                {renderItemIcon(item.icon)}
              </div>
              <div className="flex-1 min-w-0" style={{ flex: 1, minWidth: 0 }}>
                <div
                  className="flex items-center gap-2 mb-1 flex-wrap"
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}
                >
                  <h3
                    className="text-sm font-bold text-slate-100"
                    style={{ fontSize: '14px', fontWeight: 700, color: '#F1F5F9', margin: 0 }}
                  >
                    {item.title}
                  </h3>
                  {item.badge && (
                    <span
                      className={`px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider border ${
                        item.badgeColor || 'text-sky-400 border-sky-500/30 bg-sky-500/10'
                      }`}
                      style={{
                        padding: '1px 6px',
                        borderRadius: '4px',
                        fontSize: '9px',
                        fontWeight: 700,
                        letterSpacing: '0.05em',
                      }}
                    >
                      {item.badge}
                    </span>
                  )}
                </div>
                <p
                  className="text-xs text-slate-300 leading-relaxed"
                  style={{ fontSize: '12px', color: '#CBD5E1', lineHeight: 1.5, margin: 0 }}
                >
                  {item.description}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Footer Action */}
        <div
          className="p-4 border-t border-white/10 bg-[#0A0E18]/80 backdrop-blur-md"
          style={{
            padding: '16px',
            borderTop: '1px solid rgba(255, 255, 255, 0.1)',
            backgroundColor: 'rgba(10, 14, 24, 0.8)',
            backdropFilter: 'blur(12px)',
          }}
        >
          <button
            onClick={handleAction}
            className="w-full py-3.5 px-4 rounded-xl font-bold text-sm tracking-wide text-white bg-gradient-to-r from-sky-500 via-cyan-500 to-blue-600 hover:opacity-95 active:scale-[0.99] transition-all shadow-[0_0_20px_rgba(56,189,248,0.35)] flex items-center justify-center gap-2"
            style={{
              width: '100%',
              padding: '14px 16px',
              borderRadius: '12px',
              fontWeight: 700,
              fontSize: '14px',
              letterSpacing: '0.025em',
              color: '#FFFFFF',
              background: 'linear-gradient(to right, #0EA5E9, #06B6D4, #2563EB)',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              boxShadow: '0 0 20px rgba(56, 189, 248, 0.35)',
            }}
          >
            <span>{actionLabel}</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

export default WhatsNewModal;
