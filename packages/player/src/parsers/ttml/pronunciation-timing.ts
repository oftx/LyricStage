export interface PronunciationTimingSourceWord {
  readonly text: string;
  readonly beginMs: number | null;
  readonly endMs: number | null;
  readonly spaceBefore?: boolean;
  readonly joinKey?: string | null;
}

export interface ProjectedPronunciationWord {
  readonly text: string;
  readonly beginMs: number;
  readonly endMs: number;
  readonly spaceBefore: boolean;
}

interface TimedSourceWord extends PronunciationTimingSourceWord {
  readonly beginMs: number;
  readonly endMs: number;
}

interface FixedSourcePlan {
  readonly kind: "fixed";
  readonly slots: number;
  readonly expectedRoman: ReadonlySet<string>;
  readonly durationMs: number;
}

interface AmbiguousSourcePlan {
  readonly kind: "ambiguous";
  readonly minimumSlots: number;
  readonly durationMs: number;
  readonly equalSplitEligible: boolean;
}

type SourcePlan = FixedSourcePlan | AmbiguousSourcePlan;

interface AlignmentResult {
  readonly allocations: readonly number[];
  readonly cost: number;
}

interface KanaReading {
  readonly roman: string;
  readonly slots: number;
  readonly trailingSokuon: boolean;
}

interface RankedAllocation {
  readonly allocations: readonly number[];
  readonly cost: number;
}

interface AggregateBlock {
  readonly startWordIndex: number;
  readonly endWordIndex: number;
}

interface StabilizedAlignment {
  readonly allocations: readonly number[];
  readonly aggregateBlocks: readonly AggregateBlock[];
}

const kanaCharacterPattern = /[\u3041-\u3096\u30a1-\u30fa\u31f0-\u31ff]/u;
const hanCharacterPattern = /\p{Script=Han}/u;
const letterOrNumberPattern = /[\p{L}\p{N}]/u;
const ignorableTextCharacterPattern = /[\p{P}\p{S}\s]/u;
const sokuonCharacters = new Set(["っ", "ッ"]);
const prolongedSoundMark = "ー";
const smallKanaCharacters = new Set([
  "ゃ",
  "ゅ",
  "ょ",
  "ぁ",
  "ぃ",
  "ぅ",
  "ぇ",
  "ぉ",
  "ゎ",
]);
const MAX_SOURCE_WORDS = 256;
const MAX_PRONUNCIATION_TOKENS = 512;

const kanaRoman = new Map<string, string>([
  ["あ", "a"], ["い", "i"], ["う", "u"], ["え", "e"], ["お", "o"],
  ["か", "ka"], ["き", "ki"], ["く", "ku"], ["け", "ke"], ["こ", "ko"],
  ["さ", "sa"], ["し", "shi"], ["す", "su"], ["せ", "se"], ["そ", "so"],
  ["た", "ta"], ["ち", "chi"], ["つ", "tsu"], ["て", "te"], ["と", "to"],
  ["な", "na"], ["に", "ni"], ["ぬ", "nu"], ["ね", "ne"], ["の", "no"],
  ["は", "ha"], ["ひ", "hi"], ["ふ", "fu"], ["へ", "he"], ["ほ", "ho"],
  ["ま", "ma"], ["み", "mi"], ["む", "mu"], ["め", "me"], ["も", "mo"],
  ["や", "ya"], ["ゆ", "yu"], ["よ", "yo"],
  ["ら", "ra"], ["り", "ri"], ["る", "ru"], ["れ", "re"], ["ろ", "ro"],
  ["わ", "wa"], ["ゐ", "wi"], ["ゑ", "we"], ["を", "wo"], ["ん", "n"],
  ["が", "ga"], ["ぎ", "gi"], ["ぐ", "gu"], ["げ", "ge"], ["ご", "go"],
  ["ざ", "za"], ["じ", "ji"], ["ず", "zu"], ["ぜ", "ze"], ["ぞ", "zo"],
  ["だ", "da"], ["ぢ", "ji"], ["づ", "zu"], ["で", "de"], ["ど", "do"],
  ["ば", "ba"], ["び", "bi"], ["ぶ", "bu"], ["べ", "be"], ["ぼ", "bo"],
  ["ぱ", "pa"], ["ぴ", "pi"], ["ぷ", "pu"], ["ぺ", "pe"], ["ぽ", "po"],
  ["ゔ", "vu"], ["ゕ", "ka"], ["ゖ", "ke"],
  ["ぁ", "a"], ["ぃ", "i"], ["ぅ", "u"], ["ぇ", "e"], ["ぉ", "o"],
  ["ゃ", "ya"], ["ゅ", "yu"], ["ょ", "yo"], ["ゎ", "wa"],
]);

