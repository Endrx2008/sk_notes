// SKAI palette → CSS variables. Besides sk_notes' own --sk-* tokens, the generic
// variable names that community plugins and themes use for styling are defined too,
// with values from the SKAI palette (names are a public styling API; values are ours).

export const PALETTES = {
  dark: {
    bg: '#0d0d0d', bg2: '#141414', bg3: '#1c1c1c', hover: '#222222',
    accent: '#e05c00', accent2: '#ff7a1a', onAccent: '#000000',
    text: '#e8e8e8', muted: '#9a9a9a', dim: '#666666', border: '#2a2a2a',
    green: '#39d353', red: '#ff4444', blue: '#4da6ff', yellow: '#e3b341', purple: '#b98bf0', cyan: '#3fc1c9', pink: '#f26b9f',
    select: 'rgba(224, 92, 0, 0.22)', highlight: 'rgba(227, 179, 65, 0.30)', code: '#171717',
  },
  light: {
    bg: '#f6f4f1', bg2: '#ffffff', bg3: '#efebe6', hover: '#e8e3dc',
    accent: '#c75200', accent2: '#e05c00', onAccent: '#ffffff',
    text: '#1a1a1a', muted: '#5e5a55', dim: '#8a8580', border: '#d9d3cb',
    green: '#1a7f37', red: '#cf222e', blue: '#0b63c5', yellow: '#9a6700', purple: '#7a4cc2', cyan: '#0f7d84', pink: '#bf3989',
    select: 'rgba(199, 82, 0, 0.16)', highlight: 'rgba(255, 210, 80, 0.45)', code: '#efebe6',
  },
};

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ');
}

export function cssVariables(mode) {
  const p = PALETTES[mode] || PALETTES.dark;
  const v = {
    // sk_notes tokens
    '--sk-bg': p.bg, '--sk-bg2': p.bg2, '--sk-bg3': p.bg3, '--sk-hover': p.hover,
    '--sk-accent': p.accent, '--sk-accent2': p.accent2, '--sk-on-accent': p.onAccent,
    '--sk-text': p.text, '--sk-muted': p.muted, '--sk-dim': p.dim, '--sk-border': p.border,
    '--sk-green': p.green, '--sk-red': p.red, '--sk-blue': p.blue, '--sk-select': p.select,
    // generic styling variables used by plugins/themes
    '--background-primary': p.bg2, '--background-primary-alt': p.bg3,
    '--background-secondary': p.bg, '--background-secondary-alt': p.bg3,
    '--background-modifier-hover': p.hover, '--background-modifier-active-hover': p.select,
    '--background-modifier-border': p.border, '--background-modifier-border-hover': p.dim,
    '--background-modifier-border-focus': p.accent, '--background-modifier-form-field': p.bg3,
    '--background-modifier-error': p.red, '--background-modifier-error-hover': p.red,
    '--background-modifier-success': p.green, '--background-modifier-message': p.bg3,
    '--background-modifier-cover': 'rgba(0, 0, 0, 0.55)',
    '--text-normal': p.text, '--text-muted': p.muted, '--text-faint': p.dim,
    '--text-on-accent': p.onAccent, '--text-on-accent-inverted': p.text,
    '--text-error': p.red, '--text-success': p.green, '--text-warning': p.yellow,
    '--text-accent': p.accent2, '--text-accent-hover': p.accent,
    '--text-selection': p.select, '--text-highlight-bg': p.highlight,
    '--interactive-normal': p.bg3, '--interactive-hover': p.hover,
    '--interactive-accent': p.accent, '--interactive-accent-hover': p.accent2,
    '--interactive-accent-hsl': '22, 100%, 44%',
    '--color-accent': p.accent, '--color-accent-1': p.accent2, '--color-accent-2': p.accent2,
    '--color-red': p.red, '--color-green': p.green, '--color-blue': p.blue, '--color-yellow': p.yellow,
    '--color-orange': p.accent2, '--color-purple': p.purple, '--color-cyan': p.cyan, '--color-pink': p.pink,
    '--color-red-rgb': hexToRgb(p.red), '--color-green-rgb': hexToRgb(p.green), '--color-blue-rgb': hexToRgb(p.blue),
    '--color-yellow-rgb': hexToRgb(p.yellow), '--color-orange-rgb': hexToRgb(p.accent2),
    '--color-purple-rgb': hexToRgb(p.purple), '--color-cyan-rgb': hexToRgb(p.cyan), '--color-pink-rgb': hexToRgb(p.pink),
    '--color-base-00': p.bg, '--color-base-05': p.bg, '--color-base-10': p.bg2, '--color-base-20': p.bg3,
    '--color-base-25': p.hover, '--color-base-30': p.border, '--color-base-35': p.border, '--color-base-40': p.dim,
    '--color-base-50': p.dim, '--color-base-60': p.muted, '--color-base-70': p.muted, '--color-base-100': p.text,
    '--code-background': p.code, '--code-normal': p.text,
    '--link-color': p.accent2, '--link-color-hover': p.accent, '--link-external-color': p.accent2,
    '--link-unresolved-color': p.accent2, '--tag-color': p.accent2, '--tag-background': p.select,
    '--icon-color': p.muted, '--icon-color-hover': p.text, '--icon-color-active': p.accent,
    '--scrollbar-bg': 'transparent', '--scrollbar-thumb-bg': p.border, '--scrollbar-active-thumb-bg': p.dim,
    '--checkbox-color': p.accent, '--checkbox-border-color': p.dim,
    '--titlebar-background': p.bg, '--tab-background-active': p.bg2, '--nav-item-color': p.muted,
    '--nav-item-color-active': p.text, '--nav-item-background-active': p.select,
    '--font-text-theme': "'Inter', 'Noto Sans', 'DejaVu Sans', sans-serif",
    '--font-monospace-theme': "'JetBrains Mono', 'JetBrainsMono Nerd Font', 'Fira Code', monospace",
    '--font-interface-theme': "'JetBrains Mono', 'JetBrainsMono Nerd Font', 'Fira Code', monospace",
    '--radius-s': '4px', '--radius-m': '6px', '--radius-l': '10px', '--radius-xl': '14px',
    '--size-2-1': '2px', '--size-2-2': '4px', '--size-2-3': '6px', '--size-4-1': '4px', '--size-4-2': '8px',
    '--size-4-3': '12px', '--size-4-4': '16px', '--size-4-5': '20px', '--size-4-6': '24px', '--size-4-8': '32px',
    '--font-ui-smaller': '11px', '--font-ui-small': '12px', '--font-ui-medium': '13px', '--font-ui-large': '15px',
    '--icon-xs': '14px', '--icon-s': '16px', '--icon-m': '18px', '--icon-l': '18px', '--icon-stroke': '1.75px',
  };
  return v;
}

let current = 'dark';
let source = 'skai';

/** mode: 'skai' (follow the SKAI switch), 'dark' or 'light'. */
export function applyTheme(skaiTheme, preference = source) {
  source = preference;
  current = preference === 'skai' ? skaiTheme : preference;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(cssVariables(current))) root.style.setProperty(k, v);
  document.body.classList.toggle('theme-dark', current === 'dark');
  document.body.classList.toggle('theme-light', current === 'light');
}

export function themeMode() {
  return current;
}
