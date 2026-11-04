import React from 'react';
import type { VersionGuardBannerProps } from '../types';

/**
 * Floating update banner displayed when a new version is detected and reloading is in progress.
 * Built-in accessible role="status", polite aria-live, zero-dependency SVG spinner, and
 * inline-style fallbacks for non-Tailwind environments.
 */
export function VersionGuardBanner({
  isUpdating,
  message = 'Đang cập nhật phiên bản mới nhất...',
  spinnerColor = '#F97316',
  className = '',
  style,
  showSpinner = true,
}: VersionGuardBannerProps) {
  if (!isUpdating) return null;

  const defaultContainerStyle: React.CSSProperties = {
    position: 'fixed',
    top: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 99999,
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '14px 24px',
    backgroundColor: 'rgba(22, 24, 34, 0.95)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid rgba(249, 115, 22, 0.6)',
    borderRadius: '16px',
    boxShadow: '0 20px 25px -5px rgba(249, 115, 22, 0.25), 0 8px 10px -6px rgba(249, 115, 22, 0.25)',
    color: '#FFFFFF',
    fontFamily:
      'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    pointerEvents: 'none',
    ...style,
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed top-4 left-1/2 -translate-x-1/2 z-[99999] flex items-center gap-3 px-6 py-3.5 bg-[#161822]/95 backdrop-blur-md border border-orange-500/60 rounded-2xl shadow-2xl shadow-orange-500/25 text-white ${className}`}
      style={defaultContainerStyle}
    >
      {showSpinner && (
        <svg
          className="animate-spin"
          style={{
            width: '20px',
            height: '20px',
            flexShrink: 0,
            animation: 'kt-spin 1s linear infinite',
          }}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <style>
            {`
              @keyframes kt-spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
              }
            `}
          </style>
          <circle
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="3"
            strokeOpacity="0.25"
          />
          <path
            d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
            fill={spinnerColor}
          />
        </svg>
      )}
      <span
        className="text-sm font-semibold tracking-wide text-orange-400"
        style={{
          fontSize: '14px',
          fontWeight: 600,
          letterSpacing: '0.025em',
          color: '#FB923C',
          whiteSpace: 'nowrap',
        }}
      >
        {message}
      </span>
    </div>
  );
}

export default VersionGuardBanner;
