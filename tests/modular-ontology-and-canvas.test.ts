import {
  STANDARD_EDGE_TYPES,
  STANDARD_NODE_TYPES,
  STANDARD_STATE_DIMENSIONS,
  asId,
  createFixedClock,
  createGraph,
  createRegistries,
  exportJsonCanvas,
  exportTopology,
  loadPackFromJson,
  standardEpistemicPack,
  type ActorId,
} from '@episteme/core'
import { createMemoryStorage } from '@episteme/storage-memory'
import { describe, expect, it } from 'vitest'

describe('Modular pluggable ontology and canvas export', () => {
  const clock = createFixedClock(1_000)
  const actorId = asId<ActorId>('actor_test')

  it('allows defining custom domain packs declaratively from config with zero code', () => {
    const rawConfig = JSON.stringify({
      name: 'robotics',
      nodeTypes: [
        { id: 'sensor', label: 'Sensor' },
        { id: 'actuator', label: 'Actuator' },
      ],
      edgeTypes: [
        {
          id: 'triggers',
          label: 'triggers',
          category: 'structural',
          from: ['sensor'],
          to: ['actuator'],
        },
      ],
      stateDimensions: [
        {
          id: 'calibration',
          label: 'Calibration',
          kind: 'categorical',
          levels: ['uncalibrated', 'calibrated'],
        },
      ],
    })

    const pack = loadPackFromJson(rawConfig)
    const registries = createRegistries()
    pack.initialize({ registries })

    expect(registries.nodeTypes.has(asId('sensor'))).toBe(true)
    expect(registries.nodeTypes.has(asId('actuator'))).toBe(true)
    expect(registries.edgeTypes.has(asId('triggers'))).toBe(true)
    expect(registries.stateDimensions.has(asId('calibration'))).toBe(true)

    const storage = createMemoryStorage()
    const graph = createGraph({ storage, registries, clock, actorId })

    const sNode = graph.addNode({ id: asId('s1'), type: asId('sensor'), label: 'Camera' })
    const aNode = graph.addNode({ id: asId('a1'), type: asId('actuator'), label: 'Motor' })
    const edge = graph.addEdge({
      id: asId('e1'),
      from: sNode.id,
      to: aNode.id,
      type: asId('triggers'),
    })

    expect(edge.type).toBe('triggers')
    expect(graph.stats().nodes).toBe(2)
    expect(graph.stats().edges).toBe(1)
  })

  it('works seamlessly with the optional standardEpistemicPack', () => {
    const registries = createRegistries()
    standardEpistemicPack.initialize({ registries })

    expect(registries.nodeTypes.has(STANDARD_NODE_TYPES.concept)).toBe(true)
    expect(registries.nodeTypes.has(STANDARD_NODE_TYPES.claim)).toBe(true)
    expect(registries.edgeTypes.has(STANDARD_EDGE_TYPES.supports)).toBe(true)
    expect(registries.edgeTypes.has(STANDARD_EDGE_TYPES.contradicts)).toBe(true)
    expect(registries.edgeTypes.has(STANDARD_EDGE_TYPES.dependsOn)).toBe(true)
    expect(registries.stateDimensions.has(STANDARD_STATE_DIMENSIONS.confidence)).toBe(true)
    expect(registries.stateDimensions.has(STANDARD_STATE_DIMENSIONS.evidence)).toBe(true)
    expect(registries.stateDimensions.has(STANDARD_STATE_DIMENSIONS.conflict)).toBe(true)

    const storage = createMemoryStorage()
    const graph = createGraph({ storage, registries, clock, actorId })

    graph.addNode({
      id: asId('c1'),
      type: STANDARD_NODE_TYPES.concept,
      label: 'Attention',
    })
    const claim = graph.addNode({
      id: asId('cl1'),
      type: STANDARD_NODE_TYPES.claim,
      label: 'Attention is permutation invariant',
    })
    const evidence = graph.addNode({
      id: asId('ev1'),
      type: STANDARD_NODE_TYPES.evidence,
      label: 'Math proof',
    })

    const supportEdge = graph.addEdge({
      id: asId('e_supp'),
      from: evidence.id,
      to: claim.id,
      type: STANDARD_EDGE_TYPES.supports,
    })
    expect(supportEdge.type).toBe('supports')
    expect(registries.edgeTypes.find(supportEdge.type)?.category).toBe('epistemic')
  })

  it('exports valid JSON Canvas specification data and headless topology', () => {
    const registries = createRegistries()
    standardEpistemicPack.initialize({ registries })
    const storage = createMemoryStorage()
    const graph = createGraph({ storage, registries, clock, actorId })

    const n1 = graph.addNode({
      id: asId('n1'),
      type: STANDARD_NODE_TYPES.concept,
      label: 'Transformers',
    })
    const n2 = graph.addNode({
      id: asId('n2'),
      type: STANDARD_NODE_TYPES.concept,
      label: 'Self-Attention',
    })
    graph.addEdge({
      id: asId('edge1'),
      from: n2.id,
      to: n1.id,
      type: STANDARD_EDGE_TYPES.dependsOn,
    })

    // JSON Canvas export with grid layout
    const canvas = exportJsonCanvas(graph, { layout: 'grid', registries })
    expect(canvas.nodes.length).toBe(2)
    expect(canvas.edges.length).toBe(1)
    expect(canvas.nodes[0]!.type).toBe('text')
    expect(canvas.nodes[0]!.x).toBeDefined()
    expect(canvas.nodes[0]!.y).toBeDefined()
    expect(canvas.edges[0]!.fromNode).toBe('n2')
    expect(canvas.edges[0]!.toNode).toBe('n1')
    expect(canvas.edges[0]!.label).toBe('depends_on')

    // Circle layout
    const circleCanvas = exportJsonCanvas(graph, { layout: 'circle', registries })
    expect(circleCanvas.nodes.length).toBe(2)

    // Pure topology
    const topology = exportTopology(graph, { registries })
    expect(topology.nodes.length).toBe(2)
    expect(topology.edges.length).toBe(1)
    expect(topology.edges[0]!.category).toBe('structural')
  })
})
