// ============================================================================
// GRAPH LAYOUT ALGORITHMS
// ============================================================================
//
// Module: utils/graphLayout.ts
// Purpose: Force-directed and hierarchical layout algorithms for node positioning
//
// Transforms abstract graph topology into 2D coordinates for the prediction
// market node graph. Supports multiple layout strategies:
//   - Force-directed: Physics-simulation based (general purpose)
//   - Hierarchical: Layered top-down flow (sources -> analyzers -> markets)
//   - Circular: Radial arrangement (comparative analysis)
//   - Grid: Aligned rows/columns (structured dashboards)
//
// Architecture: Strategy Pattern with Simulation Loop
//   LayoutAlgorithm interface -> Concrete implementations
//   Coordinates use world space with origin (0,0) at viewport center
//
// Performance: Barnes-Hut approximation reduces O(n^2) to O(n log n)
//
// ============================================================================

import type { Node, Connection, Position } from '../types/nodes';

// =============================================================================
// CORE TYPES AND INTERFACES
// =============================================================================

/**
 * Layout algorithm type discriminator.
 */
export type LayoutType = 'force' | 'hierarchical' | 'circular' | 'grid' | 'custom';

/**
 * Generic layout algorithm interface.
 * 
 * All layout algorithms must implement this contract for
 * interoperability with the LayoutEngine.
 */
export interface LayoutAlgorithm {
  /** Algorithm identifier */
  readonly type: LayoutType;
  
  /** Human-readable name */
  readonly name: string;
  
  /** Execute layout calculation */
  execute(nodes: Node[], connections: Connection[], options: LayoutOptions): LayoutResult;
  
  /** Estimate computation cost (for UI feedback) */
  estimateComplexity(nodeCount: number, connectionCount: number): number;
}

/**
 * Layout calculation options.
 */
export interface LayoutOptions {
  /** Target bounding box (undefined = unbounded) */
  bounds?: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
  
  /** Ideal edge length in world units */
  idealEdgeLength?: number;
  
  /** Minimum node separation (collision avoidance) */
  minNodeDistance?: number;
  
  /** Node dimensions for collision detection */
  nodeDimensions?: { width: number; height: number };
  
  /** Fixed nodes that should not move (by ID) */
  fixedNodes?: Set<string>;
  
  /** Initial positions (for incremental layout) */
  initialPositions?: Map<string, Position>;
  
  /** Animation progress (0-1) for staged layout */
  animationProgress?: number;
  
  /** Random seed for deterministic layouts */
  seed?: number;
}

/**
 * Layout calculation result.
 */
export interface LayoutResult {
  /** Node ID → Position mapping */
  positions: Map<string, Position>;
  
  /** Edge routing points (for curved edges) */
  edgeRoutes?: Map<string, Position[]>;
  
  /** Algorithm metadata */
  meta: {
    /** Iterations executed */
    iterations: number;
    
    /** Final energy (movement magnitude) */
    finalEnergy: number;
    
    /** Computation time in milliseconds */
    computeTimeMs: number;
    
    /** Whether layout converged */
    converged: boolean;
  };
}

/**
 * Physics simulation configuration for force-directed layout.
 */
export interface ForceConfig {
  /** Repulsion constant (Coulomb's law) */
  repulsion: number;
  
  /** Spring constant (Hooke's law) */
  attraction: number;
  
  /** Ideal spring length */
  springLength: number;
  
  /** Centering gravity strength */
  gravity: number;
  
  /** Initial temperature (movement magnitude) */
  initialTemperature: number;
  
  /** Cooling rate per iteration (0-1) */
  coolingRate: number;
  
  /** Minimum temperature for termination */
  minTemperature: number;
  
  /** Maximum iterations */
  maxIterations: number;
  
  /** Energy threshold for early termination */
  energyThreshold: number;
  
  /** Barnes-Hut theta approximation threshold */
  barnesHutTheta: number;
  
  /** Use spatial acceleration (quadtree) */
  useSpatialIndex: boolean;
}

/**
 * Hierarchical layout configuration.
 */
export interface HierarchicalConfig {
  /** Layout direction */
  direction: 'TB' | 'BT' | 'LR' | 'RL';
  
  /** Layer assignment method */
  layering: 'longestPath' | 'coffmanGraham' | 'networkSimplex';
  
  /** Node ordering within layers */
  ordering: 'median' | 'barycenter' | 'greedySwitch';
  
  /** Coordinate assignment method */
  coordinateAssignment: 'brandesKoepf' | 'fast' | 'simple';
  
  /** Layer separation distance */
  layerSeparation: number;
  
  /** Node separation within layer */
  nodeSeparation: number;
  
  /** Whether to use orthogonal edge routing */
  orthogonalEdges: boolean;
}

/**
 * Circular layout configuration.
 */
export interface CircularConfig {
  /** Center point */
  center: Position;
  
  /** Radius (undefined = auto-calculate) */
  radius?: number;
  
  /** Start angle in radians (0 = right, PI/2 = up) */
  startAngle: number;
  