const kanaDigraphRoman = new Map<string, string>([
  ["きゃ", "kya"], ["きゅ", "kyu"], ["きょ", "kyo"],
  ["しゃ", "sha"], ["しゅ", "shu"], ["しょ", "sho"], ["しぇ", "she"],
  ["ちゃ", "cha"], ["ちゅ", "chu"], ["ちょ", "cho"], ["ちぇ", "che"],
  ["にゃ", "nya"], ["にゅ", "nyu"], ["にょ", "nyo"],
  ["ひゃ", "hya"], ["ひゅ", "hyu"], ["ひょ", "hyo"],
  ["みゃ", "mya"], ["みゅ", "myu"], ["みょ", "myo"],
  ["りゃ", "rya"], ["りゅ", "ryu"], ["りょ", "ryo"],
  ["ぎゃ", "gya"], ["ぎゅ", "gyu"], ["ぎょ", "gyo"],
  ["じゃ", "ja"], ["じゅ", "ju"], ["じょ", "jo"], ["じぇ", "je"],
  ["びゃ", "bya"], ["びゅ", "byu"], ["びょ", "byo"],
  ["ぴゃ", "pya"], ["ぴゅ", "pyu"], ["ぴょ", "pyo"],
  ["いぇ", "ye"], ["うぃ", "wi"], ["うぇ", "we"], ["うぉ", "wo"],
  ["くぁ", "kwa"], ["くぃ", "kwi"], ["くぇ", "kwe"], ["くぉ", "kwo"],
  ["ぐぁ", "gwa"], ["ぐぃ", "gwi"], ["ぐぇ", "gwe"], ["ぐぉ", "gwo"],
  ["すぃ", "si"], ["ずぃ", "zi"], ["つぁ", "tsa"], ["つぃ", "tsi"],
  ["つぇ", "tse"], ["つぉ", "tso"], ["てぃ", "ti"], ["てゅ", "tyu"],
  ["とぅ", "tu"], ["でぃ", "di"], ["でゅ", "dyu"], ["どぅ", "du"],
  ["ふぁ", "fa"], ["ふぃ", "fi"], ["ふぇ", "fe"], ["ふぉ", "fo"],
  ["ふゅ", "fyu"], ["ゔぁ", "va"], ["ゔぃ", "vi"], ["ゔぇ", "ve"],
  ["ゔぉ", "vo"], ["ゔゅ", "vyu"],
]);

function finiteInterval(
  word: PronunciationTimingSourceWord,
): word is TimedSourceWord {
  return (
    word.beginMs !== null &&
    word.endMs !== null &&
    Number.isFinite(word.beginMs) &&
    Number.isFinite(word.endMs) &&
    word.endMs > word.beginMs
  );
}

function toHiragana(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint !== undefined && codePoint >= 0x30a1 && codePoint <= 0x30f6) {
    return String.fromCodePoint(codePoint - 0x60);
  }
  return character;
}

function normalizeRoman(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/gu, "")
    .replace(/tch/gu, "cch")
    .replace(/dzu/gu, "zu");
}

function geminateRoman(roman: string): string {
  if (/^[aeioun]/u.test(roman)) return roman;
  if (roman.startsWith("ch")) return `c${roman}`;
  return `${roman[0] ?? ""}${roman}`;
}

function lastRomanVowel(roman: string): string | null {
  for (let index = roman.length - 1; index >= 0; index -= 1) {
    const character = roman[index];
    if (character && "aeiou".includes(character)) return character;
  }
  return null;
}

