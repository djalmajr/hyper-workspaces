'use strict';

// hyper-workspaces
//
// cmux-style workspace UI for Hyper (reference: the cmux app layout):
//   - left sidebar lists WORKSPACES as multi-line blocks (name + meta line);
//     the selected workspace is a solid blue pill, like cmux;
//   - the tabs of the selected workspace show in a horizontal strip at the
//     top of the terminal area (not nested in the sidebar);
//   - dragging a tab from the strip onto a sidebar block moves it to that
//     workspace; dragging it over another strip tab reorders it live;
//   - the sidebar is collapsible (toggle button / cmd+B) and resizable by
//     dragging its right edge (clamped to MIN_WIDTH..MAX_WIDTH);
//   - colors are the fixed cmux palette (near-black neutrals + blue
//     selection), including the terminal background, which decorateConfig
//     overrides to termBg (darker than the sidebar, like cmux); the ANSI
//     colors and foreground stay with the user's theme.
//
//   click a block            -> select workspace (focuses its last active tab)
//   double-click names       -> rename workspace / tab
//   "+" on a block/strip     -> new tab inside that workspace
//   "x" on a block           -> delete workspace (tabs move to the first one)
//   drag strip tab           -> over a tab: reorder; onto a block: move group
//   cmd+T                    -> new tab in the selected workspace
//   cmd+R / cmd+shift+R      -> rename the active tab / selected workspace
//   cmd+B                    -> collapse/expand the sidebar
//                               (these three are rebindable from the help
//                               modal; window:reload[Full] must stay unbound
//                               in ~/.hyper.js keymaps so the keys reach us)
//   cmd+1..9                 -> jump to the Nth tab of the CURRENT workspace
//
// Implementation notes for this setup:
//   - The sidebar/strip are rendered by decorateTabs, which means they live
//     INSIDE .header_header — the header is neutralized (transparent,
//     click-through) instead of hidden, otherwise the sidebar vanishes.
//   - Hyper prefixes every selector in config.css with `#hyper`, so `:root`
//     custom properties never match; all values are interpolated literally.
//     Geometry that changes at runtime (width, collapsed) lives in a
//     dedicated <style> tag appended after Hyper's sheets; the static
//     config.css is generated from the persisted model so the first paint
//     already matches the saved state.
//   - New tabs use rpc.emit('new', {activeUid}): the main process channel is
//     'new' (ui/window.js), and passing activeUid preserves the CWD exactly
//     like cmd+T with preserveCWD: true. The 'command' channel is unreliable
//     here because it depends on BrowserWindow.getFocusedWindow().
//   - Tab reordering reuses hyper-reorderable-tabs' reducer: dispatching
//     {type: '@@DRAGGABLE/MOVE_TAB', uid, position, isAfter} against
//     state.termGroups.termGroupsOrdered (position = target index, isAfter
//     inserts after it). Without that plugin the state key is absent and
//     reordering silently disables; cmd+alt+arrows keeps working through
//     hyper-tab-move-keys either way.
//
// Workspace state persists in state.json next to this file. Tab->workspace
// assignments are pruned only for tabs this window has actually seen, so
// multiple windows don't wipe each other's mappings.

const fs = require('fs');
const path = require('path');

const MIN_WIDTH = 180;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 240;
const STRIP_HEIGHT = 32;
// Reserved room for the macOS traffic lights in drag strips.
const LIGHTS_WIDTH = 76;
// Plugin-owned shortcuts (all cmd-based); rebindable from the help modal.
const DEFAULT_SHORTCUTS = {
  renameTab: { code: 'KeyR', shift: false },
  renameWorkspace: { code: 'KeyR', shift: true },
  toggleSidebar: { code: 'KeyB', shift: false },
};

const KEY_GLYPHS = {
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Quote: "'",
  Semicolon: ';',
  Slash: '/',
};

const shortcutLabel = ({ code, shift }) => {
  const glyph = /^Key[A-Z]$/.test(code)
    ? code.slice(3)
    : /^Digit[0-9]$/.test(code)
      ? code.slice(5)
      : KEY_GLYPHS[code] || code;
  return `⌘${shift ? '⇧' : ''}${glyph}`;
};
const STATE_FILE = path.join(__dirname, 'state.json');
const GEOMETRY_STYLE_ID = 'hyper-workspaces-geometry';
const MAX_ASSIGNMENTS = 300;
const MOVE_TAB = '@@DRAGGABLE/MOVE_TAB';

// Fixed cmux palette, sampled from the reference screenshots.
const PALETTE = {
  accent: '#3478f6',
  border: '#2c2e33',
  hover: 'rgba(255, 255, 255, 0.06)',
  sidebarBg: '#232428',
  stripBg: '#202124',
  stripHover: 'rgba(255, 255, 255, 0.05)',
  termBg: '#1b1c1f',
  text: '#e7e7ea',
};

/* ------------------------------- model -------------------------------- */

const workspaceUid = () => 'ws-' + Math.random().toString(36).slice(2, 10);

const clampWidth = (value) =>
  Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(Number(value) || DEFAULT_WIDTH)));

const freshModel = () => {
  const first = { id: workspaceUid(), name: 'General' };
  return {
    assign: {},
    lastTab: {},
    selected: first.id,
    shortcuts: { ...DEFAULT_SHORTCUTS },
    sidebarCollapsed: false,
    sidebarWidth: DEFAULT_WIDTH,
    tabTitle: {},
    workspaces: [first],
  };
};

