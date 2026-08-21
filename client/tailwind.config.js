/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      screens: {
        /**
         * A phone held sideways. Height, not width, is what runs out there:
         * a header, a chat panel below the video and a control bar leave the
         * picture a couple of centimetres tall, which is the one thing you
         * turned the phone sideways to avoid. Everything under this query
         * moves the chat beside the video and shrinks the furniture.
         *
         * Bounded by height rather than by device, so a small window on a
         * laptop gets the same treatment for the same reason.
         */
        'squat': { raw: '(orientation: landscape) and (max-height: 640px)' },
      },
      colors: {
        // A near-black stack rather than pure #000: large flat black on OLED
        // smears during scroll, and the steps here stay distinguishable on
        // cheap panels where #0a0a0a and #000 look identical.
        ink: {
          950: '#08090c',
          900: '#0d0f13',
          850: '#12151a',
          800: '#171a21',
          750: '#1d212a',
          700: '#252a35',
          600: '#333947',
          500: '#4a5163',
        },
        chalk: {
          50: '#f7f8fa',
          200: '#c9cdd8',
          400: '#8b92a4',
          600: '#5d6478',
        },
        // Single accent, used sparingly. Passes AA on ink-900 for body text.
        accent: {
          DEFAULT: '#5b8cff',
          hover: '#7aa1ff',
          muted: '#2c3f6b',
          faint: 'rgba(91, 140, 255, 0.12)',
        },
        signal: {
          good: '#3fcf8e',
          warn: '#f5b544',
          bad: '#f26d6d',
        },
      },
      fontFamily: {
        sans: [
          'Inter var',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      transitionDuration: {
        // Everything animates in under 150ms. Anything slower reads as lag.
        DEFAULT: '120ms',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'slide-in-bottom': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'slide-up': 'slide-up 140ms ease-out',
        'slide-in-right': 'slide-in-right 160ms cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-in-bottom': 'slide-in-bottom 180ms cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
};
