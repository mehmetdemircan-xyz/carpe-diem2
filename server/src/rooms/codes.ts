import { randomInt } from 'node:crypto';

/**
 * Crockford-style alphabet: no 0/O, no 1/I/L. A code read aloud over voice
 * chat should be unambiguous.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUP_LENGTH = 4;
const GROUPS = 2;

/**
 * ~31^8 ≈ 8.5e11 possible codes, drawn from a CSPRNG. Guessing a live room by
 * brute force is not viable, especially with the join rate limit in front of it.
 */
export function generateRoomCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g += 1) {
    let group = '';
    for (let i = 0; i < GROUP_LENGTH; i += 1) {
      group += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

const CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${GROUP_LENGTH}}-[${ALPHABET}]{${GROUP_LENGTH}}$`);

/**
 * Accepts what a human might paste: lowercase, missing dash, stray whitespace.
 * Returns the canonical form, or null when it cannot possibly be a code.
 */
export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const stripped = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (stripped.length !== GROUP_LENGTH * GROUPS) return null;

  const candidate = `${stripped.slice(0, GROUP_LENGTH)}-${stripped.slice(GROUP_LENGTH)}`;
  return CODE_PATTERN.test(candidate) ? candidate : null;
}