function romanizeKanaWord(
  text: string,
  incomingSokuon: boolean,
): KanaReading | null {
  const characters = Array.from(text.normalize("NFKC"), toHiragana);
  let roman = "";
  let slots = 0;
  let pendingSokuon = incomingSokuon;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (!character) continue;
    if (sokuonCharacters.has(character)) {
      pendingSokuon = true;
      continue;
    }
    if (character === prolongedSoundMark) {
      const vowel = lastRomanVowel(roman);
      if (!vowel) return null;
      roman += vowel;
      continue;
    }
    if (ignorableTextCharacterPattern.test(character)) continue;
    if (!kanaCharacterPattern.test(character)) return null;

    const next = characters[index + 1];
    const digraph = next ? kanaDigraphRoman.get(`${character}${next}`) : undefined;
    let moraRoman = digraph ?? kanaRoman.get(character);
    if (!moraRoman) return null;
    if (digraph) index += 1;
    if (pendingSokuon) {
      moraRoman = geminateRoman(moraRoman);
      pendingSokuon = false;
    }
    roman += moraRoman;
    slots += 1;
  }

  return slots > 0
    ? { roman: normalizeRoman(roman), slots, trailingSokuon: pendingSokuon }
    : null;
}

function expectedRomanVariants(
  text: string,
  reading: KanaReading,
): ReadonlySet<string> {
  const variants = new Set([
    reading.roman,
    reading.roman.replace(/([aeiou])\1+/gu, "$1"),
  ]);
  const semanticText = Array.from(text.normalize("NFKC"))
    .filter((character) => !ignorableTextCharacterPattern.test(character))
    .map(toHiragana)
    .join("");
  if (semanticText === "は") variants.add("wa");
  if (semanticText === "へ") variants.add("e");
  if (semanticText === "を") variants.add("o");
  return variants;
}

function analyzeAmbiguousSlots(text: string): number | null {
  let slots = 0;
  let hasJapaneseText = false;
  for (const rawCharacter of Array.from(text.normalize("NFKC"))) {
    const character = toHiragana(rawCharacter);
    if (hanCharacterPattern.test(character)) {
      slots += 1;
      hasJapaneseText = true;
      continue;
    }
    if (sokuonCharacters.has(character) || character === prolongedSoundMark) {
      hasJapaneseText = true;
      continue;
    }
    if (ignorableTextCharacterPattern.test(character)) continue;
    if (kanaCharacterPattern.test(character)) {
      if (!kanaRoman.has(character) && !smallKanaCharacters.has(character)) {
        return null;
      }
      if (!smallKanaCharacters.has(character)) {
        slots += 1;
      }
      hasJapaneseText = true;
      continue;
    }
    if (letterOrNumberPattern.test(character)) return null;
    return null;
  }
  return hasJapaneseText && slots > 0 ? slots : null;
}

function hasTrailingSokuon(text: string): boolean {
  const semanticCharacters = Array.from(text.normalize("NFKC"))
    .filter((character) => !ignorableTextCharacterPattern.test(character));
  const last = semanticCharacters[semanticCharacters.length - 1];
  return last !== undefined && sokuonCharacters.has(last);
}

function isSingleHanWord(text: string): boolean {
  const semanticCharacters = Array.from(text.normalize("NFKC")).filter(
    (character) => !ignorableTextCharacterPattern.test(character),
  );
  return (
    semanticCharacters.length === 1 &&
    hanCharacterPattern.test(semanticCharacters[0] ?? "")
  );
}

