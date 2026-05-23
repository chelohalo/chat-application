import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // WhatsApp-inspired palette. Keys are kept short and semantic so JSX
        // stays readable; the values are sourced from WhatsApp Web's official
        // light/dark themes (sampled directly from the rendered UI).
        wa: {
          headerLight: '#075E54',
          headerDark: '#1f2c34',
          bgLight: '#efeae2',
          bgDark: '#0b141a',
          bubbleOutLight: '#d9fdd3', // outgoing (user)
          bubbleOutDark: '#005c4b',
          bubbleInLight: '#ffffff', // incoming (bot)
          bubbleInDark: '#202c33',
          inputLight: '#f0f2f5',
          inputDark: '#2a3942',
          accent: '#00a884', // send button + tick marks
          metaLight: '#667781',
          metaDark: '#8696a0',
        },
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        // Three-dot "typing…" indicator. Each dot reads the same keyframes
        // with a staggered animation-delay (set inline in JSX) so the dots
        // bounce out of phase, mimicking WhatsApp's ellipsis animation.
        typingDot: {
          '0%, 60%, 100%': { transform: 'translateY(0)', opacity: '0.4' },
          '30%': { transform: 'translateY(-4px)', opacity: '1' },
        },
      },
      animation: {
        blink: 'blink 1s step-end infinite',
        typingDot: 'typingDot 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
