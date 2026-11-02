import {
  SessionRefusal,
  defaultDistillationPolicy,
  defaultSessionPack,
  recordableDimensions,
  type SessionScene,
} from '@episteme/application'
import {
  asId,
  defineDomainPack,
  type DimensionId,
  type StateDimensionDefinition,
} from '@episteme/core'
import { BLANK_TOPIC, type SceneProfile, type SceneRoute } from '@episteme/service'

/**
 * Working on research hypotheses: stating one, weighing evidence, and coming back to it later.
 *
 * Nothing here is about learning, and nothing here changes Core or the application. It exists to show that a scene
 * is one profile: a dimension of its own, and a few routes over the same review path everything else uses.
 */

const CREDENCE: StateDimensionDefinition = {
  id: asId<DimensionId>('credence'),
  label: 'Credence',
  kind: 'categorical',
  levels: ['doubtful', 'open', 'likely', 'established'],
}

export const hypothesisScene: SessionScene = {
  name: 'hypothesis',
  packs: [defaultSessionPack, defineDomainPack('hypothesis', { stateDimensions: [CREDENCE] })],
  distillationPolicy: defaultDistillationPolicy,
  recordableDimensions: recordableDimensions(
    [CREDENCE],
    [
      {
        id: CREDENCE.id,
        labelZh: '可信度',
        levelLabelsZh: {
          doubtful: '存疑',
          open: '未定',
          likely: '可能成立',
          established: '已确立',
        },
        description: 'How far you currently believe it.',
        descriptionZh: '你现在有多相信它。',
      },
    ],
  ),
}

const REQUESTED_BY = 'hypothesis-scene'
const CANDIDATE_REF = 'cand:'
const EVIDENCE_RELATIONS = ['supports', 'contradicts'] as const

function textOf(body: Readonly<Record<string, unknown>>, name: string): string {
  const value = body[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SessionRefusal('invalid_request', `"${name}" is required`)
  }
  return value.trim()
}

const routes: readonly SceneRoute[] = [
  {
    // A proposal, not a hypothesis yet: it counts once the person accepts it through `/suggestions/decide`.
    method: 'POST',
    path: '/hypotheses',
    handle: async ({ view, body }) => {
      const outcome = await view.propose(
        { kind: 'claim', label: textOf(body, 'statement') },
        { proposedBy: REQUESTED_BY, rationale: textOf(body, 'why') },
      )
      if (!outcome.ok) throw new SessionRefusal(outcome.refusal.code, outcome.refusal.message)
      return { suggestions: [outcome.suggestion.id] }
    },
  },
  {
    method: 'POST',
    path: '/evidence',
    handle: async ({ view, body }) => {
      const relation = textOf(body, 'relation')
      if (!EVIDENCE_RELATIONS.some((known) => known === relation)) {
        throw new SessionRefusal('invalid_request', 'relation is supports or contradicts')
      }
      const from = { proposedBy: REQUESTED_BY, rationale: textOf(body, 'why') }
      const claim = await view.propose({ kind: 'claim', label: textOf(body, 'statement') }, from)
      if (!claim.ok) throw new SessionRefusal(claim.refusal.code, claim.refusal.message)
      const link = await view.propose(
        {
          kind: 'link',
          from: `${CANDIDATE_REF}${claim.suggestion.id}`,
          to: textOf(body, 'hypothesis'),
          relation,
        },
        from,
      )
      if (!link.ok) throw new SessionRefusal(link.refusal.code, link.refusal.message)
      return { suggestions: [claim.suggestion.id, link.suggestion.id] }
    },
  },
  {
    method: 'GET',
    path: '/hypotheses',
    handle: ({ view, query }) => {
      const asked = query.get('q')?.trim().toLowerCase() ?? ''
      const nodes = view
        .listNodes()
        .filter((node) => asked === '' || node.label.toLowerCase().includes(asked))
      return {
        hypotheses: nodes.map((node) => {
          const expanded = view.expand(node.nodeId)
          return {
            nodeId: node.nodeId,
            label: node.label,
            author: expanded?.author,
            credence: view
              .understandingOf(node.nodeId)
              ?.find((dimension) => dimension.id === CREDENCE.id)?.level,
            evidence: (expanded?.neighbours ?? [])
              .filter(
                (neighbour) =>
                  neighbour.direction === 'in' &&
                  EVIDENCE_RELATIONS.some((known) => known === neighbour.type),
              )
              .map(({ nodeId, label, type }) => ({ nodeId, label, relation: type })),
          }
        }),
      }
    },
  },
]

export const hypothesisProfile: SceneProfile = {
  name: 'hypothesis',
  seed: BLANK_TOPIC,
  scene: hypothesisScene,
  routes,
}
