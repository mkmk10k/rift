/**
 * TypeScript declarations for Three.js WebGPU modules
 * These are used by the BlackHoleOrb component for TSL shaders
 */

declare module 'three/addons/capabilities/WebGPU.js' {
  const WebGPU: {
    isAvailable(): boolean;
  };
  export default WebGPU;
}

declare module 'three/addons/renderers/webgpu/WebGPURenderer.js' {
  import { Camera, Scene, WebGLRendererParameters } from 'three';

  interface WebGPURendererParameters extends WebGLRendererParameters {
    antialias?: boolean;
    alpha?: boolean;
    forceWebGL?: boolean;
  }

  class WebGPURenderer {
    constructor(parameters?: WebGPURendererParameters);
    domElement: HTMLCanvasElement;
    init(): Promise<void>;
    render(scene: Scene, camera: Camera): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    setPixelRatio(value: number): void;
    setClearColor(color: number | string, alpha?: number): void;
    dispose(): void;
    getContext(): GPUCanvasContext | WebGLRenderingContext;
    info: {
      render: {
        calls: number;
        triangles: number;
      };
    };
  }

  export default WebGPURenderer;
}

// TSL (Three.js Shading Language) exports
declare module 'three/tsl' {
  import { Color, Vector2, Vector3, Vector4 } from 'three';

  // Node types
  export type ShaderNode = any;
  export type NodeRepresentation = ShaderNode | number | Color | Vector2 | Vector3 | Vector4;

  // Core function for creating TSL shader nodes
  export function tslFn<T extends (...args: any[]) => any>(fn: T): T;

  // Uniform nodes
  export function uniform(value: number): ShaderNode;
  export function uniform(value: Vector2): ShaderNode;
  export function uniform(value: Vector3): ShaderNode;
  export function uniform(value: Vector4): ShaderNode;
  export function uniform(value: Color): ShaderNode;

  // Attribute nodes
  export function attribute(name: string, type?: string): ShaderNode;
  export const uv: ShaderNode;
  export const position: ShaderNode;
  export const normal: ShaderNode;

  // Math operations
  export function float(value: NodeRepresentation): ShaderNode;
  export function vec2(x: NodeRepresentation, y?: NodeRepresentation): ShaderNode;
  export function vec3(x: NodeRepresentation, y?: NodeRepresentation, z?: NodeRepresentation): ShaderNode;
  export function vec4(x: NodeRepresentation, y?: NodeRepresentation, z?: NodeRepresentation, w?: NodeRepresentation): ShaderNode;

  export function add(a: NodeRepresentation, b: NodeRepresentation): ShaderNode;
  export function sub(a: NodeRepresentation, b: NodeRepresentation): ShaderNode;
  export function mul(a: NodeRepresentation, b: NodeRepresentation): ShaderNode;
  export function div(a: NodeRepresentation, b: NodeRepresentation): ShaderNode;
  export function mod(a: NodeRepresentation, b: NodeRepresentation): ShaderNode;
  export function pow(a: NodeRepresentation, b: NodeRepresentation): ShaderNode;
  export function sqrt(a: NodeRepresentation): ShaderNode;
  export function abs(a: NodeRepresentation): ShaderNode;
  export function sign(a: NodeRepresentation): ShaderNode;
  export function floor(a: NodeRepresentation): ShaderNode;
  export function ceil(a: NodeRepresentation): ShaderNode;
  export function fract(a: NodeRepresentation): ShaderNode;
  export function min(a: NodeRepresentation, b: NodeRepresentation): ShaderNode;
  export function max(a: NodeRepresentation, b: NodeRepresentation): ShaderNode;
  export function clamp(x: NodeRepresentation, min: NodeRepresentation, max: NodeRepresentation): ShaderNode;
  export function mix(a: NodeRepresentation, b: NodeRepresentation, t: NodeRepresentation): ShaderNode;
  export function smoothstep(edge0: NodeRepresentation, edge1: NodeRepresentation, x: NodeRepresentation): ShaderNode;
  export function step(edge: NodeRepresentation, x: NodeRepresentation): ShaderNode;

  // Trigonometry
  export function sin(a: NodeRepresentation): ShaderNode;
  export function cos(a: NodeRepresentation): ShaderNode;
  export function tan(a: NodeRepresentation): ShaderNode;
  export function asin(a: NodeRepresentation): ShaderNode;
  export function acos(a: NodeRepresentation): ShaderNode;
  export function atan(a: NodeRepresentation): ShaderNode;
  export function atan2(y: NodeRepresentation, x: NodeRepresentation): ShaderNode;

  // Vector operations
  export function length(v: NodeRepresentation): ShaderNode;
  export function distance(a: NodeRepresentation, b: NodeRepresentation): ShaderNode;
  export function dot(a: NodeRepresentation, b: NodeRepresentation): ShaderNode;
  export function cross(a: NodeRepresentation, b: NodeRepresentation): ShaderNode;
  export function normalize(v: NodeRepresentation): ShaderNode;
  export function reflect(i: NodeRepresentation, n: NodeRepresentation): ShaderNode;
  export function refract(i: NodeRepresentation, n: NodeRepresentation, eta: NodeRepresentation): ShaderNode;

  // Exponential
  export function exp(a: NodeRepresentation): ShaderNode;
  export function exp2(a: NodeRepresentation): ShaderNode;
  export function log(a: NodeRepresentation): ShaderNode;
  export function log2(a: NodeRepresentation): ShaderNode;

  // Logic
  export function cond(condition: NodeRepresentation, ifTrue: NodeRepresentation, ifFalse: NodeRepresentation): ShaderNode;
  export function and(a: NodeRepresentation, b: NodeRepresentation): ShaderNode;
  export function or(a: NodeRepresentation, b: NodeRepresentation): ShaderNode;
  export function not(a: NodeRepresentation): ShaderNode;
  export function lessThan(a: NodeRepresentation, b: NodeRepresentation): ShaderNode;
  export function greaterThan(a: NodeRepresentation, b: NodeRepresentation): ShaderNode;
  export function equal(a: NodeRepresentation, b: NodeRepresentation): ShaderNode;

  // Loops
  export function Loop(count: NodeRepresentation | number, callback: (props: { i: ShaderNode }) => void): ShaderNode;

  // Color output
  export function color(r: NodeRepresentation, g?: NodeRepresentation, b?: NodeRepresentation): ShaderNode;

  // Time
  export const time: ShaderNode;

  // Matrix
  export function mat2(a: NodeRepresentation, b: NodeRepresentation, c: NodeRepresentation, d: NodeRepresentation): ShaderNode;
  export function mat3(...args: NodeRepresentation[]): ShaderNode;
  export function mat4(...args: NodeRepresentation[]): ShaderNode;

  // Swizzle is accessed via .x, .y, .z, .w, .xy, .xyz, etc on nodes

  // Hash/random
  export function hash(input: NodeRepresentation): ShaderNode;
}

declare module 'three/addons/nodes/Nodes.js' {
  export * from 'three/tsl';
}
