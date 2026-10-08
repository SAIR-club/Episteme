import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnSession, type Suggestion } from '@episteme/application'
import { NODE } from '@episteme/domain-learn'

/**
 * Distillation end to end (ADR 0009), over a real learning dialogue.
 *
 * The material goes in; the distiller turns it into suggestions; the learner accepts some, puts one in their
 * own words, and turns one down; only what they decided reaches the graph and the history; and all of it is
 * still there after a restart, each kept node pointing back at the words it came from.
 */

/** A tutoring exchange about why a Transformer needs positional information. */
export const MATERIAL = [
  '[00:05] 学生：为什么 Transformer 需要位置编码？',
  '[00:12] 老师：因为自注意力本身不区分词的顺序。例如把句子里的词打乱，注意力的输出只是跟着重新排列。',
  '[00:40] 学生：我明白了。',
  '[01:02] 学生：那「旋转位置编码」是怎么做的？',
  '[01:15] 老师：它把位置编码成向量的旋转，所以两个词的相对位置会体现在点积里。',
  '[01:50] 学生：这部分我还不太懂。',
].join('\n')

export interface DemoStep {
  readonly title: string
  readonly lines: readonly string[]
}

export interface DistillDemoResult {
  readonly steps: readonly DemoStep[]
  readonly suggested: number
  readonly accepted: number
  readonly eventsAfter: number
}

