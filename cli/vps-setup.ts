// vps-setup.ts — VPS provisioning steps for `airstack deploy <machine> --install`.
// The code lives in ./setup/. This file re-exports it so importers keep one path.

export { runVpsSetup, SETUP_STEPS, SetupFailed, type SetupStep, type SetupFlags, type SetupOptions } from './setup/index.js'
