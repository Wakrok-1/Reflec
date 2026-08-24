// Deterministic gradient generator for the Character Profile class badge
// (design spec v1.0, section 8). The user's class is freeform, so the
// badge color isn't picked from a preset list — it's derived from the
// class name string, so the same name always produces the same gradient.
export function classNameToGradient(className: string): string {
  const hash = className
    .toLowerCase()
    .split('')
    .reduce((acc, c) => acc + c.charCodeAt(0), 0)
  const hue1 = hash % 360
  const hue2 = (hash * 7) % 360
  return `linear-gradient(135deg, hsl(${hue1}, 65%, 65%), hsl(${hue2}, 70%, 55%))`
}