export async function runDistillDemo(): Promise<DistillDemoResult> {
  const directory = await mkdtemp(join(tmpdir(), 'episteme-distil-demo-'))
  const filePath = join(directory, 'learn.jsonl')
  const steps: DemoStep[] = []
  try {
    let session = await LearnSession.open({ filePath })
    // What the learner already has: the distiller links to these rather than suggesting them again.
    await session.batch((writer) => {
      writer.addNode({
        id: 'c_self_attention',
        label: '自注意力（Self-Attention）',
        type: NODE.concept,
        tier: 'reference',
      })
      writer.addNode({
        id: 'c_positional_encoding',
        label: '位置编码（Positional Encoding）',
        type: NODE.concept,
        tier: 'reference',
      })
    })
    steps.push({
      title: '1 · Before',
      lines: [
        `${session.listNodes().length} nodes, ${session.eventCount} recorded changes of understanding`,
      ],
    })

    const outcome = await session.distill({ title: '为什么需要位置编码', text: MATERIAL })
    if (!outcome.ok) throw new Error(outcome.refusal.message)
    const describe = (suggestion: Suggestion): string =>
      describeSuggestion(suggestion, outcome.suggestions)
    steps.push({
      title: `2 · Distilled ${outcome.episodes} episodes into ${outcome.suggestions.length} suggestions`,
      lines: outcome.suggestions.map(
        (suggestion) => `${describe(suggestion)}\n      ← 「${suggestion.origin?.excerpt ?? ''}」`,
      ),
    })
    steps.push({
      title: '3 · Nothing is recorded yet',
      lines: [
        `${session.listNodes().length} nodes, ${session.eventCount} recorded changes of understanding`,
      ],
    })

    const byLabel = (label: string) =>
      outcome.suggestions.find(
        (suggestion) => 'label' in suggestion.proposal && suggestion.proposal.label === label,
      )
    const firstOf = (kind: string, predicate: (suggestion: Suggestion) => boolean = () => true) =>
      outcome.suggestions.find(
        (suggestion) => suggestion.proposal.kind === kind && predicate(suggestion),
      )
    const decisions: string[] = []
    const decide = async (
      suggestion: Suggestion | undefined,
      decision: Parameters<LearnSession['decide']>[1],
      what: string,
    ): Promise<void> => {
      if (suggestion === undefined) throw new Error(`nothing to decide for ${what}`)
      const result = await session.decide(suggestion.id, decision, 'learn-review')
      decisions.push(`${what}: ${result.ok ? result.outcome : `refused (${result.refusal.code})`}`)
    }

    const answers = firstOf(
      'link',
      (suggestion) =>
        suggestion.proposal.kind === 'link' && suggestion.proposal.relation === 'answers',
    )
    await decide(
      answers,
      { action: 'accept' },
      'accept "the claim answers the question" before either exists',
    )
    await decide(
      byLabel('为什么 Transformer 需要位置编码？'),
      { action: 'accept' },
      'accept the question',
    )
    await decide(
      byLabel('因为自注意力本身不区分词的顺序。'),
      { action: 'accept' },
      'accept the claim',
    )
    await decide(answers, { action: 'accept' }, 'accept "the claim answers the question"')
    const understood = firstOf('state', (suggestion) => suggestion.origin?.excerpt === '我明白了。')
    await decide(
      understood,
      { action: 'accept' },
      'accept "you now understand it" (confidence medium)',
    )
    const evidence = byLabel('例如把句子里的词打乱，注意力的输出只是跟着重新排列。')
    await decide(evidence, { action: 'dismiss' }, 'dismiss the example')
    const supports = firstOf(
      'link',
      (suggestion) =>
        suggestion.proposal.kind === 'link' && suggestion.proposal.relation === 'supports',
    )
    await decide(supports, { action: 'accept' }, 'accept "the example supports the claim"')
    await decide(
      byLabel('它把位置编码成向量的旋转，所以两个词的相对位置会体现在点积里。'),
      {
        action: 'modify',
        proposal: {
          kind: 'node',
          nodeType: 'claim',
          label: 'RoPE 用旋转表示位置，相对位置进入点积',
        },
      },
      'put the RoPE claim in your own words',
    )
    steps.push({ title: '4 · The learner decides', lines: decisions })

    await session.close()
    session = await LearnSession.open({ filePath })
    const kept = session.graph
      .listNodes()
      .filter((node) => typeof node.properties['suggestion'] === 'string')
      .map((node) => {
        const origin = node.properties['origin'] as { excerpt?: string } | undefined
        return `${node.id} (${node.type}) 「${node.label}」 ← 「${origin?.excerpt ?? ''}」`
      })
    const events = session.graph
      .listNodes()
      .flatMap((node) => session.log.history({ target: node.id, actorId: session.actorId }))
      .flatMap((event) =>
        [...event.dimensions].map(
          ([dimension, value]) =>
            `${event.target}: ${dimension}=${value.level} (${value.authority ?? 'author'}${value.confirmedBy === undefined ? '' : ` by ${value.confirmedBy}`})`,
        ),
      )
    const edges = session.graph
      .listEdges()
      .filter((edge) => edge.source?.startsWith('suggestion') === true)
      .map((edge) => `${edge.from} —${edge.type}→ ${edge.to}`)
    steps.push({
      title: '5 · After a restart: only what was decided',
      lines: [
        ...kept,
        ...edges,
        ...events,
        `${session.pendingSuggestions().length} suggestions still wait; the example was never recorded`,
      ],
    })
    const result = {
      steps,
      suggested: outcome.suggestions.length,
      accepted: kept.length + edges.length + events.length,
      eventsAfter: session.eventCount,
    }
    await session.close()
    return result
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function describeSuggestion(suggestion: Suggestion, all: readonly Suggestion[]): string {
  const name = (end: string): string => {
    if (!end.startsWith('cand:')) return end
    const named = all.find((candidate) => candidate.id === end.slice(5))?.proposal
    return named !== undefined && 'label' in named ? `「${named.label}」` : end
  }
  const proposal = suggestion.proposal
  switch (proposal.kind) {
    case 'node':
      return `${proposal.nodeType.padEnd(8)} 「${proposal.label}」`
    case 'claim':
      return `claim    「${proposal.label}」`
    case 'link':
      return `${proposal.relation.padEnd(8)} ${name(proposal.from)} → ${name(proposal.to)}`
    case 'state':
      return `state    ${name(proposal.target)}: ${proposal.dimension}=${proposal.level}`
  }
}

export function formatDistillDemo(result: DistillDemoResult): string {
  return result.steps
    .map((step) => `${step.title}\n${step.lines.map((line) => `  ${line}`).join('\n')}`)
    .join('\n\n')
}
