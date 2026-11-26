/**
 * paths.ts — fixed locations on a node. Global airstack config lives under /etc/airstack only.
 */

export const NODE_ETC = '/etc/airstack'
/** Per-unit manifests (PROJECT_NAME, INSTALL_DIR, RUN_USER, … plus plugin entries) read by host scripts. */
export const DEFAULT_MANIFEST_DIR = '/etc/airstack/stacks'
/** Legacy: where stack-cli (airstack's predecessor) kept manifests. Kept on purpose so orphan
 *  cleanup can still remove old files from machines set up before airstack. */
export const LEGACY_MANIFEST_DIR = '/etc/stacks'
