/** Command that hands installDir to the stack owner, skipping (not descending into) keepOwner paths. */
export function ownershipCommand(installDir: string, appUser: string, keepOwner: string[]): string {
  const dir = installDir.replace(/\/+$/, '')
  if (keepOwner.length === 0) return `sudo chown -R ${appUser}:${appUser} ${dir}/`
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const prune = keepOwner.map(p => `-path ${q(`${dir}/${p.replace(/^\/+|\/+$/g, '')}`)} -prune -o`).join(' ')
  return `sudo find ${dir} ${prune} -exec chown ${appUser}:${appUser} {} +`
}