  /** Sweep direction: 1 = clockwise, -1 = counter-clockwise */
  direction: 1 | -1;
  
  /** Group nodes by type into sectors */
  groupByType: boolean;
  
  /** Gap between sectors in radians */
  sectorGap: number;
}

/**
 * Grid layout configuration.
 */
export interface GridConfig {
  /** Number of columns (undefined = auto sqrt) */
  columns?: number;
  
  /** Cell width */
  cellWidth: number;
  
  /** Cell height */
  cellHeight: number;
  
  /** Spacing between cells */
  spacing: number;
  
  /** Alignment within cells */
  align: 'center' | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
  
  /** Fill order: row-major or column-major */
  fillOrder: 'row' | 'column';
}

// =============================================================================
// DEFAULT CONFIGURATIONS
// =============================================================================

export const DEFAULT_FORCE_CONFIG: ForceConfig = {
  repulsion: 1000,
  attraction: 0.05,
  springLength: 150,
  gravity: 0.01,
  initialTemperature: 200,
  coolingRate: 0.95,
  minTemperature: 0.1,
  maxIterations: 300,
  energyThreshold: 0.01,
  barnesHutTheta: 0.5,
  useSpatialIndex: true,
};

export const DEFAULT_HIERARCHICAL_CONFIG: HierarchicalConfig = {
  direction: 'TB',
  layering: 'longestPath',
  ordering: 'barycenter',
  coordinateAssignment: 'brandesKoepf',
  layerSeparation: 150,
  nodeSeparation: 100,
  orthogonalEdges: false,
};

export const DEFAULT_CIRCULAR_CONFIG: CircularConfig = {
  center: [0, 0],
  startAngle: -Math.PI / 2, // Start at top
  direction: 1,
  groupByType: true,
  sectorGap: 0.2,
};

export const DEFAULT_GRID_CONFIG: GridConfig = {
  cellWidth: 150,
  cellHeight: 100,
  spacing: 50,
  align: 'center',
  fillOrder: 'row',
};

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Calculate Euclidean distance between two positions.
 */
function distance(a: Position, b: Position): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Calculate squared distance (faster, avoids sqrt).
 */
function distanceSquared(a: Position, b: Position): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/**
 * Normalize a vector to unit length.
 */
function normalize(v: Position): Position {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
  if (len === 0) return [0, 0];
  return [v[0] / len, v[1] / len];
}

/**
 * Scale a vector by a scalar.
 */
function scale(v: Position, s: number): Position {
  return [v[0] * s, v[1] * s];
}

/**
 * Seeded random number generator for deterministic layouts.
 */
function createSeededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = Math.sin(s * 12.9898 + 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
}

/**
 * Clamp value to range.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Linear interpolation between values.
 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Smooth step interpolation (ease in-out).
 */
function smoothStep(t: number): number {
  return t * t * (3 - 2 * t);
}

// =============================================================================
// SPATIAL INDEXING (QUADTREE)
// =============================================================================

/**
 * Bounding box for spatial queries.
 */
interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Quadtree node for Barnes-Hut approximation.
 */
class QuadtreeNode {
  bounds: BoundingBox;
  centerOfMass: Position = [0, 0];
  totalMass: number = 0;
  children: (QuadtreeNode | null)[] = [null, null, null, null];
  isLeaf: boolean = true;
  point: { position: Position; mass: number } | null = null;

  constructor(bounds: BoundingBox) {
    this.bounds = bounds;
  }

  insert(position: Position, mass: number = 1): void {
    if (this.isLeaf && this.point === null) {
      this.point = { position, mass };
      this.updateCenterOfMass();
      return;
    }

    if (this.isLeaf && this.point !== null) {
      this.subdivide();
      this.insertExisting(this.point);
      this.point = null;
    }

    this.insertIntoChildren(position, mass);
    this.updateCenterOfMass();
  }

  private subdivide(): void {
    const { minX, minY, maxX, maxY } = this.bounds;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    this.children = [
      new QuadtreeNode({ minX, minY, maxX: midX, maxY: midY }), // NW
      new QuadtreeNode({ minX: midX, minY, maxX, maxY: midY }), // NE
      new QuadtreeNode({ minX, minY: midY, maxX: midX, maxY }), // SW
      new QuadtreeNode({ minX: midX, minY: midY, maxX, maxY }), // SE
    ];

    this.isLeaf = false;
  }

  private insertExisting(point: { position: Position; mass: number }): void {
    this.insertIntoChildren(point.position, point.mass);
  }

  private insertIntoChildren(position: Position, mass: number): void {
    const { minX, minY, maxX, maxY } = this.bounds;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    const index = (position[0] < midX ? 0 : 1) + (position[1] < midY ? 0 : 2);
    this.children[index]!.insert(position, mass);
  }

