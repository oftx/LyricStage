import {
  createStableId,
  type LyricTrackRole,
} from "../domain/ids.js";
import type { LyricTrack, LyricWord } from "../domain/types.js";
import {
  countLetterOrNumberGraphemes,
  createKaraokeTextUnitPlan,
  hasEmphasisSplitExcludedScript,
  type KaraokeTextUnitStrategy,
} from "./text-units.js";

export type KaraokeBindingLane = "top" | "bottom";

export interface CompileKaraokeBindingGroupsInput {
  readonly track: LyricTrack;
  readonly trackName: LyricTrackRole;
  readonly lane: KaraokeBindingLane;
}

export type InvalidParserJoinGroupIssue =
  | "invalid-id"
  | "invalid-count"
  | "invalid-index"
  | "inconsistent-count"
  | "member-count-mismatch"
  | "noncontiguous-members"
  | "out-of-order-index"
  | "space-between-members";

export type KaraokeBindingFallbackReason =
  | Readonly<{ code: "no-timed-words" }>
  | Readonly<{
      code: "duplicate-word-id";
      wordId: string;
      wordIndex: number;
    }>
  | Readonly<{
      code: "invalid-word-timing";
      wordId: string;
      wordIndex: number;
      beginMs: number | null;
      endMs: number | null;
    }>
  | Readonly<{
      code: "invalid-parser-join-group";
      issue: InvalidParserJoinGroupIssue;
      groupId: string | null;
      wordId: string;
      wordIndex: number;
    }>
  | Readonly<{
      code: "track-text-mismatch";
      trackText: string;
      reconstructedText: string;
    }>;

export interface KaraokeParserJoinGroupPlan {
  readonly id: string;
  readonly purpose: "parser-text-continuity";
  readonly canDriveEmphasis: false;
  readonly firstWordIndex: number;
  readonly wordIds: readonly string[];
}

export interface KaraokeParserJoinGroupReference {
  readonly id: string;
  readonly index: number;
  readonly count: number;
  readonly purpose: "parser-text-continuity";
  readonly canDriveEmphasis: false;
}

export type KaraokeVisualEmphasisGroupSource =
  | "word"
  | "parser-join-aggregate";

export interface KaraokeVisualEmphasisGroupPlan {
  readonly id: string;
  readonly source: KaraokeVisualEmphasisGroupSource;
  readonly beginMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly text: string;
  readonly letterOrNumberCount: number;
  readonly wordIds: readonly string[];
  readonly bindingIds: readonly string[];
}

export interface KaraokeVisualEmphasisGroupReference {
  readonly id: string;
  readonly source: KaraokeVisualEmphasisGroupSource;
  readonly beginMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly text: string;
  readonly letterOrNumberCount: number;
  readonly bindingOffset: number;
  readonly bindingCount: number;
}

export interface KaraokeTextBinding {
  readonly id: string;
  readonly text: string;
  readonly timed: boolean;
  readonly wordId: string | null;
  readonly wordIndex: number | null;
  readonly unitIndex: number;
  readonly unitCount: number;
  readonly beginMs: number | null;
  readonly endMs: number | null;
  readonly strategy: KaraokeTextUnitStrategy | "fallback-text";
  readonly trackName: LyricTrackRole;
  readonly lane: KaraokeBindingLane;
  readonly parserJoinGroupId: string | null;
}

export type KaraokeEmphasisSplitReason =
  | "eligible"
  | "not-foreground-top"
  | "duration-under-1000ms"
  | "letter-number-count-outside-2-to-7"
  | "excluded-script";

export interface KaraokeEmphasisSplitEligibility {
  readonly eligible: boolean;
  readonly reason: KaraokeEmphasisSplitReason;
  readonly durationMs: number;
  readonly letterOrNumberCount: number;
  readonly metricSource: "word" | "parser-join-aggregate";
}

