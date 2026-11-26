/**
 * paths.ts — fixed locations on a node. Global airstack config lives under /etc/airstack only.
 */

export const NODE_ETC = '/etc/airstack'
/** Per-unit manifests (PROJECT_NAME, INSTALL_DIR, RUN_USER, … plus plugin entries) read by host scripts. */
export const DEFAULT_MANIFEST_DIR = '/etc/airstack/stacks'
/** Where stack-cli kept manifests; still accepted for orphan cleanup so old files get removed. */
export const LEGACY_MANIFEST_DIR = '/etc/stacks'
