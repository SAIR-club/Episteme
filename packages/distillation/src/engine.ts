import {
  CANDIDATE_PREFIX,
  type AgentWorkspace,
  type Basis,
  type CandidateNode,
  type CognitiveAgent,
  type KnownNode,
  type Suggestion,
} from '@episteme/agent'
import type { Candidate, DistillationPolicy, Origin, Refusal, Role } from './policy.js'
import {
  MAX_QUOTE_LENGTH,
  MIN_QUOTE_SIGNS,
  canonicalText,
  occurrencesOf,
  quoteSigns,
} from './quotes.js'
import { segment, type Episode, type Material, type Span } from './segment.js'

export interface DistillInput {
  readonly material: Material
  /** Who reads the material. Any `CognitiveAgent`; the first is `RuleBasedDistiller`. */
  readonly agent: CognitiveAgent
  readonly policy: DistillationPolicy
  /** The human whose understanding this is. A suggested state change is always about them. */
  readonly actorId: string
  /** What the human already has, so the material's words can be matched to it rather than duplicated. */
  readonly known: readonly KnownNode[]
  /**
   * The learner's speaker label in the material, when it is a dialogue. A turn is the learner's when its speaker
   * equals this exactly, both in NFC and trimmed, with no case folding. Without it nothing is `stated`
   * (ADR 0011).
   */
  readonly learner?: string
}

export interface DistillationResult {
  readonly sourceId: string
  /** The material as it was read: canonical (`canonicalText`). Every span points into this text. */
  readonly text: string
  readonly episodes: readonly Episode[]
  /** Everything found, kept or refused, in the order it was found. */
  readonly candidates: readonly Candidate[]
}

/** A label longer than this is a passage, not a unit of understanding. */
const MAX_LABEL = 400
/** An excerpt shown with a candidate is cut here. The span still points at the whole. */
const MAX_EXCERPT = 280

/**
 * Distils material into candidates (ADR 0009). Writes nothing, anywhere.
 *
 * For each episode, in order, the agent is asked for structure, then connections, then state changes, and
 * each time it sees every candidate kept so far, so it can connect a later answer to an earlier question.
 * Each candidate is checked against the policy and given the origin it came from. A candidate that fails a
 * check is kept as refused, with the reason, not dropped.
 */