function createSourcePlans(
  words: readonly TimedSourceWord[],
): readonly SourcePlan[] | null {
  if (
    !words.some((word) =>
      kanaCharacterPattern.test(word.text.normalize("NFKC")),
    )
  ) {
    return null;
  }

  const plans: SourcePlan[] = [];
  let previousTrailingSokuon = false;
  for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
    const word = words[wordIndex];
    if (!word) return null;
    const previous = words[wordIndex - 1];
    const incomingSokuon = Boolean(
      previousTrailingSokuon &&
        previous?.joinKey &&
        previous.joinKey === word.joinKey &&
        !word.spaceBefore,
    );
    const normalizedText = word.text.normalize("NFKC");
    const containsHan = hanCharacterPattern.test(normalizedText);
    const durationMs = word.endMs - word.beginMs;
    if (containsHan) {
      const minimumSlots = analyzeAmbiguousSlots(normalizedText);
      if (minimumSlots === null) return null;
      plans.push({
        kind: "ambiguous",
        minimumSlots,
        durationMs,
        equalSplitEligible: isSingleHanWord(normalizedText),
      });
      previousTrailingSokuon = hasTrailingSokuon(normalizedText);
    } else {
      const reading = romanizeKanaWord(normalizedText, incomingSokuon);
      if (!reading) return null;
      plans.push({
        kind: "fixed",
        slots: reading.slots,
        expectedRoman: expectedRomanVariants(normalizedText, reading),
        durationMs,
      });
      previousTrailingSokuon = reading.trailingSokuon;
    }
  }
  return Object.freeze(plans);
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle] ?? 200;
  return ((ordered[middle - 1] ?? 200) + (ordered[middle] ?? 200)) / 2;
}

function estimateSlotDuration(plans: readonly SourcePlan[]): number {
  const fixedDurations = plans
    .filter((plan): plan is FixedSourcePlan => plan.kind === "fixed")
    .map((plan) => plan.durationMs / plan.slots)
    .filter(Number.isFinite);
  const fallbackDurations = plans.map((plan) =>
    plan.durationMs / (plan.kind === "fixed" ? plan.slots : plan.minimumSlots),
  );
  return Math.max(
    90,
    Math.min(
      500,
      median(fixedDurations.length ? fixedDurations : fallbackDurations),
    ),
  );
}

function ambiguousAllocationCost(
  plan: AmbiguousSourcePlan,
  slots: number,
  slotDurationMs: number,
): number {
  const desiredSlots = Math.max(
    plan.minimumSlots,
    Math.min(plan.minimumSlots + 4, plan.durationMs / slotDurationMs),
  );
  return (slots - desiredSlots) ** 2;
}

function alignPlansToTokens(
  plans: readonly SourcePlan[],
  normalizedTokens: readonly string[],
): readonly number[] | null {
  const minimumRemaining = new Array<number>(plans.length + 1).fill(0);
  for (let index = plans.length - 1; index >= 0; index -= 1) {
    const plan = plans[index];
    minimumRemaining[index] =
      (minimumRemaining[index + 1] ?? 0) +
      (plan?.kind === "fixed" ? plan.slots : (plan?.minimumSlots ?? 0));
  }
  if ((minimumRemaining[0] ?? 0) > normalizedTokens.length) return null;

  const slotDurationMs = estimateSlotDuration(plans);
  const memo = new Map<string, AlignmentResult | null>();
  const solve = (planIndex: number, tokenIndex: number): AlignmentResult | null => {
    const key = `${planIndex}:${tokenIndex}`;
    if (memo.has(key)) return memo.get(key) ?? null;
    if (planIndex === plans.length) {
      const result = tokenIndex === normalizedTokens.length
        ? { allocations: Object.freeze([]), cost: 0 }
        : null;
      memo.set(key, result);
      return result;
    }

    const plan = plans[planIndex];
    if (!plan) return null;
    const remainingAfter = minimumRemaining[planIndex + 1] ?? 0;
    const maximumSlots = normalizedTokens.length - tokenIndex - remainingAfter;
    const candidates = plan.kind === "fixed"
      ? [plan.slots]
      : Array.from(
          { length: Math.max(0, maximumSlots - plan.minimumSlots + 1) },
          (_, offset) => plan.minimumSlots + offset,
        );

    let best: AlignmentResult | null = null;
    for (const slots of candidates) {
      if (slots > maximumSlots) continue;
      if (plan.kind === "fixed") {
        const actualRoman = normalizedTokens
          .slice(tokenIndex, tokenIndex + slots)
          .join("");
        if (!plan.expectedRoman.has(actualRoman)) continue;
      }
      const next = solve(planIndex + 1, tokenIndex + slots);
      if (!next) continue;
      const cost = next.cost +
        (plan.kind === "ambiguous"
          ? ambiguousAllocationCost(plan, slots, slotDurationMs)
          : 0);
      if (!best || cost < best.cost - 0.000001) {
        best = {
          allocations: Object.freeze([slots, ...next.allocations]),
          cost,
        };
      }
    }
    memo.set(key, best);
    return best;
  };

  return solve(0, 0)?.allocations ?? null;
}