  private updateCenterOfMass(): void {
    if (this.isLeaf && this.point) {
      this.centerOfMass = this.point.position;
      this.totalMass = this.point.mass;
    } else {
      let totalX = 0;
      let totalY = 0;
      let mass = 0;

      for (const child of this.children) {
        if (child) {
          totalX += child.centerOfMass[0] * child.totalMass;
          totalY += child.centerOfMass[1] * child.totalMass;
          mass += child.totalMass;
        }
      }

      this.totalMass = mass;
      this.centerOfMass = mass > 0 ? [totalX / mass, totalY / mass] : [0, 0];
    }
  }

  calculateForce(
    position: Position,
    theta: number,
    repulsion: number,
    callback: (force: Position) => void
  ): void {
    if (this.totalMass === 0) return;

    const dx = this.centerOfMass[0] - position[0];
    const dy = this.centerOfMass[1] - position[1];
    const distSq = dx * dx + dy * dy;

    if (distSq === 0) return;

    const dist = Math.sqrt(distSq);
    const width = this.bounds.maxX - this.bounds.minX;

    // Barnes-Hut criterion: s/d < theta
    if (this.isLeaf || (width / dist < theta)) {
      // Treat as single body
      const force = repulsion * this.totalMass / distSq;
      callback([-(dx / dist) * force, -(dy / dist) * force]);
    } else {
      // Recurse into children
      for (const child of this.children) {
        child?.calculateForce(position, theta, repulsion, callback);
      }
    }
  }
}

/**
 * Build quadtree from node positions.
 */
function buildQuadtree(positions: Position[]): QuadtreeNode {
  if (positions.length === 0) {
    return new QuadtreeNode({ minX: -1, minY: -1, maxX: 1, maxY: 1 });
  }

  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (const pos of positions) {
    minX = Math.min(minX, pos[0]);
    minY = Math.min(minY, pos[1]);
    maxX = Math.max(maxX, pos[0]);
    maxY = Math.max(maxY, pos[1]);
  }

  // Add padding
  const padding = Math.max(maxX - minX, maxY - minY) * 0.1 + 1;
  const bounds: BoundingBox = {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
  };

  const tree = new QuadtreeNode(bounds);
  for (const pos of positions) {
    tree.insert(pos);
  }

  return tree;
}

// =============================================================================
// FORCE-DIRECTED LAYOUT ALGORITHM
// =============================================================================

/**
 * Force-directed layout using physics simulation.
 * 
 * Implements Fruchterman-Reingold with Barnes-Hut optimization
 * for O(n log n) complexity.
 */
export class ForceDirectedLayout implements LayoutAlgorithm {
  readonly type: LayoutType = 'force';
  readonly name = 'Force-Directed';

  private config: ForceConfig;

  constructor(config: Partial<ForceConfig> = {}) {
    this.config = { ...DEFAULT_FORCE_CONFIG, ...config };
  }

  execute(
    nodes: Node[],
    connections: Connection[],
    options: LayoutOptions = {}
  ): LayoutResult {
    const startTime = performance.now();
    const positions = new Map<string, Position>();
    const velocities = new Map<string, Position>();
    const fixedNodes = options.fixedNodes || new Set();

    // Initialize positions
    const random = createSeededRandom(options.seed || Date.now());
    const initialPositions = options.initialPositions || new Map();

    for (const node of nodes) {
      if (initialPositions.has(node.id)) {
        positions.set(node.id, initialPositions.get(node.id)!);
      } else {
        // Random initial position in circle
        const angle = random() * Math.PI * 2;
        const radius = random() * 100 + 50;
        positions.set(node.id, [
          Math.cos(angle) * radius,
          Math.sin(angle) * radius,
        ]);
      }
      velocities.set(node.id, [0, 0]);
    }

    // Build connection index for fast lookup
    const connectionMap = new Map<string, Set<string>>();
    for (const conn of connections) {
      if (!connectionMap.has(conn.source)) {
        connectionMap.set(conn.source, new Set());
      }
      if (!connectionMap.has(conn.target)) {
        connectionMap.set(conn.target, new Set());
      }
      connectionMap.get(conn.source)!.add(conn.target);
      connectionMap.get(conn.target)!.add(conn.source);
    }

    // Simulation loop
    let temperature = this.config.initialTemperature;
    let energy = Infinity;
    let iteration = 0;

    while (
      iteration < this.config.maxIterations &&
      temperature > this.config.minTemperature &&
      energy > this.config.energyThreshold
    ) {
      energy = 0;

      // Build spatial index every 10 iterations
      const useBarnesHut = this.config.useSpatialIndex && iteration % 10 === 0;
      const quadtree = useBarnesHut
        ? buildQuadtree(Array.from(positions.values()))
        : null;

      // Calculate forces for each node
      for (const node of nodes) {
        if (fixedNodes.has(node.id)) continue;

        const pos = positions.get(node.id)!;
        let forceX = 0;
        let forceY = 0;

        // Repulsion forces
        if (quadtree) {
          quadtree.calculateForce(
            pos,
            this.config.barnesHutTheta,
            this.config.repulsion,
            (f) => {
              forceX += f[0];
              forceY += f[1];
            }
          );
        } else {
          // Brute force O(n²)
          for (const other of nodes) {
            if (other.id === node.id) continue;
            const otherPos = positions.get(other.id)!;
            const distSq = distanceSquared(pos, otherPos);
            if (distSq === 0) continue;

            const dist = Math.sqrt(distSq);
            const force = this.config.repulsion / distSq;
            const dx = pos[0] - otherPos[0];
            const dy = pos[1] - otherPos[1];

            forceX += (dx / dist) * force;
            forceY += (dy / dist) * force;
          }
        }

        // Attraction forces (springs)
        const neighbors = connectionMap.get(node.id);
        if (neighbors) {
          for (const neighborId of neighbors) {
            const neighborPos = positions.get(neighborId)!;
            const dist = distance(pos, neighborPos);
            const displacement = dist - this.config.springLength;
            const force = this.config.attraction * displacement;

            const dx = neighborPos[0] - pos[0];
            const dy = neighborPos[1] - pos[1];

            if (dist > 0) {
              forceX += (dx / dist) * force;
              forceY += (dy / dist) * force;
            }
          }
        }

        // Center gravity
        forceX -= pos[0] * this.config.gravity;
        forceY -= pos[1] * this.config.gravity;

        // Update velocity with damping
        let vel = velocities.get(node.id)!;
        vel[0] = (vel[0] + forceX) * 0.5; // Damping factor
        vel[1] = (vel[1] + forceY) * 0.5;

        // Limit velocity
        const speed = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1]);
        if (speed > temperature) {
          vel = scale(normalize(vel), temperature);
        }

        velocities.set(node.id, vel);

        // Update position
        const newPos: Position = [pos[0] + vel[0], pos[1] + vel[1]];
        positions.set(node.id, newPos);

        energy += speed;
      }

