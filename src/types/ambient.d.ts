declare module 'tree-sitter-c-sharp' {
  const csharp: any;
  export default csharp;
}
declare module 'graphology-types' {
  // Minimal type for graphology's AbstractGraph — avoids import resolution issues
  export type Attributes = Record<string, unknown>;
  export type NodeAttributes = Attributes;
  export type EdgeAttributes = Attributes;
  export type GraphConstructor = any;
  export class AbstractGraph<A=any, B=any, C=any> {
    order: number;
    size: number;
    addNode(node: string, attributes?: Attributes): void;
    addEdge(from: string, to: string, attributes?: Attributes): void;
    hasNode(node: string): boolean;
    hasEdge(from: string, to: string): boolean;
    forEachNode(callback: (node: string, attributes: Attributes) => void): void;
    forEachNeighbor(node: string, callback: (neighbor: string, attrs: Attributes) => void): void;
    getNodeAttribute(node: string, name: string): unknown;
    setNodeAttribute(node: string, name: string, value: unknown): void;
    updateNodeAttribute(node: string, name: string, updater: (v: unknown) => unknown): void;
    forEachEdge(callback: (edge: string, attributes: Attributes, source: string, target: string) => void): void;
    setEdgeAttribute(edge: string, name: string, value: unknown): void;
    dropNode(node: string): void;
    mapNodes(callback: (node: string, attributes: Attributes) => unknown): unknown[];
    filterNodes(callback: (node: string, attributes: Attributes) => boolean): string[];
  }
}
