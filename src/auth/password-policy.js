/* Password rules: minimum length 6, maximum length 128. Obvious passwords are blocked. */

export const POLICY = { minLength: 6, maxLength: 128 };

const OBVIOUS = ['password', 'qwerty', 'letmein', 'welcome', 'iloveyou', 'admin', 'changeit'];

export function passwordProblem(password, { email, name } = {}) {
  if (typeof password !== 'string' || password.length < POLICY.minLength) {
    return `Use at least ${POLICY.minLength} characters.`;
  }
  if (password.length > POLICY.maxLength) return `Use ${POLICY.maxLength} characters or fewer.`;

  const lower = password.toLowerCase();
  const local = String(email ?? '').split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return "Don't include your email address.";

  for (const part of String(name ?? '').toLowerCase().split(/\s+/)) {
    if (part.length >= 4 && lower.includes(part)) return "Don't include your name.";
  }
  if (lower.includes('garageplug')) return "Don't include the company name.";

  const letters = lower.replace(/[^a-z]/g, '');
  if (/^(.)\1+$/.test(password) || /^\d+$/.test(password) ||
      OBVIOUS.some((w) => letters === w || (letters.startsWith(w) && letters.length <= w.length + 2))) {
    return 'That password is too easy to guess. A short phrase of unrelated words works well.';
  }
  return null;
}