export interface KaraokeWordBindingPlan {
  readonly wordId: string;
  readonly wordIndex: number;
  readonly text: string;
  readonly spaceBefore: boolean;
  readonly beginMs: number;
  readonly endMs: number;
  readonly strategy: KaraokeTextUnitStrategy;
  readonly bindingIds: readonly string[];
  readonly bindings: readonly KaraokeTextBinding[];
  readonly parserJoinGroup: KaraokeParserJoinGroupReference | null;
  readonly visualEmphasisGroup: KaraokeVisualEmphasisGroupReference;
  readonly emphasisSplit: KaraokeEmphasisSplitEligibility;
}

interface KaraokeTrackBindingCompilationBase {
  readonly signature: string;
  readonly reconstructedText: string;
  readonly wordPlans: readonly KaraokeWordBindingPlan[];
  readonly flatBindings: readonly KaraokeTextBinding[];
  readonly parserJoinGroups: readonly KaraokeParserJoinGroupPlan[];
  readonly visualEmphasisGroups: readonly KaraokeVisualEmphasisGroupPlan[];
}

export interface KaraokeTrackBindingPlan
  extends KaraokeTrackBindingCompilationBase {
  readonly ok: true;
  readonly status: "timed";
  readonly fallbackReason: null;
}

export interface KaraokeTrackBindingFallback
  extends KaraokeTrackBindingCompilationBase {
  readonly ok: false;
  readonly status: "fallback";
  readonly fallbackReason: KaraokeBindingFallbackReason;
}

export type KaraokeTrackBindingCompilation =
  | KaraokeTrackBindingPlan
  | KaraokeTrackBindingFallback;

interface JoinMember {
  readonly word: LyricWord;
  readonly wordIndex: number;
  readonly groupIndex: number;
  readonly groupCount: number;
}

interface EmphasisSplitMetric {
  readonly durationMs: number;
  readonly letterOrNumberCount: number;
  readonly text: string;
  readonly source: "word" | "parser-join-aggregate";
}

interface KaraokeWordBindingDraft
  extends Omit<KaraokeWordBindingPlan, "visualEmphasisGroup"> {}

interface VisualEmphasisGroupCompilation {
  readonly plans: readonly KaraokeVisualEmphasisGroupPlan[];
  readonly references: ReadonlyMap<
    string,
    KaraokeVisualEmphasisGroupReference
  >;
}

type JoinValidationResult =
  | Readonly<{
      ok: true;
      plans: readonly KaraokeParserJoinGroupPlan[];
    }>
  | Readonly<{
      ok: false;
      reason: Extract<
        KaraokeBindingFallbackReason,
        { code: "invalid-parser-join-group" }
      >;
    }>;

function timestampValue(word: LyricWord, boundary: "begin" | "end"): number | null {
  const value = word[boundary].valueMs;
  return value !== null && Number.isFinite(value) ? value : null;
}

export function reconstructLyricTrackText(track: LyricTrack): string {
  return track.words
    .map(
      (word, index) =>
        `${index > 0 && word.spaceBefore ? " " : ""}${word.text}`,
    )
    .join("");
}

function serializeSignaturePart(value: string | number | boolean | null): string {
  const serialized = value === null ? "null" : String(value);
  return `${serialized.length}:${serialized}`;
}

function createTrackFingerprint(
  track: LyricTrack,
  trackName: LyricTrackRole,
  lane: KaraokeBindingLane,
): string {
  const parts: Array<string | number | boolean | null> = [
    "karaoke-binding-plan-v2",
    trackName,
    lane,
    track.text,
    track.language.declared,
    track.language.inferred,
    track.language.effective,
  ];
  for (const word of track.words) {
    parts.push(
      word.id,
      word.text,
      word.spaceBefore,
      word.begin.valueMs,
      word.begin.source,
      word.end.valueMs,
      word.end.source,
      word.joinGroup?.id ?? null,
      word.joinGroup?.index ?? null,
      word.joinGroup?.count ?? null,
    );
  }
  return createStableId(
    "karaoke-track-bindings",
    parts.map(serializeSignaturePart).join("|"),
  );
}

