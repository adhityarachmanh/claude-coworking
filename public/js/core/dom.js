// DOM helpers shared by every module.

export const $ = (sel) => document.querySelector(sel);
export { escapeHtml } from '../office/stage.js';

export const isTyping = (el) => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

// Phone layout (bottom navigation, sheets): a narrow window, or a phone held sideways (touch, short screen).
// Keep in sync with the phone @media blocks in public/css/app.css.
export const narrow = matchMedia('(max-width: 760px), (pointer: coarse) and (max-height: 500px)');
