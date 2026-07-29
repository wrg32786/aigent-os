export const objective = `objective: ${process.env.AIGENT_OBJECTIVE}`;
export const action = `next_valid_action: ${process.env['AIGENT_NEXT_ACTION']}`;
export const mixed = `objective: ${inert('label') + process.env.AIGENT_OBJECTIVE}`;
export const multiline = `next_valid_action: ${
  process.env.AIGENT_NEXT_ACTION
}`;
export const optional = `objective: ${process.env?.AIGENT_OBJECTIVE}`;
