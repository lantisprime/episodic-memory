#!/usr/bin/env node
/**
 * install.mjs — Install episodic-memory scripts globally and per-tool instructions.
 *
 * Usage:
 *   node install.mjs --tool <claude-code|cursor|codex|windsurf|all> [--project <path>]
 *
 * Steps:
 *   1. Copies scripts to ~/.episodic-memory/scripts/
 *   2. Creates ~/.episodic-memory/episodes/ if not exists
 *   3. Copies the appropriate instruction file to the target project (or cwd)
 *   4. Creates .episodic-memory/ in the target project for local episodes
 *
 * For Claude Code, also sets up the plugin structure.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const SCRIPTS_DIR = path.join(GLOBAL_DIR, 'scripts')
const REPO_DIR = path.dirname(new URL(import.meta.url).pathname)
const REPO_SCRIPTS = path.join(REPO_DIR, 'scripts')
const REPO_INSTRUCTIONS = path.join(REPO_DIR, 'instructions')

const argv = process.argv.slice(2)
function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const tool = flag('--tool')
const projectDir = flag('--project') || process.cwd()

if (!tool) {
  console.log(`Usage: node install.mjs --tool <claude-code|cursor|codex|windsurf|all> [--project <path>]

Tools:
  claude-code  Install SKILL.md + plugin structure
  cursor       Install .cursor/rules/episodic-memory.mdc
  codex        Install AGENTS.md (or append to existing)
  windsurf     Install .windsurfrules (or append to existing)
  all          Install for all supported tools`)
  process.exit(1)
}

const VALID_TOOLS = ['claude-code', 'cursor', 'codex', 'windsurf', 'all']
if (!VALID_TOOLS.includes(tool)) {
  console.log(`Invalid tool "${tool}". Must be one of: ${VALID_TOOLS.join(', ')}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 1. Install scripts globally
// ---------------------------------------------------------------------------
fs.mkdirSync(SCRIPTS_DIR, { recursive: true })
fs.mkdirSync(path.join(GLOBAL_DIR, 'episodes'), { recursive: true })

const scriptFiles = fs.readdirSync(REPO_SCRIPTS).filter(f => f.endsWith('.mjs'))
for (const file of scriptFiles) {
  const src = path.join(REPO_SCRIPTS, file)
  const dst = path.join(SCRIPTS_DIR, file)
  fs.copyFileSync(src, dst)
  fs.chmodSync(dst, 0o755)
}
console.log(`Installed ${scriptFiles.length} scripts to ${SCRIPTS_DIR}`)

// ---------------------------------------------------------------------------
// 2. Create local .episodic-memory in target project
// ---------------------------------------------------------------------------
const localDir = path.join(projectDir, '.episodic-memory')
fs.mkdirSync(path.join(localDir, 'episodes'), { recursive: true })

// Add to .gitignore if it exists
const gitignorePath = path.join(projectDir, '.gitignore')
if (fs.existsSync(gitignorePath)) {
  const content = fs.readFileSync(gitignorePath, 'utf8')
  if (!content.includes('.episodic-memory')) {
    fs.appendFileSync(gitignorePath, '\n# Episodic memory data\n.episodic-memory/\n')
    console.log('Added .episodic-memory/ to .gitignore')
  }
}

// ---------------------------------------------------------------------------
// 3. Install tool-specific instructions
// ---------------------------------------------------------------------------
const tools = tool === 'all' ? ['claude-code', 'cursor', 'codex', 'windsurf'] : [tool]

for (const t of tools) {
  switch (t) {
    case 'claude-code': {
      // Copy SKILL.md into .claude/skills/ or skills/ structure
      const skillDir = path.join(projectDir, '.claude', 'skills', 'episodic-memory')
      fs.mkdirSync(skillDir, { recursive: true })
      fs.copyFileSync(
        path.join(REPO_INSTRUCTIONS, 'SKILL.md'),
        path.join(skillDir, 'SKILL.md')
      )
      console.log(`Installed Claude Code skill to ${skillDir}/SKILL.md`)
      break
    }
    case 'cursor': {
      const rulesDir = path.join(projectDir, '.cursor', 'rules')
      fs.mkdirSync(rulesDir, { recursive: true })
      fs.copyFileSync(
        path.join(REPO_INSTRUCTIONS, 'cursor.mdc'),
        path.join(rulesDir, 'episodic-memory.mdc')
      )
      console.log(`Installed Cursor rules to ${rulesDir}/episodic-memory.mdc`)
      break
    }
    case 'codex': {
      const agentsFile = path.join(projectDir, 'AGENTS.md')
      const instructions = fs.readFileSync(path.join(REPO_INSTRUCTIONS, 'AGENTS.md'), 'utf8')
      if (fs.existsSync(agentsFile)) {
        const existing = fs.readFileSync(agentsFile, 'utf8')
        if (!existing.includes('episodic-memory')) {
          fs.appendFileSync(agentsFile, '\n' + instructions)
          console.log('Appended episodic-memory section to existing AGENTS.md')
        } else {
          console.log('AGENTS.md already contains episodic-memory instructions')
        }
      } else {
        fs.writeFileSync(agentsFile, instructions)
        console.log(`Created ${agentsFile}`)
      }
      break
    }
    case 'windsurf': {
      const wsFile = path.join(projectDir, '.windsurfrules')
      const instructions = fs.readFileSync(path.join(REPO_INSTRUCTIONS, 'windsurf.md'), 'utf8')
      if (fs.existsSync(wsFile)) {
        const existing = fs.readFileSync(wsFile, 'utf8')
        if (!existing.includes('episodic-memory')) {
          fs.appendFileSync(wsFile, '\n' + instructions)
          console.log('Appended episodic-memory section to existing .windsurfrules')
        } else {
          console.log('.windsurfrules already contains episodic-memory instructions')
        }
      } else {
        fs.writeFileSync(wsFile, instructions)
        console.log(`Created ${wsFile}`)
      }
      break
    }
  }
}

console.log('\nDone! Episodic memory is ready.')
console.log(`Global data:  ${GLOBAL_DIR}/`)
console.log(`Local data:   ${localDir}/`)
console.log(`Scripts:      ${SCRIPTS_DIR}/`)
