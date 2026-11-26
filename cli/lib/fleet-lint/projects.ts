// Compose project and install dir checks across the stack instances of one machine.

import type { Issue, Machine } from '../fleet.js'
import { MACHINE_UNIT } from '../units.js'

export function checkProjectsAndDirs(machine: Machine, mFile: string, issues: Issue[]) {
  const machineDir = `${machine.root}/machine`
  const seenProject = new Map<string, string>()
  const seenDir: { dir: string; owner: string }[] = [{ dir: machineDir, owner: `the machine project (${machineDir})` }]
  for (const inst of machine.instances) {
    const key = `stacks.${inst.name}`
    if (inst.composeProject === MACHINE_UNIT) {
      issues.push({ level: 'fail', file: mFile, key: `${key}.composeProject`, message: `compose project '${MACHINE_UNIT}' is the machine project. Use another composeProject.` })
    } else {
      const other = seenProject.get(inst.composeProject)
      if (other) {
        issues.push({ level: 'fail', file: mFile, key: `${key}.composeProject`, message: `compose project '${inst.composeProject}' is already used by stacks.${other}. Use another composeProject.` })
      } else {
        seenProject.set(inst.composeProject, inst.name)
      }
    }
    const dir = inst.installDir.replace(/\/+$/, '')
    for (const s of seenDir) {
      let why = ''
      if (dir === s.dir) why = `install dir ${dir} is already used by ${s.owner}`
      else if (dir.startsWith(s.dir + '/')) why = `install dir ${dir} is inside the install dir of ${s.owner}`
      else if (s.dir.startsWith(dir + '/')) why = `install dir ${dir} contains the install dir of ${s.owner}`
      if (why) {
        issues.push({ level: 'fail', file: mFile, key: `${key}.installDir`, message: `${why}. Deploy can delete the other stack's files. Use a separate installDir.` })
        break
      }
    }
    seenDir.push({ dir, owner: `stacks.${inst.name}` })
  }
}