function invalidJoinReason(
  issue: InvalidParserJoinGroupIssue,
  member: JoinMember,
  groupId: string | null,
): Extract<
  KaraokeBindingFallbackReason,
  { code: "invalid-parser-join-group" }
> {
  return Object.freeze({
    code: "invalid-parser-join-group",
    issue,
    groupId,
    wordId: member.word.id,
    wordIndex: member.wordIndex,
  });
}

function validateParserJoinGroups(
  words: readonly LyricWord[],
): JoinValidationResult {
  const groups = new Map<string, JoinMember[]>();

  for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
    const word = words[wordIndex];
    if (!word?.joinGroup) continue;
    const group = word.joinGroup;
    const member: JoinMember = {
      word,
      wordIndex,
      groupIndex: group.index,
      groupCount: group.count,
    };
    if (group.id.trim().length === 0) {
      return Object.freeze({
        ok: false,
        reason: invalidJoinReason("invalid-id", member, null),
      });
    }
    if (!Number.isInteger(group.count) || group.count < 2) {
      return Object.freeze({
        ok: false,
        reason: invalidJoinReason("invalid-count", member, group.id),
      });
    }
    if (
      !Number.isInteger(group.index) ||
      group.index < 0 ||
      group.index >= group.count
    ) {
      return Object.freeze({
        ok: false,
        reason: invalidJoinReason("invalid-index", member, group.id),
      });
    }
    const members = groups.get(group.id) ?? [];
    members.push(member);
    groups.set(group.id, members);
  }

  const plans: KaraokeParserJoinGroupPlan[] = [];
  for (const [groupId, members] of groups) {
    const first = members[0];
    if (!first) continue;
    if (members.some(({ groupCount }) => groupCount !== first.groupCount)) {
      return Object.freeze({
        ok: false,
        reason: invalidJoinReason("inconsistent-count", first, groupId),
      });
    }
    if (members.length !== first.groupCount) {
      return Object.freeze({
        ok: false,
        reason: invalidJoinReason("member-count-mismatch", first, groupId),
      });
    }
    for (let offset = 0; offset < members.length; offset += 1) {
      const member = members[offset];
      if (!member) continue;
      if (member.wordIndex !== first.wordIndex + offset) {
        return Object.freeze({
          ok: false,
          reason: invalidJoinReason(
            "noncontiguous-members",
            member,
            groupId,
          ),
        });
      }
      if (member.groupIndex !== offset) {
        return Object.freeze({
          ok: false,
          reason: invalidJoinReason("out-of-order-index", member, groupId),
        });
      }
      if (offset > 0 && member.word.spaceBefore) {
        return Object.freeze({
          ok: false,
          reason: invalidJoinReason("space-between-members", member, groupId),
        });
      }
    }
    plans.push(
      Object.freeze({
        id: groupId,
        purpose: "parser-text-continuity",
        canDriveEmphasis: false,
        firstWordIndex: first.wordIndex,
        wordIds: Object.freeze(members.map(({ word }) => word.id)),
      }),
    );
  }

  return Object.freeze({ ok: true, plans: Object.freeze(plans) });
}

