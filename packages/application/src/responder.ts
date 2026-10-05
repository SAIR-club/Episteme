import { hasOpenConflict, settledUnderstanding, type RelevantContext } from '@episteme/domain-learn'

/**
 * The Learn surface's responder, in Simplified Chinese.
 *
 * `learnerResponder` in `@episteme/domain-learn` is the English one, kept because the package's demos, tests
 * and docs are English. This is the same three-branch structure for a Chinese learner, and the structure is
 * the point rather than the wording:
 *
 * | situation | what the answer does |
 * | --- | --- |
 * | nothing recorded | establishes the ground — it cannot build on what is not there |
 * | something recorded, nothing settled | asks the learner to commit to a part of it |
 * | an unresolved conflict | refuses to build on a position the learner marked as contested |
 * | settled understanding | starts from it and skips the groundwork |
 *
 * A real model would be plugged in behind the same interface and would have to reproduce these branches. The
 * wording here is Learn's, which is why it lives in the app rather than in `@episteme/agent`.
 */
export function chineseLearnerResponder(
  input: { readonly text: string },
  context: {
    readonly summary?: string
    readonly detail?: Readonly<Record<string, unknown>>
  },
): { text: string; usedContext: boolean; contextSummary?: string } {
  const summary = context.summary?.trim() ?? ''
  const detail = context.detail

  // Nothing recorded: this must not imply the system looked and found your understanding. It has none.
  //
  // Domain-neutral on purpose. An earlier version said the answer depended on "what self-attention can and
  // cannot represent" — which was true for the built-in transformer topic and nonsense the moment a learner
  // brought their own material, because the responder has no idea what the topic is. This template was
  // written before the surface could be pointed at anything else, and pointing it at chemistry is what
  // exposed the leak.
  if (summary === '') {
    return {
      text: `我们先打下地基。关于「${input.text}」—— 要回答它，得先弄清楚它依赖的那些前提，因为这个问题的前提就是那件事。还没有任何你记录过的东西可以支撑它。`,
      usedContext: false,
    }
  }

  const openConflicts = readStringArray(detail?.['openConflicts'])
  if (openConflicts.length > 0) {
    return {
      text: `你在这里记录了一个还没解决的冲突，所以我不会把它当成已经确定的结论往下走。现在有用的一步是：明确说出你目前的立场覆盖不了哪个具体情形。`,
      usedContext: true,
      contextSummary: summary,
    }
  }

  const settledLabels = readStringArray(detail?.['settledLabels'])
  if (settledLabels.length === 0) {
    return {
      text: `我们对这件事有了一个开头，但你还没有把任何一部分标记为确定。先定下你愿意为之辩护的那一部分，再往前走。`,
      usedContext: true,
      contextSummary: summary,
    }
  }

  return {
    text: `既然你已经理解了「${settledLabels.join('」「')}」，我们就直接往下走，不必再把地基建一遍。`,
    usedContext: true,
    contextSummary: summary,
  }
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** The two facts the responder branches on, read from a retrieved context. */
export function responderFacts(context: RelevantContext): {
  readonly summary: string
  readonly openConflicts: readonly string[]
  readonly settledLabels: readonly string[]
} {
  return {
    summary: context.summary,
    openConflicts: context.known.flatMap((entry) => entry.openConflicts),
    settledLabels: settledUnderstanding(context).map((entry) => entry.label),
  }
}

/** Re-exported so a caller can ask the conflict question without importing the package directly. */
export { hasOpenConflict }
