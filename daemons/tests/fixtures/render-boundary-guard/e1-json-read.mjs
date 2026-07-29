import { readFileSync } from 'node:fs';

const state = JSON.parse(readFileSync('ACTIVE_STATE.json', 'utf8'));
export const rendered = `objective: ${state.current_objective}`;
export const renderedMultiline = `objective: ${
  state.current_objective
}`;
export const renderedMixed = `objective: ${inert('label') + state.current_objective}`;
export const renderedWithLength = `objective: ${state.current_objective + other.length}`;