function createFallback(
  input: CompileKaraokeBindingGroupsInput,
  fingerprint: string,
  reconstructedText: string,
  fallbackReason: KaraokeBindingFallbackReason,
): KaraokeTrackBindingFallback {
  const { track, trackName, lane } = input;
  const signature = createStableId(
    "karaoke-binding-fallback",
    fingerprint,
    fallbackReason.code,
  );
  const flatBindings: readonly KaraokeTextBinding[] =
    track.text.length === 0
      ? Object.freeze([])
      : Object.freeze([
          Object.freeze({
            id: createStableId("karaoke-fallback-binding", signature),
            text: track.text,
            timed: false,
            wordId: null,
            wordIndex: null,
            unitIndex: 0,
            unitCount: 1,
            beginMs: null,
            endMs: null,
            strategy: "fallback-text",
            trackName,
            lane,
            parserJoinGroupId: null,
          }),
        ]);

  return Object.freeze({
    ok: false,
    status: "fallback",
    signature,
    fallbackReason,
    reconstructedText,
    wordPlans: Object.freeze([]),
    flatBindings,
    parserJoinGroups: Object.freeze([]),
    visualEmphasisGroups: Object.freeze([]),
  });
}

function createEmphasisMetrics(
  words: readonly LyricWord[],
  parserJoinGroups: readonly KaraokeParserJoinGroupPlan[],
): ReadonlyMap<string, EmphasisSplitMetric> {
  const metrics = new Map<string, EmphasisSplitMetric>();
  const wordsById = new Map(words.map((word) => [word.id, word] as const));
  for (const word of words) {
    const beginMs = timestampValue(word, "begin") as number;
    const endMs = timestampValue(word, "end") as number;
    metrics.set(
      word.id,
      Object.freeze({
        durationMs: endMs - beginMs,
        letterOrNumberCount: countLetterOrNumberGraphemes(word.text),
        text: word.text,
        source: "word",
      }),
    );
  }

  for (const group of parserJoinGroups) {
    const members = group.wordIds.flatMap((wordId) => {
      const word = wordsById.get(wordId);
      return word ? [word] : [];
    });
    if (members.length !== group.wordIds.length || members.length < 2) continue;
    const metric = Object.freeze({
      durationMs: members.reduce((total, word) => {
        const beginMs = timestampValue(word, "begin") as number;
        const endMs = timestampValue(word, "end") as number;
        return total + (endMs - beginMs);
      }, 0),
      letterOrNumberCount: countLetterOrNumberGraphemes(
        members.map(({ text }) => text).join(""),
      ),
      text: members.map(({ text }) => text).join(""),
      source: "parser-join-aggregate" as const,
    });
    for (const member of members) metrics.set(member.id, metric);
  }

  return metrics;
}

function compileVisualEmphasisGroups(
  wordDrafts: readonly KaraokeWordBindingDraft[],
  trackName: LyricTrackRole,
  lane: KaraokeBindingLane,
): VisualEmphasisGroupCompilation {
  const groupedDrafts = new Map<string, KaraokeWordBindingDraft[]>();
  for (const word of wordDrafts) {
    const key = word.parserJoinGroup
      ? `parser:${word.parserJoinGroup.id}`
      : `word:${word.wordId}`;
    const members = groupedDrafts.get(key) ?? [];
    members.push(word);
    groupedDrafts.set(key, members);
  }

  const plans: KaraokeVisualEmphasisGroupPlan[] = [];
  const references = new Map<
    string,
    KaraokeVisualEmphasisGroupReference
  >();
  for (const [key, members] of groupedDrafts) {
    const first = members[0];
    if (!first) continue;
    const source: KaraokeVisualEmphasisGroupSource = first.parserJoinGroup
      ? "parser-join-aggregate"
      : "word";
    const text = members
      .map(
        (member, index) =>
          `${index > 0 && member.spaceBefore ? " " : ""}${member.text}`,
      )
      .join("");
    const bindingIds = Object.freeze(
      members.flatMap(({ bindingIds: memberBindingIds }) => memberBindingIds),
    );
    const plan = Object.freeze({
      id: createStableId(
        "karaoke-visual-emphasis-group",
        trackName,
        lane,
        key,
      ),
      source,
      beginMs: Math.min(...members.map(({ beginMs }) => beginMs)),
      endMs: Math.max(...members.map(({ endMs }) => endMs)),
      durationMs: members.reduce(
        (total, member) => total + (member.endMs - member.beginMs),
        0,
      ),
      text,
      letterOrNumberCount: countLetterOrNumberGraphemes(text),
      wordIds: Object.freeze(members.map(({ wordId }) => wordId)),
      bindingIds,
    } satisfies KaraokeVisualEmphasisGroupPlan);
    plans.push(plan);

    let bindingOffset = 0;
    for (const member of members) {
      references.set(
        member.wordId,
        Object.freeze({
          id: plan.id,
          source: plan.source,
          beginMs: plan.beginMs,
          endMs: plan.endMs,
          durationMs: plan.durationMs,
          text: plan.text,
          letterOrNumberCount: plan.letterOrNumberCount,
          bindingOffset,
          bindingCount: plan.bindingIds.length,
        }),
      );
      bindingOffset += member.bindings.length;
    }
  }

  return Object.freeze({
    plans: Object.freeze(plans),
    references,
  });
}

