import React from 'react';

export interface IconProps {
  className?: string;
  size?: number | string;
  color?: string;
}

export const CloseIcon: React.FC<IconProps> = ({
  className = 'w-4 h-4',
  size = 16,
  color = 'currentColor',
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export const ArrowRightIcon: React.FC<IconProps> = ({
  className = 'w-4 h-4',
  size = 16,
  color = 'currentColor',
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <line x1="5" y1="12" x2="19" y2="12" />
    <polyline points="12 5 19 12 12 19" />
  </svg>
);

export const ArrowLeftIcon: React.FC<IconProps> = ({
  className = 'w-4 h-4',
  size = 16,
  color = 'currentColor',
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <line x1="19" y1="12" x2="5" y2="12" />
    <polyline points="12 19 5 12 12 5" />
  </svg>
);

export const ChevronRightIcon: React.FC<IconProps> = ({
  className = 'w-4 h-4',
  size = 16,
  color = 'currentColor',
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

export const ChevronLeftIcon: React.FC<IconProps> = ({
  className = 'w-4 h-4',
  size = 16,
  color = 'currentColor',
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

export const SparklesIcon: React.FC<IconProps> = ({
  className = 'w-4 h-4',
  size = 16,
  color = 'currentColor',
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    <path d="M5 3v4" />
    <path d="M19 17v4" />
    <path d="M3 5h4" />
    <path d="M17 19h4" />
  </svg>
);

export const CheckIcon: React.FC<IconProps> = ({
  className = 'w-4 h-4',
  size = 16,
  color = 'currentColor',
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const CompassIcon: React.FC<IconProps> = ({
  className = 'w-4 h-4',
  size = 16,
  color = 'currentColor',
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="10" />
    <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
  </svg>
);

/**
 * Universal icon renderer that smoothly handles ComponentType, ReactNode, or emoji string
 */
export function renderStepIcon(
  icon: React.ComponentType<{ className?: string }> | React.ReactNode | string | undefined,
  defaultComponent: React.FC<IconProps> = CompassIcon,
  className = 'w-4 h-4'
): React.ReactNode {
  if (!icon) {
    const Default = defaultComponent;
    return <Default className={className} />;
  }

  if (typeof icon === 'string') {
    // If it's a short string (like emoji or symbol)
    if (icon.length <= 4) {
      return <span className="text-base select-none leading-none">{icon}</span>;
    }
    // String identifier fallback
    const Default = defaultComponent;
    return <Default className={className} />;
  }

  if (typeof icon === 'function') {
    const CustomIcon = icon as React.ComponentType<{ className?: string }>;
    return <CustomIcon className={className} />;
  }

  // Raw React element / ReactNode
  return icon;
}