function rankAmbiguousAllocations(
  plans: readonly AmbiguousSourcePlan[],
  totalSlots: number,
  slotDurationMs: number,
): readonly RankedAllocation[] {
  const minimumRemaining = new Array<number>(plans.length + 1).fill(0);
  for (let index = plans.length - 1; index >= 0; index -= 1) {
    minimumRemaining[index] =
      (minimumRemaining[index + 1] ?? 0) +
      (plans[index]?.minimumSlots ?? 0);
  }

  const memo = new Map<string, readonly RankedAllocation[]>();
  const solve = (
    planIndex: number,
    remainingSlots: number,
  ): readonly RankedAllocation[] => {
    const key = `${planIndex}:${remainingSlots}`;
    const cached = memo.get(key);
    if (cached) return cached;
    if (planIndex === plans.length) {
      const result = remainingSlots === 0
        ? [
            {
              allocations: Object.freeze([]),
              cost: 0,
            },
          ]
        : [];
      memo.set(key, result);
      return result;
    }

    const plan = plans[planIndex];
    if (!plan) return [];
    const maximumSlots =
      remainingSlots - (minimumRemaining[planIndex + 1] ?? 0);
    const candidates: RankedAllocation[] = [];
    for (
      let slots = plan.minimumSlots;
      slots <= maximumSlots;
      slots += 1
    ) {
      for (const next of solve(planIndex + 1, remainingSlots - slots)) {
        candidates.push({
          allocations: Object.freeze([slots, ...next.allocations]),
          cost:
            ambiguousAllocationCost(plan, slots, slotDurationMs) + next.cost,
        });
      }
    }
    candidates.sort((left, right) => left.cost - right.cost);
    const ranked = candidates.slice(0, 2);
    memo.set(key, ranked);
    return ranked;
  };

  return solve(0, totalSlots);
}

function hasConfidentWinner(
  ranked: readonly RankedAllocation[],
): boolean {
  const best = ranked[0];
  const second = ranked[1];
  if (!best || !second) return Boolean(best);
  const difference = second.cost - best.cost;
  const relativeDifference = difference / Math.max(1, Math.abs(second.cost));
  return difference >= 0.75 && relativeDifference >= 0.35;
}

function stabilizeAmbiguousBlocks(
  plans: readonly SourcePlan[],
  allocations: readonly number[],
): StabilizedAlignment {
  const stabilized = [...allocations];
  const aggregateBlocks: AggregateBlock[] = [];
  const slotDurationMs = estimateSlotDuration(plans);

  for (let start = 0; start < plans.length; start += 1) {
    if (plans[start]?.kind !== "ambiguous") continue;
    let end = start;
    while (plans[end + 1]?.kind === "ambiguous") end += 1;
    const blockPlans = plans.slice(start, end + 1) as AmbiguousSourcePlan[];
    const totalSlots = stabilized
      .slice(start, end + 1)
      .reduce((total, slots) => total + slots, 0);

    if (blockPlans.length === 1) {
      stabilized[start] = totalSlots;
      start = end;
      continue;
    }

    const equalSlots = totalSlots / blockPlans.length;
    if (
      Number.isInteger(equalSlots) &&
      blockPlans.every(
        (plan) =>
          plan.equalSplitEligible && equalSlots >= plan.minimumSlots,
      )
    ) {
      for (let index = start; index <= end; index += 1) {
        stabilized[index] = equalSlots;
      }
      start = end;
      continue;
    }

    const ranked = rankAmbiguousAllocations(
      blockPlans,
      totalSlots,
      slotDurationMs,
    );
    const best = ranked[0];
    if (best && hasConfidentWinner(ranked)) {
      best.allocations.forEach((slots, offset) => {
        stabilized[start + offset] = slots;
      });
    } else {
      aggregateBlocks.push({ startWordIndex: start, endWordIndex: end });
    }
    start = end;
  }

  return {
    allocations: Object.freeze(stabilized),
    aggregateBlocks: Object.freeze(aggregateBlocks),
  };
}

