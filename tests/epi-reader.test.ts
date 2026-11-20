import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EpiFileError } from '@episteme/epi-format'
import { exportEpiFile } from '@episteme/storage-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILD, NOW, PACKS, forkAndRevoke, learningGraph } from './epi-fixtures.js'
import { openEpi } from '@episteme/epi-reader'

/**
 * The lightweight reader (G3): an independent consumer reads an `.epi` file without Core, a service
 * or a Domain Pack. The fixture is built through the full stack — that is the *setup*, the only
 * legitimate use of the heavy packages — and everything the tests assert comes out of the reader
 * alone.
 */
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-epi-reader-'))
})

afterEach(async () => {
  // The temp graph and .epi files carry no real data; each test built its own.
  await import('node:fs/promises').then((fs) => fs.rm(directory, { recursive: true, force: true }))
})

describe('a lightweight reader over a .epi knowledge file', () => {
  it('answers what the knowledge is: concepts, claims, typed relations and the conflict', async () => {
    const graph = join(directory, 'graph.db')
    await learningGraph(graph)
    await forkAndRevoke(graph)
    const file = join(directory, 'graph.epi')
    await exportEpiFile(graph, file, { build: BUILD, packs: PACKS, now: NOW })

    const epi = openEpi(await readFile(file, 'utf8'))
    // The file says what it is and what it can do.
    expect(epi.format).toBe('episteme-knowledge')
    expect(epi.version).toBe(2)
    expect(epi.profiles).toEqual(['archive', 'knowledge'])
    expect(epi.restorable).toBe(true)

    // The knowledge itself, in the file's own vocabulary.
    const claims = epi.nodesByType('claim').map((node) => node.id)
    expect(claims).toContain('k_position')
    expect(claims).toContain('k_nope')
    expect(epi.nodesByType('concept').map((node) => node.id)).toEqual(['c_transformer'])
    const claim = epi.node('k_position')
    expect(claim?.text).toBe('Attention needs position information')
    // The reasoning is typed, not prose: the NoPE claim contradicts the position claim.
    const contradicts = epi.edges().filter((edge) => edge.type === 'contradicts')
    expect(contradicts).toHaveLength(1)
    expect(contradicts[0]).toMatchObject({ from: 'k_nope', to: 'k_position' })
    const answers = epi.relationsOf('k_position').map((edge) => `${edge.type}:${edge.to}`)
    expect(answers).toContain('answers:q_position')
  })

  it('reads the ontology manifest without running any pack code', async () => {
    const graph = join(directory, 'graph.db')
    await learningGraph(graph)
    const file = join(directory, 'graph.epi')
    await exportEpiFile(graph, file, { build: BUILD, packs: PACKS, now: NOW })

    const epi = openEpi(await readFile(file, 'utf8'))
    expect(epi.ontology?.packs.map((pack) => pack.name)).toEqual([
      'episteme-application',
      'test-pack',
    ])
    const dimensionIds = epi.dimensions().map((dimension) => dimension.id)
    expect(dimensionIds).toContain('confidence')
    expect(dimensionIds).toContain('conflict')
    const edgeTypeIds = epi.edgeTypes().map((type) => type.id)
    expect(edgeTypeIds).toContain('contradicts')
    expect(edgeTypeIds).toContain('answers')
  })

  it('tells who understands what, at which confidence, and where the conflict stands', async () => {
    const graph = join(directory, 'graph.db')
    await learningGraph(graph)
    await forkAndRevoke(graph)
    const file = join(directory, 'graph.epi')
    await exportEpiFile(graph, file, { build: BUILD, packs: PACKS, now: NOW })

    const epi = openEpi(await readFile(file, 'utf8'))
    expect(epi.actors()).toEqual(['actor_human'])
    const understanding = epi.stateOf('k_position')
    expect(understanding).toHaveLength(1)
    expect(understanding[0]).toMatchObject({
      target: 'k_position',
      actor: 'actor_human',
      dimensions: { confidence: { level: 'low' }, conflict: { level: 'open' } },
    })
  })

  it('surfaces the revision thread: what changed, why, and what was retracted', async () => {
    const graph = join(directory, 'graph.db')
    await learningGraph(graph)
    await forkAndRevoke(graph)
    const file = join(directory, 'graph.epi')
    await exportEpiFile(graph, file, { build: BUILD, packs: PACKS, now: NOW })

    const epi = openEpi(await readFile(file, 'utf8'))
    const thread = epi.historyOf('k_position')
    // Four recorded readings, in commit order, each with its stated reason: the session's three and
    // the fork's divergent reading.
    expect(thread.map((clue) => clue.reason)).toEqual([
      'first reading',
      'worked the rope example by hand',
      'the NoPE result',
      'the NoPE result made me doubt the rope example',
    ])
    expect(
      thread.map((clue) => clue.dimensions.confidence ?? clue.dimensions.conflict),
    ).toContainEqual(expect.objectContaining({ level: 'high' }))
    // One fork, cut from the first recorded reading; its stated reason lives on the fork's event.
    const branches = epi.branches()
    const fork = branches.find((branch) => branch.parentBranchId !== undefined)
    expect(fork?.forkPoint).toBe(thread[0]?.eventId)
    expect(thread[3]?.reason).toBe('the NoPE result made me doubt the rope example')
    // The retracted 'high' reading is marked, and stays readable — revocation is not deletion.
    expect(thread.filter((clue) => clue.revoked)).toHaveLength(1)
    expect(thread.find((clue) => clue.revoked)?.dimensions).toMatchObject({
      confidence: { level: 'high' },
    })
  })

  it('traverses a subgraph from one claim', async () => {
    const graph = join(directory, 'graph.db')
    await learningGraph(graph)
    const file = join(directory, 'graph.epi')
    await exportEpiFile(graph, file, { build: BUILD, packs: PACKS, now: NOW })

    const epi = openEpi(await readFile(file, 'utf8'))
    const subgraph = epi.subgraphFrom('k_position', 2)
    expect(subgraph.nodes.map((node) => node.id)).toEqual([
      'k_position',
      'q_position',
      'k_nope',
      'c_transformer',
    ])
    expect(subgraph.edges).toHaveLength(3)
    // An unknown root yields an empty closure, not an error.
    expect(epi.subgraphFrom('nope', 2)).toEqual({ nodes: [], edges: [] })
  })

  it('names what a reader may reuse: the publication', async () => {
    const graph = join(directory, 'graph.db')
    await learningGraph(graph, { publish: true })
    const file = join(directory, 'graph.epi')
    await exportEpiFile(graph, file, { build: BUILD, packs: PACKS, now: NOW })

    const epi = openEpi(await readFile(file, 'utf8'))
    const publications = epi.publications() as {
      root?: string
      members?: string[]
    }[]
    expect(publications).toHaveLength(1)
    expect(publications[0]?.root).toBe('k_position')
    expect(publications[0]?.members).toEqual(
      expect.arrayContaining(['k_position', 'q_position', 'c_transformer']),
    )
  })

  it('refuses a damaged file with a typed error, and knows a knowledge-only file is not restorable', async () => {
    const graph = join(directory, 'graph.db')
    await learningGraph(graph)
    const file = join(directory, 'graph.epi')
    await exportEpiFile(graph, file, { build: BUILD, packs: PACKS, now: NOW })

    const full = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    // A knowledge-only file: readable, honest about not being restorable.
    const knowledgeOnly = { ...full, profiles: ['knowledge'], archive: undefined }
    const readable = openEpi(JSON.stringify(knowledgeOnly))
    expect(readable.restorable).toBe(false)
    expect(readable.historyOf('k_position')).toEqual([])

    // A tampered knowledge section is refused, not trusted.
    const tampered = { ...full, knowledge: { ...(full.knowledge as object), sha256: '00' } }
    expect(() => openEpi(JSON.stringify(tampered))).toThrow(EpiFileError)
    try {
      openEpi(JSON.stringify(tampered))
      expect.unreachable()
    } catch (error) {
      expect((error as EpiFileError).code).toBe('damaged')
    }
    // Not JSON at all is refused before anything else.
    expect(() => openEpi('this is not a knowledge file')).toThrow(EpiFileError)
  })

  it('verifyIntegrity re-checks the checksums the file carries', async () => {
    const graph = join(directory, 'graph.db')
    await learningGraph(graph)
    const file = join(directory, 'graph.epi')
    await exportEpiFile(graph, file, { build: BUILD, packs: PACKS, now: NOW })

    const epi = openEpi(await readFile(file, 'utf8'))
    expect(() => epi.verifyIntegrity()).not.toThrow()
  })
})
