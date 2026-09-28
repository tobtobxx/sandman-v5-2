// Minimal JSON-schema subset: validate + repair (DESIGN §10.1, P3).
// Over-long strings and arrays are truncated, not rejected. Missing nullable keys get null.
// Missing required keys and invalid enum values are errors.

export type Schema = Record<string, any>;

export interface Validation {
  value: any;
  repairs: string[];
  error?: string;
}

export function validate(schema: Schema, value: any): Validation {
  const repairs: string[] = [];
  try {
    const v = walk(schema, value, "$", repairs);
    return { value: v, repairs };
  } catch (e) {
    return { value, repairs, error: (e as Error).message };
  }
}

function types(s: Schema): string[] {
  return Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
}

function walk(s: Schema, v: any, path: string, repairs: string[]): any {
  if (s.anyOf) {
    const errs: string[] = [];
    for (const alt of s.anyOf) {
      const r: string[] = [];
      try {
        const out = walk(alt, v, path, r);
        repairs.push(...r);
        return out;
      } catch (e) {
        errs.push((e as Error).message);
      }
    }
    throw new Error(`${path}: matches no alternative (${errs.join(" | ")})`);
  }
  const t = types(s);
  if (v === null || v === undefined) {
    if (t.includes("null")) return null;
    throw new Error(`${path}: missing`);
  }
  if (s.const !== undefined && v !== s.const) throw new Error(`${path}: expected ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) {
    // tolerate case/whitespace differences
    const hit = typeof v === "string" && s.enum.find((e: any) => typeof e === "string" && e.toLowerCase() === v.trim().toLowerCase());
    if (hit) {
      repairs.push(`${path}: enum case`);
      return hit;
    }
    throw new Error(`${path}: ${JSON.stringify(v)} not in enum`);
  }
  if (t.includes("object") && typeof v === "object" && !Array.isArray(v)) {
    const out: Record<string, any> = {};
    const props = s.properties ?? {};
    for (const [k, ps] of Object.entries<Schema>(props)) {
      if (!(k in v) || v[k] === undefined) {
        if (types(ps).includes("null")) {
          out[k] = null;
          repairs.push(`${path}.${k}: default null`);
          continue;
        }
        if (types(ps).includes("array") && !(s.required ?? []).includes(k)) {
          out[k] = [];
          continue;
        }
        if ((s.required ?? []).includes(k)) throw new Error(`${path}.${k}: required key missing`);
        continue;
      }
      out[k] = walk(ps, v[k], `${path}.${k}`, repairs);
    }
    if (s.additionalProperties !== false) for (const k of Object.keys(v)) if (!(k in props)) out[k] = v[k];
    return out;
  }
  if (t.includes("array") && Array.isArray(v)) {
    let arr = v;
    if (s.maxItems !== undefined && arr.length > s.maxItems) {
      repairs.push(`${path}: truncated ${arr.length}→${s.maxItems} items`);
      arr = arr.slice(0, s.maxItems);
    }
    if (s.minItems !== undefined && arr.length < s.minItems) throw new Error(`${path}: needs ≥${s.minItems} items`);
    return arr.map((x: any, i: number) => walk(s.items ?? {}, x, `${path}[${i}]`, repairs));
  }
  if (t.includes("string") && typeof v === "string") {
    if (s.maxLength !== undefined && v.length > s.maxLength) {
      repairs.push(`${path}: truncated ${v.length}→${s.maxLength} chars`);
      return v.slice(0, s.maxLength);
    }
    return v;
  }
  if ((t.includes("integer") || t.includes("number")) && typeof v === "number") return v;
  if (t.includes("integer") && typeof v === "string" && /^\d+$/.test(v)) {
    repairs.push(`${path}: string→int`);
    return Number(v);
  }
  if (t.includes("boolean") && typeof v === "boolean") return v;
  if (t.includes("boolean") && (v === "true" || v === "false")) {
    repairs.push(`${path}: string→bool`);
    return v === "true";
  }
  if (!t.length) return v;
  throw new Error(`${path}: expected ${t.join("|")}, got ${Array.isArray(v) ? "array" : typeof v}`);
}

/** Schema sent to the engine: strip keywords engines often reject; keep them locally for repair. */
export function wireSchema(s: Schema): Schema {
  if (Array.isArray(s)) return s.map(wireSchema) as any;
  if (!s || typeof s !== "object") return s;
  const out: Schema = {};
  for (const [k, v] of Object.entries(s)) {
    if (["maxLength", "maxItems", "minItems", "description"].includes(k)) continue;
    out[k] = typeof v === "object" ? wireSchema(v) : v;
  }
  if (out.type === "object" || (Array.isArray(out.type) && out.type.includes("object"))) {
    if (out.properties) {
      out.required = Object.keys(out.properties);
      out.additionalProperties = false;
    }
  }
  return out;
}

/** Schema linter (P3): a reasoning key must sort alphabetically before every decision key. */
export function lintSchema(s: Schema, path = "$"): string[] {
  const problems: string[] = [];
  if (s.anyOf) s.anyOf.forEach((a: Schema, i: number) => problems.push(...lintSchema(a, `${path}|${i}`)));
  if (s.properties) {
    const keys = Object.keys(s.properties);
    const sorted = [...keys].sort();
    if (keys.join() !== sorted.join()) problems.push(`${path}: keys not in alphabetical order (${keys.join(",")})`);
    // discriminator keys (const values, e.g. action: "block") are chosen before anything else by design
    const decisions = sorted.filter((k) => s.properties[k].const === undefined);
    if (keys.includes("analysis") && decisions[0] !== "analysis") {
      problems.push(`${path}: "${decisions[0]}" sorts before "analysis"`);
    }
    for (const [k, v] of Object.entries<Schema>(s.properties)) problems.push(...lintSchema(v, `${path}.${k}`));
  }
  if (s.items) problems.push(...lintSchema(s.items, `${path}[]`));
  return problems;
}

// small builders to keep prompt files readable
export const str = (maxLength?: number): Schema => ({ type: "string", ...(maxLength ? { maxLength } : {}) });
export const nstr = (maxLength?: number): Schema => ({ type: ["string", "null"], ...(maxLength ? { maxLength } : {}) });
export const oneOf = (values: string[]): Schema => ({ type: "string", enum: values });
export const arr = (items: Schema, maxItems?: number, minItems?: number): Schema => ({
  type: "array",
  items,
  ...(maxItems ? { maxItems } : {}),
  ...(minItems ? { minItems } : {}),
});
export const obj = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export const bool = (): Schema => ({ type: "boolean" });
