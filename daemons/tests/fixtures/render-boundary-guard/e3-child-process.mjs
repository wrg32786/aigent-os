import { execSync, spawnSync } from 'node:child_process';

const execOutput = execSync('state-command', { encoding: 'utf8' });
const spawnOutput = spawnSync('state-command', [], { encoding: 'utf8' }).stdout;
export const execRendered = `objective: ${execOutput}`;
export const spawnRendered = `next_valid_action: ${spawnOutput}`;
export const execMixed = `objective: ${inert('label') + execOutput}`;
export const spawnMultiline = `next_valid_action: ${
  spawnOutput
}`;
export const directSpawnNested = `objective: ${
  spawnSync(commandFor(value), [], { encoding: 'utf8' }).stdout
}`;
