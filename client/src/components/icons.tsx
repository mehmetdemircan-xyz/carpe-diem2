import { memo, type SVGProps } from 'react';

/**
 * Hand-rolled icon set rather than an icon package: this is every glyph the
 * app uses, it tree-shakes to nothing unused, and it saves ~40KB of
 * dependency for twelve paths.
 */

type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps) {
  return {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...props,
    className: `h-5 w-5 ${props.className ?? ''}`,
  };
}

export const MicOnIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <rect x="9" y="2.5" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
  </svg>
));

export const MicOffIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <path d="M15 5a3 3 0 0 0-6 0v4m0 2.5a3 3 0 0 0 5.2 2" />
    <path d="M5.5 11a6.5 6.5 0 0 0 10 5.5M18.5 11a6.5 6.5 0 0 1-.4 2.2M12 17.5V21M8.5 21h7" />
    <path d="M3 3l18 18" />
  </svg>
));

export const SpeakerOnIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
    <path d="M16 9.2a4 4 0 0 1 0 5.6M18.8 6.5a8 8 0 0 1 0 11" />
  </svg>
));

export const SpeakerOffIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
    <path d="M16.5 9.5l5 5M21.5 9.5l-5 5" />
  </svg>
));

export const ScreenIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <rect x="2.5" y="4" width="19" height="13" rx="2" />
    <path d="M8.5 21h7M12 17v4" />
  </svg>
));

export const ScreenOffIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <path d="M21.5 15.5V6a2 2 0 0 0-2-2H8m-3.6.4A2 2 0 0 0 2.5 6v9a2 2 0 0 0 2 2h11" />
    <path d="M8.5 21h7M12 17v4M3 3l18 18" />
  </svg>
));

export const PeopleIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M16 5.2a3.5 3.5 0 0 1 0 5.6M17.5 14.2a6.5 6.5 0 0 1 4 5.8" />
  </svg>
));

export const SettingsIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
  </svg>
));

export const LeaveIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <path d="M15 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3" />
    <path d="M10 8l-4 4 4 4M6 12h9" />
  </svg>
));

export const CopyIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
  </svg>
));

export const CheckIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <path d="M4.5 12.5l5 5 10-11" />
  </svg>
));

export const CrownIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <path d="M3 7.5l3.5 3L12 4l5.5 6.5L21 7.5 19.5 18h-15z" />
  </svg>
));

export const CloseIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
));

export const ExpandIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <path d="M9 3.5H4.5V8M15 3.5h4.5V8M9 20.5H4.5V16M15 20.5h4.5V16" />
  </svg>
));

export const CollapseIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <path d="M4.5 8H9V3.5M19.5 8H15V3.5M4.5 16H9v4.5M19.5 16H15v4.5" />
  </svg>
));

export const PinIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <path d="M9 3.5h6l-1 6 3.5 3v1.5H6.5V12.5l3.5-3z" />
    <path d="M12 14v6.5" />
  </svg>
));

export const ChatIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <path d="M20.5 12.5c0 4-3.8 7-8.5 7a9.8 9.8 0 0 1-2.6-.34L4.5 20.5l1.2-3.4A6.7 6.7 0 0 1 3.5 12.5c0-4 3.8-7 8.5-7s8.5 3 8.5 7z" />
  </svg>
));

export const StreamIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <rect x="2.5" y="6" width="19" height="13" rx="2" />
    <path d="M10 10.5l4.5 2.5-4.5 2.5z" />
    <path d="M8 2.5l2.5 3M16 2.5l-2.5 3" />
  </svg>
));

export const StreamOffIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <path d="M21.5 17V8a2 2 0 0 0-2-2H8m-3.5.1A2 2 0 0 0 2.5 8v9a2 2 0 0 0 2 2h12" />
    <path d="M3 3l18 18" />
  </svg>
));

export const SendIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <path d="M4 12L20 4l-8 16-2-6-6-2z" />
  </svg>
));

export const ChevronDownIcon = memo((props: IconProps) => (
  <svg {...base(props)}>
    <path d="M6 9.5l6 6 6-6" />
  </svg>
));

MicOnIcon.displayName = 'MicOnIcon';
MicOffIcon.displayName = 'MicOffIcon';
SpeakerOnIcon.displayName = 'SpeakerOnIcon';
SpeakerOffIcon.displayName = 'SpeakerOffIcon';
ScreenIcon.displayName = 'ScreenIcon';
ScreenOffIcon.displayName = 'ScreenOffIcon';
PeopleIcon.displayName = 'PeopleIcon';
SettingsIcon.displayName = 'SettingsIcon';
LeaveIcon.displayName = 'LeaveIcon';
CopyIcon.displayName = 'CopyIcon';
CheckIcon.displayName = 'CheckIcon';
CrownIcon.displayName = 'CrownIcon';
CloseIcon.displayName = 'CloseIcon';
ExpandIcon.displayName = 'ExpandIcon';
CollapseIcon.displayName = 'CollapseIcon';
PinIcon.displayName = 'PinIcon';
ChatIcon.displayName = 'ChatIcon';
StreamIcon.displayName = 'StreamIcon';
StreamOffIcon.displayName = 'StreamOffIcon';
SendIcon.displayName = 'SendIcon';
ChevronDownIcon.displayName = 'ChevronDownIcon';
