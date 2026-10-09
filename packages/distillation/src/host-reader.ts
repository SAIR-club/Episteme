import {
  CANDIDATE_PREFIX,
  type AgentResponse,
  type AgentWorkspace,
  type Basis,
  type CognitiveAgent,
  type QuoteAt,
  type Suggestion,
} from '@episteme/agent'
import type { Candidate, DistillationPolicy, Refusal, Relation, Role } from './policy.js'
import {
  MAX_QUOTE_LENGTH,
  MIN_QUOTE_SIGNS,
  canonicalText,
  occurrenceAt,
  occurrencesOf,
  quoteSigns,
} from './quotes.js'
import { segment } from './segment.js'

/**
 * Host-assisted distillation: the host's model reads, Episteme verifies (ADR 0011).
 *
 * A host submits what its model read in a stretch of material as items in the engine's domain-neutral roles and
 * relations. `prepareHostReading` checks what can be checked before reading: each item's shape, its basis, and
 * where its quote is in the **whole** source. It then turns the host's whole-source `occurrence` into the
 * engine's own form, an episode and an occurrence within it. What survives is handed to the ordinary engine by a
 * `CognitiveAgent`, so it meets the same policy, limits and checks as any other reader, and the engine locates
 * every quote again itself.
 */

/** One thing the host's model read. Flat, as the agent surface carries it; which fields count depends on `kind`. */
export interface HostItem {
  readonly kind: 'node' | 'relation' | 'state'
  /** Required for a node, which other items name as `cand:<ref>`. Optional otherwise. */
  readonly ref?: string
  /** node: `concept`, `question`, `claim` or `evidence`. */
  readonly role?: string
  /** node: the unit of understanding, as the learner would state it. */
  readonly label?: string
  /** relation: either end, `cand:<ref>` of this submission or an existing node id. */
  readonly from?: string
  readonly to?: string
  /** relation: `about`, `answers`, `supports`, `contradicts` or `revises`. */
  readonly relation?: string
  /** state: `cand:<ref>` of this submission or an existing node id. */
  readonly target?: string
  readonly dimension?: string
  readonly level?: string
  /** The words it rests on, verbatim from the material. Required. */
  readonly quote?: string
  /** Which occurrence of the quote, 1-based over the whole canonical source. Required when the quote recurs. */
  readonly occurrence?: number
  /** `stated` (the learner said the quoted words) or `inferred` (a reading). Required: there is no default. */
  readonly basis?: string
  readonly rationale?: string
}

/** An item refused, under the name the host knows it by. */
export interface HostRefusal {
  readonly ref: string
  readonly refusal: Refusal
}

export interface HostReading {
  /** Reads the prepared items into the engine. */
  readonly reader: CognitiveAgent
  /** Items refused before reading. Their words were not located, so they carry no origin. */
  readonly refused: readonly HostRefusal[]
  /** The refs of node items, so a refusal of what depends on one can be told apart from an unknown name. */
  readonly nodeRefs: ReadonlySet<string>
}

const ROLES: readonly Role[] = ['concept', 'question', 'claim', 'evidence']
const RELATIONS: readonly Relation[] = ['about', 'answers', 'supports', 'contradicts', 'revises']

interface Prepared {
  readonly ref: string
  readonly suggestion: Suggestion
  /** Where the engine is to read it: the episode, by id. */
  readonly episodeId: string
}