export async function distill(input: DistillInput): Promise<DistillationResult> {
  const { agent, policy } = input
  // Read, and pointed into, in its canonical form only, so a span never needs mapping back (ADR 0011).
  const material: Material = { ...input.material, text: canonicalText(input.material.text) }
  const learner = input.learner === undefined ? undefined : canonicalText(input.learner).trim()
  const episodes = segment(material)
  /** The name the reader gave each node candidate, by engine reference. */
  const localRefs = new Map<string, string>()
  const candidates: Candidate[] = []
  const roleOf = new Map(
    Object.entries(policy.nodeTypes).map(([role, type]) => [type, role as Role]),
  )
  const edgeTypes = new Set(Object.values(policy.edgeTypes))
  const knownIds = new Set(input.known.map((node) => node.id))
  let keptInRun = 0

  for (const episode of episodes) {
    const prefix = `e${episode.index + 1}.`
    let keptInEpisode = 0
    const workspace: AgentWorkspace = {
      actorId: input.actorId,
      nodeIds: input.known.map((node) => node.id),
      state: {},
      known: input.known,
      material: {
        sourceId: material.sourceId,
        episodeId: episode.id,
        text: episode.text,
        span: episode.span,
        ...(episode.time === undefined ? {} : { time: episode.time }),
      },
      candidates: candidateNodes(candidates, localRefs),
    }

    const keep = (ref: string, given: Suggestion, refusal: Refusal | undefined): void => {
      // A node's own name was replaced by the engine reference; the reader's name for anything else is its own.
      const readerRef = localRefs.get(ref) ?? given.ref
      const named = readerRef === undefined ? {} : { readerRef }
      const located = locate(material, episodes, episode, given)
      const origin = 'origin' in located ? located.origin : undefined
      const basis = basisOf(given, origin, learner)
      const suggestion: Suggestion = { ...given, basis: basis.value }
      let reason = refusal ?? ('refusal' in located ? located.refusal : undefined) ?? basis.refusal
      if (reason === undefined && origin !== undefined) {
        reason = policy.validate?.({ ref, suggestion, origin, status: 'suggested' })
      }
      if (
        reason === undefined &&
        (keptInEpisode >= policy.limits.perEpisode || keptInRun >= policy.limits.perRun)
      ) {
        reason = {
          code: 'over_limit',
          message: `more candidates than this domain keeps from one ${keptInEpisode >= policy.limits.perEpisode ? 'episode' : 'piece of material'}`,
        }
      }
      if (reason === undefined && origin !== undefined) {
        keptInEpisode += 1
        keptInRun += 1
        candidates.push({ ref, suggestion, origin, status: 'suggested', ...named })
      } else if (reason !== undefined) {
        candidates.push({
          ref,
          suggestion,
          ...(origin === undefined ? {} : { origin }),
          status: 'refused',
          refusal: reason,
          ...named,
        })
      }
    }

    // Structure first: the nodes later suggestions may refer to.
    const structure = await agent.suggestStructure(workspace)
    const local = new Map<string, string>()
    const deferred: Suggestion[] = []
    let unnamed = 0
    for (const suggestion of structure) {
      if (suggestion.kind !== 'node') {
        deferred.push(suggestion)
        continue
      }
      const name = suggestion.ref ?? `n${++unnamed}`
      const ref = `${prefix}${name}`
      if (local.has(name)) {
        keep(ref, suggestion, { code: 'duplicate_ref', message: `"${name}" names two candidates` })
        continue
      }
      local.set(name, ref)
      localRefs.set(ref, name)
      const role = roleOf.get(suggestion.nodeType)
      const label = suggestion.label.trim()
      const node =
        role === undefined
          ? suggestion
          : {
              ...suggestion,
              label,
              ref,
              properties: { ...policy.propertiesFor?.(role, label), ...suggestion.properties },
            }
      keep(ref, node, nodeRefusal(node, role, candidates, input.known))
    }

    // Then what connects them, and what the material says about the learner, seeing every candidate so far.
    const seeing: AgentWorkspace = {
      ...workspace,
      candidates: candidateNodes(candidates, localRefs),
    }
    const linked = [
      ...deferred,
      ...(await agent.suggestConnections(seeing)),
      ...(await agent.suggestStateChange(seeing)),
    ]
    let link = 0
    for (const suggestion of linked) {
      const ref = `${prefix}${suggestion.kind === 'state' ? 's' : 'l'}${++link}`
      const resolve = (end: string): string =>
        end.startsWith(CANDIDATE_PREFIX) && local.has(end.slice(CANDIDATE_PREFIX.length))
          ? `${CANDIDATE_PREFIX}${local.get(end.slice(CANDIDATE_PREFIX.length))}`
          : end
      const end = (id: string): Refusal | undefined => endpointRefusal(id, knownIds, candidates)

      if (suggestion.kind === 'edge') {
        const edge = { ...suggestion, from: resolve(suggestion.from), to: resolve(suggestion.to) }
        keep(ref, edge, edgeRefusal(edge, edgeTypes, candidates) ?? end(edge.from) ?? end(edge.to))
      } else if (suggestion.kind === 'state') {
        const state = { ...suggestion, target: resolve(suggestion.target), actorId: input.actorId }
        keep(ref, state, stateRefusal(state, policy) ?? end(state.target))
      } else {
        keep(ref, suggestion, {
          code: 'out_of_order',
          message: 'a node must be suggested as structure, before what connects it',
        })
      }
    }
  }

  return { sourceId: material.sourceId, text: material.text, episodes, candidates }
}

/** The kept nodes, as an agent sees them, each with the name its reader gave it. */
function candidateNodes(
  candidates: readonly Candidate[],
  localRefs: ReadonlyMap<string, string>,
): readonly CandidateNode[] {
  return candidates.flatMap((candidate) => {
    if (candidate.status !== 'suggested' || candidate.suggestion.kind !== 'node') return []
    const localRef = localRefs.get(candidate.ref)
    return [
      {
        ref: candidate.ref,
        nodeType: candidate.suggestion.nodeType,
        label: candidate.suggestion.label,
        episodeId: candidate.origin.episodeId,
        ...(localRef === undefined ? {} : { localRef }),
      },
    ]
  })
}

