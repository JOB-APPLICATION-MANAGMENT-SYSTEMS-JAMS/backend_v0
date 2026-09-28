/**
 * Skill synonym graph (§34.2) — local, curated, no external calls at query time.
 * Keys are canonical forms; each group is treated as one concept for matching.
 */
export const SYNONYM_GROUPS: string[][] = [
  ["javascript", "js", "node", "nodejs", "node.js", "typescript", "ts"],
  ["react", "reactjs", "react.js", "next", "nextjs", "next.js"],
  ["python", "py", "django", "flask", "fastapi"],
  ["java", "spring", "springboot", "spring boot"],
  ["kubernetes", "k8s"],
  ["postgres", "postgresql", "pg"],
  ["mongodb", "mongo"],
  ["graphql", "gql"],
  ["terraform", "iac", "infrastructure as code"],
  ["ci/cd", "cicd", "continuous integration", "continuous delivery"],
  ["aws", "amazon web services", "gcp", "google cloud", "azure"],
  ["docker", "containers", "containerisation", "containerization"],
  ["machine learning", "ml", "deep learning", "ai"],
  ["data engineering", "etl", "data pipelines"],
  ["figma", "ui design", "ux design"],
  ["product management", "pm", "product manager"],
  ["sql", "mysql", "pl/sql"],
  ["redis", "cache", "caching"],
  ["kafka", "event streaming", "message queue"],
  ["go", "golang"],
  ["rust", "rustlang"],
  ["ruby", "rails", "ruby on rails"],
  ["devops", "sre", "site reliability"],
  ["fullstack", "full stack", "full-stack", "fullstack engineer"],
  ["frontend", "front end", "front-end", "ui engineer"],
  ["backend", "back end", "back-end"],
  ["microservices", "service oriented"],
  ["rest", "rest api", "restful"],
  ["graphql api", "apollo"],
  ["vue", "vuejs", "vue.js"],
  ["angular"],
  ["swift", "ios", "ios development"],
  ["kotlin", "android"],
  ["css", "tailwind", "tailwindcss", "sass", "styled components"],
  ["html"],
  ["git", "github", "gitlab"],
  ["linux", "unix", "bash", "shell"],
  ["testing", "unit testing", "jest", "vitest", "pytest", "tdd"],
  ["security", "appsec", "owasp", "pentesting"],
  ["blockchain", "web3", "solidity"],
  ["sales", "b2b sales", "account executive"],
  ["marketing", "seo", "growth"],
  ["excel", "spreadsheets", "google sheets"],
  ["communication", "stakeholder management"],
];

const canon = (s: string) =>
  s
    .toLowerCase()
    .replace(/[.#]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Expand a skill/token into its concept family (order-preserving, self included). */
export function expand(token: string): string[] {
  const c = canon(token);
  if (!c) return [];
  for (const group of SYNONYM_GROUPS) {
    if (group.some((g) => canon(g) === c)) return [...new Set(group.map(canon))];
  }
  return [c];
}

/** Both directions: does token A relate to token B? */
export function related(a: string, b: string): boolean {
  const ea = expand(a);
  const eb = expand(b);
  return ea.some((x) => eb.includes(x));
}

/** Tokenize free text into normalized lowercase tokens (drops punctuation + stopwords). */
const STOPWORDS = new Set(
  `a an and are as at be by for from has have in is it of on or that the to was we you your with will our us their this than then there these those who what when where how not no but if can could should would may might must do does did more most other over under own same so such only too very just also about into out up down before after during while between each few many much both any all one two new role job position work working experience years year strong great looking seeking join team`.split(" ")
);

export function tokenize(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9+#./\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[-.]+|[-.]+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}
