// Diagram export: renders the flow viewport (all or some nodes) to PNG / SVG, saves images
// and prints them through a hidden frame (Electron blocks window.open).

import { toPng, toSvg } from 'html-to-image';
import { getNodesBounds, type Node } from '@xyflow/react';
import { tr } from '@shared/i18n';
import { api } from '../../../api/client';
import { pickSaveFile } from '../../../lib/files';
import { cssVar } from '../../../lib/theme';

export type ImageFormat = 'png' | 'svg';

const MAX_SIDE = 15000;

/** Renders the nodes (and the edges between them) of a React Flow container to a data URL. */
export async function renderDiagram(container: HTMLElement, nodes: Node[], format: ImageFormat, opts: { padding?: number; pixelRatio?: number; only?: boolean } = {}): Promise<string> {
  const viewport = container.querySelector<HTMLElement>('.react-flow__viewport');
  if (!viewport || !nodes.length) throw new Error(tr('Das Diagramm ist leer.', 'The diagram is empty.'));
  const b = getNodesBounds(nodes);
  const ids = new Set(nodes.map((n) => n.id));
  const pad = opts.padding ?? 32;
  const width = Math.ceil(b.width + pad * 2);
  const height = Math.ceil(b.height + pad * 2);
  const options = {
    backgroundColor: cssVar('--bg-panel') || '#ffffff',
    width,
    height,
    skipFonts: true,
    style: { width: `${width}px`, height: `${height}px`, transform: `translate(${pad - b.x}px, ${pad - b.y}px) scale(1)` },
    filter: (el: HTMLElement) => {
      const c = el.classList;
      if (!c) return true;
      if (c.contains('react-flow__handle') || c.contains('ks-dg-noexport')) return false;
      // single objects: other nodes and all relation lines are left out
      if (opts.only && (c.contains('react-flow__edges') || c.contains('react-flow__edgelabel-renderer'))) return false;
      if (opts.only && c.contains('react-flow__node')) return ids.has(el.getAttribute('data-id') ?? '');
      return true;
    }
  };
  if (format === 'svg') return toSvg(viewport, options);
  const ratio = Math.max(0.25, Math.min(opts.pixelRatio ?? 2, MAX_SIDE / Math.max(width, height)));
  return toPng(viewport, { ...options, pixelRatio: ratio });
}

/** Runs `fn` while the light theme is active (print output). */
export async function withLightTheme<T>(fn: () => Promise<T>): Promise<T> {
  const root = document.documentElement;
  const prev = root.dataset.theme;
  if (prev !== 'dark') return fn();
  root.dataset.theme = 'light';
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  try {
    return await fn();
  } finally {
    root.dataset.theme = prev;
  }
}

export function dataUrlToBytes(url: string): Uint8Array {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function svgText(url: string): string {
  const body = url.slice(url.indexOf(',') + 1);
  return /;base64,/.test(url.slice(0, url.indexOf(',') + 1)) ? atob(body) : decodeURIComponent(body);
}

/** Asks for a file name and writes the image; returns the path or null when cancelled. */
export async function saveImage(dataUrl: string, defaultPath: string, format: ImageFormat): Promise<string | null> {
  const path = await pickSaveFile({
    title: tr('Bild speichern', 'Save image'),
    defaultPath,
    filters: [format === 'png' ? { name: 'PNG', extensions: ['png'] } : { name: 'SVG', extensions: ['svg'] }]
  });
  if (!path) return null;
  const file = new RegExp(`\\.${format}$`, 'i').test(path) ? path : `${path}.${format}`;
  if (format === 'png') await api.fs.writeBinary(file, dataUrlToBytes(dataUrl));
  else await api.fs.writeText(file, svgText(dataUrl));
  return file;
}

/** Opens the print dialog for an image. */
export function printImage(dataUrl: string, title: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  const esc = title.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  frame.srcdoc =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc}</title><style>@page{margin:10mm}html,body{margin:0;background:#fff}` +
    `img{display:block;max-width:100%;max-height:100vh;margin:0 auto;object-fit:contain}</style></head><body><img alt=""></body></html>`;
  frame.onload = () => {
    const win = frame.contentWindow;
    const img = frame.contentDocument?.querySelector('img');
    if (!win || !img) {
      frame.remove();
      return;
    }
    img.onload = () => {
      win.focus();
      win.print();
      window.setTimeout(() => frame.remove(), 1500);
    };
    img.src = dataUrl;
  };
  document.body.appendChild(frame);
}