/**
 * Derives a pronunciation clock only when Japanese kana anchors can prove the
 * local token boundaries. Explicitly timed pronunciation never enters here.
 */
export function projectPronunciationTiming(
  pronunciationText: string,
  sourceWords: readonly PronunciationTimingSourceWord[],
): readonly ProjectedPronunciationWord[] {
  const tokens = pronunciationText.trim().split(/\s+/u).filter(Boolean);
  const normalizedTokens = tokens.map(normalizeRoman);
  if (
    tokens.length === 0 ||
    tokens.length > MAX_PRONUNCIATION_TOKENS ||
    normalizedTokens.some((token) => token.length === 0) ||
    sourceWords.length === 0 ||
    sourceWords.length > MAX_SOURCE_WORDS
  ) {
    return Object.freeze([]);
  }

  const timedWords: TimedSourceWord[] = [];
  for (const word of sourceWords) {
    if (!finiteInterval(word)) return Object.freeze([]);
    const previous = timedWords[timedWords.length - 1];
    if (previous && word.beginMs < previous.endMs) return Object.freeze([]);
    timedWords.push(word);
  }

  const plans = createSourcePlans(timedWords);
  if (!plans) return Object.freeze([]);
  const initialAllocations = alignPlansToTokens(plans, normalizedTokens);
  if (!initialAllocations || initialAllocations.length !== timedWords.length) {
    return Object.freeze([]);
  }
  const { allocations, aggregateBlocks } = stabilizeAmbiguousBlocks(
    plans,
    initialAllocations,
  );
  const aggregateBlocksByStart = new Map(
    aggregateBlocks.map((block) => [block.startWordIndex, block]),
  );

  const projected: ProjectedPronunciationWord[] = [];
  let tokenIndex = 0;
  for (let wordIndex = 0; wordIndex < timedWords.length; wordIndex += 1) {
    const aggregateBlock = aggregateBlocksByStart.get(wordIndex);
    if (aggregateBlock) {
      const firstWord = timedWords[aggregateBlock.startWordIndex];
      const lastWord = timedWords[aggregateBlock.endWordIndex];
      if (!firstWord || !lastWord) return Object.freeze([]);
      const slots = allocations
        .slice(aggregateBlock.startWordIndex, aggregateBlock.endWordIndex + 1)
        .reduce((total, value) => total + value, 0);
      const durationMs = lastWord.endMs - firstWord.beginMs;
      for (let slotIndex = 0; slotIndex < slots; slotIndex += 1) {
        const text = tokens[tokenIndex];
        if (!text) return Object.freeze([]);
        projected.push(
          Object.freeze({
            text,
            beginMs: firstWord.beginMs + durationMs * (slotIndex / slots),
            endMs:
              firstWord.beginMs + durationMs * ((slotIndex + 1) / slots),
            spaceBefore: tokenIndex > 0,
          }),
        );
        tokenIndex += 1;
      }
      wordIndex = aggregateBlock.endWordIndex;
      continue;
    }

    const word = timedWords[wordIndex];
    if (!word) return Object.freeze([]);
    const slots = allocations[wordIndex] ?? 0;
    const durationMs = word.endMs - word.beginMs;
    for (let slotIndex = 0; slotIndex < slots; slotIndex += 1) {
      const text = tokens[tokenIndex];
      if (!text) return Object.freeze([]);
      projected.push(
        Object.freeze({
          text,
          beginMs: word.beginMs + durationMs * (slotIndex / slots),
          endMs: word.beginMs + durationMs * ((slotIndex + 1) / slots),
          spaceBefore: tokenIndex > 0,
        }),
      );
      tokenIndex += 1;
    }
  }

  return tokenIndex === tokens.length
    ? Object.freeze(projected)
    : Object.freeze([]);
}
