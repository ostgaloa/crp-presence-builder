import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const maximumPresetBytes = 4_000_000

export function sanitizePresetName(value) {
  if (typeof value !== 'string') throw new Error('Preset name is invalid.')
  const name = value.trim().replace(/\.txt$/i, '')
  const hasControlCharacter = [...name].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  if (!name || name.length > 64 || hasControlCharacter || /[<>:"/\\|?*]/.test(name) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    throw new Error('Preset name is invalid.')
  }
  return name
}

function ensurePresetDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true })
  const info = fs.lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Preset directory is invalid.')
  return path.resolve(directory)
}

function presetFilePath(directory, requestedName) {
  const root = ensurePresetDirectory(directory)
  const name = sanitizePresetName(requestedName)
  const filePath = path.resolve(root, `${name}.txt`)
  if (path.dirname(filePath) !== root) throw new Error('Preset path is invalid.')
  try {
    const info = fs.lstatSync(filePath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Preset must be a regular file.')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return filePath
}

export function listPresets(directory) {
  const root = ensurePresetDirectory(directory)
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'))
    .flatMap((entry) => {
      const name = path.basename(entry.name, path.extname(entry.name))
      try {
        const filePath = presetFilePath(root, name)
        return [{ name, updatedAt: fs.statSync(filePath).mtimeMs }]
      } catch {
        return []
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function savePreset(directory, requestedName, content) {
  if (typeof content !== 'string' || content.length === 0 || Buffer.byteLength(content, 'utf8') > maximumPresetBytes) {
    throw new Error('Preset content is invalid or too large.')
  }
  const filePath = presetFilePath(directory, requestedName)
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    try {
      fs.unlinkSync(temporaryPath)
    } catch {
    }
  }
  return sanitizePresetName(requestedName)
}

export function loadPreset(directory, requestedName) {
  const filePath = presetFilePath(directory, requestedName)
  const info = fs.statSync(filePath)
  if (info.size > maximumPresetBytes) throw new Error('Preset is too large.')
  return fs.readFileSync(filePath, 'utf8')
}

export function deletePreset(directory, requestedName) {
  const name = sanitizePresetName(requestedName)
  const filePath = presetFilePath(directory, name)
  fs.unlinkSync(filePath)
  return name
}