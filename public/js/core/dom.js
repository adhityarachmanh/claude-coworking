// DOM helpers shared by every module.

export const $ = (sel) => document.querySelector(sel);
export { escapeHtml } from '../office/stage.js';

export const isTyping = (el) => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

// Phone-width layout (bottom navigation, one-line composer).
export const narrow = matchMedia('(max-width: 760px)');