function nodeRefusal(
  node: Suggestion & { kind: 'node' },
  role: Role | undefined,
  candidates: readonly Candidate[],
  known: readonly KnownNode[],
): Refusal | undefined {
  if (role === undefined) {
    return { code: 'not_allowed', message: `this domain does not distil "${node.nodeType}" nodes` }
  }
  if (node.label === '') return { code: 'missing_label', message: 'a candidate needs a label' }
  if (node.label.length > MAX_LABEL) {
    return {
      code: 'too_long',
      message: `a label of ${node.label.length} characters is a passage, not a unit`,
    }
  }
  const same = normalise(node.label)
  if (
    candidates.some(
      (candidate) =>
        candidate.status === 'suggested' &&
        candidate.suggestion.kind === 'node' &&
        candidate.suggestion.nodeType === node.nodeType &&
        normalise(candidate.suggestion.label) === same,
    )
  ) {
    return {
      code: 'duplicate_candidate',
      message: 'the same thing was already found in this material',
    }
  }
  const existing = known.find(
    (item) => item.type === node.nodeType && normalise(item.label) === same,
  )
  if (existing !== undefined) {
    // Only a second node is refused. What the words show can still be sent against the one the learner has.
    return {
      code: 'already_known',
      message: `the learner already has this as "${existing.id}"`,
      existingNodeId: existing.id,
    }
  }
  return undefined
}

function edgeRefusal(
  edge: Suggestion & { kind: 'edge' },
  edgeTypes: ReadonlySet<string | undefined>,
  candidates: readonly Candidate[],
): Refusal | undefined {
  if (!edgeTypes.has(edge.edgeType)) {
    return {
      code: 'not_allowed',
      message: `this domain does not distil "${edge.edgeType}" relations`,
    }
  }
  if (edge.from === edge.to)
    return { code: 'self_link', message: 'a relation needs two different ends' }
  const twice = candidates.some(
    (candidate) =>
      candidate.status === 'suggested' &&
      candidate.suggestion.kind === 'edge' &&
      candidate.suggestion.edgeType === edge.edgeType &&
      candidate.suggestion.from === edge.from &&
      candidate.suggestion.to === edge.to,
  )
  return twice
    ? {
        code: 'duplicate_candidate',
        message: 'the same relation was already found in this material',
      }
    : undefined
}

function stateRefusal(
  state: Suggestion & { kind: 'state' },
  policy: DistillationPolicy,
): Refusal | undefined {
  const entries = Object.entries(state.dimensions)
  if (entries.length === 0)
    return { code: 'missing_dimension', message: 'a state change needs a dimension' }
  for (const [dimension, value] of entries) {
    const levels = policy.stateDimensions[dimension]
    if (levels === undefined) {
      return {
        code: 'not_allowed',
        message: `this domain does not suggest changes to "${dimension}"`,
      }
    }
    if (value.level === undefined || !levels.includes(value.level)) {
      return {
        code: 'not_allowed',
        message: `"${String(value.level)}" is not a level of ${dimension}: ${levels.join(', ')}`,
      }
    }
  }
  return undefined
}

/** Whether an end of an edge or a state change names something that can exist. */
function endpointRefusal(
  id: string,
  knownIds: ReadonlySet<string>,
  candidates: readonly Candidate[],
): Refusal | undefined {
  if (!id.startsWith(CANDIDATE_PREFIX)) {
    return knownIds.has(id)
      ? undefined
      : { code: 'unknown_endpoint', message: `"${id}" is not in the graph` }
  }
  const target = candidates.find((candidate) => candidate.ref === id.slice(CANDIDATE_PREFIX.length))
  if (target === undefined) {
    return { code: 'unknown_endpoint', message: `"${id}" names no candidate of this material` }
  }
  if (target.status === 'refused') {
    return {
      code: 'depends_on_refused',
      message: `it depends on "${target.ref}", which was refused`,
    }
  }
  return undefined
}

/**
 * Where the words a suggestion rests on are, or why they cannot be found (ADR 0011).
 *
 * A suggestion with no quote rests on the whole episode being read. A quote is put in canonical form and found
 * exactly: in the episode the suggestion names, or else in the one being read, and in the occurrence it names
 * when the words occur there more than once. A quote that cannot be located is refused, never widened to the
 * episode, and leaves no origin.
 */
