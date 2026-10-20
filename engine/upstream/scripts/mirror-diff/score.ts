import type {
  ComponentScores,
  ControlSnapshot,
  DiffScore,
  DomSnapshot,
  ScrollSnapshot,
} from "./types";

const STATIC_WEIGHTS = {
  text: 0.45,
  elements: 0.15,
  tags: 0.15,
  images: 0.1,
  controls: 0.15,
} as const;

const POST_WEIGHTS = {
  text: 0.3,
  elements: 0.1,
  tags: 0.1,
  images: 0.05,
  controls: 0.2,
  activeElement: 0.1,
  scroll: 0.15,
} as const;

export function normalizeInnerText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Linear-time Sørensen-Dice similarity over normalized character bigrams. */
export function innerTextSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeInnerText(left);
  const normalizedRight = normalizeInnerText(right);
  if (normalizedLeft === normalizedRight) return 1;
  if (normalizedLeft.length < 2 || normalizedRight.length < 2) return 0;

  const leftBigrams = bigramCounts(normalizedLeft);
  const rightBigrams = bigramCounts(normalizedRight);
  let intersection = 0;
  for (const [bigram, leftCount] of leftBigrams) {
    intersection += Math.min(leftCount, rightBigrams.get(bigram) ?? 0);
  }
  return clamp((2 * intersection) / (normalizedLeft.length + normalizedRight.length - 2));
}

export function ratioSimilarity(left: number, right: number): number {
  if (left === right) return 1;
  const largest = Math.max(left, right);
  return largest === 0 ? 1 : Math.min(left, right) / largest;
}

export function countMapSimilarity(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): number {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  let intersection = 0;
  let union = 0;
  for (const key of keys) {
    intersection += Math.min(left[key] ?? 0, right[key] ?? 0);
    union += Math.max(left[key] ?? 0, right[key] ?? 0);
  }
  return union === 0 ? 1 : intersection / union;
}

export function scoreSnapshots(
  server: DomSnapshot,
  mirror: DomSnapshot,
  phase: "static" | "post-interaction",
): DiffScore {
  const controlComparison = compareRecord(server.controls, mirror.controls, sameControl);
  const scrollComparison = compareRecord(server.scroll, mirror.scroll, sameScroll);
  const components: ComponentScores = {
    text: innerTextSimilarity(server.text, mirror.text),
    elements: ratioSimilarity(server.elementCount, mirror.elementCount),
    tags: countMapSimilarity(server.tagCounts, mirror.tagCounts),
    images: ratioSimilarity(server.imageCount, mirror.imageCount),
    controls: controlComparison.score,
    activeElement: server.activeElement === mirror.activeElement ? 1 : 0,
    scroll: scrollComparison.score,
  };

  const score =
    phase === "static" ? weighted(components, STATIC_WEIGHTS) : weighted(components, POST_WEIGHTS);
  return {
    score,
    components,
    differences: {
      controls: controlComparison.differences,
      activeElement:
        server.activeElement === mirror.activeElement
          ? null
          : { server: server.activeElement, mirror: mirror.activeElement },
      scroll: scrollComparison.differences,
    },
  };
}

/** Uses the exact post-interaction comparison semantics without considering structural fields. */
export function interactionStatesMatch(left: DomSnapshot, right: DomSnapshot): boolean {
  return (
    compareRecord(left.controls, right.controls, sameControl).score === 1 &&
    left.activeElement === right.activeElement &&
    compareRecord(left.scroll, right.scroll, sameScroll).score === 1
  );
}

function bigramCounts(value: string): Map<string, number> {
  const result = new Map<string, number>();
  for (let index = 0; index < value.length - 1; index += 1) {
    const bigram = value.slice(index, index + 2);
    result.set(bigram, (result.get(bigram) ?? 0) + 1);
  }
  return result;
}

function compareRecord<T>(
  left: Readonly<Record<string, T>>,
  right: Readonly<Record<string, T>>,
  equal: (leftValue: T, rightValue: T) => boolean,
): { score: number; differences: string[] } {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  if (keys.length === 0) return { score: 1, differences: [] };
  const differences = keys.filter((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    return leftValue === undefined || rightValue === undefined || !equal(leftValue, rightValue);
  });
  return { score: (keys.length - differences.length) / keys.length, differences };
}

function sameControl(left: ControlSnapshot, right: ControlSnapshot): boolean {
  return (
    left.kind === right.kind &&
    left.value === right.value &&
    left.checked === right.checked &&
    JSON.stringify(left.selected) === JSON.stringify(right.selected)
  );
}

function sameScroll(left: ScrollSnapshot, right: ScrollSnapshot): boolean {
  // F4 deliberately treats <=3px as an echo match; the instrument grants two extra device-pixel
  // units for rounding at iframe boundaries.
  return Math.abs(left.x - right.x) <= 5 && Math.abs(left.y - right.y) <= 5;
}

function weighted(
  scores: ComponentScores,
  weights: Readonly<Partial<Record<keyof ComponentScores, number>>>,
): number {
  let result = 0;
  for (const [name, weight] of Object.entries(weights) as Array<[keyof ComponentScores, number]>) {
    result += scores[name] * weight;
  }
  return clamp(result);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
