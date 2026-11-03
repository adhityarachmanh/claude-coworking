// The office canvas: one Scene per project, drawn by the single Stage.
import { Scene } from '../office/scene.js';
import { Stage } from '../office/stage.js';
import { Brain } from '../office/brain.js';
import { $ } from './dom.js';
import { state } from './state.js';

export const scenes = new Map();
export const stage = new Stage($('#stage'));
// 🧠 Mode Otak: the same office as a neural network (office/brain.js), toggled on the stage, remembered per browser
export const brain = new Brain($('#stage'));

export function sceneFor(id) {
  let scene = scenes.get(id);
  if (!scene) {
    scene = new Scene();
    for (const evt of state.events[id] ?? []) scene.handle(evt, false);
    if (state.statuses[id]) scene.setStatus(state.statuses[id]);
    for (const approval of state.approvals.values()) if (approval.project === id && approval.status === 'pending') scene.restorePending(approval);
    scenes.set(id, scene);
  }
  return scene;
}