function locate(
  material: Material,
  episodes: readonly Episode[],
  reading: Episode,
  suggestion: Suggestion,
): { readonly origin: Origin } | { readonly refusal: Refusal } {
  if (suggestion.quote === undefined || suggestion.quote === '') {
    return { origin: originAt(material, reading, reading.span) }
  }
  const quote = canonicalText(suggestion.quote)
  if (quote.length > MAX_QUOTE_LENGTH) {
    return refused('quote_too_long', `a quote of ${quote.length} characters is a passage`)
  }
  if (quoteSigns(quote) < MIN_QUOTE_SIGNS) {
    return refused(
      'quote_too_short',
      `a quote needs at least ${MIN_QUOTE_SIGNS} letters or digits to rest on`,
    )
  }
  const named = suggestion.quoteAt
  const episode =
    named === undefined ? reading : episodes.find((candidate) => candidate.id === named.episodeId)
  if (episode === undefined) {
    return refused('quote_not_found', `there is no passage "${named?.episodeId ?? ''}"`)
  }

  const found = occurrencesOf(episode.text, quote)
  if (found.length === 0) {
    const crossing = occurrencesOf(material.text, quote).some(
      (start) =>
        !episodes.some(
          (candidate) =>
            candidate.span.start <= start && start + quote.length <= candidate.span.end,
        ),
    )
    return crossing
      ? refused('quote_spans_episodes', 'the quote runs across two passages')
      : refused('quote_not_found', 'the quote is not in the passage it is said to come from')
  }
  const occurrence = named?.occurrence
  if (occurrence === undefined && found.length > 1) {
    return refused(
      'quote_ambiguous',
      `the quote occurs ${found.length} times; say which occurrence is meant`,
    )
  }
  const offset = occurrence === undefined ? found[0] : found[occurrence - 1]
  if (offset === undefined) {
    return refused('quote_not_found', `the quote has no occurrence ${String(occurrence)}`)
  }
  const start = episode.span.start + offset
  return { origin: originAt(material, episode, { start, end: start + quote.length }) }
}

function refused(code: string, message: string): { readonly refusal: Refusal } {
  return { refusal: { code, message } }
}

/** The origin of the words at `span`, with the speaker whose turn holds them, when one does. */
function originAt(material: Material, episode: Episode, span: Span): Origin {
  const words = material.text.slice(span.start, span.end)
  const speaker = episode.turns.find(
    (turn) =>
      turn.speaker !== undefined && turn.span.start <= span.start && span.end <= turn.span.end,
  )?.speaker
  return {
    sourceId: material.sourceId,
    episodeId: episode.id,
    span,
    excerpt: words.length > MAX_EXCERPT ? `${words.slice(0, MAX_EXCERPT - 1)}…` : words,
    ...(episode.time === undefined ? {} : { time: episode.time }),
    ...(speaker === undefined ? {} : { speaker }),
  }
}

/**
 * The basis of a suggestion's quote (ADR 0011).
 *
 * Only words inside a turn whose speaker is the given `learner` can be `stated`, and a reader that says `stated`
 * of anything else is refused.
 *
 * A reader that leaves the basis unset gets `stated` exactly when its quote is in such a turn, and `inferred`
 * otherwise. That default exists for the rule-based reader, whose candidates are the learner's sentences as
 * written. A reader whose suggestions are its own reading, such as a host's model, must state the basis of
 * every suggestion itself: an inference does not become `stated` because the words it rests on are the
 * learner's.
 */
function basisOf(
  suggestion: Suggestion,
  origin: Origin | undefined,
  learner: string | undefined,
): { readonly value: Basis; readonly refusal?: Refusal } {
  const learners =
    learner !== undefined &&
    learner !== '' &&
    origin?.speaker !== undefined &&
    canonicalText(origin.speaker).trim() === learner
  if (suggestion.basis === 'stated' && !learners) {
    return {
      value: 'stated',
      refusal: {
        code: 'basis_mismatch',
        message:
          learner === undefined || learner === ''
            ? 'nothing is stated by the learner unless the material says who the learner is'
            : `the quote is not in a turn of "${learner}"`,
      },
    }
  }
  return { value: suggestion.basis ?? (learners ? 'stated' : 'inferred') }
}

/** Labels compared without case, surrounding space or final punctuation. */
function normalise(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[。.!！?？\s]+$/u, '')
}