const normalizeModel = (model) => {
  if (!model || !Array.isArray(model.workspaces) || model.workspaces.length === 0) {
    return freshModel();
  }
  model.assign = model.assign && typeof model.assign === 'object' ? model.assign : {};
  model.lastTab = model.lastTab && typeof model.lastTab === 'object' ? model.lastTab : {};
  model.tabTitle = model.tabTitle && typeof model.tabTitle === 'object' ? model.tabTitle : {};
  const savedShortcuts =
    model.shortcuts && typeof model.shortcuts === 'object' ? model.shortcuts : {};
  model.shortcuts = {};
  for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
    const saved = savedShortcuts[action];
    model.shortcuts[action] =
      saved && typeof saved.code === 'string'
        ? { code: saved.code, shift: !!saved.shift }
        : { ...DEFAULT_SHORTCUTS[action] };
  }
  model.sidebarWidth = clampWidth(model.sidebarWidth);
  model.sidebarCollapsed = !!model.sidebarCollapsed;
  delete model.collapsed; // legacy v1 field
  if (!model.workspaces.some((ws) => ws && ws.id === model.selected)) {
    model.selected = model.workspaces[0].id;
  }
  // Data hygiene: drop assignments pointing at workspaces that no longer
  // exist and titles for tabs without an assignment — stale uids left by
  // old windows that no window can ever use again.
  for (const uid of Object.keys(model.assign)) {
    if (!model.workspaces.some((ws) => ws.id === model.assign[uid])) {
      delete model.assign[uid];
    }
  }
  for (const uid of Object.keys(model.tabTitle)) {
    if (!(uid in model.assign)) delete model.tabTitle[uid];
  }
  return model;
};

const loadModel = () => {
  try {
    return normalizeModel(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch (_) {
    return freshModel();
  }
};

let saveTimer = null;
const saveModel = (model) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const uids = Object.keys(model.assign);
      if (uids.length > MAX_ASSIGNMENTS) {
        for (const uid of uids.slice(0, uids.length - MAX_ASSIGNMENTS)) {
          delete model.assign[uid];
        }
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(model, null, 2));
    } catch (_) {
      // No persistence available; keep working in memory.
    }
  }, 150);
};

/* ------------------------------ geometry ------------------------------- */

const geometryCss = (width, collapsed) => {
  const left = collapsed ? 0 : width;
  return `
    #hyper .terms_terms {
      margin-left: ${left}px !important;
      width: calc(100% - ${left}px) !important;
    }
    #hyper .wsbar { width: ${width}px; }
    #hyper .wstrip { left: ${left}px; }
  `;
};

// Runtime geometry updates (collapse toggle, live resize) go through a
// dedicated style tag appended to <head>, which wins over config.css.
const applyGeometry = (width, collapsed) => {
  if (typeof document === 'undefined') return;
  let tag = document.getElementById(GEOMETRY_STYLE_ID);
  if (!tag) {
    tag = document.createElement('style');
    tag.id = GEOMETRY_STYLE_ID;
    document.head.appendChild(tag);
  }
  tag.textContent = geometryCss(width, collapsed);
};

/* ---------------------------- hyper hooks ------------------------------ */

const canOpenTabs = () =>
  typeof window !== 'undefined' && window.rpc && typeof window.rpc.emit === 'function';

const openNewTab = () => {
  if (!canOpenTabs()) return;
  const state = window.store && window.store.getState();
  const activeUid = state && state.sessions && state.sessions.activeUid;
  window.rpc.emit('new', activeUid ? { activeUid } : {});
};

