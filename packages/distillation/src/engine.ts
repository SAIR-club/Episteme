import {
  CANDIDATE_PREFIX,
  type AgentWorkspace,
  type CandidateNode,
  type CognitiveAgent,
  type KnownNode,
  type Suggestion,
} from '@episteme/agent'
import type { Candidate, DistillationPolicy, Origin, Refusal, Role } from './policy.js'
import { segment, type Episode, type Material } from './segment.js'

export interface DistillInput {
  readonly material: Material
  /** Who reads the material. Any `CognitiveAgent`; the first is `RuleBasedDistiller`. */
  readonly agent: CognitiveAgent
  readonly policy: DistillationPolicy
  /** The human whose understanding this is. A suggested state change is always about them. */
  readonly actorId: string
  /** What the human already has, so the material's words can be matched to it rather than duplicated. */
  readonly known: readonly KnownNode[]
}

export interface DistillationResult {
  readonly sourceId: string
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
  const { material, agent, policy } = input
  const episodes = segment(material)
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
      candidates: candidateNodes(candidates),
    }

    const keep = (ref: string, suggestion: Suggestion, refusal: Refusal | undefined): void => {
      const origin = originOf(material, episode, suggestion.quote)
      let reason = refusal ?? policy.validate?.({ ref, suggestion, origin, status: 'suggested' })
      if (
        reason === undefined &&
        (keptInEpisode >= policy.limits.perEpisode || keptInRun >= policy.limits.perRun)
      ) {
        reason = {
          code: 'over_limit',
          message: `more candidates than this domain keeps from one ${keptInEpisode >= policy.limits.perEpisode ? 'episode' : 'piece of material'}`,
        }
      }
      if (reason === undefined) {
        keptInEpisode += 1
        keptInRun += 1
        candidates.push({ ref, suggestion, origin, status: 'suggested' })
      } else {
        candidates.push({ ref, suggestion, origin, status: 'refused', refusal: reason })
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
    const seeing: AgentWorkspace = { ...workspace, candidates: candidateNodes(candidates) }
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

  return { sourceId: material.sourceId, episodes, candidates }
}

/** The kept nodes, as an agent sees them. */
function candidateNodes(candidates: readonly Candidate[]): readonly CandidateNode[] {
  return candidates.flatMap((candidate) =>
    candidate.status === 'suggested' && candidate.suggestion.kind === 'node'
      ? [
          {
            ref: candidate.ref,
            nodeType: candidate.suggestion.nodeType,
            label: candidate.suggestion.label,
            episodeId: candidate.origin.episodeId,
          },
        ]
      : [],
  )
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
    return { code: 'already_known', message: `the learner already has this as "${existing.id}"` }
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

/** The words a candidate rests on: its quote, where the episode holds it, or else the whole episode. */
function originOf(material: Material, episode: Episode, quote: string | undefined): Origin {
  const at = quote === undefined || quote === '' ? -1 : episode.text.indexOf(quote)
  const span =
    at < 0
      ? episode.span
      : { start: episode.span.start + at, end: episode.span.start + at + (quote ?? '').length }
  const words = material.text.slice(span.start, span.end)
  return {
    sourceId: material.sourceId,
    episodeId: episode.id,
    span,
    excerpt: words.length > MAX_EXCERPT ? `${words.slice(0, MAX_EXCERPT - 1)}…` : words,
    ...(episode.time === undefined ? {} : { time: episode.time }),
  }
}

/** Labels compared without case, surrounding space or final punctuation. */
function normalise(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[。.!！?？\s]+$/u, '')
}
