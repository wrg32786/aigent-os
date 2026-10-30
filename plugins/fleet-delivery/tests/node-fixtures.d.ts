// The Node built-ins used by direct-hooks.mts. Keep this narrow so the fixtures
// can be checked alongside the dependency-free plugin without Node globals.
declare module 'node:assert/strict' {
  const assert: {
    ok(value: unknown, message?: string | Error): asserts value
    equal(actual: unknown, expected: unknown, message?: string | Error): void
    deepEqual(actual: unknown, expected: unknown, message?: string | Error): void
  }
  export default assert
}

declare module 'node:test' {
  export function test(name: string, body: () => void | Promise<void>): Promise<void>
}