/** Checks a host's items and prepares the reader that hands the survivors to the engine. Writes nothing. */
export function prepareHostReading(input: {
  readonly sourceId: string
  readonly text: string
  readonly items: readonly HostItem[]
  readonly policy: DistillationPolicy
  readonly actorId: string
}): HostReading {
  const text = canonicalText(input.text)
  const episodes = segment({ sourceId: input.sourceId, text })
  const refused: HostRefusal[] = []
  const refs = input.items.map((item, index) => item.ref?.trim() || `#${index + 1}`)
  const nodeRefs = new Set(
    input.items.flatMap((item, index) => (item.kind === 'node' ? [refs[index] ?? ''] : [])),
  )

  // First pass: everything an item can be refused for on its own, and where its words are.
  const located = new Map<number, { readonly quoteAt: QuoteAt; readonly episode: number }>()
  const seen = new Set<string>()
  input.items.forEach((item, index) => {
    const ref = refs[index] ?? `#${index + 1}`
    const refuse = (code: string, message: string): void => {
      refused.push({ ref, refusal: { code, message } })
    }
    if (seen.has(ref)) return refuse('duplicate_ref', `"${ref}" names two items`)
    seen.add(ref)
    const missing = missingFields(item)
    if (missing !== undefined) return refuse('invalid_candidate', missing)
    if (item.basis !== 'stated' && item.basis !== 'inferred') {
      return refuse(
        'missing_basis',
        'every item says whether the learner stated it or it was inferred',
      )
    }
    if (item.quote === undefined || item.quote.trim() === '') {
      return refuse('missing_quote', 'every item quotes the words it rests on')
    }
    const quote = canonicalText(item.quote)
    if (quote.length > MAX_QUOTE_LENGTH) {
      return refuse('quote_too_long', `a quote of ${quote.length} characters is a passage`)
    }
    if (quoteSigns(quote) < MIN_QUOTE_SIGNS) {
      return refuse(
        'quote_too_short',
        `a quote needs at least ${MIN_QUOTE_SIGNS} letters or digits to rest on`,
      )
    }
    const found = occurrencesOf(text, quote)
    if (found.length === 0) return refuse('quote_not_found', 'the quote is not in the material')
    if (item.occurrence === undefined && found.length > 1) {
      return refuse(
        'quote_ambiguous',
        `the quote occurs ${found.length} times in the material; say which occurrence is meant`,
      )
    }
    const start = item.occurrence === undefined ? found[0] : found[item.occurrence - 1]
    if (start === undefined) {
      return refuse('quote_not_found', `the quote has no occurrence ${String(item.occurrence)}`)
    }
    const episode = episodes.findIndex(
      (candidate) => candidate.span.start <= start && start + quote.length <= candidate.span.end,
    )
    const holding = episodes[episode]
    if (holding === undefined) {
      return refuse('quote_spans_episodes', 'the quote runs across two passages')
    }
    const inEpisode = occurrenceAt(holding.text, quote, start - holding.span.start)
    located.set(index, {
      quoteAt:
        inEpisode === undefined
          ? { episodeId: holding.id }
          : { episodeId: holding.id, occurrence: inEpisode },
      episode,
    })
  })

  // Second pass: what each relation and state change depends on, and the episode it is read in, which is the
  // latest of its quote's and its candidate ends'. By then the engine has kept or refused every end.
  const nodeEpisode = new Map<string, number>()
  input.items.forEach((item, index) => {
    const at = located.get(index)
    if (item.kind === 'node' && at !== undefined) nodeEpisode.set(refs[index] ?? '', at.episode)
  })
  const prepared: Prepared[] = []
  input.items.forEach((item, index) => {
    const at = located.get(index)
    if (at === undefined) return
    const ref = refs[index] ?? `#${index + 1}`
    const refuse = (code: string, message: string): void => {
      refused.push({ ref, refusal: { code, message } })
    }
    const common = {
      rationale: item.rationale ?? '',
      quote: item.quote ?? '',
      quoteAt: at.quoteAt,
      basis: item.basis as Basis,
    }
    let episode = at.episode
    for (const end of endsOf(item)) {
      if (!end.startsWith(CANDIDATE_PREFIX)) continue
      const name = end.slice(CANDIDATE_PREFIX.length)
      const endEpisode = nodeEpisode.get(name)
      if (endEpisode !== undefined) {
        episode = Math.max(episode, endEpisode)
        continue
      }
      return nodeRefs.has(name)
        ? refuse('depends_on_refused', `it depends on "${name}", which was refused`)
        : refuse('unknown_endpoint', `"${end}" names no node item of this submission`)
    }
    const episodeId = episodes[episode]?.id ?? ''

    if (item.kind === 'node') {
      const nodeType = isRole(item.role) ? input.policy.nodeTypes[item.role] : undefined
      if (nodeType === undefined) {
        return refuse('not_allowed', `this domain does not distil "${String(item.role)}" nodes`)
      }
      prepared.push({
        ref,
        episodeId,
        suggestion: { kind: 'node', nodeType, label: item.label ?? '', ref, ...common },
      })
    } else if (item.kind === 'relation') {
      const edgeType = isRelation(item.relation) ? input.policy.edgeTypes[item.relation] : undefined
      if (edgeType === undefined) {
        return refuse(
          'not_allowed',
          `this domain does not distil "${String(item.relation)}" relations`,
        )
      }
      prepared.push({
        ref,
        episodeId,
        suggestion: {
          kind: 'edge',
          edgeType,
          from: item.from ?? '',
          to: item.to ?? '',
          ref,
          ...common,
        },
      })
    } else {
      prepared.push({
        ref,
        episodeId,
        suggestion: {
          kind: 'state',
          target: item.target ?? '',
          actorId: input.actorId,
          dimensions: {
            [item.dimension ?? '']: { level: item.level ?? '', authority: 'suggested' },
          },
          evidence: [item.quote ?? ''],
          ref,
          ...common,
        },
      })
    }
  })

  return { reader: new HostReader(prepared), refused, nodeRefs }
}

/**
 * How the engine's refusal of a host item is told to the host: under the host's ref, and, when it names a node
 * of the submission that the engine refused, as depending on it. The reader can only see kept nodes, so the
 * engine knows such an end only as a name it cannot find.
 */
