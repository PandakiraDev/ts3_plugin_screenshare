export const DEFAULT_PORT = 8080

/**
 * Port z ENV, z odpornością na śmieci. Hostingi (Railway/Render) wstrzykują PORT
 * same, ale potrafią podać pusty string — wtedy lepiej wystartować na domyślnym
 * niż wywalić kontener przy starcie.
 */
export function resolvePort(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!raw || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_PORT
  }
  return parsed
}
