// The plugin ships standalone and cannot import daemons/; the parity test is the contract.
export const CAPSULE_SECTIONS = Object.freeze([
  { key: 'done', maxDepth: 2, title: "Done (don't redo)", anchor: '<!-- swe:done -->', headingPattern: '^Done\\b.*redo' },
  { key: 'errors', maxDepth: 2, title: 'Historical-Errors -> Resolutions', anchor: '<!-- swe:errors -->', headingPattern: '^Historical-Errors\\s*(?:→|->)\\s*Resolutions' },
  { key: 'rejected', maxDepth: 2, title: 'Historical-Rejected-Approaches', anchor: '<!-- swe:rejected -->', headingPattern: '^Historical-Rejected-Approaches$' },
  { key: 'files', maxDepth: 2, title: 'Files-Read / Files-Modified', anchor: '<!-- swe:files -->', headingPattern: '^Files-Read / Files-Modified$' },
  { key: 'facts', maxDepth: 2, title: 'Operating-Facts', anchor: '<!-- swe:facts -->', headingPattern: '^Operating-Facts$' },
  { key: 'effects', maxDepth: 3, title: 'In-Flight Side Effects', anchor: '<!-- swe:effects -->', headingPattern: '^In-Flight Side Effects' },
  { key: 'gates', maxDepth: 3, title: 'Pending-Gates', anchor: '<!-- swe:gates -->', headingPattern: '^Pending-Gates$' },
  { key: 'rows', maxDepth: 2, title: 'Claimed-Rows', anchor: '<!-- swe:rows -->', headingPattern: '^Claimed-Rows$' },
].map((entry) => Object.freeze({ ...entry, heading: new RegExp(entry.headingPattern, 'i') })));