      // Cool down
      temperature *= this.config.coolingRate;
      iteration++;
    }

    // Apply constraints
    this.applyConstraints(positions, options);

    const computeTime = performance.now() - startTime;

    return {
      positions,
      meta: {
        iterations: iteration,
        finalEnergy: energy,
        computeTimeMs: computeTime,
        converged: energy <= this.config.energyThreshold,
      },
    };
  }

  private applyConstraints(
    positions: Map<string, Position>,
    options: LayoutOptions
  ): void {
    // Boundary constraints
    if (options.bounds) {
      const { minX, minY, maxX, maxY } = options.bounds;
      for (const [id, pos] of positions) {
        positions.set(id, [
          clamp(pos[0], minX, maxX),
          clamp(pos[1], minY, maxY),
        ]);
      }
    }

    // Minimum node distance
    if (options.minNodeDistance) {
      const minDist = options.minNodeDistance;
      const nodes = Array.from(positions.entries());

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const [id1, pos1] = nodes[i];
          const [id2, pos2] = nodes[j];
          const dist = distance(pos1, pos2);

          if (dist < minDist && dist > 0) {
            const overlap = minDist - dist;
            const dx = (pos2[0] - pos1[0]) / dist;
            const dy = (pos2[1] - pos1[1]) / dist;

            const move = overlap / 2;
            positions.set(id1, [pos1[0] - dx * move, pos1[1] - dy * move]);
            positions.set(id2, [pos2[0] + dx * move, pos2[1] + dy * move]);
          }
        }
      }
    }
  }

  estimateComplexity(nodeCount: number, _connectionCount: number): number {
    const barnesHutFactor = this.config.useSpatialIndex ? Math.log(nodeCount) : nodeCount;
    return nodeCount * barnesHutFactor * this.config.maxIterations;
  }
}

// =============================================================================
// HIERARCHICAL LAYOUT ALGORITHM
// =============================================================================

/**
 * Hierarchical layout for DAGs using Sugiyama framework.
 * 
 * Assigns nodes to layers, orders within layers, then assigns coordinates.
 * Optimized for top-down flow visualization (sources → markets).
 */
export class HierarchicalLayout implements LayoutAlgorithm {
  readonly type: LayoutType = 'hierarchical';
  readonly name = 'Hierarchical';

  private config: HierarchicalConfig;

  constructor(config: Partial<HierarchicalConfig> = {}) {
    this.config = { ...DEFAULT_HIERARCHICAL_CONFIG, ...config };
  }

  execute(
    nodes: Node[],
    connections: Connection[],
    options: LayoutOptions = {}
  ): LayoutResult {
    const startTime = performance.now();

    // Build adjacency lists
    const outgoing = new Map<string, Set<string>>();
    const incoming = new Map<string, Set<string>>();

    for (const node of nodes) {
      outgoing.set(node.id, new Set());
      incoming.set(node.id, new Set());
    }

    for (const conn of connections) {
      outgoing.get(conn.source)?.add(conn.target);
      incoming.get(conn.target)?.add(conn.source);
    }

    // 1. Layer assignment (longest path from sources)
    const layers = this.assignLayers(nodes, outgoing, incoming);

    // 2. Node ordering within layers (minimize crossings)
    const orderedLayers = this.orderNodes(layers, outgoing, incoming);

    // 3. Coordinate assignment
    const positions = this.assignCoordinates(
      orderedLayers,
      options.fixedNodes || new Set()
    );

    // Apply constraints
    this.applyConstraints(positions, options);

    const computeTime = performance.now() - startTime;

    return {
      positions,
      meta: {
        iterations: 1,
        finalEnergy: 0,
        computeTimeMs: computeTime,
        converged: true,
      },
    };
  }

