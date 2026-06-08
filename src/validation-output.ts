export type ColorFn = (s: string) => string;

export function printValidationIssue(error: string, color: ColorFn): void {
  const issue = parseValidationIssue(error);
  console.error('  ' + color('where: ') + issue.where);
  console.error('  ' + color('what:  ') + issue.what);
  if (issue.detail) console.error('  ' + color('detail: ') + issue.detail);
}

export function parseValidationIssue(error: string): { where: string; what: string; detail: string } {
  const match = /^([^:]+):\s*(.*?)(?:\s+(\{.*\}))?$/.exec(error);
  if (!match) return { where: '<unknown>', what: error, detail: '' };
  return {
    where: match[1],
    what: match[2],
    detail: match[3] ?? '',
  };
}
