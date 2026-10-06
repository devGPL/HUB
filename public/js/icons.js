// Ícones SVG inline (traço 1.75, 24x24). Herdam a cor via currentColor.
const svg = (body, cls = '') =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${body}</svg>`;

export const icons = {
  check: () => svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  cross: () => svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  dash: () => svg('<path d="M7 12h10"/>'),
  external: () => svg('<path d="M14 5h5v5M19 5l-8 8M17 14v5H5V7h5"/>'),
  refresh: () => svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>'),
  pr: () => svg('<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M6 8.2v7.6M18 15.8V9a3 3 0 0 0-3-3h-4M13 3.5L10.5 6 13 8.5"/>'),
  branch: () => svg('<circle cx="6" cy="5.5" r="2.2"/><circle cx="6" cy="18.5" r="2.2"/><circle cx="18" cy="7.5" r="2.2"/><path d="M6 7.7v8.6M18 9.7c0 4.3-12 2.3-12 6.6"/>'),
  clock: () => svg('<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>'),
  shield: () => svg('<path d="M12 3.5l7 2.5v5.5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6l7-2.5z"/><path d="M9 12l2.2 2.2L15.5 10"/>'),
  repo: () => svg('<path d="M5 4.5h11.5a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2v-13zM5 17.5a2 2 0 0 1 2-2h11.5"/>'),
  play: () => svg('<path d="M8 5.5v13l10-6.5-10-6.5z"/>'),
  key: () => svg('<circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5L19 4M16 7l2.5 2.5M14 9l2 2"/>'),
  logout: () => svg('<path d="M14 4.5H5v15h9M10 12h10M16.5 8.5L20 12l-3.5 3.5"/>'),
  search: () => svg('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>'),
  close: () => svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  alert: () => svg('<path d="M12 4l9 16H3l9-16z"/><path d="M12 10v4.5M12 17v.5"/>'),
  grid: () => svg('<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>'),
  list: () => svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  wrench: () => svg('<path d="M14.5 6.5a4 4 0 0 0 5 5l-8.5 8.5a2.1 2.1 0 0 1-3-3l8.5-8.5a4 4 0 0 1-2-2z"/><path d="M14.5 6.5l3-3 3 3-3 3"/>'),
  plus: () => svg('<path d="M12 5v14M5 12h14"/>'),
  trash: () => svg('<path d="M4.5 6.5h15M9.5 6.5V4h5v2.5M6.5 6.5l1 13.5h9l1-13.5M10 10v6.5M14 10v6.5"/>'),
  sliders: () => svg('<path d="M5 4v16M12 4v16M19 4v16"/><path d="M3 9h4M10 15h4M17 7h4"/>'),
};