  private assignLayers(
    nodes: Node[],
    outgoing: Map<string, Set<string>>,
    incoming: Map<string, Set<string>>
  ): string[][] {
    // outgoing is used by the minimizeCrossings method
    void outgoing;
    const layers: string[][] = [];
    const assigned = new Set<string>();
    const remaining = new Set<string>(nodes.map(n => n.id as string));

    // Find sources (no incoming edges)
    let currentLayer: string[] = nodes
      .filter(n => incoming.get(n.id)?.size === 0)
      .map(n => n.id as string);

    while (currentLayer.length > 0) {
      layers.push(currentLayer);
      currentLayer.forEach(id => {
        assigned.add(id);
        remaining.delete(id);
      });

      // Next layer: nodes whose predecessors are all assigned
      const nextLayer: string[] = [];
      for (const id of remaining) {
        const preds = incoming.get(id) || new Set();
        if (Array.from(preds).every(p => assigned.has(p))) {
          nextLayer.push(id);
        }
      }
      currentLayer = nextLayer;
    }

    // Handle cycles (nodes not assigned)
    if (remaining.size > 0) {
      layers.push(Array.from(remaining));
    }

    return layers;
  }

  private orderNodes(
    layers: string[][],
    outgoing: Map<string, Set<string>>,
    incoming: Map<string, Set<string>>
  ): string[][] {
    // Simple barycenter heuristic
    const ordered = layers.map(layer => [...layer]);

    for (let iter = 0; iter < 4; iter++) {
      // Down pass
      for (let i = 1; i < ordered.length; i++) {
        ordered[i] = this.barycenterSort(ordered[i], ordered[i - 1], incoming);
      }

      // Up pass
      for (let i = ordered.length - 2; i >= 0; i--) {
        ordered[i] = this.barycenterSort(ordered[i], ordered[i + 1], outgoing);
      }
    }

    return ordered;
  }

  private barycenterSort(
    layer: string[],
    adjacentLayer: string[],
    edges: Map<string, Set<string>>
  ): string[] {
    const positions = new Map<string, number>();

    for (const nodeId of layer) {
      const neighbors = edges.get(nodeId) || new Set();
      let sum = 0;
      let count = 0;

      for (const neighbor of neighbors) {
        const idx = adjacentLayer.indexOf(neighbor);
        if (idx >= 0) {
          sum += idx;
          count++;
        }
      }

      positions.set(nodeId, count > 0 ? sum / count : layer.indexOf(nodeId));
    }

    return [...layer].sort((a, b) => positions.get(a)! - positions.get(b)!);
  }

  private assignCoordinates(
    layers: string[][],
    fixedNodes: Set<string>
  ): Map<string, Position> {
    const positions = new Map<string, Position>();
    const isHorizontal = this.config.direction === 'LR' || this.config.direction === 'RL';
    const isReversed = this.config.direction === 'BT' || this.config.direction === 'RL';

    const layerSep = this.config.layerSeparation;
    const nodeSep = this.config.nodeSeparation;

    layers.forEach((layer, layerIdx) => {
      const layerPos = isReversed
        ? (layers.length - 1 - layerIdx) * layerSep
        : layerIdx * layerSep;

      const layerWidth = (layer.length - 1) * nodeSep;
      const startOffset = -layerWidth / 2;

      layer.forEach((nodeId, nodeIdx) => {
        if (fixedNodes.has(nodeId)) return;

        const nodePos = startOffset + nodeIdx * nodeSep;

        if (isHorizontal) {
          positions.set(nodeId, [layerPos, nodePos]);
        } else {
          positions.set(nodeId, [nodePos, layerPos]);
        }
      });
    });

    return positions;
  }

  private applyConstraints(
    positions: Map<string, Position>,
    options: LayoutOptions
  ): void {
    if (options.bounds) {
      const { minX, minY, maxX, maxY } = options.bounds;
      for (const [id, pos] of positions) {
        positions.set(id, [
          clamp(pos[0], minX, maxX),
          clamp(pos[1], minY, maxY),
        ]);
      }
    }
  }

  estimateComplexity(nodeCount: number, connectionCount: number): number {
    // O(n + e) with small constant for crossing minimization
    return nodeCount + connectionCount;
  }
}

// =============================================================================
// CIRCULAR LAYOUT ALGORITHM
// =============================================================================

/**
 * Circular/radial layout for comparative visualization.
 * 
 * Groups nodes by type into sectors, placing related nodes adjacent.
 * Useful for comparing multiple markets or analyzing correlation clusters.
 */
export class CircularLayout implements LayoutAlgorithm {
  readonly type: LayoutType = 'circular';
  readonly name = 'Circular';

  private config: CircularConfig;

