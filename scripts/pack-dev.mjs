#!/usr/bin/env node
/**
 * Pack a development build for the machine that runs it.
 *
 * The published package is the only official build; this script produces a
 * pre-release tarball the author installs locally to try the current checkout.
 * The version carries a `-dev.<timestamp>` suffix so `GET /health` tells the
 * two apart, and semver keeps the eventual release (`0.1.4`) above every
 * pre-release of it (`0.1.4-dev.202610312330`), so installing the release
 * later replaces the dev build instead of looking like a downgrade.
 *
 * The tarball is staged from the exact file list `npm pack` would ship, so the
 * dev build keeps the shape of the published one (prebuilt client.js included).
 */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** `yyyymmddHHMM` in local time: sortable, and valid inside a semver pre-release. */
function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`
}

function run(args, cwd) {
  execFileSync(npm, args, { cwd, stdio: 'inherit' })
}

const version = `${pkg.version}-dev.${stamp()}`
console.log(`pack:dev — ${pkg.name}@${version}`)

// The tarball must be the bundle users install, so it is built and tested first.
run(['run', 'build'], root)
run(['test'], root)

const dryRun = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root,
  encoding: 'utf8',
}))
const report = Array.isArray(dryRun) ? dryRun[0] : dryRun[pkg.name] ?? Object.values(dryRun)[0]
const files = report?.files?.map((entry) => entry.path) ?? []
if (files.length === 0) throw new Error('npm pack reported no files to ship')

const stage = path.join(root, '.dev-pack', version)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
for (const file of files) {
  const target = path.join(stage, file)
  mkdirSync(path.dirname(target), { recursive: true })
  cpSync(path.join(root, file), target)
}
writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify({ ...pkg, version }, null, 2)}\n`)

const dist = path.join(root, 'dist')
mkdirSync(dist, { recursive: true })
run(['pack', '--ignore-scripts', '--pack-destination', dist], stage)
rmSync(stage, { recursive: true, force: true })
console.log(`pack:dev — installed artifact: ${path.join(dist, `${pkg.name}-${version}.tgz`)}`)