export function hostRefusalOf(reading: HostReading, candidate: Candidate): HostRefusal | undefined {
  if (candidate.status !== 'refused') return undefined
  const ref = candidate.readerRef ?? candidate.ref
  const { suggestion, refusal } = candidate
  if (refusal.code === 'unknown_endpoint') {
    const ends =
      suggestion.kind === 'edge'
        ? [suggestion.from, suggestion.to]
        : suggestion.kind === 'state'
          ? [suggestion.target]
          : []
    const refusedNode = ends
      .filter((end) => end.startsWith(CANDIDATE_PREFIX))
      .map((end) => end.slice(CANDIDATE_PREFIX.length))
      .find((name) => reading.nodeRefs.has(name))
    if (refusedNode !== undefined) {
      return {
        ref,
        refusal: {
          code: 'depends_on_refused',
          message: `it depends on "${refusedNode}", which was refused`,
        },
      }
    }
  }
  return { ref, refusal }
}

/**
 * Hands prepared host items to the engine, each in the episode it is to be read in.
 *
 * A candidate end in an earlier episode is named by the engine's reference, found through the reader's own name
 * for it in `workspace.candidates` (`localRef`); the reader never constructs one. An end in the same episode is
 * left to the engine, which resolves its own episode's names.
 */
class HostReader implements CognitiveAgent {
  readonly id = 'host-reader'
  readonly description =
    'Hands a host model’s reading of the material to the engine; suggests only.'
  readonly #prepared: readonly Prepared[]
  readonly #episodeOf: ReadonlyMap<string, string>

  constructor(prepared: readonly Prepared[]) {
    this.#prepared = prepared
    this.#episodeOf = new Map(
      prepared.flatMap((item) =>
        item.suggestion.kind === 'node' ? [[item.ref, item.episodeId] as const] : [],
      ),
    )
  }

  respond(): Promise<AgentResponse> {
    return Promise.resolve({
      text: 'This reader hands a host’s reading to the engine; it does not answer.',
      usedContext: false,
    })
  }

  suggestStructure(workspace: AgentWorkspace): Promise<readonly Suggestion[]> {
    return Promise.resolve(this.#here(workspace, 'node'))
  }

  suggestConnections(workspace: AgentWorkspace): Promise<readonly Suggestion[]> {
    return Promise.resolve(
      this.#here(workspace, 'edge').map((suggestion) =>
        suggestion.kind === 'edge'
          ? {
              ...suggestion,
              from: this.#end(suggestion.from, workspace),
              to: this.#end(suggestion.to, workspace),
            }
          : suggestion,
      ),
    )
  }

  suggestStateChange(workspace: AgentWorkspace): Promise<readonly Suggestion[]> {
    return Promise.resolve(
      this.#here(workspace, 'state').map((suggestion) =>
        suggestion.kind === 'state'
          ? { ...suggestion, target: this.#end(suggestion.target, workspace) }
          : suggestion,
      ),
    )
  }

  #here(workspace: AgentWorkspace, kind: Suggestion['kind']): readonly Suggestion[] {
    const episodeId = workspace.material?.episodeId
    return this.#prepared
      .filter((item) => item.episodeId === episodeId && item.suggestion.kind === kind)
      .map((item) => item.suggestion)
  }

  #end(end: string, workspace: AgentWorkspace): string {
    if (!end.startsWith(CANDIDATE_PREFIX)) return end
    const name = end.slice(CANDIDATE_PREFIX.length)
    if (this.#episodeOf.get(name) === workspace.material?.episodeId) return end
    const earlier = workspace.candidates?.find((candidate) => candidate.localRef === name)
    return earlier === undefined ? end : `${CANDIDATE_PREFIX}${earlier.ref}`
  }
}

function missingFields(item: HostItem): string | undefined {
  const needs: Readonly<Record<HostItem['kind'], readonly (keyof HostItem)[]>> = {
    node: ['ref', 'role', 'label', 'rationale'],
    relation: ['from', 'to', 'relation', 'rationale'],
    state: ['target', 'dimension', 'level', 'rationale'],
  }
  const fields = needs[item.kind]
  if (fields === undefined) return `"${String(item.kind)}" is not node, relation or state`
  const missing = fields.filter((field) => {
    const value = item[field]
    return typeof value !== 'string' || value.trim() === ''
  })
  return missing.length === 0 ? undefined : `a ${item.kind} needs ${missing.join(', ')}`
}

function endsOf(item: HostItem): readonly string[] {
  if (item.kind === 'relation') return [item.from ?? '', item.to ?? '']
  if (item.kind === 'state') return [item.target ?? '']
  return []
}

function isRole(value: string | undefined): value is Role {
  return ROLES.includes(value as Role)
}

function isRelation(value: string | undefined): value is Relation {
  return RELATIONS.includes(value as Relation)
}
