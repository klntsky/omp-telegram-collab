export function isMentionableSkillName(name: string): boolean {
  return name.length > 0 && !/[\s\u0000-\u001f\u007f-\u009f\\]/u.test(name);
}

export function skillCommandAliases(skills: Array<{ name: string; description: string }>): Map<string, { name: string; description: string }> {
  const aliases = new Map<string, { name: string; description: string }>();
  for (const skill of skills) {
    if (!isMentionableSkillName(skill.name)) continue;
    const normalized = skill.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!normalized) continue;
    const alias = `skill_${normalized}`.slice(0, 32);
    if (!aliases.has(alias)) aliases.set(alias, skill);
  }
  return aliases;
}
