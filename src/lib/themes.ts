// The palettes and accents the Appearance settings offer. Kept apart from the
// settings page so the phone app can offer the same ones.

export interface ThemeOption {
  value: string;
  label: string;
  /** Stage colour, then the palette's most colourful one. */
  swatch: [string, string];
}

export const LIGHT_THEMES: ThemeOption[] = [
  { value: "zeron-light", label: "Zeron Light", swatch: ["#f2f2f5", "#8e7cf6"] },
  { value: "sand", label: "Sand", swatch: ["#efe9dd", "#b3803f"] },
];

export const DARK_THEMES: ThemeOption[] = [
  { value: "zeron-dark", label: "Zeron Dark", swatch: ["#0d0d0d", "#8e7cf6"] },
  { value: "dark-plus", label: "Dark+", swatch: ["#1e1e1e", "#007acc"] },
  { value: "catppuccin-mocha", label: "Catppuccin Mocha", swatch: ["#1e1e2e", "#cba6f7"] },
  { value: "tokyo-night", label: "Tokyo Night", swatch: ["#1a1b26", "#7aa2f7"] },
  { value: "dracula", label: "Dracula", swatch: ["#282a36", "#bd93f9"] },
  { value: "github-dark", label: "GitHub Dark", swatch: ["#0d1117", "#58a6ff"] },
  { value: "ayu-dark", label: "Ayu Dark", swatch: ["#0a0e14", "#ffb454"] },
  { value: "ayu-mirage", label: "Ayu Mirage", swatch: ["#1f2430", "#ffcc66"] },
  { value: "gruvbox-dark", label: "Gruvbox Dark", swatch: ["#282828", "#b8bb26"] },
  { value: "rose-pine-moon", label: "Rosé Pine Moon", swatch: ["#232136", "#ea9a97"] },
  { value: "nord", label: "Nord", swatch: ["#2e3440", "#88c0d0"] },
  { value: "one-dark-pro", label: "One Dark Pro", swatch: ["#282c34", "#61afef"] },
  { value: "atom-one-dark", label: "Atom One Dark", swatch: ["#21252b", "#528bff"] },
  { value: "night-owl", label: "Night Owl", swatch: ["#011627", "#82aaff"] },
  {
    value: "winter-is-coming-dark-blue",
    label: "Winter is Coming Dark Blue",
    swatch: ["#0e1c36", "#6a9fb5"],
  },
  { value: "palenight", label: "Palenight", swatch: ["#292d3e", "#c792ea"] },
  { value: "synthwave-84", label: "SynthWave '84", swatch: ["#262335", "#ff7edb"] },
  { value: "shades-of-purple", label: "Shades of Purple", swatch: ["#2d2b55", "#fad000"] },
  { value: "cobalt2", label: "Cobalt2", swatch: ["#193549", "#ffc600"] },
  { value: "andromeda", label: "Andromeda", swatch: ["#23262e", "#c74ded"] },
  { value: "midnight", label: "Midnight", swatch: ["#02040a", "#8ca0ff"] },
];

export const ACCENTS = [
  { value: "default", label: "Theme default" },
  { value: "#8e7cf6", label: "Purple" },
  { value: "#818cf8", label: "Indigo" },
  { value: "#60a5fa", label: "Blue" },
  { value: "#22d3ee", label: "Cyan" },
  { value: "#2dd4bf", label: "Teal" },
  { value: "#34d399", label: "Green" },
  { value: "#a3e635", label: "Lime" },
  { value: "#f5c518", label: "Yellow" },
  { value: "#f59e42", label: "Orange" },
  { value: "#ef5350", label: "Red" },
  { value: "#f472b6", label: "Pink" },
  { value: "#fb7185", label: "Rose" },
];
