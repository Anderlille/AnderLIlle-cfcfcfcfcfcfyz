/**
 * Theme settings bridge.
 *
 * Komari renders a settings form from komari-theme.json and returns typed values in
 * `publicSettings.theme_settings`. CF-Server-Monitor only stores a free-form
 * `theme_options` object (edited as raw JSON in the admin panel, or saved by the theme
 * through POST /api/theme_options). This module turns that object back into the exact
 * typed map the Glassmorphism store expects.
 */
import { THEME_SCHEMA } from '@/cfsm/themeSchema'

type SchemaField = Extract<(typeof THEME_SCHEMA)[number], { key: string }>

export const THEME_FIELDS: SchemaField[] = THEME_SCHEMA.filter((item): item is SchemaField => 'key' in item)

/**
 * CFSM-specific default overrides.
 * - rpcTransportMode: Komari defaults to HTTP polling every 3 s. On CFSM every poll is a
 *   Worker request, so the port defaults to the push-based /api/ws channel instead.
 */
const CFSM_DEFAULT_OVERRIDES: Record<string, unknown> = {
  rpcTransportMode: 'websocket',
}

export function themeDefaults(): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  for (const field of THEME_FIELDS)
    defaults[field.key] = field.default
  return { ...defaults, ...CFSM_DEFAULT_OVERRIDES }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Accept both a flat `{ key: value }` object and the `{ configuration: [{ key, value }] }` style other CFSM themes document. */
export function flattenThemeOptions(raw: unknown): Record<string, unknown> {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    }
    catch {
      return {}
    }
  }
  if (!isRecord(value))
    return {}

  const flat: Record<string, unknown> = {}
  const configuration = value.configuration
  const list = Array.isArray(configuration)
    ? configuration
    : isRecord(configuration) && Array.isArray(configuration.data) ? configuration.data : []
  for (const item of list) {
    if (isRecord(item) && typeof item.key === 'string')
      flat[item.key] = 'value' in item ? item.value : item.default
  }
  for (const [key, option] of Object.entries(value)) {
    if (key !== 'configuration')
      flat[key] = option
  }
  return flat
}

function coerce(field: SchemaField, value: unknown): unknown {
  switch (field.type) {
    case 'switch':
      if (typeof value === 'boolean')
        return value
      if (value === 1 || value === '1' || value === 'true')
        return true
      if (value === 0 || value === '0' || value === 'false')
        return false
      return field.default
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value ?? '').trim())
      return Number.isFinite(n) && String(value ?? '').trim() !== '' ? n : field.default
    }
    case 'pingtasks':
      return Array.isArray(value) ? JSON.stringify(value) : value
    default:
      return value === null || value === undefined ? field.default : String(value)
  }
}

/** Saved options (typed) without defaults — used when writing back so defaults are not frozen into storage. */
export function normalizeSavedThemeOptions(raw: unknown): Record<string, unknown> {
  const flat = flattenThemeOptions(raw)
  const result: Record<string, unknown> = {}
  const fields = new Map(THEME_FIELDS.map(field => [field.key, field]))
  for (const [key, value] of Object.entries(flat)) {
    const field = fields.get(key)
    result[key] = field ? coerce(field, value) : value
  }
  return result
}

/** Defaults + saved values, typed exactly like Komari's `theme_settings`. */
export function resolveThemeSettings(raw: unknown): Record<string, unknown> {
  return { ...themeDefaults(), ...normalizeSavedThemeOptions(raw) }
}
