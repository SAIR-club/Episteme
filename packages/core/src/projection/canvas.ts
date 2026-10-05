import type { CoreGraph } from '../graph/graph.js'
import type { SubGraph, GraphNode, GraphEdge } from '../ontology/resources.js'
import type { Registries } from '../graph/registries.js'

/**
 * Open JSON Canvas Specification 1.0 (https://jsoncanvas.org/spec/1.0/)
 *
 * Provides a universal, tool-agnostic export for graph visualization tools (such as Obsidian Canvas).
 * Core remains 100% headless, exporting pure topological canvas data with computed layout positions.
 */

export interface JsonCanvasNode {
  readonly id: string
  readonly type: 'text' | 'file' | 'link' | 'group'
  readonly text?: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly color?: string
}

export interface JsonCanvasEdge {
  readonly id: string
  readonly fromNode: string
  readonly toNode: string
  readonly fromSide?: 'top' | 'right' | 'bottom' | 'left'
  readonly toSide?: 'top' | 'right' | 'bottom' | 'left'
  readonly label?: string
  readonly color?: string
}

export interface JsonCanvas {
  readonly nodes: readonly JsonCanvasNode[]
  readonly edges: readonly JsonCanvasEdge[]
}

export interface CanvasLayoutOptions {
  /** Layout algorithm: 'grid' (default) or 'circle'. */
  readonly layout?: 'grid' | 'circle'
  readonly nodeWidth?: number
  readonly nodeHeight?: number
  readonly spacingX?: number
  readonly spacingY?: number
  readonly circleRadius?: number
  readonly registries?: Registries
}

/** Color palette for standard edge categories in canvas view. */
const CATEGORY_COLORS: Record<string, string> = {
  epistemic: '#38bdf8', // Light blue (justification & truth)
  structural: '#a855f7', // Purple (hierarchy & dependency)
  provenance: '#f59e0b', // Amber (derivation & inquiry)
  identity: '#10b981', // Emerald (equivalence)
}

function extractNodesAndEdges(graph: SubGraph | CoreGraph): {
  nodes: readonly GraphNode[]
  edges: readonly GraphEdge[]
} {
  if ('nodes' in graph && 'edges' in graph) {
    return { nodes: graph.nodes, edges: graph.edges }
  }
  return { nodes: graph.listNodes(), edges: graph.listEdges() }
}

/**
 * Exports a graph or subgraph to the standard JSON Canvas 1.0 format with deterministic layout coordinates.
 */
export function exportJsonCanvas(
  graph: SubGraph | CoreGraph,
  options: CanvasLayoutOptions = {},
): JsonCanvas {
  const { nodes, edges } = extractNodesAndEdges(graph)
  const width = options.nodeWidth ?? 260
  const height = options.nodeHeight ?? 140
  const spacingX = options.spacingX ?? 80
  const spacingY = options.spacingY ?? 80
  const layout = options.layout ?? 'grid'
  const registries = options.registries

  const canvasNodes: JsonCanvasNode[] = []

  if (layout === 'circle') {
    const count = nodes.length
    const radius = options.circleRadius ?? Math.max(300, count * 60)
    for (let i = 0; i < count; i++) {
      const node = nodes[i]!
      const angle = (2 * Math.PI * i) / Math.max(1, count)
      const x = Math.round(radius * Math.cos(angle))
      const y = Math.round(radius * Math.sin(angle))
      canvasNodes.push({
        id: String(node.id),
        type: 'text',
        text: `### ${node.label}\n\n*Type: ${String(node.type)}*`,
        x,
        y,
        width,
        height,
      })
    }
  } else {
    // Grid layout: arranged in columns based on square root of count
    const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)))
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = col * (width + spacingX)
      const y = row * (height + spacingY)
      canvasNodes.push({
        id: String(node.id),
        type: 'text',
        text: `### ${node.label}\n\n*Type: ${String(node.type)}*`,
        x,
        y,
        width,
        height,
      })
    }
  }

  const canvasEdges: JsonCanvasEdge[] = edges.map((edge) => {
    const category = registries?.edgeTypes.find(String(edge.type))?.category ?? 'structural'
    return {
      id: String(edge.id),
      fromNode: String(edge.from),
      toNode: String(edge.to),
      label: String(edge.type),
      color: CATEGORY_COLORS[category] ?? '#94a3b8',
    }
  })

  return { nodes: canvasNodes, edges: canvasEdges }
}

/**
 * Standard pure-topology representation for external graph engines (e.g. D3, Cytoscape, WebGL).
 */
export interface GraphTopology {
  readonly nodes: readonly {
    readonly id: string
    readonly label: string
    readonly type: string
    readonly properties: Readonly<Record<string, unknown>>
  }[]
  readonly edges: readonly {
    readonly id: string
    readonly from: string
    readonly to: string
    readonly type: string
    readonly category?: string
  }[]
}

/**
 * Exports a graph to a pure headless topology adjacency list without layout assumptions.
 */
export function exportTopology(
  graph: SubGraph | CoreGraph,
  options?: { registries?: Registries },
): GraphTopology {
  const { nodes, edges } = extractNodesAndEdges(graph)
  const registries = options?.registries

  return {
    nodes: nodes.map((n) => ({
      id: String(n.id),
      label: n.label,
      type: String(n.type),
      properties: n.properties,
    })),
    edges: edges.map((e) => {
      const category = registries?.edgeTypes.find(String(e.type))?.category
      return {
        id: String(e.id),
        from: String(e.from),
        to: String(e.to),
        type: String(e.type),
        ...(category !== undefined ? { category } : {}),
      }
    }),
  }
}
