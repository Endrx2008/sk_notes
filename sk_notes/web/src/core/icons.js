// sk_notes icon set – original drawings (24×24 grid, stroke = currentColor).
// Style: straight strokes, squared ends softened by round joins, one accent detail.
// Names are plain English words so plugin calls like setIcon(el, 'search') find a
// sensible icon; unknown names get a neutral placeholder.

const P = (d) => `<path d="${d}"/>`;
const R = (x, y, w, h, r = 2) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/>`;
const C = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
const L = (x1, y1, x2, y2) => `<path d="M${x1} ${y1}L${x2} ${y2}"/>`;

const ICONS = {
  // files & folders
  'file': P('M6 3h8l4 4v14H6z') + P('M14 3v4h4'),
  'file-text': P('M6 3h8l4 4v14H6z') + P('M14 3v4h4') + L(9, 12, 15, 12) + L(9, 16, 13, 16),
  'file-plus': P('M6 3h8l4 4v14H6z') + P('M14 3v4h4') + L(12, 11, 12, 17) + L(9, 14, 15, 14),
  'file-edit': P('M13 21H6V3h8l4 4v4') + P('M14 3v4h4') + P('M15 20l5-5 2 2-5 5h-2z'),
  'files': P('M8 6V3h7l4 4v11h-3') + R(4, 7, 11, 14, 1),
  'folder': P('M3 6h6l2 2h10v11H3z'),
  'folder-open': P('M3 19V6h6l2 2h8v3') + P('M3 19l3-8h16l-3 8z'),
  'folder-plus': P('M3 6h6l2 2h10v11H3z') + L(12, 11, 12, 16) + L(9.5, 13.5, 14.5, 13.5),
  'folder-closed': P('M3 6h6l2 2h10v11H3z') + L(3, 11, 21, 11),
  'vault': R(3, 4, 18, 16, 3) + C(12, 12, 3.5) + L(12, 8.5, 12, 6) + L(3, 9, 1.5, 9) + L(3, 15, 1.5, 15),
  'image': R(3, 4, 18, 16, 2) + C(9, 9.5, 1.8) + P('M3 17l5-5 4 4 3-3 6 6'),
  'film': R(3, 4, 18, 16, 2) + L(7, 4, 7, 20) + L(17, 4, 17, 20) + L(3, 12, 21, 12),
  'music': P('M9 18V5l11-2v13') + C(6.5, 18, 2.5) + C(17.5, 16, 2.5),
  'paperclip': P('M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.6 1.6 0 0 1-2.3-2.3L14.5 7.3'),
  'pdf': P('M6 3h8l4 4v14H6z') + P('M14 3v4h4') + P('M8.5 17v-4h1.5a1 1 0 0 1 0 2H8.5') + P('M12.5 13v4h1a2 2 0 0 0 0-4z'),
  'archive': R(3, 4, 18, 5, 1) + P('M5 9v11h14V9') + L(10, 13, 14, 13),

  // actions
  'plus': L(12, 5, 12, 19) + L(5, 12, 19, 12),
  'minus': L(5, 12, 19, 12),
  'x': L(6, 6, 18, 18) + L(18, 6, 6, 18),
  'check': P('M4.5 12.5l5 5L19.5 6.5'),
  'pencil': P('M4 20l1-5L16 4l4 4L9 19z') + L(13.5, 6.5, 17.5, 10.5),
  'eraser': P('M7 21h13') + P('M5.5 15.5l9-9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 20H8.3l-2.8-2.8a1.2 1.2 0 0 1 0-1.7z') + L(9.5, 11.5, 14.5, 16.5),
  'brush': P('M9.5 14.5L19 5a1.4 1.4 0 0 1 2 2l-9.5 9.5') + P('M9.5 14.5c-2 0-3.5 1.4-3.5 3.3 0 1.2-.8 2.2-2 2.2 1 1 2.3 1.5 3.8 1.5 2.6 0 4.2-1.9 4.2-4.2'),
  'text-color': P('M6 16L11 4h2l5 12') + L(8, 11.5, 16, 11.5) + R(4, 19, 16, 3, 1),
  'trash': L(4, 7, 20, 7) + P('M9 7V4h6v3') + P('M6 7l1 14h10l1-14') + L(10, 11, 10, 17) + L(14, 11, 14, 17),
  'copy': R(8, 8, 13, 13, 2) + P('M16 8V4H3v13h5'),
  'clipboard': R(5, 5, 14, 16, 2) + R(9, 3, 6, 4, 1),
  'save': P('M5 3h11l3 3v15H5z') + P('M8 3v5h7V3') + R(8, 13, 8, 5, 1),
  'download': L(12, 4, 12, 15) + P('M7 10l5 5 5-5') + L(4, 20, 20, 20),
  'upload': L(12, 20, 12, 9) + P('M7 14l5-5 5 5') + L(4, 4, 20, 4),
  'refresh': P('M20 11a8 8 0 0 0-14.6-4.4L4 8') + P('M4 3v5h5') + P('M4 13a8 8 0 0 0 14.6 4.4L20 16') + P('M20 21v-5h-5'),
  'undo': P('M9 14L4 9l5-5') + P('M4 9h10a6 6 0 0 1 0 12h-3'),
  'redo': P('M15 14l5-5-5-5') + P('M20 9H10a6 6 0 0 0 0 12h3'),
  'external-link': P('M14 4h6v6') + L(20, 4, 11, 13) + P('M18 14v6H4V6h6'),
  'link': P('M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L12 5.6') + P('M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2'),
  'unlink': P('M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-3.4-7.7') + P('M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 3.4 7.7') + L(3, 3, 6, 6) + L(18, 18, 21, 21),
  'search': C(10.5, 10.5, 6.5) + L(15.5, 15.5, 20.5, 20.5),
  'replace': P('M4 7h12l-3-3') + P('M20 17H8l3 3'),
  'filter': P('M3 5h18l-7 8v6l-4 2v-8z'),
  'sort': L(7, 4, 7, 20) + P('M3 8l4-4 4 4') + L(17, 20, 17, 4) + P('M13 16l4 4 4-4'),
  'sort-asc': L(7, 4, 7, 20) + P('M3 16l4 4 4-4') + L(13, 6, 21, 6) + L(13, 12, 19, 12) + L(13, 18, 16, 18),
  'sort-desc': L(7, 4, 7, 20) + P('M3 16l4 4 4-4') + L(13, 6, 16, 6) + L(13, 12, 19, 12) + L(13, 18, 21, 18),
  'more-horizontal': C(5, 12, 1.2) + C(12, 12, 1.2) + C(19, 12, 1.2),
  'more-vertical': C(12, 5, 1.2) + C(12, 12, 1.2) + C(12, 19, 1.2),
  'menu': L(4, 6, 20, 6) + L(4, 12, 20, 12) + L(4, 18, 20, 18),
  'grip': C(9, 6, 1) + C(15, 6, 1) + C(9, 12, 1) + C(15, 12, 1) + C(9, 18, 1) + C(15, 18, 1),
  'send': P('M4 12L20 4l-5 16-3-7z') + L(12, 13, 20, 4),
  'stop': R(6, 6, 12, 12, 2),
  'play': P('M7 4l13 8-13 8z'),
  'pause': R(6, 4, 4, 16, 1) + R(14, 4, 4, 16, 1),
  'mic': R(9, 3, 6, 11, 3) + P('M5 11a7 7 0 0 0 14 0') + L(12, 18, 12, 21),
  'eye': P('M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z') + C(12, 12, 3),
  'eye-off': P('M10 5.2A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6') + P('M6.5 6.5C3.7 8.3 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6') + L(3, 3, 21, 21) + P('M9.9 9.9a3 3 0 0 0 4.2 4.2'),
  'lock': R(5, 10, 14, 11, 2) + P('M8 10V7a4 4 0 0 1 8 0v3'),
  'unlock': R(5, 10, 14, 11, 2) + P('M8 10V7a4 4 0 0 1 7.5-2'),
  'key': C(7.5, 15.5, 4) + L(10.5, 12.5, 20, 3) + L(16, 7, 19, 10),
  'shield': P('M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'),
  'pin': P('M9 3h6l-1 6 4 4H6l4-4z') + L(12, 13, 12, 21),
  'pin-off': P('M9 3h6l-1 6 4 4H6l4-4z') + L(12, 13, 12, 21) + L(3, 3, 21, 21),
  'star': P('M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.3L12 17.5 6.5 20.4l1-6.3L3 9.7l6.2-.9z'),
  'bookmark': P('M6 3h12v18l-6-4-6 4z'),
  'bookmark-plus': P('M6 3h12v18l-6-4-6 4z') + L(12, 7, 12, 12) + L(9.5, 9.5, 14.5, 9.5),
  'heart': P('M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z'),
  'bell': P('M6 16V11a6 6 0 0 1 12 0v5l2 2H4z') + P('M10 21h4'),
  'info': C(12, 12, 9) + L(12, 11, 12, 16) + C(12, 8, 0.6),
  'help': C(12, 12, 9) + P('M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6') + C(12, 17, 0.6),
  'alert-triangle': P('M12 3l10 18H2z') + L(12, 10, 12, 14) + C(12, 17.5, 0.6),
  'alert-circle': C(12, 12, 9) + L(12, 7, 12, 13) + C(12, 16.5, 0.6),
  'check-circle': C(12, 12, 9) + P('M8 12.5l3 3 5-6'),
  'x-circle': C(12, 12, 9) + L(9, 9, 15, 15) + L(15, 9, 9, 15),
  'circle': C(12, 12, 8),
  'dot': C(12, 12, 2.5),
  'square': R(4, 4, 16, 16, 2),
  'check-square': R(4, 4, 16, 16, 2) + P('M8 12l3 3 5-6'),
  'list-checks': P('M3 6l2 2 3-3') + P('M3 13l2 2 3-3') + L(11, 7, 21, 7) + L(11, 14, 21, 14) + L(11, 20, 21, 20),

  // navigation
  'chevron-right': P('M9 5l7 7-7 7'),
  'chevron-left': P('M15 5l-7 7 7 7'),
  'chevron-down': P('M5 9l7 7 7-7'),
  'chevron-up': P('M5 15l7-7 7 7'),
  'chevrons-up-down': P('M7 9l5-5 5 5') + P('M7 15l5 5 5-5'),
  'chevrons-down-up': P('M7 4l5 5 5-5') + P('M7 20l5-5 5 5'),
  'arrow-left': L(20, 12, 4, 12) + P('M10 6l-6 6 6 6'),
  'arrow-right': L(4, 12, 20, 12) + P('M14 6l6 6-6 6'),
  'arrow-up': L(12, 20, 12, 4) + P('M6 10l6-6 6 6'),
  'arrow-down': L(12, 4, 12, 20) + P('M6 14l6 6 6-6'),
  'corner-down-left': P('M20 4v7a3 3 0 0 1-3 3H5') + P('M9 10l-4 4 4 4'),
  'home': P('M3 11l9-8 9 8') + P('M5 9v12h14V9') + R(10, 14, 4, 7, 0),
  'shuffle': P('M3 7h4l10 10h4') + P('M18 14l3 3-3 3') + P('M3 17h4l3-3') + P('M14 10l3-3h4') + P('M18 4l3 3-3 3'),
  'dice': R(4, 4, 16, 16, 3) + C(9, 9, 1) + C(15, 15, 1) + C(15, 9, 1) + C(9, 15, 1),
  'maximize': P('M4 9V4h5') + P('M20 9V4h-5') + P('M4 15v5h5') + P('M20 15v5h-5'),
  'minimize': P('M9 4v5H4') + P('M15 4v5h5') + P('M9 20v-5H4') + P('M15 20v-5h5'),
  'zoom-in': C(10.5, 10.5, 6.5) + L(15.5, 15.5, 20.5, 20.5) + L(10.5, 8, 10.5, 13) + L(8, 10.5, 13, 10.5),
  'zoom-out': C(10.5, 10.5, 6.5) + L(15.5, 15.5, 20.5, 20.5) + L(8, 10.5, 13, 10.5),
  'move': L(12, 3, 12, 21) + L(3, 12, 21, 12) + P('M9 6l3-3 3 3') + P('M9 18l3 3 3-3') + P('M6 9l-3 3 3 3') + P('M18 9l3 3-3 3'),
  'hand': P('M8 13V6a1.5 1.5 0 0 1 3 0v5') + P('M11 10V4.5a1.5 1.5 0 0 1 3 0V10') + P('M14 10V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7 6 6 0 0 1-5-3l-2.5-4.5a1.5 1.5 0 0 1 2.6-1.5L8 14'),

  // layout
  'sidebar-left': R(3, 4, 18, 16, 2) + L(9, 4, 9, 20),
  'sidebar-right': R(3, 4, 18, 16, 2) + L(15, 4, 15, 20),
  'columns': R(3, 4, 18, 16, 2) + L(12, 4, 12, 20),
  'rows': R(3, 4, 18, 16, 2) + L(3, 12, 21, 12),
  'split-right': R(3, 4, 18, 16, 2) + L(13, 4, 13, 20) + L(16, 12, 19, 12),
  'split-down': R(3, 4, 18, 16, 2) + L(3, 13, 21, 13),
  'layout': R(3, 4, 18, 16, 2) + L(3, 9, 21, 9) + L(10, 9, 10, 20),
  'panel-top': R(3, 4, 18, 16, 2) + L(3, 9, 21, 9),
  'layers': P('M12 3l9 5-9 5-9-5z') + P('M3 13l9 5 9-5'),
  'window': R(3, 4, 18, 16, 2) + L(3, 8, 21, 8) + C(6, 6, 0.4),
  'stack': R(4, 7, 13, 13, 2) + P('M8 4h11a1 1 0 0 1 1 1v11'),
  'table': R(3, 4, 18, 16, 2) + L(3, 9, 21, 9) + L(3, 14, 21, 14) + L(9, 9, 9, 20),
  'kanban': R(3, 4, 5, 16, 1) + R(10, 4, 5, 11, 1) + R(17, 4, 4, 7, 1),
  'list': L(9, 6, 21, 6) + L(9, 12, 21, 12) + L(9, 18, 21, 18) + C(4.5, 6, 1) + C(4.5, 12, 1) + C(4.5, 18, 1),
  'list-ordered': L(10, 6, 21, 6) + L(10, 12, 21, 12) + L(10, 18, 21, 18) + P('M4 4h1v4') + P('M4 14h2l-2 3h2'),
  'grid': R(4, 4, 7, 7, 1) + R(13, 4, 7, 7, 1) + R(4, 13, 7, 7, 1) + R(13, 13, 7, 7, 1),
  'map-pin': P('M12 21s-7-6-7-12a7 7 0 0 1 14 0c0 6-7 12-7 12z') + C(12, 9, 2.5),

  // knowledge
  'graph': C(6, 7, 2.5) + C(18, 6, 2) + C(16, 18, 2.5) + C(6, 17, 1.5) + L(8.3, 7.6, 16, 6.3) + L(7.6, 9, 14.6, 16.3) + L(17.6, 8, 16.4, 15.5) + L(7.4, 16.6, 13.5, 17.7),
  'canvas': R(3, 3, 7, 6, 1) + R(14, 9, 7, 6, 1) + R(5, 15, 7, 6, 1) + P('M10 6h3a2 2 0 0 1 2 2v1') + P('M8 15v-2a2 2 0 0 1 2-2h4'),
  'database': P('M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z') + P('M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6') + P('M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'),
  'tag': P('M3 3h8l10 10-8 8L3 11z') + C(7.5, 7.5, 1.4),
  'tags': P('M3 5h7l9 9-7 7-9-9z') + C(6.8, 8.8, 1.2) + P('M13 5l9 9-5 5'),
  'hash': L(9, 3, 7, 21) + L(17, 3, 15, 21) + L(4, 9, 20, 9) + L(3, 15, 19, 15),
  'at-sign': C(12, 12, 4) + P('M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8'),
  'heading': L(6, 4, 6, 20) + L(18, 4, 18, 20) + L(6, 12, 18, 12),
  'outline': L(4, 5, 20, 5) + L(8, 10, 20, 10) + L(8, 15, 20, 15) + L(12, 20, 20, 20),
  'quote': P('M5 17c2-1 3-3 3-6V7H4v5h3') + P('M14 17c2-1 3-3 3-6V7h-4v5h3'),
  'code': P('M8 7l-5 5 5 5') + P('M16 7l5 5-5 5') + L(14, 4, 10, 20),
  'braces': P('M8 4H7a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h1') + P('M16 4h1a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-1'),
  'terminal': R(3, 4, 18, 16, 2) + P('M7 9l3 3-3 3') + L(12, 15, 17, 15),
  'command': R(3, 4, 18, 16, 2) + P('M7 9l3 3-3 3') + L(12, 15, 17, 15),
  'calendar': R(3, 5, 18, 16, 2) + L(3, 10, 21, 10) + L(8, 3, 8, 7) + L(16, 3, 16, 7),
  'calendar-plus': R(3, 5, 18, 16, 2) + L(3, 10, 21, 10) + L(8, 3, 8, 7) + L(16, 3, 16, 7) + L(12, 13, 12, 18) + L(9.5, 15.5, 14.5, 15.5),
  'calendar-day': R(3, 5, 18, 16, 2) + L(3, 10, 21, 10) + L(8, 3, 8, 7) + L(16, 3, 16, 7) + R(7, 13, 4, 4, 0.5),
  'clock': C(12, 12, 9) + P('M12 7v5l3 2'),
  'history': P('M3 12a9 9 0 1 0 3-6.7L3 8') + P('M3 3v5h5') + P('M12 7v5l3 2'),
  'template': R(3, 3, 18, 18, 2) + L(3, 9, 21, 9) + L(9, 9, 9, 21),
  'text-cursor': P('M9 4h6') + P('M9 20h6') + L(12, 4, 12, 20),
  'type': P('M5 6V4h14v2') + L(12, 4, 12, 20) + L(9, 20, 15, 20),
  'bold': P('M7 4h6a4 4 0 0 1 0 8H7z') + P('M7 12h7a4 4 0 0 1 0 8H7z'),
  'italic': L(14, 4, 10, 20) + L(10, 4, 18, 4) + L(6, 20, 14, 20),
  'strikethrough': L(4, 12, 20, 12) + P('M16 6.5A4 4 0 0 0 12 4c-2.5 0-4 1.4-4 3.2') + P('M8 17.5A4 4 0 0 0 12 20c2.5 0 4-1.4 4-3.2'),
  'highlighter': P('M9 18l-4 2 1-4L16 6l3 3z') + L(4, 21, 20, 21),
  'sigma': P('M18 6V4H6l6 8-6 8h12v-2'),
  'superscript': P('M4 6l8 12') + P('M12 6l-8 12') + P('M16 4h3v1l-3 3h3'),
  'book': P('M4 19V5a2 2 0 0 1 2-2h14v15H6a2 2 0 0 0-2 2z') + P('M4 19a2 2 0 0 0 2 2h14v-3'),
  'book-open': P('M2 5h7a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H2z') + P('M22 5h-7a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h8z'),
  'edit-mode': P('M4 20l1-5L16 4l4 4L9 19z'),
  'reading-mode': P('M2 5h7a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H2z') + P('M22 5h-7a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h8z'),
  'presentation': R(3, 4, 18, 12, 1) + L(12, 16, 12, 20) + L(8, 21, 16, 21),
  'merge': C(6, 6, 2) + C(6, 18, 2) + C(18, 12, 2) + L(6, 8, 6, 16) + P('M6 8c0 3 3 4 10 4'),
  'git-branch': C(6, 5, 2) + C(6, 19, 2) + C(18, 7, 2) + L(6, 7, 6, 17) + P('M18 9c0 5-6 4-11 8'),
  'cloud': P('M7 19a5 5 0 0 1-.6-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 10z'),
  'globe': C(12, 12, 9) + L(3, 12, 21, 12) + P('M12 3c3 3 3 15 0 18') + P('M12 3c-3 3-3 15 0 18'),
  'wifi-off': L(3, 3, 21, 21) + P('M8.5 16.5a5 5 0 0 1 7 0') + P('M5 12.8a10 10 0 0 1 3.4-2.2') + C(12, 20, 0.6),
  'printer': P('M6 9V3h12v6') + R(3, 9, 18, 8, 2) + R(6, 14, 12, 7, 1),
  'share': C(18, 5, 2.5) + C(6, 12, 2.5) + C(18, 19, 2.5) + L(8.2, 10.8, 15.8, 6.2) + L(8.2, 13.2, 15.8, 17.8),
  'import': P('M12 3v12') + P('M7 10l5 5 5-5') + P('M4 15v5h16v-5'),
  'export': P('M12 15V3') + P('M7 8l5-5 5 5') + P('M4 15v5h16v-5'),
  'palette': P('M12 3a9 9 0 1 0 0 18c1.4 0 2-1 1.5-2.2-.6-1.4.3-2.8 1.8-2.8H18a3 3 0 0 0 3-3c0-5.5-4-10-9-10z') + C(7.5, 11, 1) + C(10, 7, 1) + C(15, 7.5, 1),
  'sun': C(12, 12, 4) + L(12, 2, 12, 4) + L(12, 20, 12, 22) + L(2, 12, 4, 12) + L(20, 12, 22, 12) + L(5, 5, 6.5, 6.5) + L(17.5, 17.5, 19, 19) + L(5, 19, 6.5, 17.5) + L(17.5, 6.5, 19, 5),
  'moon': P('M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'),
  'settings': C(12, 12, 3) + P('M19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-2 1.2L14.8 21h-4l-.3-2a7 7 0 0 1-2-1.2l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-2.4L4.6 10.3l2-3.4 1.9.7a7 7 0 0 1 2-1.2L10.8 3h4l.3 2a7 7 0 0 1 2 1.2l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 2.4z'),
  'sliders': L(4, 7, 20, 7) + L(4, 17, 20, 17) + C(9, 7, 2) + C(15, 17, 2),
  'keyboard': R(2, 6, 20, 13, 2) + L(6, 10, 6, 10.01) + L(10, 10, 10, 10.01) + L(14, 10, 14, 10.01) + L(18, 10, 18, 10.01) + L(7, 15, 17, 15),
  'puzzle': P('M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3z'),
  'plug': L(9, 3, 9, 8) + L(15, 3, 15, 8) + P('M6 8h12v3a6 6 0 0 1-12 0z') + L(12, 17, 12, 21),
  'power': L(12, 3, 12, 11) + P('M7 6a8 8 0 1 0 10 0'),
  'user': C(12, 8, 4) + P('M4 21a8 8 0 0 1 16 0'),
  'sparkles': P('M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z') + P('M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z'),
  'bot': R(4, 8, 16, 12, 3) + L(12, 4, 12, 8) + C(12, 3.5, 1) + C(9, 14, 1.2) + C(15, 14, 1.2),
  'message': P('M4 4h16v12H9l-5 4z'),
  'messages': P('M3 3h13v9H7l-4 3z') + P('M8 15v2h9l4 3V8h-3'),
  'wand': L(4, 20, 15, 9) + P('M17 3v4') + P('M15 5h4') + P('M20 10v3') + P('M18.5 11.5h3'),
  'scorpion': P('M12 21c-3 0-5-2-5-5 0-2 1-3 2-4') + P('M12 21c3 0 5-2 5-5 0-2-1-3-2-4') + P('M9 12c0-3 1-5 3-5s3 2 3 5') + P('M12 7c0-2 1-4 3-4s3 1 3 3-1 2-2 2'),
  'diff': L(12, 3, 12, 11) + L(8, 7, 16, 7) + L(8, 17, 16, 17) + R(4, 13, 16, 8, 2),
  'word-count': L(4, 6, 14, 6) + L(4, 11, 20, 11) + L(4, 16, 11, 16) + P('M15 16h5') + P('M17.5 13.5v5'),
  'focus': P('M4 8V4h4') + P('M20 8V4h-4') + P('M4 16v4h4') + P('M20 16v4h-4') + C(12, 12, 3),
  'fold': P('M7 15l5-5 5 5'),
  'unfold': P('M7 9l5 5 5-5'),
  'scissors': C(6, 6, 2.5) + C(6, 18, 2.5) + L(8, 8, 20, 18) + L(8, 16, 20, 6),
  'dollar': L(12, 2, 12, 22) + P('M17 6H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H6'),
  'percent': L(19, 5, 5, 19) + C(6.5, 6.5, 2.5) + C(17.5, 17.5, 2.5),
  'binary': R(4, 4, 6, 7, 2) + R(14, 13, 6, 7, 2) + L(17, 4, 17, 11) + L(7, 13, 7, 20),
  'check-check': P('M2 12.5l4 4 9-10') + P('M10 15.5l1 1 9-10'),
  'brackets': P('M8 4H4v16h4') + P('M16 4h4v16h-4'),
  'rocket': P('M5 15c-1 1-2 4-2 6 2 0 5-1 6-2') + P('M9 15l-3-3c1-5 5-9 14-9 0 9-4 13-9 14z') + C(15, 9, 1.5),
};

const ALIASES = {
  'magnifying-glass': 'search', 'cog': 'settings', 'gear': 'settings', 'trash-2': 'trash', 'delete': 'trash',
  'cross': 'x', 'close': 'x', 'checkmark': 'check', 'edit': 'pencil', 'pencil-line': 'pencil', 'pen': 'pencil',
  'document': 'file-text', 'note': 'file-text', 'file-plus-2': 'file-plus', 'files-plus': 'file-plus',
  'folder-tree': 'folder', 'folder-input': 'folder', 'folder-output': 'folder', 'folder-cog': 'folder',
  'git-fork': 'git-branch', 'git-commit': 'git-branch', 'git-pull-request': 'git-branch', 'github': 'git-branch',
  'ellipsis': 'more-horizontal', 'ellipsis-vertical': 'more-vertical', 'three-horizontal-bars': 'menu',
  'vertical-three-dots': 'more-vertical', 'horizontal-split': 'split-down', 'vertical-split': 'split-right',
  'columns-2': 'columns', 'rows-2': 'rows', 'panel-left': 'sidebar-left', 'panel-right': 'sidebar-right',
  'panel-left-close': 'sidebar-left', 'panel-right-close': 'sidebar-right', 'layout-dashboard': 'layout',
  'layout-grid': 'grid', 'layout-list': 'list', 'list-todo': 'list-checks', 'list-tree': 'outline',
  'calendar-days': 'calendar-day', 'calendar-with-checkmark': 'calendar-day', 'calendar-check': 'calendar-day',
  'calendar-range': 'calendar', 'calendar-clock': 'calendar', 'alarm-clock': 'clock', 'timer': 'clock',
  'info-circle': 'info', 'help-circle': 'help', 'circle-help': 'help', 'question-mark-glyph': 'help',
  'alert-octagon': 'alert-circle', 'circle-alert': 'alert-circle', 'triangle-alert': 'alert-triangle',
  'circle-check': 'check-circle', 'check-circle-2': 'check-circle', 'circle-x': 'x-circle', 'checkbox-glyph': 'check-square',
  'square-check': 'check-square', 'square-check-big': 'check-square', 'checkbox': 'check-square',
  'bookmark-check': 'bookmark', 'star-list': 'star', 'tag-glyph': 'tag', 'tags-glyph': 'tags',
  'link-2': 'link', 'link-glyph': 'link', 'external-link-glyph': 'external-link', 'broken-link': 'unlink',
  'unlink-2': 'unlink', 'image-file': 'image', 'image-glyph': 'image', 'audio-file': 'music', 'pdf-file': 'pdf',
  'file-image': 'image', 'file-audio': 'music', 'file-video': 'film', 'video': 'film', 'file-code': 'code',
  'file-json': 'braces', 'curly-braces': 'braces', 'square-terminal': 'terminal', 'terminal-square': 'terminal',
  'git-compare': 'diff', 'blocks': 'puzzle', 'boxes': 'puzzle', 'package': 'archive', 'box': 'archive',
  'refresh-cw': 'refresh', 'refresh-ccw': 'refresh', 'rotate-ccw': 'undo', 'rotate-cw': 'redo', 'undo-glyph': 'undo',
  'redo-glyph': 'redo', 'reset': 'refresh', 'sync': 'refresh', 'cloud-upload': 'upload', 'cloud-download': 'download',
  'down-arrow-with-tail': 'arrow-down', 'up-arrow-with-tail': 'arrow-up', 'left-arrow-with-tail': 'arrow-left',
  'right-arrow-with-tail': 'arrow-right', 'left-arrow': 'arrow-left', 'right-arrow': 'arrow-right',
  'right-triangle': 'chevron-right', 'down-chevron-glyph': 'chevron-down', 'up-chevron-glyph': 'chevron-up',
  'right-chevron-glyph': 'chevron-right', 'left-chevron-glyph': 'chevron-left', 'chevron-down-square': 'chevron-down',
  'expand-vertically': 'chevrons-up-down', 'collapse-vertically': 'chevrons-down-up',
  'maximize-2': 'maximize', 'minimize-2': 'minimize', 'expand': 'maximize', 'shrink': 'minimize', 'fullscreen': 'maximize',
  'lucide-search': 'search', 'dice-5': 'dice', 'dices': 'dice', 'random': 'shuffle', 'house': 'home',
  'heading-glyph': 'heading', 'heading-1': 'heading', 'heading-2': 'heading', 'pilcrow': 'type', 'text': 'type',
  'text-glyph': 'type', 'case-sensitive': 'type', 'whole-word': 'type', 'regex': 'code', 'code-glyph': 'code',
  'code-2': 'code', 'brackets-glyph': 'brackets', 'quote-glyph': 'quote', 'message-square': 'message',
  'message-circle': 'message', 'messages-square': 'messages', 'bot-message-square': 'bot', 'brain': 'sparkles',
  'brain-circuit': 'sparkles', 'wand-2': 'wand', 'wand-sparkles': 'wand', 'magic-wand': 'wand', 'zap': 'sparkles',
  'lightbulb': 'sparkles', 'paintbrush': 'palette', 'brush': 'palette', 'swatch-book': 'palette', 'contrast': 'moon',
  'sun-moon': 'sun', 'sliders-horizontal': 'sliders', 'settings-2': 'sliders', 'wrench': 'settings', 'hammer': 'settings',
  'eye-off-glyph': 'eye-off', 'lock-glyph': 'lock', 'unlock-glyph': 'unlock', 'shield-check': 'shield',
  'key-round': 'key', 'mic-2': 'mic', 'microphone': 'mic', 'microphone-filled': 'mic', 'volume-2': 'music',
  'play-circle': 'play', 'pause-circle': 'pause', 'square-stop': 'stop', 'circle-stop': 'stop',
  'plus-circle': 'plus', 'circle-plus': 'plus', 'plus-square': 'plus', 'plus-with-circle': 'plus', 'minus-circle': 'minus',
  'minus-with-circle': 'minus', 'circle-dot': 'dot', 'dot-network': 'graph', 'network': 'graph', 'git-graph': 'graph',
  'waypoints': 'graph', 'workflow': 'canvas', 'layout-template': 'template', 'table-2': 'table', 'sheet': 'table',
  'columns-3': 'kanban', 'square-kanban': 'kanban', 'trello': 'kanban', 'clipboard-list': 'clipboard',
  'clipboard-copy': 'copy', 'copy-plus': 'copy', 'documents': 'files', 'library': 'book', 'notebook': 'book',
  'notebook-pen': 'book', 'book-open-text': 'book-open', 'scroll': 'book-open', 'scroll-text': 'book-open',
  'presentation-chart': 'presentation', 'monitor': 'presentation', 'globe-2': 'globe', 'earth': 'globe',
  'map': 'map-pin', 'compass': 'globe', 'wifi': 'globe', 'cloud-off': 'wifi-off', 'send-horizontal': 'send',
  'share-2': 'share', 'forward': 'arrow-right', 'reply': 'corner-down-left', 'enter': 'corner-down-left',
  'log-in': 'import', 'log-out': 'export', 'file-input': 'import', 'file-output': 'export', 'file-down': 'download',
  'file-up': 'upload', 'hard-drive-download': 'download', 'save-all': 'save', 'floppy-disk': 'save',
  'history-glyph': 'history', 'clock-glyph': 'clock', 'hourglass': 'clock', 'layers-glyph': 'layers',
  'stacked-levels': 'layers', 'pin-glyph': 'pin', 'pinned': 'pin', 'filter-x': 'filter', 'list-filter': 'filter',
  'arrow-up-down': 'sort', 'arrow-down-up': 'sort', 'arrow-down-wide-narrow': 'sort-desc', 'arrow-up-narrow-wide': 'sort-asc',
  'arrow-down-a-z': 'sort-asc', 'arrow-up-z-a': 'sort-desc', 'grip-vertical': 'grip', 'grip-horizontal': 'grip',
  'move-vertical': 'move', 'hand-grab': 'hand', 'mouse-pointer': 'hand', 'crosshair': 'focus', 'scan': 'focus',
  'locate': 'focus', 'target': 'focus', 'merge-cells': 'merge', 'git-merge': 'merge', 'split': 'split-right',
  'scissors-line-dashed': 'scissors', 'cut': 'scissors', 'hash-glyph': 'hash', 'sigma-square': 'sigma',
  'function-square': 'sigma', 'calculator': 'sigma', 'binary-glyph': 'binary', 'user-circle': 'user', 'users': 'user',
  'bell-ring': 'bell', 'heart-handshake': 'heart', 'flame': 'sparkles', 'rocket-glyph': 'rocket', 'vault-glyph': 'vault',
  'sk-logo': 'scorpion',
};

const cache = new Map();
const custom = new Map();

function svgFor(name) {
  const key = name.startsWith('lucide-') ? name.slice(7) : name;
  if (custom.has(name)) return custom.get(name);
  const id = ICONS[key] ? key : ALIASES[key] || ALIASES[name];
  const body = id && ICONS[id];
  if (!body) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="svg-icon sk-icon-${id}">${body}</svg>`;
}

export function hasIcon(name) {
  return !!svgFor(name);
}

/** Put the icon `name` into `el` (replacing its content). */
export function setIcon(el, name) {
  if (!el) return;
  el.empty?.();
  if (!name) return;
  let html = cache.get(name);
  if (html === undefined) {
    html = svgFor(name) || svgFor('dot').replace('sk-icon-dot', 'sk-icon-placeholder');
    cache.set(name, html);
  }
  el.insertAdjacentHTML('beforeend', html);
}

export function getIcon(name) {
  const html = svgFor(name);
  if (!html) return null;
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.firstChild;
}

/** Plugins register their own SVG content (viewBox 0 0 100 100). */
export function addIcon(name, svgContent) {
  custom.set(name, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="svg-icon ${name}" fill="currentColor" stroke="currentColor">${svgContent}</svg>`);
  cache.delete(name);
}

export function removeIcon(name) {
  custom.delete(name);
  cache.delete(name);
}

export function getIconIds() {
  return [...Object.keys(ICONS), ...custom.keys()];
}
