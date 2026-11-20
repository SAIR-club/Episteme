import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CognitiveSession } from '@episteme/application'
import { asId, createFixedClock, defineDomainPack, type EdgeTypeId } from '@episteme/core'
import { openEpi } from '@episteme/epi-reader'
import { openEpisteme } from '@episteme/sdk'
import { exportEpiFile, openSqliteStorage } from '@episteme/storage-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PACKS } from './epi-fixtures.js'
import { testScene } from './test-scene.js'

/**
 * The end-to-end cognitive case (G5): real, checkable material — why Transformers need positional
 * encodings (Vaswani et al. 2017's permutation-invariance argument) and the NoPE finding that
 * decoder-only models without explicit positional encodings still learn position (Haviv et al.
 * 2022) — carried from distillation through human review into an understanding that is then
 * genuinely revised, exported, and read back by the independent reader, which must be able to
 * answer how it was first understood, why it changed, what supports the new reading, what stays
 * contested, who proposed it, and what another person may reuse.
 *
 * Distiller capability, recorded honestly: from the NoPE dialogue the rule-based distiller
 * suggested the two claims but no `contradicts` link, no `supports` link to the earlier
 * understanding, and no revision link — a learner seeing conflict between materials is beyond it
 * today. Those three links are the human review step, through the session's ordinary paths; the
 * test asserts the final structure, not a distiller capability the distiller does not have.
 */
const MATERIAL_1 = [
  '[00:05] 学生：为什么 Transformer 需要位置编码？',
  '[00:12] 老师：因为自注意力本身不区分词的顺序。例如把句子里的词打乱，注意力的输出只是跟着重新排列。',
  '[00:40] 学生：我明白了。',
].join('\n')

const MATERIAL_2 = [
  '[05:00] 学生：我读到 Haviv 等人 2022 年的论文，完全去掉位置编码的 decoder-only 语言模型仍然有效。',
  '[05:20] 老师：这就是 NoPE 的发现：没有显式位置编码，模型仍能学到位置信息。',
  '[05:45] 老师：一个解释是因果注意力掩码：每个词只能看到前面的词，所以模型可以按位置区分它们。',
  '[06:10] 学生：这和我原来的理解矛盾——位置编码看起来是必须的，现在看是可选的。',
].join('\n')

const QUESTION = '为什么 Transformer 需要位置编码？'
const OLD_CLAIM = '因为自注意力本身不区分词的顺序。'
const EVIDENCE_1 = '例如把句子里的词打乱，注意力的输出只是跟着重新排列。'
const CAUSAL_CLAIM =
  '一个解释是因果注意力掩码：每个词只能看到前面的词，所以模型可以按位置区分它们。'