function resolveEmphasisSplitEligibility(
  metric: EmphasisSplitMetric,
  trackName: LyricTrackRole,
  lane: KaraokeBindingLane,
): KaraokeEmphasisSplitEligibility {
  const foregroundTop = trackName === "foreground" && lane === "top";
  const durationEligible = metric.durationMs >= 1_000;
  const lengthEligible =
    metric.letterOrNumberCount >= 2 && metric.letterOrNumberCount <= 7;
  const scriptEligible = !hasEmphasisSplitExcludedScript(metric.text);
  const eligible =
    foregroundTop && durationEligible && lengthEligible && scriptEligible;
  const reason: KaraokeEmphasisSplitReason = !foregroundTop
    ? "not-foreground-top"
    : !durationEligible
      ? "duration-under-1000ms"
      : !lengthEligible
        ? "letter-number-count-outside-2-to-7"
        : !scriptEligible
          ? "excluded-script"
          : "eligible";
  return Object.freeze({
    eligible,
    reason,
    durationMs: metric.durationMs,
    letterOrNumberCount: metric.letterOrNumberCount,
    metricSource: metric.source,
  });
}

/** Compiles a lossless timed track into deterministic grapheme bindings. */
export function compileKaraokeBindingGroups(
  input: CompileKaraokeBindingGroupsInput,
): KaraokeTrackBindingCompilation {
  const { track, trackName, lane } = input;
  const fingerprint = createTrackFingerprint(track, trackName, lane);
  const reconstructedText = reconstructLyricTrackText(track);
  if (track.words.length === 0) {
    return createFallback(
      input,
      fingerprint,
      reconstructedText,
      Object.freeze({ code: "no-timed-words" }),
    );
  }

  const seenWordIds = new Set<string>();
  for (let wordIndex = 0; wordIndex < track.words.length; wordIndex += 1) {
    const word = track.words[wordIndex];
    if (!word) continue;
    if (seenWordIds.has(word.id)) {
      return createFallback(
        input,
        fingerprint,
        reconstructedText,
        Object.freeze({ code: "duplicate-word-id", wordId: word.id, wordIndex }),
      );
    }
    seenWordIds.add(word.id);

    const beginMs = timestampValue(word, "begin");
    const endMs = timestampValue(word, "end");
    if (beginMs === null || endMs === null || endMs <= beginMs) {
      return createFallback(
        input,
        fingerprint,
        reconstructedText,
        Object.freeze({
          code: "invalid-word-timing",
          wordId: word.id,
          wordIndex,
          beginMs,
          endMs,
        }),
      );
    }
  }

  const joinValidation = validateParserJoinGroups(track.words);
  if (!joinValidation.ok) {
    return createFallback(
      input,
      fingerprint,
      reconstructedText,
      joinValidation.reason,
    );
  }

  if (reconstructedText !== track.text) {
    return createFallback(
      input,
      fingerprint,
      reconstructedText,
      Object.freeze({
        code: "track-text-mismatch",
        trackText: track.text,
        reconstructedText,
      }),
    );
  }

  const wordDrafts: KaraokeWordBindingDraft[] = [];
  const flatBindings: KaraokeTextBinding[] = [];
  const emphasisMetrics = createEmphasisMetrics(
    track.words,
    joinValidation.plans,
  );
  for (let wordIndex = 0; wordIndex < track.words.length; wordIndex += 1) {
    const word = track.words[wordIndex];
    if (!word) continue;
    const beginMs = timestampValue(word, "begin") as number;
    const endMs = timestampValue(word, "end") as number;
    const durationMs = endMs - beginMs;
    const emphasisMetric = emphasisMetrics.get(word.id) as EmphasisSplitMetric;
    const emphasisSplit = resolveEmphasisSplitEligibility(
      emphasisMetric,
      trackName,
      lane,
    );
    // Split eligible Latin runs into letter bindings so emphasis scale/glow
    // can animate per character. Trade-off: cross-span kerning (e.g. "To") is
    // weaker than a single text node — letter effects take priority.
    const unitPlan = createKaraokeTextUnitPlan(word.text, {
      splitLatinLetterNumber: emphasisSplit.eligible,
    });
    const unitCount = unitPlan.units.length;
    const parserJoinGroup = word.joinGroup
      ? Object.freeze({
          id: word.joinGroup.id,
          index: word.joinGroup.index,
          count: word.joinGroup.count,
          purpose: "parser-text-continuity" as const,
          canDriveEmphasis: false as const,
        })
      : null;
    const bindings = Object.freeze(
      unitPlan.units.map((unit, unitIndex) => {
        const unitBeginMs = beginMs + durationMs * (unitIndex / unitCount);
        const unitEndMs =
          unitIndex === unitCount - 1
            ? endMs
            : beginMs + durationMs * ((unitIndex + 1) / unitCount);
        return Object.freeze({
          id: createStableId(
            "karaoke-binding",
            trackName,
            lane,
            word.id,
            unitIndex,
            unitCount,
            unit.text,
          ),
          text: unit.text,
          timed: true,
          wordId: word.id,
          wordIndex,
          unitIndex,
          unitCount,
          beginMs: unitBeginMs,
          endMs: unitEndMs,
          strategy: unitPlan.strategy,
          trackName,
          lane,
          parserJoinGroupId: parserJoinGroup?.id ?? null,
        } satisfies KaraokeTextBinding);
      }),
    );
    const bindingIds = Object.freeze(bindings.map(({ id }) => id));
    const wordDraft = {
      wordId: word.id,
      wordIndex,
      text: word.text,
      spaceBefore: word.spaceBefore,
      beginMs,
      endMs,
      strategy: unitPlan.strategy,
      bindingIds,
      bindings,
      parserJoinGroup,
      emphasisSplit,
    } satisfies KaraokeWordBindingDraft;
    wordDrafts.push(wordDraft);
    flatBindings.push(...bindings);
  }

  const visualEmphasis = compileVisualEmphasisGroups(
    wordDrafts,
    trackName,
    lane,
  );
  const wordPlans = wordDrafts.map((wordDraft) => {
    const visualEmphasisGroup = visualEmphasis.references.get(
      wordDraft.wordId,
    );
    if (!visualEmphasisGroup) {
      throw new Error(
        `Missing visual emphasis group for karaoke word ${wordDraft.wordId}`,
      );
    }
    return Object.freeze({
      ...wordDraft,
      visualEmphasisGroup,
    } satisfies KaraokeWordBindingPlan);
  });

  return Object.freeze({
    ok: true,
    status: "timed",
    signature: createStableId("karaoke-binding-plan", fingerprint),
    fallbackReason: null,
    reconstructedText,
    wordPlans: Object.freeze(wordPlans),
    flatBindings: Object.freeze(flatBindings),
    parserJoinGroups: joinValidation.plans,
    visualEmphasisGroups: visualEmphasis.plans,
  });
}