exports.decorateConfig = (config) => {
  const uiFont =
    config.uiFontFamily || '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const strip = `${STRIP_HEIGHT}px`;
  const saved = loadModel();
  const css = `
    /* The sidebar/strip are rendered INSIDE .header_header (Tabs lives
       there), so the header must stay displayed. It is neutralized instead:
       invisible, click-through and non-draggable; children re-enable their
       own pointer events. */
    .header_header {
      background: transparent !important;
      border: 0 !important;
      box-shadow: none !important;
      pointer-events: none !important;
      -webkit-app-region: no-drag !important;
    }
    /* Terminal: right of the sidebar, below the strip. !important beats
       hyper-tab-move-keys' calc(100% - 36px) and styled-jsx margin-top.
       The horizontal geometry matches the persisted state and is kept in
       sync at runtime by the ${GEOMETRY_STYLE_ID} style tag. */
    .terms_terms {
      height: calc(100% - ${strip}) !important;
      margin-top: ${strip} !important;
    }
    ${geometryCss(saved.sidebarWidth, saved.sidebarCollapsed)}

    /* ------------------------------ sidebar ----------------------------- */
    .wsbar {
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      z-index: 120;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      background: ${PALETTE.sidebarBg};
      border-right: 1px solid ${PALETTE.border};
      color: ${PALETTE.text};
      font-family: ${uiFont};
      font-size: 12px;
      -webkit-font-smoothing: antialiased;
      user-select: none;
      cursor: default;
      pointer-events: auto;
    }
    .wsbar * { box-sizing: border-box; }
    /* Icon row beside the macOS traffic lights; the empty area drags the
       window, like cmux. */
    .wsbar_top {
      flex: none;
      display: flex;
      align-items: center;
      gap: 2px;
      height: 38px;
      padding: 0 8px 0 ${LIGHTS_WIDTH}px;
      -webkit-app-region: drag;
    }
    .wsbar_spring { flex: 1; }
    .wsbar_icon {
      -webkit-app-region: no-drag;
      flex: none;
      background: none;
      border: 0;
      color: inherit;
      font-size: 18px;
      line-height: 1;
      width: 24px;
      height: 24px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 5px;
      cursor: pointer;
      opacity: 0.6;
    }
    .wsbar_icon:hover { opacity: 1; background: ${PALETTE.hover}; }
    .wsbar_list { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 2px 8px 8px; }
    .wsbar_list::-webkit-scrollbar { width: 5px; }
    .wsbar_list::-webkit-scrollbar-thumb {
      background: rgba(127, 127, 127, 0.3);
      border-radius: 3px;
    }
    .ws_block {
      position: relative;
      padding: 6px 10px 7px 12px;
      margin-bottom: 4px;
      border-radius: 8px;
      cursor: pointer;
    }
    .ws_block:hover { background: ${PALETTE.hover}; }
    .ws_block.selected { background: ${PALETTE.accent}; }
    .ws_block.drop {
      outline: 1.5px dashed ${PALETTE.accent};
      outline-offset: -1px;
      background: ${PALETTE.hover};
    }
    .ws_block.selected.drop { outline-color: #fff; }
    .ws_row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .ws_name {
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 13px;
      font-weight: 600;
    }
    .ws_block.selected .ws_name { color: #fff; }
    .ws_meta {
      margin-top: 3px;
      font-size: 11px;
      opacity: 0.55;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ws_block.selected .ws_meta { color: #fff; opacity: 0.8; }
    .ws_dot {
      flex: none;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: ${PALETTE.accent};
    }
    .ws_block.selected .ws_dot { background: #fff; }
    .ws_btn {
      flex: none;
      visibility: hidden;
      background: none;
      border: 0;
      color: inherit;
      font-size: 16px;
      line-height: 1;
      width: 22px;
      height: 22px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      cursor: pointer;
      opacity: 0.65;
    }
    .ws_block:hover .ws_btn, .wstrip_tab:hover .ws_btn {
      visibility: visible;
    }
    .ws_btn:hover { opacity: 1; background: rgba(0, 0, 0, 0.25); }
    .ws_block.selected .ws_btn { color: #fff; }
    .wsbar_foot {
      flex: none;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding: 6px 10px 8px;
      border-top: 1px solid ${PALETTE.border};
    }
    .wsbar_help_btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      background: none;
      border: 0;
      color: inherit;
      padding: 0;
      border-radius: 5px;
      cursor: pointer;
      opacity: 0.55;
    }
    .wsbar_help_btn:hover { opacity: 1; background: ${PALETTE.hover}; }
    .ws_modal_overlay {
      position: fixed;
      inset: 0;
      z-index: 200;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.45);
      pointer-events: auto;
    }
    .ws_modal {
      width: 400px;
      max-width: calc(100vw - 80px);
      background: #26272b;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 10px;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
      padding: 14px 16px 16px;
      font-size: 12px;
    }
    .ws_modal_head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      font-size: 13px;
      font-weight: 600;
      color: #fff;
    }
    .ws_modal_close {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      background: none;
      border: 0;
      color: inherit;
      font-size: 16px;
      padding: 0;
      border-radius: 4px;
      cursor: pointer;
      opacity: 0.6;
    }
    .ws_modal_close:hover { opacity: 1; background: ${PALETTE.hover}; }
    .ws_help_row { display: flex; gap: 10px; align-items: center; padding: 3px 0; }
    .ws_help_key {
      flex: none;
      min-width: 64px;
      text-align: center;
      font-weight: 600;
      color: #fff;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 4px;
      padding: 1px 8px;
      font-size: 11px;
    }
    .ws_help_key.editable {
      cursor: pointer;
      font-family: inherit;
      line-height: inherit;
      border-color: rgba(52, 120, 246, 0.55);
    }
    .ws_help_key.editable:hover {
      border-color: ${PALETTE.accent};
      background: rgba(52, 120, 246, 0.16);
    }
    .ws_help_key.recording {
      border-color: ${PALETTE.accent};
      background: rgba(52, 120, 246, 0.22);
    }
    .ws_modal_note { margin-top: 10px; font-size: 10.5px; line-height: 1.5; opacity: 0.45; }
    .ws_help_txt { opacity: 0.7; }
    .ws_modal_small { width: 320px; }
    .ws_modal_input {
      width: 100%;
      box-sizing: border-box;
      margin: 2px 0 12px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      padding: 6px 8px;
      color: inherit;
      font: inherit;
      font-size: 13px;
      outline: none;
    }
    .ws_modal_input:focus { border-color: ${PALETTE.accent}; }
    .ws_modal_input::placeholder { color: inherit; opacity: 0.35; }
    .ws_modal_actions { display: flex; justify-content: flex-end; gap: 8px; }
    .ws_modal_btn {
      background: rgba(255, 255, 255, 0.08);
      border: 0;
      border-radius: 6px;
      padding: 5px 14px;
      color: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .ws_modal_btn:hover { background: rgba(255, 255, 255, 0.14); }
    .ws_modal_btn.primary { background: ${PALETTE.accent}; color: #fff; }
    .ws_modal_btn.primary:hover { opacity: 0.9; }
    /* Invisible grab area on the right edge; min ${MIN_WIDTH}px, max ${MAX_WIDTH}px. */
    .wsbar_resize {
      position: absolute;
      top: 0;
      right: -3px;
      bottom: 0;
      width: 7px;
      z-index: 10;
      cursor: col-resize;
      -webkit-app-region: no-drag;
    }
    .wsbar_resize:hover, .wsbar_resize.dragging {
      background: linear-gradient(to right, transparent 2px, ${PALETTE.accent} 2px, ${PALETTE.accent} 4px, transparent 4px);
    }

    /* ------------------------------- strip ------------------------------ */
    .wstrip {
      position: fixed;
      top: 0;
      right: 0;
      height: ${strip};
      z-index: 110;
      display: flex;
      align-items: stretch;
      box-sizing: border-box;
      background: ${PALETTE.stripBg};
      border-bottom: 1px solid ${PALETTE.border};
      color: ${PALETTE.text};
      font-family: ${uiFont};
      font-size: 12px;
      -webkit-font-smoothing: antialiased;
      user-select: none;
      pointer-events: auto;
      -webkit-app-region: drag;
      overflow-x: auto;
      overflow-y: hidden;
    }
    .wstrip::-webkit-scrollbar { height: 0; }
    .wstrip * { box-sizing: border-box; }
    /* Room for the traffic lights when the sidebar is collapsed. */
    .wstrip_lights { flex: none; width: ${LIGHTS_WIDTH}px; }
    .wstrip_toggle {
      -webkit-app-region: no-drag;
      flex: none;
      /* Anchored to the top so its center (7 + 24/2 = 19px) matches both
         the expanded .wsbar_top icon row and the macOS traffic lights —
         no vertical shift when collapsing. */
      align-self: flex-start;
      background: none;
      border: 0;
      color: inherit;
      font-size: 18px;
      line-height: 1;
      width: 24px;
      height: 24px;
      margin: 7px 4px 0 0;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 5px;
      cursor: pointer;
      opacity: 0.6;
    }
    .wstrip_toggle:hover { opacity: 1; background: ${PALETTE.stripHover}; }
    .wstrip_tab {
      -webkit-app-region: no-drag;
      flex: 0 1 190px;
      min-width: 96px;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 8px 0 12px;
      border-right: 1px solid ${PALETTE.border};
      cursor: pointer;
      opacity: 0.7;
    }
    .wstrip_tab:hover { background: ${PALETTE.stripHover}; opacity: 0.95; }
    .wstrip_tab.active {
      background: ${PALETTE.termBg};
      box-shadow: inset 0 2px 0 ${PALETTE.accent};
      opacity: 1;
    }
    .wstrip_title {
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .wstrip_jump {
      flex: none;
      font-size: 10px;
      opacity: 0.35;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .wstrip_new {
      -webkit-app-region: no-drag;
      flex: none;
      align-self: center;
      background: none;
      border: 0;
      color: inherit;
      font-size: 18px;
      line-height: 1;
      width: 24px;
      height: 24px;
      margin: 0 4px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 5px;
      cursor: pointer;
      opacity: 0.6;
    }
    .wstrip_new:hover { opacity: 1; background: ${PALETTE.stripHover}; }
  `;
  return Object.assign({}, config, {
    backgroundColor: PALETTE.termBg,
    cursorAccentColor: PALETTE.termBg,
    css: `${config.css || ''}\n${css}`,
  });
};

