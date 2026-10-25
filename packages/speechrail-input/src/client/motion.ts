/**
 * Motion preferences, read from the running environment.
 * @module @hrygo/dsh-speechrail-bundle/client/motion
 */

/**
 * Whether the system asks for less motion.
 *
 * A fade is decoration, so a user who asked for less motion should not get one, and a rotating
 * indicator is worse than decoration for anyone whose vestibular system reacts to it: that phase has
 * a static form. Read per render rather than subscribed - a preference changed mid-session lands on
 * the next render, which every phase change already causes. Guarded, because not every environment
 * exposes `matchMedia` (jsdom, for one, does not).
 * @returns true when `prefers-reduced-motion: reduce` matches.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
