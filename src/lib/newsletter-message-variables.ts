const supported = new Set(["{{contact.name}}", "{{project.name}}", "{{agent.name}}"]);

export function newsletterVariableIssues(content: string): string[] {
  const tokens = content.match(/\{\{[^}]*\}\}/g) ?? [];
  const issues = tokens.filter(token => !supported.has(token));
  if (/\{\{|\}\}/.test(content.replace(/\{\{[^}]*\}\}/g, ""))) issues.push("Unvollständige Pflichtvariable");
  return [...new Set(issues)];
}
