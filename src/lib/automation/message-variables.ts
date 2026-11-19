export type AutomationMessageValues = { contactName: string; projectName: string; agentName: string; requestUrl?: string };
const names = ["contact.name", "project.name", "agent.name", "request.url"] as const;
export function automationMessageVariableIssues(subject: string, body: string, values?: AutomationMessageValues): string[] {
  const issues: string[] = [], content = `${subject}\n${body}`;
  for (const match of content.matchAll(/\{\{([^}]+)\}\}/g)) {
    if (!(names as readonly string[]).includes(match[1])) { issues.push(`Unbekannte Pflichtvariable: ${match[0]}`); continue; }
    if (values) {
      const value = match[1] === "contact.name" ? values.contactName : match[1] === "project.name" ? values.projectName : match[1] === "agent.name" ? values.agentName : values.requestUrl;
      if (!value?.trim()) issues.push(`Pflichtvariable fehlt: ${match[0]}`);
    }
  }
  if (/\{\{|\}\}/.test(content.replace(/\{\{[^}]+\}\}/g, ""))) issues.push("Eine Pflichtvariable ist unvollständig geschrieben.");
  return [...new Set(issues)];
}
