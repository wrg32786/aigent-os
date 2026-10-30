'use strict';

const escaped = ['password', 'passwd', 'token', 'secret', 'api_key', 'apiKey',
  'access_token', 'refresh_token', 'client_secret', 'key'].flatMap((key) =>
  ['"', "'"].map((quote) => ({
    name: `escaped ${quote === '"' ? 'double' : 'single'} quote ${key}`,
    command: `curl -X POST -d "{\\${quote}${key}\\${quote}:\\${quote}hunter2\\${quote}}" https://api/login`,
    secret: 'hunter2',
  })));
const gh = ['secret', 'variable'].flatMap((kind) => ['--body ', '-b ', '', '--body='].map((flag) => ({
  name: `gh ${kind} ${flag || 'positional'}`,
  command: `gh ${kind} set NAME ${flag}hunter2`, secret: 'hunter2',
})));
const headers = ['x-api-key', 'api-key', 'X-Custom-Token', 'service-secret', 'user-password'].map((key) => ({
  name: `header ${key}`, input: `${key}: abc123`,
  command: `curl -X POST -H '${key}: abc123' https://x`, secret: 'abc123',
}));
const punctuation = ['(password:hunter2)', '{password: hunter2}', '{client_secret:hunter2}',
  '[auth_token: hunter2]', 'x,password:hunter2'].map((input) => ({
  name: `punctuated credential ${input}`, input, command: `curl -d '${input}' https://x`, secret: 'hunter2',
}));
const prefixedCredentials = [
  ...['GH_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', '--password', '--api-key', '--auth-token', '--client-secret']
    .map((key) => ({ name: `prefixed credential ${key}`, input: `${key}=privatevalue`, command: `${key}=privatevalue`, secret: 'privatevalue' })),
  ...['p', 'o', 'u', 's', 'r'].map((shape) => ({ name: `GitHub gh${shape} token`, input: `gh${shape}_abc123`, command: `gh${shape}_abc123`, secret: `gh${shape}_abc123` })),
  ...['git push -u origin main', 'tokenizer: bpe', 'keyword=foo'].map((input) => ({ name: `preserve ${input}`, input, command: input, unchanged: true })),
];
module.exports = { escaped, gh, headers, punctuation, prefixedCredentials };
