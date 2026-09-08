// Stand-in for the real `server-only` package under Vitest.
//
// `server-only`'s package.json resolves to a no-op (`empty.js`) only when
// the `react-server` export condition is set, which is how Next.js's
// webpack build marks a Server Components bundle. Vitest runs plain Node
// with no such condition, so importing the real package throws
// unconditionally — see vitest.shared.ts, which aliases "server-only" to
// this file for every package's tests.
export {};
