/* global figma, __html__ */
// 🎨 Adhit Office Figma bridge — plugin main thread (Figma Plugin API).
// It receives one command at a time from ui.html and answers with a plain JSON value.
figma.showUI(__html__, { width: 340, height: 210 });

const MAX_NODES = 500;

const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) throw new Error(`Warna tidak valid: ${hex} (pakai #RRGGBB)`);
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
};

const solid = (hex) => [{ type: 'SOLID', color: hexToRgb(hex) }];

const rgbToHex = (c) => {
  const to = (v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255).toString(16).padStart(2, '0');
  return `#${to(c?.r)}${to(c?.g)}${to(c?.b)}`.toUpperCase();
};

const fillOf = (node) => {
  const paint = Array.isArray(node.fills) ? node.fills.find((f) => f.type === 'SOLID' && f.visible !== false) : null;
  return paint ? rgbToHex(paint.color) : null;
};

function summary(node) {
  const out = {
    id: node.id,
    name: node.name,
    type: node.type,
    x: typeof node.x === 'number' ? Math.round(node.x) : undefined,
    y: typeof node.y === 'number' ? Math.round(node.y) : undefined,
    width: typeof node.width === 'number' ? Math.round(node.width) : undefined,
    height: typeof node.height === 'number' ? Math.round(node.height) : undefined,
    visible: node.visible !== false,
  };
  if (node.type === 'TEXT') Object.assign(out, { characters: String(node.characters ?? '').slice(0, 500), fontSize: node.fontSize, fontName: node.fontName });
  const fill = fillOf(node);
  if (fill) out.fill = fill;
  if (node.cornerRadius) out.cornerRadius = node.cornerRadius;
  if ('children' in node && Array.isArray(node.children)) out.children = node.children.length;
  return out;
}

async function nodeById(id) {
  if (!id) throw new Error('id node kosong');
  const node = figma.getNodeByIdAsync ? await figma.getNodeByIdAsync(String(id)) : figma.getNodeById(String(id));
  if (!node) throw new Error(`Node tidak ditemukan: ${id}`);
  return node;
}

async function parentFor(id, node) {
  if (!id) return figma.currentPage;
  const parent = await nodeById(id);
  if (!('appendChild' in parent)) throw new Error(`Node ${id} tidak bisa menampung anak.`);
  parent.appendChild(node);
  return parent;
}

function place(node, args) {
  if (typeof args.x === 'number') node.x = args.x;
  if (typeof args.y === 'number') node.y = args.y;
  if (typeof args.width === 'number' && 'resize' in node) node.resize(Math.max(1, args.width), Math.max(1, typeof args.height === 'number' ? args.height : node.height));
  else if (typeof args.height === 'number' && 'resize' in node) node.resize(node.width, Math.max(1, args.height));
}

function tree(node, depth, state) {
  if (state.count >= MAX_NODES || depth < 0) return summary(node);
  state.count++;
  const out = summary(node);
  if ('children' in node && Array.isArray(node.children) && node.children.length && depth > 0) {
    out.children = node.children.slice(0, 80).map((child) => tree(child, depth - 1, state));
  }
  return out;
}

async function run(cmd, args) {
  switch (cmd) {
    case 'status':
      return {
        file: figma.root.name,
        page: figma.currentPage.name,
        pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })),
        selection: figma.currentPage.selection.length,
        editor: figma.editorType,
      };
    case 'selection':
      return figma.currentPage.selection.map(summary);
    case 'page':
      return tree(figma.currentPage, Math.max(1, Math.min(6, Number(args.depth) || 3)), { count: 0 });
    case 'node':
      return tree(await nodeById(args.id), 2, { count: 0 });
    case 'export': {
      const node = await nodeById(args.id);
      if (args.format === 'png') {
        const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: Math.max(0.1, Math.min(4, Number(args.scale) || 2)) } });
        return { format: 'png', data: `data:image/png;base64,${figma.base64Encode(bytes)}` };
      }
      return { format: 'svg', data: await node.exportAsync({ format: 'SVG_STRING' }) };
    }
    case 'create_frame': {
      const frame = figma.createFrame();
      frame.name = String(args.name ?? 'Frame').slice(0, 120);
      await parentFor(args.parentId, frame);
      place(frame, args);
      frame.fills = args.fill ? solid(args.fill) : [];
      return { id: frame.id, name: frame.name, width: frame.width, height: frame.height };
    }
    case 'create_rect': {
      const rect = figma.createRectangle();
      rect.name = String(args.name ?? 'Rectangle').slice(0, 120);
      await parentFor(args.parentId, rect);
      place(rect, args);
      rect.fills = solid(args.fill ?? '#D9D4CB');
      if (typeof args.radius === 'number') rect.cornerRadius = Math.max(0, args.radius);
      return { id: rect.id, name: rect.name, width: rect.width, height: rect.height };
    }
    case 'create_text': {
      await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
      const text = figma.createText();
      text.fontName = { family: 'Inter', style: 'Regular' };
      text.characters = String(args.text ?? '').slice(0, 4000);
      text.fontSize = Math.max(6, Math.min(200, Number(args.size) || 16));
      await parentFor(args.parentId, text);
      if (typeof args.x === 'number') text.x = args.x;
      if (typeof args.y === 'number') text.y = args.y;
      text.fills = solid(args.color ?? '#1E1B18');
      return { id: text.id, name: text.name, width: text.width, height: text.height };
    }
    case 'set_fill': {
      const node = await nodeById(args.id);
      if (!('fills' in node)) throw new Error('Node ini tidak punya fills.');
      node.fills = solid(args.color);
      return { id: node.id, fill: args.color };
    }
    case 'move': {
      const node = await nodeById(args.id);
      if (typeof args.x === 'number') node.x = args.x;
      if (typeof args.y === 'number') node.y = args.y;
      return { id: node.id, x: node.x, y: node.y };
    }
    default:
      throw new Error(`Perintah tidak dikenal: ${cmd}`);
  }
}

figma.ui.onmessage = async (msg) => {
  if (!msg) return;
  if (msg.type === 'status') {
    figma.ui.postMessage({ type: 'status', file: figma.root.name, page: figma.currentPage.name });
    return;
  }
  if (msg.type !== 'cmd') return;
  try {
    const data = await run(String(msg.cmd), msg.args && typeof msg.args === 'object' ? msg.args : {});
    figma.ui.postMessage({ type: 'result', id: msg.id, ok: true, data });
  } catch (err) {
    figma.ui.postMessage({ type: 'result', id: msg.id, ok: false, error: String(err?.message ?? err).slice(0, 500) });
  }
};