exports.decorateTabs = (Tabs, { React }) => {
  const h = React.createElement;

  // Rendered at 16px over the 24-unit grid. strokeWidth 1.5 lands on a
  // WHOLE 1 css px stroke (1.5 * 16/24 = 1): crisp on 1x displays and 2
  // device px on retina. Round strokeWidth 2 would render 1.33px, straddle
  // pixels and read as blurry/low quality.
  const svgIcon = (...children) =>
    h(
      'svg',
      {
        fill: 'none',
        height: 16,
        stroke: 'currentColor',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        strokeWidth: 1.5,
        viewBox: '0 0 24 24',
        width: 16,
      },
      ...children
    );
  // Lucide-style icons, all rendered at the same 16px size as the help one.
  const ICONS = {
    close: () => svgIcon(h('path', { d: 'M18 6 6 18' }), h('path', { d: 'm6 6 12 12' })),
    help: () =>
      svgIcon(
        h('circle', { cx: 12, cy: 12, r: 10 }),
        h('path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' }),
        h('path', { d: 'M12 17h.01' })
      ),
    panel: () =>
      svgIcon(h('rect', { height: 18, rx: 2, width: 18, x: 3, y: 3 }), h('path', { d: 'M9 3v18' })),
    plus: () => svgIcon(h('path', { d: 'M5 12h14' }), h('path', { d: 'M12 5v14' })),
  };

  return class WorkspaceSidebar extends React.Component {
    constructor(props) {
      super(props);
      this.state = { dropWs: null, helpOpen: false, model: loadModel(), recordingKey: null, renameTabValue: '', renameValue: '', renaming: null, renamingTab: null, resizing: false };
      this.seenUids = new Set();
      this.wsHadTabs = new Set();
      this.pendingRenameWs = null;
      this.pendingAssign = [];
      this.didEnsureTabs = false;
      this.restoreActiveUid = null;
      this.lastActiveUid = null;
      this.everActiveUids = new Set();
      this.dragUid = null;
      this.dragWs = null;
      this.appliedGeometry = null;
      this.refitRaf = null;
    }

    componentDidMount() {
      this.reconcile();
      this.syncGeometry();
      window.addEventListener('keydown', this.onKeyDown, true);
      window.addEventListener('contextmenu', this.onGlobalContextMenu, true);
      // Nudge xterm to re-fit now that .terms_terms is offset by the sidebar.
      this.scheduleRefit();
    }

    componentWillUnmount() {
      window.removeEventListener('keydown', this.onKeyDown, true);
      window.removeEventListener('contextmenu', this.onGlobalContextMenu, true);
      window.removeEventListener('mousemove', this.onResizeMove);
      window.removeEventListener('mouseup', this.onResizeEnd);
      cancelAnimationFrame(this.refitRaf);
    }

    componentDidUpdate(prevProps) {
      if (prevProps.tabs !== this.props.tabs) this.reconcile();
      this.syncGeometry();
    }

    commit(mutate) {
      const model = this.state.model;
      mutate(model);
      saveModel(model);
      this.setState({ model: Object.assign({}, model) });
    }

    /* ------------------------- geometry / layout ------------------------- */

    syncGeometry() {
      const { sidebarWidth, sidebarCollapsed } = this.state.model;
      const key = `${sidebarWidth}:${sidebarCollapsed}`;
      if (this.appliedGeometry === key) return;
      this.appliedGeometry = key;
      applyGeometry(sidebarWidth, sidebarCollapsed);
      this.scheduleRefit();
    }

    scheduleRefit() {
      cancelAnimationFrame(this.refitRaf);
      this.refitRaf = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    }

    toggleSidebar = () => {
      this.commit((m) => {
        m.sidebarCollapsed = !m.sidebarCollapsed;
      });
    };

    onKeyDown = (event) => {
      // Recording mode (rebinding from the help modal) swallows everything
      // until a valid cmd-based combination or Escape.
      if (this.state.recordingKey) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') {
          this.setState({ recordingKey: null });
          return;
        }
        if (!event.metaKey || event.ctrlKey || event.altKey) return;
        if (/^(Meta|Shift|Control|Alt)/.test(event.key)) return;
        const action = this.state.recordingKey;
        const combo = { code: event.code, shift: event.shiftKey };
        const taken = Object.entries(this.state.model.shortcuts).some(
          ([other, sc]) => other !== action && sc.code === combo.code && sc.shift === combo.shift
        );
        if (taken) return;
        this.commit((m) => {
          m.shortcuts[action] = combo;
        });
        this.setState({ recordingKey: null });
        return;
      }
      const cmdOnly = event.metaKey && !event.ctrlKey && !event.altKey;
      const shortcuts = this.state.model.shortcuts;
      const matches = (sc) => cmdOnly && event.shiftKey === sc.shift && event.code === sc.code;
      if (matches(shortcuts.toggleSidebar)) {
        event.preventDefault();
        event.stopPropagation();
        this.toggleSidebar();
        return;
      }
      // The rename keys reach the renderer because window:reload and
      // window:reloadFull are unbound in ~/.hyper.js keymaps.
      if (matches(shortcuts.renameTab)) {
        event.preventDefault();
        event.stopPropagation();
        this.startTabRenameShortcut();
        return;
      }
      if (matches(shortcuts.renameWorkspace)) {
        event.preventDefault();
        event.stopPropagation();
        this.startWorkspaceRenameShortcut();
        return;
      }
      // cmd+1..9 jumps within the SELECTED workspace (tab:jump:prefix is
      // unbound in ~/.hyper.js keymaps so the digits reach the renderer).
      if (cmdOnly && !event.shiftKey && /^Digit[1-9]$/.test(event.code)) {
        event.preventDefault();
        event.stopPropagation();
        const model = this.state.model;
        const groupTabs = (this.props.tabs || []).filter(
          (tab) => model.assign[tab.uid] === model.selected
        );
        const target = groupTabs[Number(event.code.slice(5)) - 1];
        if (target && !target.isActive) this.selectTab(target.uid);
        return;
      }
      if (
        event.key === 'Escape' &&
        (this.state.helpOpen || this.state.renaming || this.state.renamingTab)
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.setState({
          helpOpen: false,
          recordingKey: null,
          renameTabValue: '',
          renameValue: '',
          renaming: null,
          renamingTab: null,
        });
      }
    };

    toggleHelp = (event) => {
      event.stopPropagation();
      this.setState({ helpOpen: !this.state.helpOpen });
    };

    startWorkspaceRenameShortcut = () => {
      const model = this.state.model;
      const ws = model.workspaces.find((other) => other.id === model.selected);
      if (ws) this.setState({ renameValue: ws.name, renaming: ws.id });
    };

    startTabRenameShortcut = () => {
      const active = (this.props.tabs || []).find((tab) => tab.isActive);
      if (!active) return;
      this.setState({
        renameTabValue: this.state.model.tabTitle[active.uid] || active.title || '',
        renamingTab: active.uid,
      });
    };

    commitTabRename = () => {
      const { renamingTab, renameTabValue } = this.state;
      if (renamingTab) {
        this.commit((m) => {
          const trimmed = renameTabValue.trim();
          if (trimmed) m.tabTitle[renamingTab] = trimmed;
          else delete m.tabTitle[renamingTab]; // empty restores the shell title
        });
      }
      this.setState({ renameTabValue: '', renamingTab: null });
    };

    // Activity dot = output while you were away. Restricted to tabs the
    // user has actually visited, otherwise freshly-materialized shells
    // light it up just by printing their first prompt.
    hasUnseenActivity(tab) {
      return !!tab.hasActivity && !tab.isActive && this.everActiveUids.has(tab.uid);
    }

    titleOf(tab) {
      return this.state.model.tabTitle[tab.uid] || tab.title || 'Shell';
    }

    closeShortcuts = () => this.setState({ helpOpen: false, recordingKey: null });

    renderShortcuts() {
      const shortcuts = this.state.model.shortcuts;
      const recording = this.state.recordingKey;
      const rows = [
        { key: '⌘T', text: 'New tab in the active workspace' },
        { key: '⌘D', text: 'Vertical split in the tab' },
        { key: '⌘⇧D', text: 'Horizontal split in the tab' },
        { action: 'renameTab', text: 'Rename the active tab' },
        { action: 'renameWorkspace', text: 'Rename the selected workspace' },
        { action: 'toggleSidebar', text: 'Collapse / expand the sidebar' },
        { key: '⌘W', text: 'Close the tab' },
        { key: '⌘1…9', text: "Jump to the workspace's Nth tab" },
        { key: '⌘⇧[', text: 'Previous tab' },
        { key: '⌘⇧]', text: 'Next tab' },
        { key: '⌘⌥←', text: 'Move the tab left' },
        { key: '⌘⌥→', text: 'Move the tab right' },
      ];
      return h(
        'div',
        { className: 'ws_modal_overlay', onClick: this.closeShortcuts },
        h(
          'div',
          { className: 'ws_modal', onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { className: 'ws_modal_head' },
            h('span', null, 'Shortcuts'),
            h(
              'button',
              { className: 'ws_modal_close', title: 'Close', onClick: this.closeShortcuts },
              ICONS.close()
            )
          ),
          rows.map((row) =>
            h(
              'div',
              { className: 'ws_help_row', key: row.text },
              row.action
                ? h(
                    'button',
                    {
                      className:
                        'ws_help_key editable' +
                        (recording === row.action ? ' recording' : ''),
                      title: 'Click, then press the new combination (with ⌘)',
                      onClick: () =>
                        this.setState({
                          recordingKey: recording === row.action ? null : row.action,
                        }),
                    },
                    recording === row.action ? '…' : shortcutLabel(shortcuts[row.action])
                  )
                : h('span', { className: 'ws_help_key' }, row.key),
              h('span', { className: 'ws_help_txt' }, row.text)
            )
          ),
          h(
            'div',
            { className: 'ws_modal_note' },
            'Shortcuts with a blue outline are editable: click, then press the new combination (with ⌘). The others come from Hyper (~/.hyper.js) and other plugins.'
          )
        )
      );
    }

    cancelRename = () => {
      this.setState({ renameTabValue: '', renameValue: '', renaming: null, renamingTab: null });
    };

    // Hyper opens the terminal context menu from a window-level listener;
    // right-clicks on the sidebar, strip or modals are not terminal clicks.
    onGlobalContextMenu = (event) => {
      const target = event.target;
      if (target && target.closest && target.closest('.wsbar, .wstrip, .ws_modal_overlay')) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    renderRenameModal() {
      const isWorkspace = !!this.state.renaming;
      const value = isWorkspace ? this.state.renameValue : this.state.renameTabValue;
      const commit = isWorkspace ? this.commitRename : this.commitTabRename;
      return h(
        'div',
        { className: 'ws_modal_overlay', onClick: this.cancelRename },
        h(
          'div',
          { className: 'ws_modal ws_modal_small', onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { className: 'ws_modal_head' },
            h('span', null, isWorkspace ? 'Rename workspace' : 'Rename tab'),
            h(
              'button',
              { className: 'ws_modal_close', title: 'Close', onClick: this.cancelRename },
              ICONS.close()
            )
          ),
          h('input', {
            autoFocus: true,
            className: 'ws_modal_input',
            placeholder: isWorkspace ? '' : 'Leave empty to restore the shell title',
            value,
            onChange: (event) =>
              this.setState(
                isWorkspace
                  ? { renameValue: event.target.value }
                  : { renameTabValue: event.target.value }
              ),
            onFocus: (event) => event.target.select(),
            onKeyDown: (event) => {
              if (event.key === 'Enter') commit();
              if (event.key === 'Escape') this.cancelRename();
            },
          }),
          h(
            'div',
            { className: 'ws_modal_actions' },
            h('button', { className: 'ws_modal_btn', onClick: this.cancelRename }, 'Cancel'),
            h('button', { className: 'ws_modal_btn primary', onClick: commit }, 'Rename')
          )
        )
      );
    }

    startResize = (event) => {
      event.preventDefault();
      this.resizeStartX = event.clientX;
      this.resizeStartWidth = this.state.model.sidebarWidth;
      this.setState({ resizing: true });
      window.addEventListener('mousemove', this.onResizeMove);
      window.addEventListener('mouseup', this.onResizeEnd);
    };

    // Live resize mutates the model and updates the geometry style tag
    // directly (no React re-render per mousemove); the final width is
    // committed once on mouseup.
    onResizeMove = (event) => {
      const width = clampWidth(this.resizeStartWidth + (event.clientX - this.resizeStartX));
      if (width === this.state.model.sidebarWidth) return;
      this.state.model.sidebarWidth = width;
      this.appliedGeometry = `${width}:false`;
      applyGeometry(width, false);
      this.scheduleRefit();
    };

    onResizeEnd = () => {
      window.removeEventListener('mousemove', this.onResizeMove);
      window.removeEventListener('mouseup', this.onResizeEnd);
      this.setState({ resizing: false });
      this.commit(() => {}); // persist the width mutated during the drag
    };

    /* ----------------------------- model sync ---------------------------- */

    // Routes each arriving tab to the workspace that requested it (the
    // pendingAssign queue) or to the selected one, prunes tabs this window
    // saw disappear, materializes a session for every tab-less workspace at
    // boot, removes workspaces that lost their last tab, and follows the
    // active tab's workspace when the active tab CHANGES (so selecting an
    // empty workspace isn't immediately overridden).
    reconcile() {
      const model = this.state.model;
      const tabs = this.props.tabs || [];
      // While tabs are being materialized (queued spawns / focus restore),
      // activations are programmatic — they must not mark tabs as "visited"
      // for the activity dot.
      const materializing = this.pendingAssign.length > 0 || !!this.restoreActiveUid;
      const alive = new Set();
      let dirty = false;
      for (const tab of tabs) {
        alive.add(tab.uid);
        if (!model.workspaces.some((ws) => ws.id === model.assign[tab.uid])) {
          model.assign[tab.uid] = this.takePendingAssign(model) || model.selected;
          dirty = true;
        }
        this.seenUids.add(tab.uid);
      }
      // The default tab of a brand-new workspace steals focus when it
      // spawns, which would blur-commit an already-open rename input; the
      // rename only starts once that tab has actually arrived.
      if (
        this.pendingRenameWs &&
        tabs.some((tab) => model.assign[tab.uid] === this.pendingRenameWs)
      ) {
        const pending = model.workspaces.find((ws) => ws.id === this.pendingRenameWs);
        this.pendingRenameWs = null;
        if (pending) this.setState({ renameValue: pending.name, renaming: pending.id });
      }
      for (const uid of Object.keys(model.assign)) {
        if (this.seenUids.has(uid) && !alive.has(uid)) {
          delete model.assign[uid];
          delete model.tabTitle[uid];
          this.seenUids.delete(uid);
          dirty = true;
        }
      }
      const active = tabs.find((tab) => tab.isActive);
      const liveCount = new Map();
      for (const tab of tabs) {
        const wsId = model.assign[tab.uid];
        liveCount.set(wsId, (liveCount.get(wsId) || 0) + 1);
      }
      // A workspace whose LAST tab just left (closed or dragged out) is
      // removed automatically. Only workspaces that already had a tab in
      // this window count — a freshly created workspace is safe while its
      // default tab is still being spawned.
      if (model.workspaces.length > 1) {
        const keep = model.workspaces.filter(
          (ws) => !(this.wsHadTabs.has(ws.id) && !liveCount.get(ws.id))
        );
        if (keep.length === 0) keep.push(model.workspaces[0]);
        if (keep.length !== model.workspaces.length) {
          for (const ws of model.workspaces) {
            if (!keep.includes(ws)) {
              delete model.lastTab[ws.id];
              this.wsHadTabs.delete(ws.id);
            }
          }
          model.workspaces = keep;
          if (!keep.some((ws) => ws.id === model.selected)) {
            model.selected = (active && model.assign[active.uid]) || keep[0].id;
          }
          dirty = true;
        }
      }
      if (tabs.length) {
        for (const [wsId, count] of liveCount) {
          if (count > 0) this.wsHadTabs.add(wsId);
        }
      }
      // Every workspace owns its terminals: once the boot tab exists, any
      // workspace still without a live tab gets a session of its own
      // (persisted workspaces restored after a restart, for example).
      if (!this.didEnsureTabs && tabs.length) {
        this.didEnsureTabs = true;
        let spawned = false;
        for (const ws of model.workspaces) {
          if (!liveCount.get(ws.id)) {
            this.pendingAssign.push(ws.id);
            openNewTab();
            spawned = true;
          }
        }
        // Spawned tabs activate themselves as they arrive; remember where
        // the user was so focus returns once the queue drains.
        if (spawned && active) this.restoreActiveUid = active.uid;
      }
      if (this.restoreActiveUid && this.pendingAssign.length === 0) {
        const restore = this.restoreActiveUid;
        this.restoreActiveUid = null;
        if (alive.has(restore) && (!active || active.uid !== restore)) {
          this.selectTab(restore);
        }
      }
      if (active) {
        const wsId = model.assign[active.uid];
        if (model.lastTab[wsId] !== active.uid) {
          model.lastTab[wsId] = active.uid;
          dirty = true;
        }
        if (active.uid !== this.lastActiveUid) {
          this.lastActiveUid = active.uid;
          if (!materializing) this.everActiveUids.add(active.uid);
          if (wsId !== model.selected) {
            model.selected = wsId;
            dirty = true;
          }
        }
      }
      if (dirty) {
        saveModel(model);
        this.setState({ model: Object.assign({}, model) });
      }
    }

    // Pops the first pending workspace that still exists.
    takePendingAssign(model) {
      while (this.pendingAssign.length) {
        const candidate = this.pendingAssign.shift();
        if (model.workspaces.some((ws) => ws.id === candidate)) return candidate;
      }
      return null;
    }

    /* ----------------------------- actions ------------------------------- */

    selectTab = (uid) => {
      const onChange = this.props.onChange || this.props.onSelect;
      if (onChange) onChange(uid);
    };

    closeTab = (event, uid) => {
      event.stopPropagation();
      if (this.props.onClose) this.props.onClose(uid);
    };

    selectWorkspace = (ws) => {
      const model = this.state.model;
      const groupTabs = (this.props.tabs || []).filter((tab) => model.assign[tab.uid] === ws.id);
      const remembered = groupTabs.find((tab) => tab.uid === model.lastTab[ws.id]);
      const target = remembered || groupTabs[0];
      this.commit((m) => {
        m.selected = ws.id;
      });
      if (target) {
        if (!target.isActive) this.selectTab(target.uid);
      } else {
        // A workspace always owns its terminals — an empty one (transient
        // states only) gets its own session instead of borrowing another
        // workspace's terminal.
        this.pendingAssign.push(ws.id);
        openNewTab();
      }
    };

    addWorkspace = () => {
      const ws = { id: workspaceUid(), name: `Workspace ${this.state.model.workspaces.length + 1}` };
      this.commit((m) => {
        m.workspaces.push(ws);
        m.selected = ws.id;
      });
      // Every workspace starts with a tab of its own; the rename input opens
      // via reconcile() after that tab arrives (see pendingRenameWs).
      this.pendingRenameWs = ws.id;
      this.pendingAssign.push(ws.id);
      openNewTab();
    };

    deleteWorkspace = (event, ws) => {
      event.stopPropagation();
      this.commit((m) => {
        if (m.workspaces.length <= 1) return;
        m.workspaces = m.workspaces.filter((other) => other.id !== ws.id);
        const fallback = m.workspaces[0].id;
        for (const uid of Object.keys(m.assign)) {
          if (m.assign[uid] === ws.id) m.assign[uid] = fallback;
        }
        if (m.selected === ws.id) m.selected = fallback;
        delete m.lastTab[ws.id];
      });
    };

    newTabIn = (event, ws) => {
      event.stopPropagation();
      this.commit((m) => {
        m.selected = ws.id;
      });
      this.pendingAssign.push(ws.id);
      openNewTab();
    };

    startRename = (event, ws) => {
      event.stopPropagation();
      this.setState({ renameValue: ws.name, renaming: ws.id });
    };

    commitRename = () => {
      const { renaming, renameValue } = this.state;
      if (renaming) {
        this.commit((m) => {
          const ws = m.workspaces.find((other) => other.id === renaming);
          if (ws && renameValue.trim()) ws.name = renameValue.trim();
        });
      }
      this.setState({ renameValue: '', renaming: null });
    };

    /* --------------------------- drag and drop --------------------------- */

    onTabDragStart = (event, uid) => {
      this.dragUid = uid;
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData('text/plain', uid);
      } catch (_) {
        // dataTransfer can be unavailable in synthetic events; instance field covers it.
      }
    };

    onTabDragEnd = () => {
      this.dragUid = null;
      this.setState({ dropWs: null });
    };

    // Live reorder while dragging over a sibling strip tab, using
    // hyper-reorderable-tabs' MOVE_TAB reducer. The half-width rule keeps it
    // stable (no dispatch when the effective order wouldn't change).
    onStripTabDragOver = (event, targetUid) => {
      event.preventDefault();
      const dragged = this.dragUid;
      if (!dragged || dragged === targetUid || !window.store) return;
      const state = window.store.getState();
      const ordered = state.termGroups && state.termGroups.termGroupsOrdered;
      if (!ordered) return; // hyper-reorderable-tabs not installed
      const from = ordered.indexOf(dragged);
      const to = ordered.indexOf(targetUid);
      if (from === -1 || to === -1) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const isAfter = event.clientX > rect.left + rect.width / 2;
      const newIndex = isAfter ? to + 1 : to;
      const finalIndex = from < newIndex ? newIndex - 1 : newIndex;
      if (finalIndex === from) return;
      window.store.dispatch({ type: MOVE_TAB, uid: dragged, position: to, isAfter });
    };

    onWorkspaceDragStart = (event, ws) => {
      this.dragWs = ws.id;
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData('application/x-hyper-workspace', ws.id);
      } catch (_) {
        // dataTransfer can be unavailable in synthetic events; instance field covers it.
      }
    };

    onWorkspaceDragEnd = () => {
      this.dragWs = null;
      this.setState({ dropWs: null });
    };

    // Live workspace reorder while dragging a block over a sibling, using the
    // same half-size rule as strip tabs, on the vertical axis.
    onWorkspaceReorderOver = (event, target) => {
      if (this.dragWs === target.id) return;
      const workspaces = this.state.model.workspaces;
      const from = workspaces.findIndex((ws) => ws.id === this.dragWs);
      const to = workspaces.findIndex((ws) => ws.id === target.id);
      if (from === -1 || to === -1) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const isAfter = event.clientY > rect.top + rect.height / 2;
      const newIndex = isAfter ? to + 1 : to;
      const finalIndex = from < newIndex ? newIndex - 1 : newIndex;
      if (finalIndex === from) return;
      this.commit((m) => {
        const [moved] = m.workspaces.splice(from, 1);
        m.workspaces.splice(finalIndex, 0, moved);
      });
    };

    onBlockDragOver = (event, ws) => {
      event.preventDefault();
      if (this.dragWs) {
        this.onWorkspaceReorderOver(event, ws);
        return;
      }
      event.dataTransfer.dropEffect = 'move';
      if (this.state.dropWs !== ws.id) this.setState({ dropWs: ws.id });
    };

    onBlockDragLeave = (ws) => {
      if (this.state.dropWs === ws.id) this.setState({ dropWs: null });
    };

    onBlockDrop = (event, ws) => {
      event.preventDefault();
      if (this.dragWs) {
        this.dragWs = null; // reorder already applied live during dragover
        return;
      }
      const uid =
        this.dragUid || (event.dataTransfer ? event.dataTransfer.getData('text/plain') : null);
      this.dragUid = null;
      this.setState({ dropWs: null });
      if (uid) {
        this.commit((m) => {
          m.assign[uid] = ws.id;
        });
      }
    };

    /* ------------------------------ render ------------------------------- */

    renderBlock(ws, groupTabs) {
      const model = this.state.model;
      const selected = model.selected === ws.id;
      const hasActivity = groupTabs.some((tab) => this.hasUnseenActivity(tab));
      const current =
        groupTabs.find((tab) => tab.uid === model.lastTab[ws.id]) || groupTabs[0];
      const meta = current ? this.titleOf(current) : '\u00a0';
      return h(
        'div',
        {
          className:
            'ws_block' +
            (selected ? ' selected' : '') +
            (this.state.dropWs === ws.id ? ' drop' : ''),
          draggable: true,
          key: ws.id,
          onClick: () => this.selectWorkspace(ws),
          onDragEnd: this.onWorkspaceDragEnd,
          onDragLeave: () => this.onBlockDragLeave(ws),
          onDragOver: (event) => this.onBlockDragOver(event, ws),
          onDragStart: (event) => this.onWorkspaceDragStart(event, ws),
          onDrop: (event) => this.onBlockDrop(event, ws),
        },
        h(
          'div',
          { className: 'ws_row' },
          h(
            'span',
            { className: 'ws_name', onDoubleClick: (event) => this.startRename(event, ws) },
            ws.name
          ),
          hasActivity ? h('span', { className: 'ws_dot' }) : null,
          this.state.model.workspaces.length > 1
            ? h(
                'button',
                {
                  className: 'ws_btn',
                  title: 'Delete workspace (tabs move to the first one)',
                  onClick: (event) => this.deleteWorkspace(event, ws),
                },
                ICONS.close()
              )
            : null
        ),
        h('div', { className: 'ws_meta' }, meta)
      );
    }

    renderStripTab(tab, jumpIndex) {
      return h(
        'div',
        {
          className: 'wstrip_tab' + (tab.isActive ? ' active' : ''),
          draggable: true,
          key: tab.uid,
          title: this.titleOf(tab),
          onClick: () => this.selectTab(tab.uid),
          onDoubleClick: () =>
            this.setState({
              renameTabValue: this.state.model.tabTitle[tab.uid] || tab.title || '',
              renamingTab: tab.uid,
            }),
          onDragEnd: this.onTabDragEnd,
          onDragOver: (event) => this.onStripTabDragOver(event, tab.uid),
          onDragStart: (event) => this.onTabDragStart(event, tab.uid),
        },
        h('span', { className: 'wstrip_title' }, this.titleOf(tab)),
        this.hasUnseenActivity(tab)
          ? h('span', { className: 'ws_dot', title: 'New activity' })
          : null,
        jumpIndex <= 9 ? h('span', { className: 'wstrip_jump' }, `⌘${jumpIndex}`) : null,
        this.props.onClose
          ? h(
              'button',
              {
                className: 'ws_btn',
                title: 'Close tab',
                onClick: (event) => this.closeTab(event, tab.uid),
              },
              ICONS.close()
            )
          : null
      );
    }

    render() {
      const model = this.state.model;
      const collapsed = model.sidebarCollapsed;
      const tabs = this.props.tabs || [];
      const byWorkspace = new Map(model.workspaces.map((ws) => [ws.id, []]));
      tabs.forEach((tab) => {
        const assigned = model.assign[tab.uid];
        const wsId = byWorkspace.has(assigned)
          ? assigned
          : byWorkspace.has(model.selected)
            ? model.selected
            : model.workspaces[0].id;
        byWorkspace.get(wsId).push(tab);
      });
      const stripTabs = byWorkspace.get(model.selected) || [];
      const selectedWs =
        model.workspaces.find((ws) => ws.id === model.selected) || model.workspaces[0];
      return h(
        React.Fragment,
        null,
        collapsed
          ? null
          : h(
              'div',
              { className: 'wsbar' },
              h(
                'div',
                { className: 'wsbar_top' },
                h(
                  'button',
                  {
                    className: 'wsbar_icon',
                    title: 'Collapse sidebar (⌘B)',
                    onClick: this.toggleSidebar,
                  },
                  ICONS.panel()
                ),
                h('span', { className: 'wsbar_spring' }),
                h(
                  'button',
                  { className: 'wsbar_icon', title: 'New workspace', onClick: this.addWorkspace },
                  ICONS.plus()
                )
              ),
              h(
                'div',
                { className: 'wsbar_list' },
                model.workspaces.map((ws) => this.renderBlock(ws, byWorkspace.get(ws.id)))
              ),
              h(
                'div',
                { className: 'wsbar_foot' },
                h(
                  'button',
                  { className: 'wsbar_help_btn', title: 'Help', onClick: this.toggleHelp },
                  ICONS.help()
                )
              ),
              h('div', {
                className: 'wsbar_resize' + (this.state.resizing ? ' dragging' : ''),
                onMouseDown: this.startResize,
              })
            ),
        h(
          'div',
          { className: 'wstrip' },
          collapsed ? h('div', { className: 'wstrip_lights' }) : null,
          collapsed
            ? h(
                'button',
                {
                  className: 'wstrip_toggle',
                  title: 'Expand sidebar (⌘B)',
                  onClick: this.toggleSidebar,
                },
                ICONS.panel()
              )
            : null,
          stripTabs.map((tab, index) => this.renderStripTab(tab, index + 1)),
          canOpenTabs()
            ? h(
                'button',
                {
                  className: 'wstrip_new',
                  title: 'New tab in this workspace',
                  onClick: (event) => this.newTabIn(event, selectedWs),
                },
                ICONS.plus()
              )
            : null
        ),
        this.state.helpOpen ? this.renderShortcuts() : null,
        this.state.renaming || this.state.renamingTab ? this.renderRenameModal() : null
      );
    }
  };
};