const NEW_CLAIM = '这和我原来的理解矛盾——位置编码看起来是必须的，现在看是可选的。'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-epi-e2e-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('from material to an exported understanding a reader can reuse', () => {
  it('carries a real understanding through distillation, review, revision, export and an independent read-back', async () => {
    // ── Material → distillation → human review: the initial understanding ──
    const graph = join(directory, 'case.db')
    const session = await CognitiveSession.open({
      filePath: graph,
      sharing: true,
      scene: testScene,
    })
    const first = await session.distill(
      { title: '位置编码', text: MATERIAL_1 },
      { requestedBy: 'actor_agent_test-host' },
    )
    if (!first.ok) throw new Error(first.refusal.message)
    for (const suggestion of first.suggestions) {
      const decided = await session.decide(suggestion.id, { action: 'accept' }, 'review')
      expect(decided.ok).toBe(true)
    }
    const byLabel = (label: string) => session.listNodes().find((node) => node.label === label)
    const question = byLabel(QUESTION)
    const oldClaim = byLabel(OLD_CLAIM)
    const evidence1 = byLabel(EVIDENCE_1)
    expect([question?.nodeId, oldClaim?.nodeId, evidence1?.nodeId]).not.toContain(undefined)

    // The learner's own readings: medium after the first pass, high after working the example.
    await session.record(oldClaim!.nodeId, { confidence: 'medium' }, { reason: 'first reading' })
    await session.record(
      oldClaim!.nodeId,
      { confidence: 'high' },
      { reason: 'worked the scrambled-words example by hand' },
    )

    // ── The genuine conflict: the NoPE finding contradicts the old claim ──
    const second = await session.distill(
      { title: 'NoPE：没有位置编码的语言模型', text: MATERIAL_2 },
      { requestedBy: 'actor_agent_test-host' },
    )
    if (!second.ok) throw new Error(second.refusal.message)
    // Recorded honestly, not asserted away: the distiller did not see the contradiction.
    expect(
      second.suggestions.some(
        (suggestion) =>
          suggestion.proposal.kind === 'link' && suggestion.proposal.relation === 'contradicts',
      ),
    ).toBe(false)
    for (const suggestion of second.suggestions) {
      const decided = await session.decide(suggestion.id, { action: 'accept' }, 'review')
      expect(decided.ok).toBe(true)
    }
    const causalClaim = byLabel(CAUSAL_CLAIM)
    const newClaim = byLabel(NEW_CLAIM)
    expect([causalClaim?.nodeId, newClaim?.nodeId]).not.toContain(undefined)

    // Human review fills what the distiller could not reach, through the session's ordinary paths.
    await session.link(newClaim!.nodeId, oldClaim!.nodeId, asId<EdgeTypeId>('contradicts'))
    await session.link(causalClaim!.nodeId, newClaim!.nodeId, asId<EdgeTypeId>('supports'))
    await session.link(oldClaim!.nodeId, newClaim!.nodeId, asId<EdgeTypeId>('evolves_to'))
    await session.record(oldClaim!.nodeId, { conflict: 'open' }, { reason: 'the NoPE finding' })
    await session.close()

    // ── The revision: a fork from the first reading, and the old high reading retracted ──
    const storage = await openSqliteStorage(graph)
    let forkedFrom: string
    try {
      const episteme = await openEpisteme(storage, {
        packs: PACKS.map((pack) => defineDomainPack(pack.name, pack.definitions)),
        clock: createFixedClock(0),
      })
      const lineage = episteme.log.history({
        target: asId(oldClaim!.nodeId),
        actorId: asId('actor_human'),
      })
      expect(lineage.length).toBe(3)
      forkedFrom = lineage[0]!.id
      episteme.log.fork({
        from: lineage[0]!.id,
        target: asId(oldClaim!.nodeId),
        actorId: asId('actor_human'),
        dimensions: new Map([[asId('confidence'), { level: 'low' }]]),
        reason: 'the NoPE finding made me re-examine the old claim',
      })
      episteme.log.revokeStateEvent(lineage[1]!.id, { reason: 'the NoPE finding' })
      await episteme.persist()
    } finally {
      await storage.close()
    }

    // ── Share what is safe: publish the revised understanding with its evidence ──
    const sharing = await CognitiveSession.open({
      filePath: graph,
      sharing: true,
      scene: testScene,
    })
    const published = await sharing.publish({
      root: newClaim!.nodeId,
      include: [oldClaim!.nodeId, causalClaim!.nodeId, question!.nodeId, evidence1!.nodeId],
    })
    if (!published.ok) throw new Error(JSON.stringify(published.refusal))
    await sharing.close()

    // ── Export, and answer the six questions through the independent reader ──
    const file = join(directory, 'case.epi')
    await exportEpiFile(graph, file, {
      build: 'goal-mode-e2e',
      packs: PACKS,
      now: () => new Date(0),
    })
    const epi = openEpi(await readFile(file, 'utf8'))
    epi.verifyIntegrity()
    const oldId = oldClaim!.nodeId
    const newId = newClaim!.nodeId

    // Q1: how was it first understood? The medium first reading, still visible in order.
    const thread = epi.historyOf(oldId)
    expect(thread[0]).toMatchObject({
      dimensions: { confidence: { level: 'medium' } },
      reason: 'first reading',
      revoked: false,
    })
    // Q2: why was it revised? The fork names the NoPE finding; the high reading carries the
    // revocation's stated reason on the clue.
    const fork = epi.branches().find((branch) => branch.parentBranchId !== undefined)
    expect(fork?.forkPoint).toBe(thread[0]?.eventId)
    const retracted = thread.find((clue) => clue.revoked)
    expect(retracted).toMatchObject({
      reason: 'worked the scrambled-words example by hand',
      revocationReason: 'the NoPE finding',
    })
    const forkEvent = thread.find(
      (clue) => clue.reason === 'the NoPE finding made me re-examine the old claim',
    )
    expect(forkEvent).toMatchObject({ dimensions: { confidence: { level: 'low' } } })
    // Q3: what supports the new understanding? The causal-mask claim supports it, and it evolves
    // from the old one — typed relations, not prose.
    const intoNew = epi
      .edges()
      .filter((edge) => edge.to === newId)
      .map((edge) => edge.type)
    expect(intoNew).toContain('supports')
    expect(intoNew).toContain('evolves_to')
    expect(epi.edges().some((edge) => edge.type === 'contradicts')).toBe(true)
    // Q4: what stays contested? The old claim's conflict is still open, with the contradiction live.
    const contested = epi.stateOf(oldId)
    expect(contested[0]?.dimensions).toMatchObject({ conflict: { level: 'open' } })
    // Q5: who proposed it? The human actor, and the suggestions came from the distiller agent.
    expect(epi.actors()).toEqual(['actor_human'])
    // Q6: what may another reader reuse? The published members, by stable id, in the reader.
    const publications = epi.publications() as { root?: string; members?: string[] }[]
    expect(publications[0]?.root).toBe(newId)
    expect(publications[0]?.members).toEqual(
      expect.arrayContaining([oldId, newId, causalClaim?.nodeId]),
    )
    // The fork lineage stays traceable: the archive carries where the new reading was cut from.
    expect(forkedFrom).toBe(thread[0]?.eventId)
  })
})
