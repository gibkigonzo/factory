// Odczyt specu z treści issue: kryteria akceptacji i ryzyko produktowe.
// Format pochodzi z szablonu specu (skill spec-writer): sekcje „## Kryteria akceptacji” i „## Ryzyko produktowe: …”.

export interface IssueSpec {
  acceptance: string[];
  productRisk?: 'low' | 'high';
}

const HEADING = /^#{1,3}\s+/;
const ACCEPTANCE = /^#{1,3}\s+Kryteria akceptacji/i;
const ITEM = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;
const RISK = /^#{0,3}\s*Ryzyko produktowe\s*:\s*(niskie|wysokie)\s*$/im;

export function parseSpec(body: string): IssueSpec {
  const acceptance: string[] = [];
  let inside = false;
  for (const line of body.split(/\r?\n/)) {
    if (ACCEPTANCE.test(line)) {
      inside = true;
      continue;
    }
    if (inside && HEADING.test(line)) break;
    const item = inside ? ITEM.exec(line) : null;
    if (item) acceptance.push(item[1]!);
  }
  const risk = RISK.exec(body)?.[1]?.toLowerCase();
  const spec: IssueSpec = { acceptance };
  if (risk) spec.productRisk = risk === 'wysokie' ? 'high' : 'low';
  return spec;
}

export function normalizeCriterion(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
