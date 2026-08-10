// Runs a wasm32-wasip1 binary under Node's WASI, used as cargo's test runner on
// machines without a C linker. See ../.cargo/config.toml.
import { WASI } from 'node:wasi';
import { readFileSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

const [wasmPath, ...rest] = argv.slice(2);
if (!wasmPath) {
  console.error('usage: wasi-run.mjs <file.wasm> [args...]');
  exit(2);
}

const wasi = new WASI({
  version: 'preview1',
  args: [wasmPath, ...rest],
  env,
  preopens: { '/': '/' },
  returnOnExit: true,
  // Inherit the real stdio explicitly. Without this, panic messages written to
  // fd 2 are lost and a failing test reports only "RuntimeError: unreachable".
  stdin: 0,
  stdout: 1,
  stderr: 2,
});

const module = await WebAssembly.compile(readFileSync(wasmPath));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
exit(wasi.start(instance));