  constructor(config: Partial<CircularConfig> = {}) {
    this.config = { ...DEFAULT_CIRCULAR_CONFIG, ...config };
  }

  execute(
    nodes: Node[],
    _connections: Connection[],
    options: LayoutOptions = {}
  ): LayoutResult {
    const startTime = performance.now();
    const positions = new Map<string, Position>();
    const fixedNodes = options.fixedNodes || new Set();

    // Group nodes by type if configured
    let groups: string[][];
    if (this.config.groupByType) {
      const typeGroups = new Map<string, string[]>();
      for (const node of nodes) {
        const typeKey = JSON.stringify(node.node_type);
        if (!typeGroups.has(typeKey)) {
          typeGroups.set(typeKey, []);
        }
        typeGroups.get(typeKey)!.push(node.id);
      }
      groups = Array.from(typeGroups.values());
    } else {
      groups = [nodes.map(n => n.id)];
    }

    // Calculate radius
    const nodeCount = nodes.length;
    const circumference = nodeCount * 80; // 80px per node
    const radius = this.config.radius || circumference / (2 * Math.PI);

    // Position nodes in sectors
    let currentAngle = this.config.startAngle;

    for (const group of groups) {
      const sectorSize = (2 * Math.PI) / groups.length - this.config.sectorGap;
      const angleStep = sectorSize / group.length;

      for (const nodeId of group) {
        if (fixedNodes.has(nodeId)) continue;

        const angle = currentAngle + angleStep * group.indexOf(nodeId) * this.config.direction;
        const x = this.config.center[0] + Math.cos(angle) * radius;
        const y = this.config.center[1] + Math.sin(angle) * radius;

        positions.set(nodeId, [x, y]);
      }

      currentAngle += (2 * Math.PI) / groups.length;
    }

    // Apply constraints
    this.applyConstraints(positions, options);

    const computeTime = performance.now() - startTime;

    return {
      positions,
      meta: {
        iterations: 1,
        finalEnergy: 0,
        computeTimeMs: computeTime,
        converged: true,
      },
    };
  }

  private applyConstraints(
    positions: Map<string, Position>,
    options: LayoutOptions
  ): void {
    if (options.bounds) {
      const { minX, minY, maxX, maxY } = options.bounds;
      for (const [id, pos] of positions) {
        positions.set(id, [
          clamp(pos[0], minX, maxX),
          clamp(pos[1], minY, maxY),
        ]);
      }
    }
  }

  estimateComplexity(nodeCount: number, _connectionCount: number): number {
    return nodeCount; // O(n)
  }
}

// =============================================================================
// GRID LAYOUT ALGORITHM
// =============================================================================

/**
 * Grid layout for structured dashboards.
 * 
 * Arranges nodes in rows and columns with consistent spacing.
 * Ideal for tabular data or when precise alignment is needed.
 */
export class GridLayout implements LayoutAlgorithm {
  readonly type: LayoutType = 'grid';
  readonly name = 'Grid';

  private config: GridConfig;

  constructor(config: Partial<GridConfig> = {}) {
    this.config = { ...DEFAULT_GRID_CONFIG, ...config };
  }

  execute(
    nodes: Node[],
    _connections: Connection[],
    options: LayoutOptions = {}
  ): LayoutResult {
    const startTime = performance.now();
    const positions = new Map<string, Position>();
    const fixedNodes = options.fixedNodes || new Set();

    const nodeCount = nodes.length;
    const cols = this.config.columns || Math.ceil(Math.sqrt(nodeCount));
    const rows = Math.ceil(nodeCount / cols);

    const totalWidth = cols * this.config.cellWidth + (cols - 1) * this.config.spacing;
    const totalHeight = rows * this.config.cellHeight + (rows - 1) * this.config.spacing;
    const startX = -totalWidth / 2 + this.config.cellWidth / 2;
    const startY = -totalHeight / 2 + this.config.cellHeight / 2;

    nodes.forEach((node, index) => {
      if (fixedNodes.has(node.id)) return;

      let row: number;
      let col: number;

      if (this.config.fillOrder === 'row') {
        row = Math.floor(index / cols);
        col = index % cols;
      } else {
        col = Math.floor(index / rows);
        row = index % rows;
      }

      let x = startX + col * (this.config.cellWidth + this.config.spacing);
      let y = startY + row * (this.config.cellHeight + this.config.spacing);

      // Apply alignment
      switch (this.config.align) {
        case 'topLeft':
          x -= this.config.cellWidth / 2;
          y -= this.config.cellHeight / 2;
          break;
        case 'topRight':
          x += this.config.cellWidth / 2;
          y -= this.config.cellHeight / 2;
          break;
        case 'bottomLeft':
          x -= this.config.cellWidth / 2;
          y += this.config.cellHeight / 2;
          break;
        case 'bottomRight':
          x += this.config.cellWidth / 2;
          y += this.config.cellHeight / 2;
          break;
        // 'center' is default, no offset needed
      }

      positions.set(node.id, [x, y]);
    });

    // Apply constraints
    this.applyConstraints(positions, options);

    const computeTime = performance.now() - startTime;

    return {
      positions,
      meta: {
        iterations: 1,
        finalEnergy: 0,
        computeTimeMs: computeTime,
        converged: true,
      },
    };
  }

