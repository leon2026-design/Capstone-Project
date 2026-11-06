/**
 * Extracts only explicit, conventional version designations at the end of a
 * reviewed title. A download suffix such as "(1)" is not a version.
 */
export function reviewedVersionFromTitle(title: string): string | null {
  const suffix = /\(([^()]*)\)\s*$/u.exec(title)?.[1]?.trim();
  if (!suffix) return null;
  const explicitVersion = /^(?:radio(?:\s+(?:edit|mix|version))?|extended(?:\s+(?:mix|edit|version))?|(?:.+\s+)?(?:remix|rerub)|(?:club|original|dj)\s+(?:mix|edit|version)|instrumental|acoustic|a\s*cappella|live(?:\s+at\s+.+)?|remaster(?:ed)?|sped\s+up|slowed)$/iu;
  return explicitVersion.test(suffix) ? suffix : null;
}
