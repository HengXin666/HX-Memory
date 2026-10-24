// external/reflect.ts — 没有原生 reflect 的引擎走这条。结论必须能对上 canonical id。
import type { CanonicalMemory } from "./canonical.ts";
import type { Reflection } from "./ports.ts";

export async function portableReflect(
  records: readonly CanonicalMemory[],
  input: { question: string; context: string; disposition: string },
  complete: (prompt: string) => Promise<string>,
): Promise<Reflection> {
  if (!input.context.trim() && records.length === 0) {
    return { text: "", citations: [], insufficient: true };
  }
  const allowed = new Set(records.map((row) => row.id));
  const prompt = [
    input.disposition,
    '只输出一行 JSON: {"insufficient":boolean,"text":string,"citations":string[]}',
    "citations 里的 id 只能来自下面的记录。没有把握就把 insufficient 设为 true, text 留空。",
    "问题: " + input.question,
    "当前上下文:\n" + input.context,
    ...records.map((row) => "id=" + row.id + " kind=" + row.kind + " " + row.text),
  ].join("\n");
  let raw = "";
  try {
    raw = await complete(prompt);
  } catch {
    return { text: "", citations: [], insufficient: true };
  }
  return normalizeReflection(parseLoose(raw), allowed);
}

export function normalizeReflection(
  parsed: { insufficient?: boolean; text?: string; citations?: string[] },
  allowed: ReadonlySet<string>,
): Reflection {
  const citations = (parsed.citations ?? []).filter((id) => allowed.has(id));
  const text = (parsed.text ?? "").trim();
  if (parsed.insufficient || !text) return { text: "", citations, insufficient: true };
  return { text, citations, insufficient: false };
}

function parseLoose(raw: string): { insufficient?: boolean; text?: string; citations?: string[] } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    if (/insufficient/i.test(raw)) return { insufficient: true, text: "" };
    return { insufficient: true, text: "" };
  }
  try {
    const json = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    return {
      insufficient: json.insufficient === true,
      text: typeof json.text === "string" ? json.text : "",
      citations: Array.isArray(json.citations)
        ? json.citations.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return { insufficient: true, text: "" };
  }
}
