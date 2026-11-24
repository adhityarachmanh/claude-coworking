// The office canvas: one Scene per project, drawn by the single Stage.
import { Scene } from '../office/scene.js';
import { Stage } from '../office/stage.js';
import { Brain } from '../office/brain.js';
import { Terminal } from '../office/terminal.js';
import { Mission } from '../office/mission.js';
import { Orchestra } from '../office/orchestra.js';
import { $ } from './dom.js';
import { state } from './state.js';

export const scenes = new Map();
export const stage = new Stage($('#stage'));
// 🧠 Mode Otak: the same office as a neural network (office/brain.js), toggled on the stage, remembered per browser
export const brain = new Brain($('#stage'));
// 💻 Mode Terminal: one hacker terminal per role, every line a real chat row (office/terminal.js)
export const terminal = new Terminal($('#stage'));
// 🛰 Mission Control: the current mission as a NASA-style dashboard (office/mission.js)
export const mission = new Mission($('#stage'));
// 🎼 Mode Orkestra: the team as an orchestra, optional soft music (office/orchestra.js)
export const orchestra = new Orchestra($('#stage'));

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