  private applyConstraints(
    positions: Map<string, Position>,
    options: LayoutOptions
  ): void {
    if (options.bounds) {
      const { minX, minY, maxX, maxY } = options.bounds;
      for (const [id, pos] of positions) {
        positions.set(id, [
          clamp(pos[0], minX, maxX),
          clamp(pos[1], minY, maxY),
        ]);
      }
    }
  }

  estimateComplexity(nodeCount: number, _connectionCount: number): number {
    return nodeCount; // O(n)
  }
}

// =============================================================================
// LAYOUT ENGINE
// =============================================================================

/**
 * Central layout engine managing algorithm registration and execution.
 */
export class LayoutEngine {
  private algorithms = new Map<LayoutType, LayoutAlgorithm>();

  constructor() {
    // Register default algorithms
    this.register(new ForceDirectedLayout());
    this.register(new HierarchicalLayout());
    this.register(new CircularLayout());
    this.register(new GridLayout());
  }

  /**
   * Register a layout algorithm.
   */
  register(algorithm: LayoutAlgorithm): void {
    this.algorithms.set(algorithm.type, algorithm);
  }

  /**
   * Get available algorithm types.
   */
  getAvailableTypes(): LayoutType[] {
    return Array.from(this.algorithms.keys());
  }

  /**
   * Get algorithm by type.
   */
  getAlgorithm(type: LayoutType): LayoutAlgorithm | undefined {
    return this.algorithms.get(type);
  }

  /**
   * Execute layout algorithm.
   */
  execute(
    type: LayoutType,
    nodes: Node[],
    connections: Connection[],
    options?: LayoutOptions
  ): LayoutResult {
    const algorithm = this.algorithms.get(type);
    if (!algorithm) {
      throw new Error(`Unknown layout type: ${type}`);
    }

    return algorithm.execute(nodes, connections, options ?? {});
  }

  /**
   * Estimate layout computation cost.
   */
  estimateComplexity(
    type: LayoutType,
    nodeCount: number,
    connectionCount: number
  ): number {
    const algorithm = this.algorithms.get(type);
    if (!algorithm) return Infinity;
    return algorithm.estimateComplexity(nodeCount, connectionCount);
  }

  /**
   * Recommend best algorithm for graph structure.
   */
  recommendAlgorithm(nodes: Node[], connections: Connection[]): LayoutType {
    const nodeCount = nodes.length;
    const edgeCount = connections.length;

    // Check if DAG (suitable for hierarchical)
    if (this.isDAG(nodes, connections)) {
      return 'hierarchical';
    }

    // Check if highly connected (force-directed works better)
    const density = edgeCount / (nodeCount * (nodeCount - 1) / 2);
    if (density > 0.3) {
      return 'force';
    }

    // Small graphs: any algorithm works
    if (nodeCount < 20) {
      return 'force';
    }

    // Large sparse graphs: hierarchical if possible
    if (edgeCount < nodeCount * 2) {
      return 'hierarchical';
    }

    return 'force';
  }

  private isDAG(nodes: Node[], connections: Connection[]): boolean {
    // Build adjacency list
    const adj = new Map<string, Set<string>>();
    for (const node of nodes) {
      adj.set(node.id, new Set());
    }
    for (const conn of connections) {
      adj.get(conn.source)?.add(conn.target);
    }

    // Kahn's algorithm for topological sort
    const inDegree = new Map<string, number>();
    for (const node of nodes) {
      inDegree.set(node.id, 0);
    }
    for (const conn of connections) {
      inDegree.set(conn.target, (inDegree.get(conn.target) || 0) + 1);
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    let processed = 0;
    while (queue.length > 0) {
      const node = queue.shift()!;
      processed++;

      for (const neighbor of adj.get(node) || []) {
        const newDegree = (inDegree.get(neighbor) || 0) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    return processed === nodes.length;
  }
}

// =============================================================================
// CONVENIENCE FUNCTIONS
// =============================================================================

/**
 * Global layout engine instance.
 */
const defaultEngine = new LayoutEngine();

/**
 * Calculate layout using force-directed algorithm.
 * Convenience function for quick layout calculation.
 */
export function calculateForceLayout(
  nodes: Node[],
  connections: Connection[],
  config?: Partial<ForceConfig>,
  options?: LayoutOptions
): LayoutResult {
  const layout = new ForceDirectedLayout(config);
  return layout.execute(nodes, connections, options);
}

/**
 * Calculate layout using hierarchical algorithm.
 */
export function calculateHierarchicalLayout(
  nodes: Node[],
  connections: Connection[],
  config?: Partial<HierarchicalConfig>,
  options?: LayoutOptions
): LayoutResult {
  const layout = new HierarchicalLayout(config);
  return layout.execute(nodes, connections, options);
}

/**
 * Calculate layout using circular algorithm.
 */
export function calculateCircularLayout(
  nodes: Node[],
  connections: Connection[],
  config?: Partial<CircularConfig>,
  options?: LayoutOptions
): LayoutResult {
  const layout = new CircularLayout(config);
  return layout.execute(nodes, connections, options);
}

/**
 * Calculate layout using grid algorithm.
 */
export function calculateGridLayout(
  nodes: Node[],
  connections: Connection[],
  config?: Partial<GridConfig>,
  options?: LayoutOptions
): LayoutResult {
  const layout = new GridLayout(config);
  return layout.execute(nodes, connections, options);
}

/**
 * Recommend and calculate optimal layout.
 */
export function calculateOptimalLayout(
  nodes: Node[],
  connections: Connection[],
  options?: LayoutOptions
): { type: LayoutType; result: LayoutResult } {
  const type = defaultEngine.recommendAlgorithm(nodes, connections);
  const result = defaultEngine.execute(type, nodes, connections, options);
  return { type, result };
}

/**
 * Animate layout transition.
 * 
 * Returns intermediate positions for animation frames.
 */
export function* animateLayout(
  startPositions: Map<string, Position>,
  endPositions: Map<string, Position>,
  durationMs: number = 500,
  easing: (t: number) => number = smoothStep
): Generator<Map<string, Position>, void, unknown> {
  const startTime = performance.now();
  const nodeIds = Array.from(endPositions.keys());

  while (true) {
    const elapsed = performance.now() - startTime;
    const progress = Math.min(elapsed / durationMs, 1);
    const eased = easing(progress);

    const currentPositions = new Map<string, Position>();

    for (const id of nodeIds) {
      const start = startPositions.get(id) || endPositions.get(id)!;
      const end = endPositions.get(id)!;

      currentPositions.set(id, [
        lerp(start[0], end[0], eased),
        lerp(start[1], end[1], eased),
      ]);
    }

    yield currentPositions;

    if (progress >= 1) break;
  }
}

/**
 * Fit layout to bounds while preserving aspect ratio.
 */
export function fitToBounds(
  positions: Map<string, Position>,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  padding: number = 20
): Map<string, Position> {
  if (positions.size === 0) return positions;

  // Calculate current bounds
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (const pos of positions.values()) {
    minX = Math.min(minX, pos[0]);
    minY = Math.min(minY, pos[1]);
    maxX = Math.max(maxX, pos[0]);
    maxY = Math.max(maxY, pos[1]);
  }

  // Calculate scales
  const currentWidth = maxX - minX;
  const currentHeight = maxY - minY;
  const targetWidth = bounds.maxX - bounds.minX - padding * 2;
  const targetHeight = bounds.maxY - bounds.minY - padding * 2;

  const scaleX = targetWidth / currentWidth;
  const scaleY = targetHeight / currentHeight;
  const scale = Math.min(scaleX, scaleY);

  // Calculate offsets to center
  const scaledWidth = currentWidth * scale;
  const scaledHeight = currentHeight * scale;
  const offsetX = bounds.minX + (bounds.maxX - bounds.minX - scaledWidth) / 2 - minX * scale;
  const offsetY = bounds.minY + (bounds.maxY - bounds.minY - scaledHeight) / 2 - minY * scale;

  // Apply transformation
  const fitted = new Map<string, Position>();
  for (const [id, pos] of positions) {
    fitted.set(id, [
      pos[0] * scale + offsetX,
      pos[1] * scale + offsetY,
    ]);
  }

  return fitted;
}

// =============================================================================
// EXPORTS
// =============================================================================

export { defaultEngine as layoutEngine };

// =============================================================================
// EXAMPLE USAGE
// =============================================================================
//
// // Basic force-directed layout
// const result = calculateForceLayout(nodes, connections, {
//   repulsion: 2000,
//   springLength: 200,
// });
// 
// // Apply positions to nodes
// for (const [id, pos] of result.positions) {
//   updateNodePosition(id, pos);
// }
// 
// // Hierarchical layout for DAG
// const hierResult = calculateHierarchicalLayout(nodes, connections, {
//   direction: 'TB',
//   layerSeparation: 150,
// });
// 
// // Animated transition
// const startPos = getCurrentPositions();
// const endPos = calculateOptimalLayout(nodes, connections).result.positions;
// 
// for (const frame of animateLayout(startPos, endPos, 500)) {
//   for (const [id, pos] of frame) {
//     updateNodePosition(id, pos);
//   }
//   await new Promise(r => requestAnimationFrame(r));
// }
// 
// // Using layout engine directly
// const engine = new LayoutEngine();
// const recommended = engine.recommendAlgorithm(nodes, connections);
// console.log(`Recommended: ${recommended}`);
// 
// const layout = engine.execute(recommended, nodes, connections, {
//   bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 800 },
//   fixedNodes: new Set(['node-1', 'node-2']),
// });
// 
// // Fit to view
// const fitted = fitToBounds(layout.positions, {
//   minX: 0, minY: 0, maxX: window.innerWidth, maxY: window.innerHeight,
// });
//
// ============================================================================